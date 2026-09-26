import {
  HTTPError,
  MAX_BODY,
  MAX_RECORDS,
  type Update,
  type Hit,
  type StoredSession,
} from "./types";
export async function readUpdate(request: Request): Promise<Update> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new HTTPError(415, "Use application/json");
  const reader = request.body?.getReader();
  if (!reader) throw new HTTPError(400, "Missing body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY) {
      await reader.cancel();
      throw new HTTPError(413, "Maximum body size is 128 KiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let input: Update;
  try {
    input = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HTTPError(400, "Invalid JSON");
  }
  const s = input?.session;
  const validString = (v: unknown, max: number): v is string =>
    typeof v === "string" && v.length <= max;
  const validID = (v: unknown) =>
    validString(v, 128) && /^[a-zA-Z0-9_.-]+$/.test(v);
  if (
    !s ||
    !validID(s.device) ||
    !validID(s.source_id) ||
    !["codex", "claude"].includes(s.source) ||
    !validString(s.title, 4096) ||
    !validString(s.cwd, 4096) ||
    !validString(s.path, 4096) ||
    ![0, 1].includes(s.archived) ||
    !Number.isSafeInteger(s.updated_at_ms) ||
    s.updated_at_ms < 0 ||
    s.updated_at_ms > 8640000000000000 ||
    !Array.isArray(input.records) ||
    input.records.length > MAX_RECORDS
  )
    throw new HTTPError(400, "Invalid session or batch");
  const lines = new Set<number>();
  for (const r of input.records) {
    if (
      !r ||
      !Number.isSafeInteger(r.line) ||
      r.line < 1 ||
      lines.has(r.line) ||
      !["user", "assistant"].includes(r.role) ||
      !(
        r.text === null ||
        (validString(r.text, 20 * 1024) &&
          new TextEncoder().encode(r.text).length <= 20 * 1024)
      )
    )
      throw new HTTPError(400, "Invalid record");
    lines.add(r.line);
  }
  return input;
}
export async function update(db: D1Database, input: Update) {
  const s = input.session;
  const select =
    "(SELECT id FROM sessions WHERE device=? AND source=? AND source_id=?)";
  const identity = [s.device, s.source, s.source_id];
  const statements = [
    db
      .prepare(
        `INSERT INTO sessions(device,source,source_id,title,cwd,path,archived,updated_at_ms)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(device,source,source_id) DO UPDATE SET
    title=excluded.title,cwd=excluded.cwd,path=excluded.path,archived=excluded.archived,updated_at_ms=excluded.updated_at_ms
    WHERE sessions.title IS NOT excluded.title OR sessions.cwd IS NOT excluded.cwd OR sessions.path IS NOT excluded.path
      OR sessions.archived IS NOT excluded.archived OR sessions.updated_at_ms IS NOT excluded.updated_at_ms`,
      )
      .bind(...identity, s.title, s.cwd, s.path, s.archived, s.updated_at_ms),
  ];
  for (const r of input.records)
    statements.push(
      r.text === null
        ? db
            .prepare(
              `DELETE FROM records WHERE session_id=${select} AND line=?`,
            )
            .bind(...identity, r.line)
        : db
            .prepare(
              `INSERT INTO records(session_id,line,role,text) VALUES(${select},?,?,?)
        ON CONFLICT(session_id,line) DO UPDATE SET role=excluded.role,text=excluded.text
        WHERE records.role IS NOT excluded.role OR records.text IS NOT excluded.text`,
            )
            .bind(...identity, r.line, r.role, r.text),
    );
  const results = await db.batch(statements);
  return {
    rows_read: results.reduce((n, r) => n + r.meta.rows_read, 0),
    rows_written: results.reduce((n, r) => n + r.meta.rows_written, 0),
  };
}
export function parseQuery(q: string): string[] {
  if (q.length > 512) throw new HTTPError(400, "Query is too long");
  const terms = [...q.matchAll(/"([^"]*)"|([^\s"]+)/gu)]
    .map((m) => (m[1] ?? m[2]).trim())
    .filter(Boolean);
  if (terms.length > 5 || terms.some((t) => t.length > 100))
    throw new HTTPError(400, "Use at most 5 terms, up to 100 characters each");
  return terms;
}
export function numberParam(
  url: URL,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new HTTPError(400, `Invalid ${name}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n > max)
    throw new HTTPError(400, `Invalid ${name}`);
  return n;
}
export async function search(db: D1Database, url: URL) {
  const terms = parseQuery(url.searchParams.get("q") ?? "");
  const offset = numberParam(url, "offset", 0, 1000000);
  const args: (string | number)[] = [];
  const hits = terms.map((term, i) => {
    if ([...term].length >= 3) {
      args.push(`"${term.replaceAll('"', '""')}"`);
      return `SELECT r.session_id,r.line,${i} term FROM records_fts JOIN records r ON r.id=records_fts.rowid WHERE records_fts MATCH ?`;
    }
    args.push(term);
    return `SELECT session_id,line,${i} term FROM records WHERE instr(lower(text),lower(?))>0`;
  });
  const scope: string[] = [];
  const device = url.searchParams.get("device") ?? "";
  const cwd = (url.searchParams.get("cwd") ?? "").replace(/\/$/, "");
  if (device.length > 128 || cwd.length > 4096)
    throw new HTTPError(400, "Filter is too long");
  if (device) {
    scope.push("s.device=?");
    args.push(device);
  }
  if (cwd) {
    scope.push("(s.cwd=? OR substr(s.cwd,1,length(?)+1)=?||'/')");
    args.push(cwd, cwd, cwd);
  }
  const cte = terms.length
    ? `WITH hits AS (${hits.join(" UNION ALL ")}), matched AS
    (SELECT session_id,max(line) line FROM hits GROUP BY session_id HAVING count(DISTINCT term)=${terms.length})`
    : "";
  // Read a bounded excerpt in SQL; large message bodies stay in D1 during search.
  const query = `${cte} SELECT s.*,${terms.length ? "m.line" : "0"} line,
    ${terms.length ? "substr(r.text,max(1,instr(lower(r.text),lower(?))-80),240)" : "''"} snippet
    FROM sessions s ${terms.length ? "JOIN matched m ON m.session_id=s.id JOIN records r ON r.session_id=s.id AND r.line=m.line" : ""}
    ${scope.length ? "WHERE " + scope.join(" AND ") : ""} ORDER BY s.updated_at_ms DESC,s.id DESC LIMIT 21 OFFSET ?`;
  // The excerpt placeholder appears before the WHERE filters, after the CTE.
  if (terms.length) args.splice(terms.length, 0, terms.at(-1)!);
  args.push(offset);
  const rows = (
    await db
      .prepare(query)
      .bind(...args)
      .all<Hit>()
  ).results;
  return {
    results: rows.slice(0, 20),
    next_offset: rows.length > 20 ? offset + 20 : null,
  };
}
export async function detail(db: D1Database, id: number, after: number) {
  const session = await db
    .prepare("SELECT * FROM sessions WHERE id=?")
    .bind(id)
    .first<StoredSession>();
  if (!session) throw new HTTPError(404, "Session not found");
  const rows = (
    await db
      .prepare(
        "SELECT line,role,text FROM records WHERE session_id=? AND line>? ORDER BY line LIMIT 21",
      )
      .bind(id, after)
      .all<{ line: number; role: string; text: string }>()
  ).results;
  return {
    session,
    records: rows.slice(0, 20),
    next_after: rows.length > 20 ? rows[19].line : null,
  };
}
