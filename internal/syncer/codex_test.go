package syncer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

func TestCodexCompressedSessions(t *testing.T) {
	const id = "019e992e-38ca-7a92-8dc6-45f54a2bad8d"
	const data = `{"type":"session_meta","payload":{"cwd":"/projects/demo"}}
{"timestamp":"2026-06-06T04:06:43Z","type":"response_item","payload":{"role":"user","content":"hello 日本語"}}
{"type":"event_msg","payload":{"type":"token_count"}}
{"timestamp":"2026-06-06T04:07:00Z","type":"response_item","payload":{"role":"assistant","content":"answer"}}`
	encoder, err := zstd.NewWriter(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = encoder.Close() }()
	compressed := encoder.EncodeAll([]byte(data), nil)
	for _, dir := range []string{"sessions/2026/06/06", "archived_sessions"} {
		for _, suffix := range []string{".jsonl.zst", ".JSONL.ZST"} {
			t.Run(dir+suffix, func(t *testing.T) {
				root := t.TempDir()
				sessionDir := filepath.Join(root, dir)
				if err := os.MkdirAll(sessionDir, 0o700); err != nil {
					t.Fatal(err)
				}
				index := `{"id":"` + id + `","thread_name":"Session title"}`
				if err := os.WriteFile(filepath.Join(root, "session_index.jsonl"), []byte(index), 0o600); err != nil {
					t.Fatal(err)
				}
				plain := filepath.Join(sessionDir, "rollout-2026-06-06T04-06-43-"+id+".jsonl")
				if err := os.WriteFile(plain, []byte(data), 0o600); err != nil {
					t.Fatal(err)
				}
				want, err := ReadDocuments(root, "", "test")
				if err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(plain); err != nil {
					t.Fatal(err)
				}
				path := strings.TrimSuffix(plain, ".jsonl") + suffix
				if err := os.WriteFile(path, compressed, 0o600); err != nil {
					t.Fatal(err)
				}
				got, err := ReadDocuments(root, "", "test")
				if err != nil {
					t.Fatal(err)
				}
				want[0].Session.Path = path
				if !reflect.DeepEqual(got, want) || len(got[0].Records) != 2 || got[0].Session.SourceID != id {
					t.Fatalf("got %+v; want %+v", got, want)
				}
			})
		}
	}
}

func TestCodexCompressedSessionErrors(t *testing.T) {
	encoder, err := zstd.NewWriter(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = encoder.Close() }()
	valid := encoder.EncodeAll([]byte(`{"type":"response_item","payload":{"role":"user","content":"hello"}}`+"\n"), nil)
	corrupt := append([]byte(nil), valid...)
	corrupt[len(corrupt)-1] ^= 0xff
	for name, data := range map[string][]byte{
		"invalid header": []byte("not zstd"),
		"truncated":      valid[:len(valid)-1],
		"bad checksum":   corrupt,
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, "sessions")
			if err := os.Mkdir(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "session.jsonl.zst")
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := ReadDocuments(root, "", "test"); err == nil || !strings.Contains(err.Error(), path) {
				t.Fatalf("expected error containing path; got %v", err)
			}
		})
	}
}

func TestCompressedSessionFallbackID(t *testing.T) {
	plain := "/sessions/session.jsonl"
	if sessionIDFromPath(plain) != sessionIDFromPath(plain+".zst") {
		t.Fatal("compression changed session identity")
	}
}

func TestCodexOpenPageContext(t *testing.T) {
	const context = `<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>`
	for _, tc := range []struct {
		name  string
		texts []string
		kinds []string
		want  string
	}{
		{"metadata", []string{context}, []string{"additional_content.codex_apps_open_page"}, ""},
		{"mixed content", []string{context, "question"}, []string{"additional_content.codex_apps_open_page", "user"}, "question"},
		{"legacy", []string{context}, nil, ""},
		{"legacy page ID", []string{`<external_codex_apps_open_page>{"page_id":"page-123"}</external_codex_apps_open_page>`}, nil, ""},
		{"legacy mixed content", []string{context, "question"}, nil, "question"},
		{"mismatched metadata", []string{context, "question"}, []string{"user"}, "question"},
		{"explicit user content", []string{context}, []string{"user"}, context},
		{"discussion", []string{"Please exclude " + context}, nil, "Please exclude " + context},
		{"following conversation", []string{context + "\nquestion"}, nil, context + "\nquestion"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			content := make([]map[string]string, 0, len(tc.texts))
			for _, text := range tc.texts {
				content = append(content, map[string]string{"type": "input_text", "text": text})
			}
			payload := map[string]any{"role": "user", "content": content}
			if tc.kinds != nil {
				payload["internal_chat_message_metadata_passthrough"] = map[string]any{"content_item_kinds": tc.kinds}
			}
			line, err := json.Marshal(map[string]any{"type": "response_item", "payload": payload})
			if err != nil {
				t.Fatal(err)
			}
			got := extractCodexJSONLine(line)
			if got.text != tc.want {
				t.Fatalf("text=%q; want %q", got.text, tc.want)
			}
		})
	}
}
