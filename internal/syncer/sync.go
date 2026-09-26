package syncer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
)

const (
	maxBody    = 128 * 1024
	maxRecords = 40
)

type (
	SessionState struct {
		Session  Session        `json:"session"`
		Metadata string         `json:"metadata"`
		Records  map[int]string `json:"records"`
	}
	State struct {
		Version  int                      `json:"version"`
		Scope    string                   `json:"scope"`
		Sessions map[string]*SessionState `json:"sessions"`
		Pending  *Update                  `json:"pending,omitempty"`
		Reset    bool                     `json:"reset,omitempty"`
	}
)

func hash(value any) string {
	data, _ := json.Marshal(value)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func Scope(base, device, codex, claude string) string {
	return hash([]string{base, device, codex, claude})
}

func LoadState(path, scope string) (*State, error) {
	state := &State{Version: 1, Scope: scope, Sessions: map[string]*SessionState{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(data, state); err != nil {
		return nil, fmt.Errorf("read sync state: %w", err)
	}
	if state.Version != 1 || state.Scope != scope || state.Sessions == nil {
		return nil, errors.New("sync state does not match this endpoint, device, or source directories")
	}
	return state, nil
}

func (s *State) Save(path string) error {
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".sync-state-*")
	if err != nil {
		return err
	}
	name := file.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err = file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
func key(s Session) string { return s.Source + "/" + s.SourceID }
func checkpoint(state *State, input Update) {
	k := key(input.Session)
	current := state.Sessions[k]
	if current == nil {
		current = &SessionState{Records: map[int]string{}}
		state.Sessions[k] = current
	}
	current.Session = input.Session
	current.Metadata = hash(input.Session)
	for _, r := range input.Records {
		if r.Text == nil {
			delete(current.Records, r.Line)
		} else {
			current.Records[r.Line] = hash(r)
		}
	}
}

func drain(ctx context.Context, c *Client, state *State, path string) error {
	if state.Pending == nil {
		return nil
	}
	if err := c.Send(ctx, *state.Pending); err != nil {
		return err
	}
	checkpoint(state, *state.Pending)
	state.Pending = nil
	return state.Save(path)
}

func batches(s Session, records []Record) ([]Update, error) {
	result := []Update{}
	batch := Update{Session: s, Records: []Record{}}
	for _, r := range records {
		candidate := Update{Session: s, Records: append(slices.Clone(batch.Records), r)}
		data, _ := json.Marshal(candidate)
		if len(candidate.Records) > maxRecords || len(data) > maxBody {
			if len(batch.Records) == 0 {
				return nil, fmt.Errorf("record at line %d exceeds the upload limit", r.Line)
			}
			result = append(result, batch)
			batch = Update{Session: s, Records: []Record{r}}
			data, _ = json.Marshal(batch)
			if len(data) > maxBody {
				return nil, fmt.Errorf("record at line %d exceeds the upload limit", r.Line)
			}
		} else {
			batch = candidate
		}
	}
	if len(batch.Records) > 0 || len(result) == 0 {
		result = append(result, batch)
	}
	return result, nil
}

type Stats struct {
	Sessions int
	Changed  int
	Records  int
	Deleted  int
	Requests int
}

func Sync(ctx context.Context, c *Client, docs []Document, state *State, path, device string, prune, rebuild bool) (Stats, error) {
	stats := Stats{Sessions: len(docs)}
	if rebuild {
		state.Reset = true
		if err := state.Save(path); err != nil {
			return stats, err
		}
	}
	if state.Reset {
		if err := c.DeleteDevice(ctx, device); err != nil {
			return stats, err
		}
		state.Sessions = map[string]*SessionState{}
		state.Pending = nil
		state.Reset = false
		if err := state.Save(path); err != nil {
			return stats, err
		}
	}
	if err := drain(ctx, c, state, path); err != nil {
		return stats, err
	}
	seen := map[string]bool{}
	for _, doc := range docs {
		k := key(doc.Session)
		seen[k] = true
		previous := state.Sessions[k]
		changes := []Record{}
		current := map[int]bool{}
		for _, r := range doc.Records {
			current[r.Line] = true
			if previous == nil || previous.Records[r.Line] != hash(r) {
				changes = append(changes, r)
			}
		}
		if previous != nil {
			for line := range previous.Records {
				if !current[line] {
					changes = append(changes, Record{Line: line, Role: "user", Text: nil})
				}
			}
		}
		if len(changes) == 0 && previous != nil && previous.Metadata == hash(doc.Session) {
			continue
		}
		slices.SortFunc(changes, func(a, b Record) int { return a.Line - b.Line })
		requests, err := batches(doc.Session, changes)
		if err != nil {
			return stats, err
		}
		for _, input := range requests {
			// Persist intent before sending. A lost response is replayed before new changes.
			state.Pending = &input
			if err = state.Save(path); err != nil {
				return stats, err
			}
			if err = drain(ctx, c, state, path); err != nil {
				return stats, err
			}
		}
		stats.Changed++
		stats.Records += len(changes)
	}
	if prune {
		keys := make([]string, 0, len(state.Sessions))
		for k := range state.Sessions {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		for _, k := range keys {
			if seen[k] {
				continue
			}
			if err := c.DeleteSession(ctx, state.Sessions[k].Session); err != nil {
				return stats, err
			}
			delete(state.Sessions, k)
			if err := state.Save(path); err != nil {
				return stats, err
			}
			stats.Deleted++
		}
	}
	stats.Requests = c.Requests
	return stats, nil
}
func StateFilename(scope string) string { return "sync-" + scope[:16] + ".json" }
func SessionPath(id, after string) (string, error) {
	n, err := strconv.ParseUint(id, 10, 53)
	if err != nil || n == 0 {
		return "", errors.New("session ID must be a positive integer")
	}
	if _, err = strconv.ParseUint(after, 10, 53); err != nil {
		return "", errors.New("after must be a nonnegative integer")
	}
	return "/api/v1/sessions/" + id + "?after=" + after, nil
}
