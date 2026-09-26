CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  device TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  path TEXT NOT NULL,
  archived INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(device, source, source_id)
);
CREATE INDEX sessions_updated ON sessions(updated_at_ms DESC, id DESC);
CREATE TABLE records (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  line INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  UNIQUE(session_id, line)
);
CREATE VIRTUAL TABLE records_fts USING fts5(text, content='records', content_rowid='id', tokenize='trigram');
CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(rowid,text) VALUES(new.id,new.text);
END;
CREATE TRIGGER records_ad AFTER DELETE ON records BEGIN
  INSERT INTO records_fts(records_fts,rowid,text) VALUES('delete',old.id,old.text);
END;
CREATE TRIGGER records_au AFTER UPDATE ON records BEGIN
  INSERT INTO records_fts(records_fts,rowid,text) VALUES('delete',old.id,old.text);
  INSERT INTO records_fts(rowid,text) VALUES(new.id,new.text);
END;
