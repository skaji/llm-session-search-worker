package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const childEnv = "LLM_SESSION_SEARCH_DAEMON_CHILD"

func daemonPID(dir string) (int, bool, error) {
	file, err := os.OpenFile(filepath.Join(dir, "app.pid"), os.O_RDWR, 0o600)
	if errors.Is(err, os.ErrNotExist) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = file.Close() }()
	err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if err == nil {
		_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		return 0, false, nil
	}
	if !errors.Is(err, syscall.EWOULDBLOCK) {
		return 0, false, err
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return 0, false, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 1 {
		return 0, false, errors.New("daemon is starting; retry shortly")
	}
	return pid, true, nil
}

func startDaemon(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if pid, running, err := daemonPID(dir); err != nil {
		return err
	} else if running {
		_, _ = fmt.Fprintf(os.Stdout, "Daemon already running (PID %d)\n", pid)
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	logFile, err := os.OpenFile(filepath.Join(dir, "app.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() { _ = logFile.Close() }()
	readReady, writeReady, err := os.Pipe()
	if err != nil {
		return err
	}
	defer func() { _ = readReady.Close() }()
	cmd := exec.Command(executable, os.Args[1:]...)
	cmd.Env = append(os.Environ(), childEnv+"=1")
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.ExtraFiles = []*os.File{writeReady}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err = cmd.Start(); err != nil {
		_ = writeReady.Close()
		return err
	}
	_ = writeReady.Close()
	ready := make(chan error, 1)
	go func() { var value [1]byte; _, e := io.ReadFull(readReady, value[:]); ready <- e }()
	select {
	case err = <-ready:
		if err != nil {
			_ = cmd.Wait()
			return errors.New("daemon failed to start; see app.log")
		}
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Signal(syscall.SIGTERM)
		_ = cmd.Wait()
		return errors.New("daemon startup timed out; see app.log")
	}
	_, _ = fmt.Fprintf(os.Stdout, "Daemon started (PID %d); log: %s\n", cmd.Process.Pid, filepath.Join(dir, "app.log"))
	return cmd.Process.Release()
}

func runDaemon(ctx context.Context, dir string, interval time.Duration, syncOnce func() error) error {
	file, err := os.OpenFile(filepath.Join(dir, "app.pid"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("daemon already running")
	}
	defer func() { _ = file.Truncate(0); _ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN) }()
	if err = file.Truncate(0); err != nil {
		return err
	}
	if _, err = fmt.Fprintln(file, os.Getpid()); err != nil {
		return err
	}
	ready := os.NewFile(3, "ready")
	if ready == nil {
		return errors.New("missing startup pipe")
	}
	_, err = ready.Write([]byte{1})
	_ = ready.Close()
	if err != nil {
		return err
	}
	log.SetFlags(log.LstdFlags)
	log.Printf("Daemon started; sync interval %s", interval)
	for {
		if err = syncOnce(); err != nil {
			log.Printf("Sync failed: %v", err)
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			log.Print("Daemon stopped")
			return nil
		case <-timer.C:
		}
	}
}

func stopDaemon(dir string) error {
	pid, running, err := daemonPID(dir)
	if err != nil {
		return err
	}
	if !running {
		_, _ = fmt.Fprintln(os.Stdout, "Daemon stopped")
		return nil
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	if err = process.Signal(syscall.SIGTERM); err != nil {
		return err
	}
	for range 50 {
		_, running, err = daemonPID(dir)
		if err != nil {
			return err
		}
		if !running {
			_, _ = fmt.Fprintln(os.Stdout, "Daemon stopped")
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("stop requested; daemon has not exited yet")
}
