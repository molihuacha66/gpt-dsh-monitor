import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { MonitorError } from './errors.ts';
import {monitorVersion,SCHEMA_VERSION,validateMonitorLayout} from './schema.ts';

export const COVERAGE_GAPS = ['wake-input-not-in-bridge', 'cli-trace-not-collected', 'subagents-not-collected', 'recipient-delivery-not-proven', 'audit-may-be-incomplete'];
export class MonitorStore {
  db: DatabaseSync;
  observationLimit = 100000;
  constructor(path: string,options:{allowLegacyUpgrade?:boolean}={}) {
    if (existsSync(path)) {
      const probe = new DatabaseSync(path, { readOnly: true });
      try {
        if (probe.prepare("SELECT value FROM monitor_meta WHERE key='application'").get()?.value !== 'gpt-dsh-monitor-v1') {
          throw new MonitorError('OUTPUT_NOT_MONITOR_DATABASE');
        }
        const version=monitorVersion(probe);
        validateMonitorLayout(probe,version<SCHEMA_VERSION);
        if(version<SCHEMA_VERSION&&!options.allowLegacyUpgrade)throw new MonitorError('MONITOR_MIGRATION_REQUIRES_BACKUP');
      } catch(error) { if(error instanceof MonitorError&&error.code.startsWith('MONITOR_'))throw error;throw new MonitorError('OUTPUT_NOT_MONITOR_DATABASE'); }
      finally { probe.close(); }
    }
    this.db = new DatabaseSync(path);
    try{this.db.exec(`
      PRAGMA busy_timeout=2000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS monitor_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO monitor_meta VALUES('application','gpt-dsh-monitor-v1');
      CREATE TABLE IF NOT EXISTS source_binding(id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL, schema_hash TEXT NOT NULL, policy TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_rows(table_name TEXT NOT NULL, row_key TEXT NOT NULL, collab TEXT, payload TEXT NOT NULL, digest TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_changed_at INTEGER NOT NULL, source_present INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(table_name,row_key));
      CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, row_key TEXT NOT NULL, observed_at INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints(table_name TEXT PRIMARY KEY, max_seq INTEGER, row_count INTEGER NOT NULL, captured_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_gaps(code TEXT PRIMARY KEY, status TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, occurrences INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_rows_collab ON source_rows(collab,table_name);
      CREATE INDEX IF NOT EXISTS ix_observations_row ON observations(table_name,row_key,id);
      CREATE INDEX IF NOT EXISTS ix_observations_age ON observations(observed_at,id);
      CREATE TABLE IF NOT EXISTS monitor_runtime(id INTEGER PRIMARY KEY CHECK(id=1),updated_at INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collector_lease(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,pid INTEGER NOT NULL,heartbeat INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS retention_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,cutoff INTEGER NOT NULL,watermark INTEGER NOT NULL,removed INTEGER NOT NULL,archive_hash TEXT NOT NULL);
    `);
    validateMonitorLayout(this.db);
    this.db.prepare("INSERT INTO monitor_meta VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(SCHEMA_VERSION));
    this.db.exec('COMMIT');
    }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');this.db.close();throw error}
    for (const code of COVERAGE_GAPS) this.db.prepare('INSERT OR IGNORE INTO collection_gaps VALUES(?,?,?,?,1)').run(code,'unknown-not-captured',Date.now(),Date.now());
  }
  gap(code: string, status = 'collection-error'): void {
    this.db.prepare(`INSERT INTO collection_gaps VALUES(?,?,?,?,1) ON CONFLICT(code) DO UPDATE SET last_seen_at=excluded.last_seen_at,occurrences=occurrences+1,status=excluded.status`).run(code, status, Date.now(), Date.now());
  }
  close(): void { this.db.close(); }
}
