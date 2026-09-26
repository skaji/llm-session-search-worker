-- Adapted from llm-session-search/internal/search/store.go.


CREATE TABLE IF NOT EXISTS search_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS sessions (
    key INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    path TEXT NOT NULL,
    archived INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL DEFAULT '',
    started_at_ms INTEGER,
    updated_at_ms INTEGER,
    size INTEGER NOT NULL,
    mtime_ns INTEGER NOT NULL,
    line_count INTEGER NOT NULL DEFAULT 0,
    scan_generation TEXT NOT NULL,
    UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS sessions_updated_at_idx
    ON sessions(updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS records (
	id INTEGER PRIMARY KEY,
	session_key INTEGER NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
	line_number INTEGER NOT NULL,
	timestamp_ms INTEGER,
	role TEXT NOT NULL DEFAULT '',
	phase TEXT NOT NULL DEFAULT '',
	text TEXT NOT NULL,
    UNIQUE(session_key, line_number)
);

CREATE INDEX IF NOT EXISTS records_session_idx
    ON records(session_key, line_number);

CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
    text,
    content='records',
    content_rowid='id',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
    INSERT INTO records_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
    INSERT INTO records_fts(records_fts, rowid, text)
        VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
    INSERT INTO records_fts(records_fts, rowid, text)
        VALUES ('delete', old.id, old.text);
    INSERT INTO records_fts(rowid, text) VALUES (new.id, new.text);
END;
