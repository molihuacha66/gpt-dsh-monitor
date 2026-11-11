import { DatabaseSync } from 'node:sqlite';
import { MonitorError } from './errors.ts';
import {monitorVersion} from './schema.ts';
import {storedRuntime} from './runtime/health.ts';

export type Filters = { collab: string; includeTests: boolean; q: string; direction: string; status: string; from: number | null; to: number | null; before: number | null; limit: number };
export type Payload = Record<string, unknown>;
export type Item = { key: string; collab: string | null; sourcePresent: boolean; data: Payload };
export type RuntimeStatus = { collecting: boolean; lastError: string | null; intervalMs: number; agentError?: string | null; useStoredRuntime?:boolean };
function integer(value: string | null, nullable = true): number | null {
  if (value === null || value === '') { if (nullable) return null; throw new MonitorError('INVALID_FILTER'); }
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) throw new MonitorError('INVALID_FILTER');
  return n;
}
export function filters(params: URLSearchParams): Filters {
  const collab = params.get('collab') ?? '__all__'; const q = params.get('q') ?? '';
  const direction = params.get('direction') ?? 'all'; const status = params.get('status') ?? 'all';
  if (collab.length > 200 || q.length > 200 || /[\x00-\x1f]/.test(collab + q)) throw new MonitorError('INVALID_FILTER');
  if (!['all', 'gpt-dsh', 'dsh-gpt', 'broadcast'].includes(direction)) throw new MonitorError('INVALID_FILTER');
  if (!['all', 'created', 'accepted', 'running', 'done', 'failed', 'rejected', 'transferred', 'cancelled'].includes(status)) throw new MonitorError('INVALID_FILTER');
  const tests = params.get('includeTests') ?? '0'; if (!['0', '1'].includes(tests)) throw new MonitorError('INVALID_FILTER');
  const from = integer(params.get('from')), to = integer(params.get('to')), before = integer(params.get('before'));
  const limit = integer(params.get('limit') ?? '30', false)!;
  if (limit < 1 || limit > 100 || (from !== null && to !== null && from > to)) throw new MonitorError('INVALID_FILTER');
  return { collab, q, direction, status, includeTests: tests === '1', from, to, before, limit };
}
function decode(row: Record<string, unknown>): Item {
  let value: unknown;
  try { value = JSON.parse(String(row.payload)); } catch { throw new MonitorError('MONITOR_DATA_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MonitorError('MONITOR_DATA_INVALID');
  return { key: String(row.row_key), collab: row.collab == null ? null : String(row.collab), sourcePresent: row.source_present === 1, data: value as Payload };
}
export class MonitorQuery {
  path: string;
  constructor(path: string) { this.path = path; }
  read<T>(fn: (db: DatabaseSync) => T): T {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.path, { readOnly: true });
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN');
      if (db.prepare("SELECT value FROM monitor_meta WHERE key='application'").get()?.value !== 'gpt-dsh-monitor-v1') throw new MonitorError('NOT_MONITOR_DATABASE');
      monitorVersion(db);
      const result = fn(db); db.exec('COMMIT'); return result;
    } catch (e) { if (e instanceof MonitorError) throw e; throw new MonitorError('MONITOR_UNAVAILABLE'); }
    finally { db?.close(); }
  }
  where(table: string, f: Filters, options: { cursor?: boolean; ignoreTests?: boolean } = {}) {
    const sql = ['table_name=?', 'source_present=1']; const values: (string | number)[] = [table];
    if (f.collab !== '__all__') {
      if (f.collab === '__unknown__') sql.push('collab IS NULL');
      else { sql.push('collab=?'); values.push(f.collab); }
    }
    if (!f.includeTests && !options.ignoreTests) sql.push("(collab IS NULL OR (collab NOT GLOB 'test-*' AND collab NOT GLOB 'mcp-*'))");
    if (f.q) {
      const fields = table === 'messages' ? ['subject','body','id','reply_to','source','sender','recipient','kind','state','collab'] : ['title','brief','result','id','parent_id','creator','assignee','state','collab'];
      const content = fields.map(key => `COALESCE(CAST(json_extract(payload,'$.${key}') AS TEXT),'')`).join("||char(10)||");
      sql.push(`instr(lower(${content}),lower(?))>0`); values.push(f.q);
    }
    if (f.from !== null) { sql.push("CAST(json_extract(payload,'$.created_at') AS INTEGER)>=?"); values.push(f.from); }
    if (f.to !== null) { sql.push("CAST(json_extract(payload,'$.created_at') AS INTEGER)<=?"); values.push(f.to); }
    if (table === 'messages' && f.direction !== 'all') {
      if (f.direction === 'broadcast') sql.push("json_extract(payload,'$.recipient')='both'");
      else {
        sql.push("json_extract(payload,'$.sender')=? AND json_extract(payload,'$.recipient')=?");
        values.push(...(f.direction === 'gpt-dsh' ? ['codex', 'dsh'] : ['dsh', 'codex']));
      }
    }
    if (table === 'tasks' && f.status !== 'all') { sql.push("json_extract(payload,'$.state')=?"); values.push(f.status); }
    if (options.cursor && f.before !== null) { sql.push('CAST(row_key AS INTEGER)<?'); values.push(f.before); }
    return { sql: sql.join(' AND '), values };
  }
  list(table: 'messages' | 'tasks', f: Filters) {
    return this.read(db => {
      const page = this.where(table, f, { cursor: true }); const all = this.where(table, f); const unhidden = this.where(table, f, { ignoreTests: true });
      const rows = db.prepare(`SELECT row_key,collab,source_present,payload FROM source_rows WHERE ${page.sql} ORDER BY CAST(row_key AS INTEGER) DESC LIMIT ?`).all(...page.values, f.limit + 1);
      const more = rows.length > f.limit; const items = rows.slice(0, f.limit).map(r => decode(r));
      const total = Number(db.prepare(`SELECT count(*) n FROM source_rows WHERE ${all.sql}`).get(...all.values)!.n);
      const withTests = Number(db.prepare(`SELECT count(*) n FROM source_rows WHERE ${unhidden.sql}`).get(...unhidden.values)!.n);
      return { items, total, hiddenTests: Math.max(0, withTests - total), nextBefore: more ? Number(items.at(-1)!.key) : null };
    });
  }
  detail(table: 'messages' | 'tasks', id: string, f: Filters) {
    if (!id || id.length > 128) throw new MonitorError('INVALID_FILTER');
    return this.read(db => {
      const scoped = { ...f, q: '', from: null, to: null, before: null, direction: 'all', status: 'all' };
      const base = this.where(table, scoped);
      const row = db.prepare(`SELECT row_key,collab,source_present,payload FROM source_rows WHERE ${base.sql} AND json_extract(payload,'$.id')=?`).get(...base.values, id);
      if (!row) throw new MonitorError('NOT_FOUND');
      const item = decode(row);
      const events = table === 'tasks' ? db.prepare("SELECT row_key,collab,source_present,payload FROM source_rows WHERE table_name='task_events' AND source_present=1 AND json_extract(payload,'$.task_id')=? AND collab IS ? ORDER BY CAST(row_key AS INTEGER)").all(id, item.collab).map(r => decode(r)) : [];
      return { item, events };
    });
  }
  overview(f: Filters, runtime: RuntimeStatus) {
    return this.read(db => {
      if(runtime.useStoredRuntime){const stored=storedRuntime(db,this.path);const bridge=stored.snapshot?.jobs.find(job=>job.name==='bridge');runtime={...runtime,collecting:stored.live,lastError:stored.live&&bridge?.phase==='error'?bridge.code:null,intervalMs:stored.snapshot?.intervalMs??runtime.intervalMs}}
      const count = (table: string) => { const w = this.where(table, f); return Number(db.prepare(`SELECT count(*) n FROM source_rows WHERE ${w.sql}`).get(...w.values)!.n); };
      const checkpoints = db.prepare('SELECT table_name,row_count,captured_at FROM checkpoints ORDER BY table_name').all();
      const capturedAt = checkpoints.length ? Math.min(...checkpoints.map(r => Number(r.captured_at))) : null;
      const ageMs = capturedAt === null ? null : Math.max(0, Date.now() - capturedAt);
      const storedGaps = db.prepare('SELECT code,status,first_seen_at,last_seen_at,occurrences FROM collection_gaps ORDER BY code').all();
      const hasError = runtime.lastError !== null || storedGaps.some(g => g.status === 'collection-error');
      const freshness = !runtime.collecting ? 'snapshot' : hasError || ageMs === null || ageMs > 300000 ? 'error' : ageMs > runtime.intervalMs * 2 ? 'stale' : 'fresh';
      const collabs = db.prepare("SELECT collab,count(*) n FROM source_rows WHERE table_name='messages' AND source_present=1 GROUP BY collab ORDER BY collab").all().map(r => ({ id: r.collab == null ? '__unknown__' : String(r.collab), count: Number(r.n), test: /^(test-|mcp-)/.test(String(r.collab)) }));
      return { messages: count('messages'), tasks: count('tasks'), capturedAt, ageMs, freshness, runtime, checkpoints, gaps: storedGaps, collabs, coverage: 'bridge-persisted-only' };
    });
  }
}
