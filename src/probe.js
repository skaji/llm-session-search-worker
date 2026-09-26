// Disposable D1 binding probe. Never upload real transcripts to this API.
const MAX_BYTES = 128 * 1024;
const MAX_RECORDS = 40;
const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
function metrics(results) {
  return results.reduce((sum, { meta }) => ({
    statements: sum.statements + 1,
    rows_read: sum.rows_read + meta.rows_read,
    rows_written: sum.rows_written + meta.rows_written,
    sql_ms: sum.sql_ms + meta.duration,
  }), { statements: 0, rows_read: 0, rows_written: 0, sql_ms: 0 });
}
async function body(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing JSON');
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BYTES) { await reader.cancel(); throw new Error('Payload exceeds 128 KiB'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export default {
  async fetch(request, env) {
    if (!env.PROBE_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.PROBE_TOKEN}`) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const url = new URL(request.url);
    const db = env.DB;
    if (request.method === 'POST' && url.pathname === '/update') {
      let input;
      try {
        input = await body(request);
        if (!input || !validId(input.device) || !validId(input.session) || !Array.isArray(input.records) || input.records.length > MAX_RECORDS) throw new Error('Invalid batch');
        const lines = new Set();
        for (const record of input.records) {
          if (!record || !Number.isSafeInteger(record.line) || record.line < 1 || lines.has(record.line) || !(record.text === null || typeof record.text === 'string')) throw new Error('Invalid or duplicate record');
          lines.add(record.line);
        }
      } catch (error) { return json({ error: error.message }, 400); }
      // Namespacing preserves the existing experiment schema and device isolation.
      const source = `probe:${input.device}`;
      const id = input.session;
      const statements = [db.prepare(`INSERT INTO sessions(source,source_id,path,archived,size,mtime_ns,scan_generation)
        VALUES (?,?,'',0,0,0,'probe') ON CONFLICT(source,source_id) DO NOTHING`).bind(source, id)];
      for (const record of input.records) {
        statements.push(record.text === null
          ? db.prepare(`DELETE FROM records WHERE session_key=(SELECT key FROM sessions WHERE source=? AND source_id=?) AND line_number=?`).bind(source, id, record.line)
          : db.prepare(`INSERT INTO records(session_key,line_number,text)
            VALUES ((SELECT key FROM sessions WHERE source=? AND source_id=?),?,?)
            ON CONFLICT(session_key,line_number) DO UPDATE SET text=excluded.text
            WHERE records.text IS NOT excluded.text`).bind(source, id, record.line, record.text));
      }
      const results = await db.batch(statements);
      return json({ metrics: metrics(results) });
    }
    if (request.method === 'GET' && url.pathname === '/search') {
      const terms = url.searchParams.getAll('term');
      if (!terms.length || terms.length > 5 || terms.some(t => !t.trim() || t.length > 100)) return json({ error: 'Supply 1–5 nonempty terms of at most 100 characters' }, 400);
      const args = [];
      const hits = terms.map((term, index) => {
        if ([...term].length >= 3) {
          args.push(`"${term.replaceAll('"', '""')}"`);
          return `SELECT r.session_key, ${index} term FROM records_fts JOIN records r ON r.id=records_fts.rowid WHERE records_fts MATCH ?`;
        }
        args.push(term);
        return `SELECT session_key, ${index} term FROM records WHERE instr(lower(text),lower(?))>0`;
      });
      const result = await db.prepare(`WITH hits AS (${hits.join(' UNION ALL ')})
        SELECT s.key,s.source,s.source_id FROM hits JOIN sessions s ON s.key=hits.session_key
        GROUP BY s.key HAVING count(DISTINCT term)=? ORDER BY s.key DESC LIMIT 20`).bind(...args, terms.length).all();
      return json({ results: result.results, metrics: metrics([result]) });
    }
    if (request.method === 'POST' && url.pathname === '/rollback') {
      // First statement updates FTS via a trigger; the second deliberately fails.
      const before = await db.prepare("SELECT id,text FROM records WHERE session_key IN (SELECT key FROM sessions WHERE source LIKE 'probe:%') ORDER BY id LIMIT 1").first();
      if (!before) return json({ error: 'Seed a probe record first' }, 409);
      let failed = false;
      try {
        await db.batch([
          db.prepare('UPDATE records SET text=? WHERE id=?').bind('rollbackuniquemarker', before.id),
          db.prepare('INSERT INTO records(session_key,line_number,text) VALUES(NULL,1,?)').bind('invalid'),
        ]);
      } catch { failed = true; }
      const after = await db.prepare('SELECT text FROM records WHERE id=?').bind(before.id).first();
      const fts = await db.prepare("SELECT count(*) n FROM records_fts WHERE records_fts MATCH 'rollbackuniquemarker'").first();
      const passed = failed && after.text === before.text && fts.n === 0;
      return json({ passed }, passed ? 200 : 500);
    }
    return json({ error: 'Not found' }, 404);
  },
};
