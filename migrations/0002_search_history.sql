CREATE TABLE search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  query TEXT NOT NULL,
  UNIQUE(email, query)
);
CREATE INDEX search_history_recent ON search_history(email, id DESC);
