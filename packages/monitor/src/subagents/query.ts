import { MonitorQuery } from '../query.ts';
import { MonitorError } from '../errors.ts';

export class AgentQuery {
  query: MonitorQuery;
  constructor(database: string) { this.query = new MonitorQuery(database); }
  summary() {
    return this.query.read(db => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_scan'").get()) return { scan: null, children: 0, events: 0, coverage: 'not-connected' };
      const scan = db.prepare('SELECT scanned_at,status,files,parsed,errors,pending,discovery_errors FROM agent_scan WHERE id=1').get() ?? null;
      const children = Number(db.prepare('SELECT count(*) n FROM agent_sessions s JOIN agent_files f ON s.file_key=f.file_key AND s.generation=f.generation WHERE is_child=1').get()!.n);
      const events = Number(db.prepare('SELECT count(*) n FROM agent_events').get()!.n);
      const issues = db.prepare("SELECT status,count(*) AS count FROM agent_files WHERE status NOT IN ('parsed','pending-tail') GROUP BY status ORDER BY status").all();
      return { scan, children, events, issues, coverage: 'persisted-v4-selected-events', attribution: 'unknown-collaboration' };
    });
  }
  sessions(q: string, before: number | null, limit: number) {
    if (q.length > 200 || /[\x00-\x1f]/.test(q)) throw new MonitorError('INVALID_FILTER');
    return this.query.read(db => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE name='agent_sessions'").get()) return { items: [], total: 0, nextBefore: null };
      const where = "s.is_child=1 AND instr(lower(s.session_id||' '||COALESCE(s.parent_id,'')||' '||COALESCE(json_extract(s.state,'$.label'),'')),lower(?))>0";
      const total = Number(db.prepare(`SELECT count(*) n FROM agent_sessions s WHERE ${where}`).get(q)!.n);
      const rows = db.prepare(`SELECT s.rowid AS key,s.file_key,s.generation,s.state,f.status AS file_status,f.scanned_at,CASE WHEN s.generation=f.generation THEN 1 ELSE 0 END AS current FROM agent_sessions s JOIN agent_files f ON s.file_key=f.file_key WHERE ${where} AND (? IS NULL OR s.rowid<?) ORDER BY s.rowid DESC LIMIT ?`).all(q, before, before, limit + 1);
      const items = rows.slice(0, limit).map(r => ({ key: Number(r.key), fileKey: r.file_key, generation: r.generation, current: !!r.current, fileStatus: r.file_status, scannedAt: r.scanned_at, state: JSON.parse(String(r.state)) }));
      return { items, total, nextBefore: rows.length > limit ? items.at(-1)!.key : null };
    });
  }
  events(file: string, generation: number, before: number | null, limit: number) {
    if (!/^[0-9a-f]{64}$/.test(file) || !Number.isSafeInteger(generation) || generation < 1) throw new MonitorError('INVALID_FILTER');
    return this.query.read(db => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE name='agent_sessions'").get()) throw new MonitorError('NOT_FOUND');
      const session = db.prepare('SELECT state FROM agent_sessions WHERE file_key=? AND generation=? AND is_child=1').get(file, generation);
      if (!session) throw new MonitorError('NOT_FOUND');
      const state = JSON.parse(String(session.state));
      const source = db.prepare('SELECT generation,status,scanned_at FROM agent_files WHERE file_key=?').get(file);
      if (!source) throw new MonitorError('NOT_FOUND');
      // A parent's persisted receipt proves reception; child outputs alone do not.
      // Query only current parent generations; old-generation receipts remain in stored history.
      const current = source.generation === generation;
      const where = `(e.file_key=? AND e.generation=?) OR (?=1 AND e.sender_id=? AND e.recipient_id=? AND e.kind IN ('received','settlement-notice') AND EXISTS(SELECT 1 FROM agent_files f WHERE f.file_key=e.file_key AND f.generation=e.generation))`;
      const values = [file, generation, current ? 1 : 0, state.id, state.parent_id];
      if (before !== null && !db.prepare(`SELECT 1 FROM agent_events e WHERE e.id=? AND (${where})`).get(before, ...values)) throw new MonitorError('AGENT_CURSOR_INVALID');
      const rows = db.prepare(`SELECT e.id,e.payload,s.session_id AS logged_in FROM agent_events e JOIN agent_sessions s ON s.file_key=e.file_key AND s.generation=e.generation WHERE (${where}) AND (? IS NULL OR (e.at,e.id)<(SELECT at,id FROM agent_events WHERE id=?)) ORDER BY e.at DESC,e.id DESC LIMIT ?`).all(...values, before, before, limit + 1);
      return { state, source: { current, status: source.status, scannedAt: source.scanned_at }, items: rows.slice(0, limit).map(r => ({ key: Number(r.id), loggedIn: String(r.logged_in), ...JSON.parse(String(r.payload)) })), nextBefore: rows.length > limit ? Number(rows[limit - 1]!.id) : null };
    });
  }
}
