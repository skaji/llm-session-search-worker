-- Only synthetic data is used. This dedicated playground database is disposable.
DELETE FROM sessions;
INSERT INTO sessions(key,source,source_id,path,archived,title,cwd,size,mtime_ns,scan_generation)
VALUES (1,'codex','fixture-a','/fixture/a',0,'A','/projects/demo',0,0,'test'),
       (2,'codex','fixture-b','/fixture/b',0,'B','/projects/demo/sub',0,0,'test'),
       (3,'claude','fixture-c','/fixture/c',0,'C','/projects/other',0,0,'test');
INSERT INTO records(id,session_key,line_number,role,text) VALUES
 (1,1,1,'user','Cloudflare Workers support 日本語検索 and Go.'),
 (2,1,2,'assistant','GitHub Actions deploys this application.'),
 (3,2,1,'user','Cloudflare alone is not enough.'),
 (4,3,1,'user','GitHub Actions alone is not enough.');
SELECT 'trigram substring' AS test, count(*) = 2 AS passed FROM records_fts WHERE records_fts MATCH '"loudf"';
SELECT 'Japanese trigram' AS test, count(*) = 1 AS passed FROM records_fts WHERE records_fts MATCH '"日本語"';
SELECT 'phrase' AS test, count(*) = 2 AS passed FROM records_fts WHERE records_fts MATCH '"github actions"';
SELECT 'short term fallback' AS test, count(*) = 1 AS passed FROM records WHERE instr(lower(text),lower('Go')) > 0;
SELECT 'Japanese short term fallback' AS test, count(*) = 1 AS passed FROM records WHERE instr(text,'検索') > 0;
WITH term_hits(term_number,session_key,line_number) AS (
 SELECT 0,r.session_key,r.line_number FROM records_fts JOIN records r ON r.id=records_fts.rowid WHERE records_fts MATCH '"cloudflare"'
 UNION ALL
 SELECT 1,r.session_key,r.line_number FROM records_fts JOIN records r ON r.id=records_fts.rowid WHERE records_fts MATCH '"github actions"'
), matches AS (
 SELECT session_key,max(line_number) AS line_number,count(DISTINCT line_number) AS match_count
 FROM term_hits GROUP BY session_key HAVING count(DISTINCT term_number)=2
)
SELECT 'session-level AND across messages' AS test,
 count(*)=1 AND min(s.key)=1 AND min(matches.match_count)=2 AS passed
FROM matches JOIN sessions s ON s.key=matches.session_key
JOIN records r ON r.session_key=s.key AND r.line_number=matches.line_number
WHERE s.cwd='/projects/demo' OR substr(s.cwd,1,length('/projects/demo/'))='/projects/demo/';
UPDATE records SET text='Replacement marker' WHERE id=1;
SELECT 'update removes old posting' AS test, count(*)=0 AS passed FROM records_fts WHERE records_fts MATCH '"日本語"';
SELECT 'update adds new posting' AS test, count(*)=1 AS passed FROM records_fts WHERE records_fts MATCH '"replacement"';
INSERT INTO records(session_key,line_number,role,text) VALUES(1,2,'assistant','New append marker')
ON CONFLICT(session_key,line_number) DO UPDATE SET text=excluded.text WHERE records.text<>excluded.text;
INSERT INTO records(session_key,line_number,role,text) VALUES(1,2,'assistant','New append marker')
ON CONFLICT(session_key,line_number) DO UPDATE SET text=excluded.text WHERE records.text<>excluded.text;
SELECT 'idempotent upsert' AS test, count(*)=1 AS passed FROM records_fts WHERE records_fts MATCH '"append marker"';
DELETE FROM records WHERE id=3;
SELECT 'delete removes posting' AS test, count(*)=0 AS passed FROM records_fts WHERE records_fts MATCH '"cloudflare"';
DELETE FROM sessions WHERE key=1;
SELECT 'cascade deletes records' AS test, count(*)=0 AS passed FROM records WHERE session_key=1;
SELECT 'cascade removes postings' AS test, count(*)=0 AS passed FROM records_fts WHERE records_fts MATCH '"replacement" OR "append marker"';
INSERT INTO records_fts(records_fts,rank) VALUES('integrity-check',1);
SELECT 'FTS integrity check completed' AS test, 1 AS passed;
