package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/skaji/llm-session-search-worker/internal/syncer"
	"golang.org/x/term"
)

var version = "dev"

var validDevice = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,128}$`)

func main() {
	if err := run(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func configure(config *syncer.Config, dir string, askToken bool) error {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return errors.New("initial setup requires a terminal; run llm-session-sync configure interactively")
	}
	reader := bufio.NewReader(os.Stdin)
	name := config.Device
	if name == "" {
		name, _ = os.Hostname()
		name = strings.TrimSuffix(name, ".local")
	}
	_, _ = fmt.Fprintf(os.Stderr, "Device name [%s]: ", name)
	input, err := reader.ReadString('\n')
	if err != nil {
		return err
	}
	if input = strings.TrimSpace(input); input != "" {
		name = input
	}
	if !validDevice.MatchString(name) {
		return errors.New("device name must contain 1–128 letters, digits, dots, underscores, or hyphens")
	}
	config.Device = name
	client, err := syncer.NewClient(config.URL)
	if err != nil {
		return err
	}
	if askToken && !client.Local {
		_, _ = fmt.Fprintf(os.Stderr, "Cloudflare Access token for %s (hidden; Enter keeps the saved token): ", config.URL)
		token, readErr := term.ReadPassword(int(os.Stdin.Fd()))
		_, _ = fmt.Fprintln(os.Stderr)
		if readErr != nil {
			return readErr
		}
		if value := strings.TrimSpace(string(token)); value != "" {
			config.Token = value
		}
		if len(strings.Split(config.Token, ".")) != 3 {
			return errors.New("expected a Cloudflare Access JWT; obtain it with cloudflared access login")
		}
	}
	return config.Save(dir)
}

func run() error {
	command := "sync"
	args := os.Args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command = args[0]
		args = args[1:]
	}
	if !map[string]bool{"sync": true, "configure": true, "login": true, "search": true, "show": true}[command] {
		return fmt.Errorf("unknown command %q", command)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.Usage = func() {
		_, _ = fmt.Fprintln(flags.Output(), "Usage: llm-session-sync [sync|configure|login|search|show] [options]\nWith no command, configure if needed and sync once. Place flags before search words or session ID.")
		flags.PrintDefaults()
	}
	showVersion := flags.Bool("version", false, "Print version and exit")
	daemon := flags.Bool("daemon", false, "Run periodic sync in the background")
	daemonStatus := flags.Bool("daemon-status", false, "Show daemon and token status")
	daemonStop := flags.Bool("daemon-stop", false, "Stop the background daemon")
	interval := flags.Duration("interval", time.Minute, "Daemon sync interval")
	endpoint := flags.String("url", "", "Worker origin (saved by configure)")
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dataDir := flags.String("data-dir", filepath.Join(home, ".llm-session-search-worker"), "Configuration and checkpoint directory")
	codexDefault := os.Getenv("CODEX_HOME")
	if codexDefault == "" {
		codexDefault = filepath.Join(home, ".codex")
	}
	claudeDefault := os.Getenv("CLAUDE_CONFIG_DIR")
	if claudeDefault == "" {
		claudeDefault = filepath.Join(home, ".claude")
	}
	codex := flags.String("codex-home", codexDefault, "Codex data directory; empty disables it")
	claude := flags.String("claude-home", claudeDefault, "Claude data directory; empty disables it")
	prune := flags.Bool("prune", false, "Remove previously synced sessions no longer present locally")
	rebuild := flags.Bool("rebuild", false, "Delete this device's cloud copy and upload it again")
	dry := flags.Bool("dry-run", false, "Parse files and report counts without network requests or state changes")
	cwd := flags.String("cwd", "", "Search within this working directory and descendants")
	filterDevice := flags.String("filter-device", "", "Search only this device")
	offset := flags.Uint("offset", 0, "Search pagination offset")
	after := flags.String("after", "0", "Show messages after this line number")
	if err = flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if *showVersion {
		_, err := fmt.Fprintln(os.Stdout, version)
		return err
	}
	if command != "search" && command != "show" && flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	modes := 0
	for _, enabled := range []bool{*daemon, *daemonStatus, *daemonStop} {
		if enabled {
			modes++
		}
	}
	if modes > 1 || (modes > 0 && command != "sync") {
		return errors.New("daemon options are mutually exclusive and only apply to sync")
	}
	if *interval <= 0 {
		return errors.New("interval must be positive")
	}
	if *daemon && (*dry || *rebuild) {
		return errors.New("run dry-run or rebuild once, without -daemon")
	}
	if *daemonStop {
		return stopDaemon(*dataDir)
	}
	if *daemonStatus {
		pid, running, statusErr := daemonPID(*dataDir)
		if statusErr != nil {
			return statusErr
		}
		if running {
			_, _ = fmt.Fprintf(os.Stdout, "Daemon: running (PID %d)\n", pid)
		} else {
			_, _ = fmt.Fprintln(os.Stdout, "Daemon: stopped")
		}
		config, loadErr := syncer.LoadConfig(*dataDir)
		if loadErr != nil {
			return loadErr
		}
		client, clientErr := syncer.NewClient(config.URL)
		if clientErr != nil {
			return clientErr
		}
		client.Token = config.Token
		_, _ = fmt.Fprintln(os.Stdout, "Token:", syncer.TokenStatus(ctx, client))
		return nil
	}
	config, err := syncer.LoadConfig(*dataDir)
	if err != nil {
		return err
	}
	if *endpoint != "" && strings.TrimRight(*endpoint, "/") != config.URL {
		if command != "configure" && (config.Token != "" || config.Device != "") {
			return errors.New("use configure --url to change the endpoint; saved tokens are never sent to another origin")
		}
		config.URL = strings.TrimRight(*endpoint, "/")
		config.Token = ""
	}
	if config.URL == "" {
		return errors.New("worker URL is not configured; run llm-session-sync configure -url <url from settings.json>")
	}
	client, err := syncer.NewClient(config.URL)
	if err != nil {
		return err
	}
	if command == "configure" {
		return configure(&config, *dataDir, true)
	}
	if os.Getenv(childEnv) != "1" && command != "login" && !*dry && (config.Device == "" || (!client.Local && config.Token == "" && command != "login")) {
		if err = configure(&config, *dataDir, true); err != nil {
			return err
		}
	}
	client.Token = config.Token
	if command == "sync" {
		once := func() error {
			latest, loadErr := syncer.LoadConfig(*dataDir)
			if loadErr != nil {
				return loadErr
			}
			if *dry {
				latest = config
			}
			return syncOnce(ctx, latest, *dataDir, *codex, *claude, *dry, *prune, *rebuild)
		}
		if *daemon {
			if os.Getenv(childEnv) == "1" {
				return runDaemon(ctx, *dataDir, *interval, once)
			}
			return startDaemon(*dataDir)
		}
		return once()
	}

	var data []byte
	switch command {
	case "login":
		if config.Device == "" {
			if err = configure(&config, *dataDir, false); err != nil {
				return err
			}
		}
		if err = client.Login(ctx); err == nil {
			data, err = client.Get(ctx, "/api/v1/me")
		}
		if err == nil {
			config.Token = client.Token
			err = config.Save(*dataDir)
		}
	case "search":
		values := url.Values{"q": {strings.Join(flags.Args(), " ")}, "cwd": {*cwd}, "device": {*filterDevice}, "offset": {fmt.Sprint(*offset)}}
		data, err = client.Get(ctx, "/api/v1/search?"+values.Encode())
	case "show":
		if flags.NArg() != 1 {
			return errors.New("usage: show [options] SESSION_ID")
		}
		var path string
		path, err = syncer.SessionPath(flags.Arg(0), *after)
		if err == nil {
			data, err = client.Get(ctx, path)
		}
	}
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(os.Stdout, string(data))
	return err
}

func syncOnce(ctx context.Context, config syncer.Config, dataDir, codexHome, claudeHome string, dry, prune, rebuild bool) error {
	client, err := syncer.NewClient(config.URL)
	if err != nil {
		return err
	}
	client.Token = config.Token
	for _, path := range []*string{&codexHome, &claudeHome} {
		if *path != "" {
			*path, err = filepath.Abs(*path)
			if err != nil {
				return err
			}
		}
	}
	docs, readErr := syncer.ReadDocuments(codexHome, claudeHome, config.Device)
	if readErr != nil {
		return readErr
	}
	if dry {
		records := 0
		for _, d := range docs {
			records += len(d.Records)
		}
		_, _ = fmt.Fprintf(os.Stdout, "%d sessions, %d records; no data sent\n", len(docs), records)
		return nil
	}
	if !validDevice.MatchString(config.Device) {
		return errors.New("invalid device name in config.json")
	}
	if err = os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	scope := syncer.Scope(client.Base, config.Device, codexHome, claudeHome)
	path := filepath.Join(dataDir, syncer.StateFilename(scope))
	// Serialize all syncs for this configuration, even if input directories differ.
	lock, lockErr := os.OpenFile(filepath.Join(dataDir, "sync.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if lockErr != nil {
		return lockErr
	}
	defer func() { _ = lock.Close() }()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("another sync is running")
	}
	defer func() { _ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) }()
	state, stateErr := syncer.LoadState(path, scope)
	if stateErr != nil {
		return stateErr
	}
	stats, syncErr := syncer.Sync(ctx, client, docs, state, path, config.Device, prune, rebuild)
	if syncErr != nil {
		return syncErr
	}
	if os.Getenv(childEnv) == "1" {
		log.Printf("Sync complete: %d sessions, %d changed, %d records, %d deleted, %d requests", stats.Sessions, stats.Changed, stats.Records, stats.Deleted, stats.Requests)
		return nil
	}
	return json.NewEncoder(os.Stdout).Encode(stats)
}
