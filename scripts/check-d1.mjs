import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const mode = process.argv[2];
if (!['--local', '--remote'].includes(mode)) throw new Error('Specify --local or --remote');
const report = [];
function execute(label, args) {
  const raw = execFileSync('node_modules/.bin/wrangler', [
    'd1', 'execute', 'DB', '--config', 'wrangler.probe.jsonc', mode, '--json', ...(args[0] === '--command' ? [`--command=${args[1]}`] : args),
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // Remote file import prints progress before JSON, even with --json.
  const starts = [...raw.matchAll(/^[\[{]/gm)].map((match) => match.index);
  let results;
  for (const start of starts) {
    try { results = JSON.parse(raw.slice(start)); break; } catch {}
  }
  if (!Array.isArray(results)) throw new Error(`Unexpected Wrangler output: ${raw}`);
  for (const result of results) {
    if (result.success === false) throw new Error(JSON.stringify(result));
    for (const row of result.results ?? []) {
      if ('passed' in row) {
        console.log(`${row.passed === 1 ? 'PASS' : 'FAIL'} ${row.test}`);
        if (row.passed !== 1) throw new Error(`Failed: ${row.test}`);
      }
    }
  }
  report.push({ label, results });
  mkdirSync('results', { recursive: true });
  writeFileSync(`results/${mode.slice(2)}.json`, JSON.stringify(report, null, 2) + '\n');
  return results;
}
execute('schema', ['--command', readFileSync('sql/schema.sql', 'utf8')]);
const smoke = execute('smoke', ['--command', readFileSync('sql/smoke.sql', 'utf8')]);
if (smoke.flatMap((result) => result.results ?? []).filter((row) => 'passed' in row).length !== 13) {
  throw new Error('Expected all 13 smoke assertions to be returned');
}
mkdirSync('results', { recursive: true });
writeFileSync(`results/${mode.slice(2)}.json`, JSON.stringify(report, null, 2) + '\n');


// A small reproducible workload, not an estimate of real transcript distribution.
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const sql = ['DELETE FROM sessions;'];
for (let session = 1; session <= 20; session++) {
  sql.push(`INSERT INTO sessions(key,source,source_id,path,archived,cwd,size,mtime_ns,scan_generation)
    VALUES(${session},'codex','bench-${session}','/fixture/${session}',0,'/projects/demo',0,0,'bench');`);
}
for (let start = 0; start < 1000; start += 20) {
  const rows = [];
  for (let i = start; i < start + 20; i++) {
    const text = `Message ${i}: reviewing implementation ${i * 7919}. ` +
      'We discussed database migrations, incremental synchronization, retries, and search results. '.repeat(4) +
      (i % 10 === 0 ? '日本語検索と更新の検証。 ' : '') +
      (i % 100 === 0 ? 'rare-marker GitHub Actions' : 'ordinary message');
    rows.push(`(${Math.floor(i / 50) + 1},${i % 50 + 1},'user',${quote(text)})`);
  }
  sql.push(`INSERT INTO records(session_key,line_number,role,text) VALUES ${rows.join(',')};`);
}
mkdirSync('.wrangler', { recursive: true });
writeFileSync('.wrangler/benchmark.sql', sql.join('\n'));
execute('seed-1000', ['--file', '.wrangler/benchmark.sql']);
for (const [label, query] of [
  ['trigram-rare', `SELECT count(*) AS count FROM records_fts WHERE records_fts MATCH '"rare-marker"'`],
  ['trigram-common', `SELECT count(*) AS count FROM records_fts WHERE records_fts MATCH '"database"'`],
  ['trigram-japanese', `SELECT count(*) AS count FROM records_fts WHERE records_fts MATCH '"日本語"'`],
  ['short-scan', `SELECT count(*) AS count FROM records WHERE instr(lower(text),lower('更新'))>0`],
  ['unchanged-upsert', `INSERT INTO records(session_key,line_number,role,text) SELECT session_key,line_number,role,text FROM records WHERE id=(SELECT min(id) FROM records) ON CONFLICT(session_key,line_number) DO UPDATE SET text=excluded.text WHERE records.text<>excluded.text`],
  ['session-search', `WITH term_hits(term_number,session_key,line_number) AS (
    SELECT 0,r.session_key,r.line_number FROM records_fts JOIN records r ON r.id=records_fts.rowid WHERE records_fts MATCH '"database"'
    UNION ALL
    SELECT 1,r.session_key,r.line_number FROM records_fts JOIN records r ON r.id=records_fts.rowid WHERE records_fts MATCH '"rare-marker"'
  ), matches AS (
    SELECT session_key,max(line_number) AS line_number,count(DISTINCT line_number) AS match_count
    FROM term_hits GROUP BY session_key HAVING count(DISTINCT term_number)=2
  ) SELECT s.source_id,r.text,matches.match_count FROM matches
    JOIN records r ON r.session_key=matches.session_key AND r.line_number=matches.line_number
    JOIN sessions s ON s.key=r.session_key
    WHERE s.cwd='/projects/demo' OR substr(s.cwd,1,length('/projects/demo/'))='/projects/demo/'
    ORDER BY coalesce(s.updated_at_ms,0) DESC,coalesce(r.timestamp_ms,0) DESC LIMIT 20 OFFSET 0`],
  ['append-one', `INSERT INTO records(session_key,line_number,role,text) VALUES(1,51,'assistant','New incremental upload with 日本語検索 and database markers')`],
  ['update-one', `UPDATE records SET text='Updated incremental upload with a replacement marker' WHERE session_key=1 AND line_number=51`],
  ['delete-one', `DELETE FROM records WHERE session_key=1 AND line_number=51`],
]) {
  const result = execute(label, ['--command', query]);
  const expected = { 'trigram-rare': 10, 'trigram-common': 1000, 'trigram-japanese': 100, 'short-scan': 100 };
  if (label in expected && result[0].results[0].count !== expected[label]) throw new Error(`Wrong count: ${label}`);
  if (label === 'session-search' && result[0].results.length !== 10) throw new Error('Wrong session count');
  if (mode === '--remote' && label === 'unchanged-upsert' && result[0].meta.rows_written !== 0) throw new Error('Unchanged upsert wrote rows');
  console.log(label, JSON.stringify(result.map(({ results, meta }) => ({ resultCount: results?.length, meta }))));
}
writeFileSync(`results/${mode.slice(2)}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(`Saved results/${mode.slice(2)}.json`);
