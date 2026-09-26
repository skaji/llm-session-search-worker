export interface Env {
  DB: D1Database;
  ALLOWED_EMAIL: string;
}
export interface Session {
  id?: number;
  device: string;
  source: string;
  source_id: string;
  title: string;
  cwd: string;
  path: string;
  archived: number;
  updated_at_ms: number;
}
export interface RecordDelta {
  line: number;
  role: string;
  text: string | null;
}
export interface Update {
  session: Session;
  records: RecordDelta[];
}
export interface Hit extends Session {
  id: number;
  line: number;
  snippet: string;
}
export class HTTPError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const MAX_BODY = 128 * 1024;
export const MAX_RECORDS = 40;
