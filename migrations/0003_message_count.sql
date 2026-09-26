ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0 CHECK(message_count >= 0);

UPDATE sessions SET message_count = (
  SELECT count(*) FROM records WHERE records.session_id = sessions.id
);

CREATE TRIGGER records_count_ai AFTER INSERT ON records BEGIN
  UPDATE sessions SET message_count = message_count + 1 WHERE id = new.session_id;
END;

CREATE TRIGGER records_count_ad AFTER DELETE ON records BEGIN
  UPDATE sessions SET message_count = message_count - 1 WHERE id = old.session_id;
END;
