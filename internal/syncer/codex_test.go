package syncer

import (
	"encoding/json"
	"testing"
)

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
