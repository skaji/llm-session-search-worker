package syncer

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

type sessionFile struct {
	source, path, id, title string
	archived, titleKnown    bool
	info                    fs.FileInfo
}

var uuidPattern = regexp.MustCompile(`(?i)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`)

func sessionIDFromPath(path string) string {
	if match := uuidPattern.FindStringSubmatch(filepath.Base(path)); len(match) > 1 {
		return strings.ToLower(match[1])
	}
	sum := sha256.Sum256([]byte(path))
	return "file-" + hex.EncodeToString(sum[:12])
}

func ReadDocuments(codexHome, claudeHome, device string) ([]Document, error) {
	var files []sessionFile
	found := false
	for _, source := range []struct {
		home     string
		discover func(string) ([]sessionFile, bool, error)
	}{{codexHome, discoverCodexSessionFiles}, {claudeHome, discoverClaudeSessionFiles}} {
		if source.home == "" {
			continue
		}
		items, ok, err := source.discover(source.home)
		if err != nil {
			return nil, err
		}
		found = found || ok
		files = append(files, items...)
	}
	if !found {
		return nil, errors.New("no Codex or Claude session directories found")
	}
	slices.SortFunc(files, func(a, b sessionFile) int { return strings.Compare(a.path, b.path) })
	documents := make([]Document, 0, len(files))
	seen := map[string]bool{}
	for _, f := range files {
		key := f.source + "/" + f.id
		if seen[key] {
			return nil, fmt.Errorf("duplicate session identity %s; remove duplicate JSONL copies", key)
		}
		seen[key] = true
		doc, err := readDocument(f, device)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", f.path, err)
		}
		documents = append(documents, doc)
	}
	return documents, nil
}

func readDocument(f sessionFile, device string) (Document, error) {
	doc := Document{Session: Session{Device: device, Source: f.source, SourceID: f.id, Title: f.title, Path: f.path}, Records: []Record{}}
	if f.archived {
		doc.Session.Archived = 1
	}
	handle, err := os.Open(f.path)
	if err != nil {
		return doc, err
	}
	defer func() { _ = handle.Close() }()
	// Bound the snapshot to the discovered size; an append is picked up next time.
	reader := bufio.NewReaderSize(io.LimitReader(handle, f.info.Size()), 256*1024)
	updated := int64(0)
	for lineNumber := 1; ; lineNumber++ {
		line, readErr := reader.ReadBytes('\n')
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) > 0 {
			if !json.Valid(trimmed) {
				if errors.Is(readErr, io.EOF) {
					break
				}
				return doc, fmt.Errorf("invalid JSON at line %d", lineNumber)
			}
			e := extractSessionLine(f.source, line)
			if doc.Session.CWD == "" {
				doc.Session.CWD = e.cwd
			}
			if e.title != "" && (e.forceTitle || doc.Session.Title == "") {
				doc.Session.Title = e.title
			}
			if e.text != "" && (e.role == "user" || e.role == "assistant") {
				for _, t := range e.timestamps {
					updated = max(updated, t.UnixMilli())
				}
				doc.Records = append(doc.Records, Record{Line: lineNumber, Role: e.role, Text: &e.text})
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return doc, readErr
		}
	}
	doc.Session.UpdatedAtMS = updated
	return doc, nil
}
