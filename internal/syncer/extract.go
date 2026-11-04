package syncer

import (
	"time"
	"unicode/utf8"

	session "github.com/skaji/llm-session-internal"
)

const (
	maxIndexedStringBytes = 16 * 1024
	sourceCodex           = "codex"
	sourceClaude          = "claude"
)

type extractedLine struct {
	text, role, phase, cwd, title string
	timestamps                    []time.Time
	forceTitle                    bool
}

func extractSessionLine(source string, line []byte) extractedLine {
	e := session.Extract(source, line)
	return extractedLine{text: limitString(e.Text), role: e.Role, phase: e.Phase, cwd: e.CWD, title: e.Title, timestamps: e.Timestamps, forceTitle: e.ForceTitle}
}

func limitString(value string) string {
	if len(value) <= maxIndexedStringBytes {
		return value
	}
	half := maxIndexedStringBytes / 2
	prefixEnd := half
	for prefixEnd > 0 && !utf8.RuneStart(value[prefixEnd]) {
		prefixEnd--
	}
	suffixStart := len(value) - half
	for suffixStart < len(value) && !utf8.RuneStart(value[suffixStart]) {
		suffixStart++
	}
	return value[:prefixEnd] + "\n…[truncated]…\n" + value[suffixStart:]
}
