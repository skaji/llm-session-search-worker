package syncer

import (
	session "github.com/skaji/llm-session-internal"
)

func discoverCodexSessionFiles(home string) ([]sessionFile, bool, error) {
	return discoverFiles(session.Codex, home)
}

func discoverClaudeSessionFiles(home string) ([]sessionFile, bool, error) {
	return discoverFiles(session.Claude, home)
}

func discoverFiles(source, home string) ([]sessionFile, bool, error) {
	files, found, err := session.Discover(source, home)
	out := make([]sessionFile, 0, len(files))
	for _, f := range files {
		out = append(out, sessionFile{source: f.Source, path: f.Path, id: f.ID, title: f.Title, archived: f.Archived, titleKnown: f.TitleKnown, info: f.Info})
	}
	return out, found, err
}

func extractCodexJSONLine(line []byte) extractedLine { return extractSessionLine(sourceCodex, line) }

func extractClaudeJSONLine(line []byte) extractedLine { return extractSessionLine(sourceClaude, line) }
