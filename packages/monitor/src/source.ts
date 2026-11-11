import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { identity } from './paths.ts';
import { MonitorError } from './errors.ts';

export const COLUMNS = {
  messages: 'seq id collab sender recipient kind subject body source reply_to client_msg_id state created_at delivered_at read_at replied_at',
  tasks: 'seq id collab parent_id title brief assignee creator state deps result artifacts created_at updated_at',
  task_events: 'seq task_id actor from_state to_state note created_at',
  record_docs: 'collab key version value updated_by updated_at',
  record_history: 'seq collab key version value updated_by updated_at',
  audit: 'seq at actor action detail',
} as const;
export type Table = keyof typeof COLUMNS;
export const TABLES = Object.keys(COLUMNS) as Table[];
export type Row = Record<string, string | number | null>;
export type Snapshot = { identity: string; schema: string; rows: Record<Table, Row[]>; capturedAt: number };

export class BridgeSource {
  path: string;
  maxSnapshotBytes=64*1024*1024;
  constructor(path: string) { this.path = path; }
  snapshot(): Snapshot {
    const before = identity(this.path);
    const db = new DatabaseSync(this.path, { readOnly: true, enableDoubleQuotedStringLiterals: false });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN');
      const schema: unknown[] = [];
      const rows = {} as Record<Table, Row[]>;
      let count = 0;
      let bytes=0;
      for (const table of TABLES) {
        const info = db.prepare(`PRAGMA table_info("${table}")`).all();
        const expected = COLUMNS[table].split(' ');
        if (info.length !== expected.length || info.some((v, i) => v.name !== expected[i])) throw new MonitorError('SOURCE_SCHEMA_CHANGED');
        const type = db.prepare('SELECT type FROM sqlite_schema WHERE name=?').get(table);
        if (type?.type !== 'table') throw new MonitorError('SOURCE_SCHEMA_CHANGED');
        schema.push([table, info]);
        const selected = expected.map(c => `"${c}"`).join(',');
        const usage=db.prepare(`SELECT count(*) n,coalesce(sum(${expected.map(c=>`coalesce(length(CAST("${c}" AS BLOB)),0)`).join('+')}),0) bytes FROM "${table}"`).get()!;
        bytes+=Number(usage.bytes);
        if(bytes>this.maxSnapshotBytes)throw new MonitorError('SOURCE_BYTE_LIMIT');
        if(count+Number(usage.n)>100000)throw new MonitorError('SOURCE_TOO_LARGE');
        rows[table] = db.prepare(`SELECT ${selected} FROM "${table}" ORDER BY ${table === 'record_docs' ? 'collab,key' : 'seq'} LIMIT 100001`).all() as Row[];
        count += rows[table].length;
        if (count > 100000) throw new MonitorError('SOURCE_TOO_LARGE');
      }
      db.exec('COMMIT'); // Release the WAL reader before any monitor persistence.
      if (identity(this.path) !== before) throw new MonitorError('SOURCE_REPLACED');
      return { identity: before, schema: createHash('sha256').update(JSON.stringify(schema)).digest('hex'), rows, capturedAt: Date.now() };
    } finally { db.close(); }
  }
}
