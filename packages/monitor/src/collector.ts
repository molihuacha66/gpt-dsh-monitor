import { createHash } from 'node:crypto';
import { guardPaths } from './paths.ts';
import { BridgeSource, TABLES } from './source.ts';
import type { Row, Table, Snapshot } from './source.ts';
import { MonitorStore } from './store.ts';
import { redact, POLICY_VERSION } from './redaction.ts';
import { MonitorError, safeCode } from './errors.ts';

type Entry = { table: Table; key: string; collab: string | null; payload: string; digest: string };
function entries(snapshot: Snapshot): Entry[] {
  const owners = new Map<string, string>();
  for (const row of [...snapshot.rows.messages, ...snapshot.rows.tasks]) owners.set(String(row.id), String(row.collab));
  const result: Entry[] = [];
  for (const table of TABLES) {
    const seen = new Set<string>();
    for (const row of snapshot.rows[table]) {
      let collab = row.collab == null ? null : String(row.collab);
      if (table === 'task_events') collab = owners.get(String(row.task_id)) ?? null;
      if (table === 'audit') {
        try {
          const detail = JSON.parse(String(row.detail));
          if (row.action === 'codex.wake') collab = typeof detail?.collab === 'string' ? detail.collab : null;
          if (['message.send', 'task.create', 'task.move'].includes(String(row.action))) collab = owners.get(String(detail?.id)) ?? null;
        } catch { /* Unknown belongs to no invented collaboration. */ }
      }
      // Only a digest of already-redacted material is persisted.
      const clean = redact(row) as Row;
      const key = table === 'record_docs' ? JSON.stringify([clean.collab, clean.key]) : String(row.seq);
      if (seen.has(key)) throw new MonitorError('REDACTED_KEY_COLLISION');
      seen.add(key);
      const payload = JSON.stringify(clean);
      result.push({ table, key, collab: collab == null ? null : String(redact(collab)), payload, digest: createHash('sha256').update(payload).digest('hex') });
    }
  }
  return result;
}
export class Collector {
  source: BridgeSource;
  store: MonitorStore;
  constructor(source: string, output: string) {
    const paths = guardPaths(source, output);
    this.source = new BridgeSource(paths.source);
    this.store = new MonitorStore(paths.output);
  }
  cycle(options: { verify?: boolean; failAfter?: number; acceptHistoryChange?: boolean } = {}): Record<string, unknown> {
    const db = this.store.db;
    let transaction = false;
    try {
      // Serialize collectors before reading the source to avoid committing an older snapshot over a newer one.
      db.exec('BEGIN IMMEDIATE'); transaction = true;
      const snapshot = this.source.snapshot();
      const binding = db.prepare('SELECT * FROM source_binding WHERE id=1').get();
      if (binding && binding.identity !== snapshot.identity) throw new MonitorError('SOURCE_REPLACED');
      if (binding && binding.schema_hash !== snapshot.schema) throw new MonitorError('SOURCE_SCHEMA_CHANGED');
      if (binding && binding.policy !== POLICY_VERSION) throw new MonitorError('POLICY_CHANGED_REBUILD_REQUIRED');
      if (options.verify && !binding) throw new MonitorError('NOT_COLLECTED');
      const data = entries(snapshot);
      let observationCount = Number(db.prepare('SELECT count(*) n FROM observations').get()!.n);
      let observationsSkipped = 0;
      const observe = db.prepare('INSERT INTO observations(table_name,row_key,observed_at,payload,digest) VALUES(?,?,?,?,?)');
      const appendObservation = (table: string, key: string, payload: string, digest: string) => {
        if (observationCount >= this.store.observationLimit) { observationsSkipped++; return; }
        observe.run(table, key, snapshot.capturedAt, payload, digest); observationCount++;
      };
      const byTable = new Map(TABLES.map(t => [t, new Set(data.filter(e => e.table === t).map(e => e.key))]));
      let removed = 0;
      const removedPayload = JSON.stringify({ coverage: 'removed-from-source' });
      for (const old of db.prepare('SELECT table_name,row_key FROM source_rows WHERE source_present=1').all()) {
        if (!byTable.get(old.table_name as Table)?.has(String(old.row_key))) {
          if (!options.acceptHistoryChange || options.verify) throw new MonitorError('SOURCE_HISTORY_CHANGED');
          db.prepare('UPDATE source_rows SET source_present=0,last_changed_at=? WHERE table_name=? AND row_key=?').run(snapshot.capturedAt, old.table_name, old.row_key);
          appendObservation(String(old.table_name), String(old.row_key), removedPayload, createHash('sha256').update(removedPayload).digest('hex'));
          removed++;
        }
      }
      if (removed) this.store.gap('source-history-removed', 'known-source-gap');
      let added = 0, changed = 0;
      const find = db.prepare('SELECT digest,collab,source_present FROM source_rows WHERE table_name=? AND row_key=?');
      const upsert = db.prepare(`INSERT INTO source_rows(table_name,row_key,collab,payload,digest,first_seen_at,last_changed_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(table_name,row_key) DO UPDATE SET collab=excluded.collab,payload=excluded.payload,digest=excluded.digest,last_changed_at=excluded.last_changed_at,source_present=1`);
      let written = 0;
      for (const entry of data) {
        const previous = find.get(entry.table, entry.key);
        if (!previous || previous.digest !== entry.digest || previous.collab !== entry.collab || previous.source_present !== 1) {
          if (options.verify) throw new MonitorError('VERIFY_MISMATCH_RUN_COLLECT');
          if (previous) changed++; else added++;
          upsert.run(entry.table, entry.key, entry.collab, entry.payload, entry.digest, snapshot.capturedAt, snapshot.capturedAt);
          appendObservation(entry.table, entry.key, entry.payload, entry.digest);
          if (++written === options.failAfter) throw new MonitorError('SIMULATED_INTERRUPTION');
        }
      }
      const counts: Record<string, number> = {};
      for (const table of TABLES) {
        const rows = snapshot.rows[table];
        const maxSeq = table === 'record_docs' ? null : rows.reduce((n, r) => Math.max(n, Number(r.seq ?? 0)), 0);
        counts[table] = rows.length;
        if (!options.verify) db.prepare(`INSERT INTO checkpoints VALUES(?,?,?,?) ON CONFLICT(table_name) DO UPDATE SET max_seq=excluded.max_seq,row_count=excluded.row_count,captured_at=excluded.captured_at`).run(table, maxSeq, rows.length, snapshot.capturedAt);
      }
      if (!options.verify) {
        if (observationsSkipped) this.store.gap('OBSERVATIONS_CAP_REACHED', 'degraded-history');
        db.prepare('INSERT OR IGNORE INTO source_binding VALUES(1,?,?,?)').run(snapshot.identity, snapshot.schema, POLICY_VERSION);
        db.prepare("UPDATE collection_gaps SET status='recovered' WHERE status='collection-error'").run();
      }
      db.exec('COMMIT'); transaction = false;
      return { ok: true, mode: options.verify ? 'verify' : 'collect', added, changed, removed, observationsSkipped, counts, capturedAt: snapshot.capturedAt, coverage: 'bridge-persisted-only' };
    } catch (error) {
      if (transaction) db.exec('ROLLBACK');
      this.store.gap(safeCode(error));
      throw new MonitorError(safeCode(error));
    }
  }
  close(): void { this.store.close(); }
}
