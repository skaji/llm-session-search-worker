package syncer

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestParseConversations(t *testing.T) {
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	if err := os.Mkdir(sessions, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(sessions, "test.jsonl")
	data := `{"type":"session_meta","payload":{"cwd":"/projects/demo"},"timestamp":"2026-09-25T01:00:00Z"}
{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"hello 日本語検索"},{"type":"input_text","text":"# AGENTS.md instructions for /tmp\n<INSTRUCTIONS>hidden</INSTRUCTIONS>"}]}}
{"type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"answer"}]}}
{"type":"response_item","payload":`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	docs, err := ReadDocuments(root, "", "macbook")
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) != 1 || len(docs[0].Records) != 2 || docs[0].Session.CWD != "/projects/demo" || strings.Contains(*docs[0].Records[0].Text, "hidden") {
		t.Fatalf("unexpected extraction: %+v", docs)
	}
	e := extractClaudeJSONLine([]byte(`{"type":"user","message":{"role":"user","content":"<system-reminder>ignore</system-reminder> question"}}`))
	if e.text != "question" {
		t.Fatal(e.text)
	}
	e = extractClaudeJSONLine([]byte(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","input":{"text":"hidden"}},{"type":"text","text":"visible"}]}}`))
	if e.text != "visible" {
		t.Fatal(e.text)
	}
	text := limitString(strings.Repeat("日本語", 10000))
	if !utf8.ValidString(text) || len(text) > 20*1024 || !strings.Contains(text, "truncated") {
		t.Fatal("invalid truncation")
	}
}

func TestPendingReplayAndNoOp(t *testing.T) {
	calls := 0
	fail := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		if fail {
			w.WriteHeader(500)
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL)
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	state, _ := LoadState(path, "scope")
	text := "hello"
	doc := Document{Session: Session{Device: "mac", Source: "codex", SourceID: "one"}, Records: []Record{{Line: 1, Role: "user", Text: &text}}}
	if _, err := Sync(context.Background(), client, []Document{doc}, state, path, "mac", false, false); err == nil {
		t.Fatal("expected error")
	}
	state, err := LoadState(path, "scope")
	if err != nil {
		t.Fatal(err)
	}
	if state.Pending == nil {
		t.Fatal("missing pending batch")
	}
	fail = false
	if _, err = Sync(context.Background(), client, []Document{doc}, state, path, "mac", false, false); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("calls=%d", calls)
	}
	if _, err = Sync(context.Background(), client, []Document{doc}, state, path, "mac", false, false); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatal("unchanged sync made a request")
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatal("unsafe permissions")
	}
}

func TestBatchesAndConfig(t *testing.T) {
	text := strings.Repeat("\x01", 16000)
	records := make([]Record, 45)
	for i := range records {
		records[i] = Record{Line: i + 1, Role: "user", Text: &text}
	}
	requests, err := batches(Session{}, records)
	if err != nil {
		t.Fatal(err)
	}
	for _, request := range requests {
		data, _ := json.Marshal(request)
		if len(data) > maxBody || len(request.Records) > 40 {
			t.Fatal("oversized batch")
		}
	}
	dir := t.TempDir()
	config := Config{URL: "https://sessions.example.com", Device: "test", Token: "a.b.c"}
	if err = config.Save(dir); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadConfig(dir)
	if err != nil || loaded != config {
		t.Fatal("config roundtrip failed")
	}
	info, _ := os.Stat(filepath.Join(dir, "config.json"))
	if info.Mode().Perm() != 0o600 {
		t.Fatal("unsafe config permissions")
	}
}

func TestExpiredTokenAndRedirect(t *testing.T) {
	data, _ := json.Marshal(map[string]int64{"exp": time.Now().Add(-time.Hour).Unix()})
	token := "a." + base64.RawURLEncoding.EncodeToString(data) + ".c"
	client, _ := NewClient("https://sessions.example.com")
	client.Token = token
	if !strings.Contains(TokenStatus(context.Background(), client), "expired") {
		t.Fatal("missing expiry")
	}
	if _, err := client.Get(context.Background(), "/api/v1/me"); !errors.Is(err, ErrAuthentication) {
		t.Fatal("expired token accepted")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://example.com/login", http.StatusFound)
	}))
	defer server.Close()
	client, _ = NewClient(server.URL)
	if _, err := client.Get(context.Background(), "/api/v1/me"); !errors.Is(err, ErrAuthentication) {
		t.Fatal("redirect followed")
	}
}

func TestDisplayedMessageUpdateTime(t *testing.T) {
	for _, tc := range []struct {
		name, source, data string
		want               string
		count              int
	}{
		{"codex", sourceCodex, `
{"timestamp":"2026-09-22T10:00:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"question"}]}}
{"timestamp":"2026-09-22T11:00:00Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"answer"}]}}
{"timestamp":"2026-09-22T10:30:00Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"earlier answer appended later"}]}}
{"timestamp":"2026-09-27T02:00:00Z","type":"event_msg","payload":{"type":"token_count"}}
{"timestamp":"2026-09-27T03:00:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<environment_context>hidden</environment_context>"}]}}
{"timestamp":"2026-09-27T04:00:00Z","type":"response_item","payload":{"role":"assistant","content":[]}}
`, "2026-09-22T11:00:00Z", 3},
		{"claude", sourceClaude, `
{"timestamp":"2026-09-22T10:00:00Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}
{"timestamp":"2026-09-22T11:00:00Z","type":"user","message":{"role":"user","content":"question"}}
{"timestamp":"2026-09-27T02:00:00Z","type":"custom-title","customTitle":"New title"}
{"timestamp":"2026-09-27T03:00:00Z","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","input":{"text":"hidden"}}]}}
{"timestamp":"2026-09-27T04:00:00Z","type":"user","message":{"role":"user","content":"<system-reminder>hidden</system-reminder>"}}
`, "2026-09-22T11:00:00Z", 2},
		{"missing timestamps", sourceCodex, `
{"timestamp":"2026-09-27T02:00:00Z","type":"session_meta","payload":{"cwd":"/test"}}
{"type":"response_item","payload":{"role":"user","content":"question"}}
{"timestamp":"invalid","type":"response_item","payload":{"role":"assistant","content":"answer"}}
`, "", 2},
		{"no displayed messages", sourceClaude, `{"timestamp":"2026-09-27T02:00:00Z","type":"custom-title","customTitle":"Title"}`, "", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "session.jsonl")
			if err := os.WriteFile(path, []byte(tc.data), 0o600); err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			doc, err := readDocument(sessionFile{source: tc.source, path: path, info: info}, "test")
			if err != nil {
				t.Fatal(err)
			}
			var want int64
			if tc.want != "" {
				parsed, err := time.Parse(time.RFC3339, tc.want)
				if err != nil {
					t.Fatal(err)
				}
				want = parsed.UnixMilli()
			}
			if doc.Session.UpdatedAtMS != want || len(doc.Records) != tc.count {
				t.Fatalf("updated=%d records=%d; want updated=%d records=%d", doc.Session.UpdatedAtMS, len(doc.Records), want, tc.count)
			}
		})
	}
}

func TestSyncCorrectsExistingUpdateTime(t *testing.T) {
	var requests []Update
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		var input Update
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
		}
		requests = append(requests, input)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "state.json")
	state, err := LoadState(path, "scope")
	if err != nil {
		t.Fatal(err)
	}
	text := "answer"
	doc := Document{Session: Session{Device: "mac", Source: sourceCodex, SourceID: "existing", UpdatedAtMS: 2000}, Records: []Record{{Line: 1, Role: "assistant", Text: &text}}}
	checkpoint(state, Update(doc))
	if err := state.Save(path); err != nil {
		t.Fatal(err)
	}
	doc.Session.UpdatedAtMS = 1000
	stats, err := Sync(context.Background(), client, []Document{doc}, state, path, "mac", false, false)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Changed != 1 || len(requests) != 1 || requests[0].Session != doc.Session || len(requests[0].Records) != 0 {
		t.Fatalf("expected metadata-only correction: stats=%+v requests=%+v", stats, requests)
	}
	state, err = LoadState(path, "scope")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Sync(context.Background(), client, []Document{doc}, state, path, "mac", false, false); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 1 {
		t.Fatal("corrected timestamp was uploaded again")
	}
}
