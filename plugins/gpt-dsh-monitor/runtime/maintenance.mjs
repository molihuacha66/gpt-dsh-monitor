import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);

// packages/monitor/src/config.ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// packages/monitor/src/errors.ts
var MonitorError = class extends Error {
  code;
  constructor(code) {
    super(code);
    this.code = code;
  }
};
function safeCode(error) {
  return error instanceof MonitorError ? error.code : "IO_OR_DATABASE_ERROR";
}

// packages/monitor/src/config.ts
function settings() {
  const home = resolve(process.env.MONITOR_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".local/share"), "BridgeBetween"));
  const file = join(home, "settings.json");
  let raw = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw.application !== "gpt-dsh-monitor" || raw.schemaVersion !== 1) throw new Error();
    } catch {
      throw new MonitorError("SETTINGS_INVALID");
    }
  }
  return { home, database: resolve(raw.database ?? join(home, "monitor/monitor.sqlite")), source: resolve(raw.source ?? join(home, "bridge/data/bridge.sqlite")), project: resolve(raw.project ?? join(home, "project")), sessions: resolve(raw.sessions ?? join(home, "empty-sessions")), port: raw.port ?? 47832 };
}

// packages/monitor/src/maintenance/database.ts
import { DatabaseSync as DatabaseSync2, backup } from "node:sqlite";
import { existsSync as existsSync4, lstatSync as lstatSync2, mkdirSync as mkdirSync2, openSync, closeSync, fstatSync, readFileSync as readFileSync2, writeFileSync, createReadStream } from "node:fs";
import { dirname, resolve as resolve2, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

// packages/monitor/src/schema.ts
var SCHEMA_VERSION = 2;
function validateMonitorLayout(db, allowMissingV2 = false) {
  const tables = { monitor_meta: "key value", source_binding: "id identity schema_hash policy", source_rows: "table_name row_key collab payload digest first_seen_at last_changed_at source_present", observations: "id table_name row_key observed_at payload digest", checkpoints: "table_name max_seq row_count captured_at", collection_gaps: "code status first_seen_at last_seen_at occurrences", monitor_runtime: "id updated_at payload", collector_lease: "id owner pid heartbeat", retention_runs: "id at cutoff watermark removed archive_hash" };
  for (const [table, names] of Object.entries(tables)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
    if (allowMissingV2 && !columns.length && ["monitor_runtime", "collector_lease", "retention_runs"].includes(table)) continue;
    if (columns.join(" ") !== names) throw new MonitorError("MONITOR_SCHEMA_INVALID");
  }
}
function monitorVersion(db) {
  if (db.prepare("SELECT value FROM monitor_meta WHERE key='application'").get()?.value !== "gpt-dsh-monitor-v1") throw new MonitorError("NOT_MONITOR_DATABASE");
  const raw = db.prepare("SELECT value FROM monitor_meta WHERE key='schema_version'").get()?.value;
  if (raw === void 0) return 1;
  if (!/^\d+$/.test(String(raw)) || Number(raw) < 1) throw new MonitorError("MONITOR_SCHEMA_INVALID");
  const version = Number(raw);
  if (version > SCHEMA_VERSION) throw new MonitorError("MONITOR_UPGRADE_REQUIRED");
  return version;
}

// packages/monitor/src/store.ts
import { DatabaseSync } from "node:sqlite";
import { existsSync as existsSync2 } from "node:fs";
var COVERAGE_GAPS = ["wake-input-not-in-bridge", "cli-trace-not-collected", "subagents-not-collected", "recipient-delivery-not-proven", "audit-may-be-incomplete"];
var MonitorStore = class {
  db;
  observationLimit = 1e5;
  constructor(path, options = {}) {
    if (existsSync2(path)) {
      const probe = new DatabaseSync(path, { readOnly: true });
      try {
        if (probe.prepare("SELECT value FROM monitor_meta WHERE key='application'").get()?.value !== "gpt-dsh-monitor-v1") {
          throw new MonitorError("OUTPUT_NOT_MONITOR_DATABASE");
        }
        const version = monitorVersion(probe);
        validateMonitorLayout(probe, version < SCHEMA_VERSION);
        if (version < SCHEMA_VERSION && !options.allowLegacyUpgrade) throw new MonitorError("MONITOR_MIGRATION_REQUIRES_BACKUP");
      } catch (error) {
        if (error instanceof MonitorError && error.code.startsWith("MONITOR_")) throw error;
        throw new MonitorError("OUTPUT_NOT_MONITOR_DATABASE");
      } finally {
        probe.close();
      }
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`
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
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
    for (const code of COVERAGE_GAPS) this.db.prepare("INSERT OR IGNORE INTO collection_gaps VALUES(?,?,?,?,1)").run(code, "unknown-not-captured", Date.now(), Date.now());
  }
  gap(code, status = "collection-error") {
    this.db.prepare(`INSERT INTO collection_gaps VALUES(?,?,?,?,1) ON CONFLICT(code) DO UPDATE SET last_seen_at=excluded.last_seen_at,occurrences=occurrences+1,status=excluded.status`).run(code, status, Date.now(), Date.now());
  }
  close() {
    this.db.close();
  }
};

// packages/monitor/src/paths.ts
import { existsSync as existsSync3, realpathSync, statSync, lstatSync, mkdirSync } from "node:fs";
function identity(path) {
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}

// packages/monitor/src/maintenance/database.ts
var inside = (root, path) => {
  const r = relative(resolve2(root), resolve2(path));
  return r === "" || !r.startsWith("..") && !isAbsolute(r);
};
var protectedRoots = [dirname(settings().source), settings().sessions];
function safePath(input, write = false) {
  const path = resolve2(input);
  if (write && protectedRoots.some((root) => inside(root, path))) throw new MonitorError("UNSAFE_OUTPUT_PATH");
  const parts = [];
  let p = path;
  while (dirname(p) !== p) {
    parts.push(p);
    p = dirname(p);
  }
  for (const file of parts.reverse()) if (existsSync4(file)) {
    const s = lstatSync2(file);
    if (s.isSymbolicLink() || s.isFile() && s.nlink > 1) throw new MonitorError("UNSAFE_OUTPUT_PATH");
  }
  return path;
}
function readonly(path) {
  safePath(path);
  const db = new DatabaseSync2(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000");
    const version = monitorVersion(db);
    validateMonitorLayout(db, version < SCHEMA_VERSION);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function reserve(path) {
  safePath(path, true);
  for (const file of [path, path + "-wal", path + "-shm", path + "-journal", path + ".manifest.json"]) if (existsSync4(file)) throw new MonitorError("BACKUP_TARGET_EXISTS");
  mkdirSync2(dirname(path), { recursive: true });
  const fd = openSync(path, "wx");
  return { fd, stat: fstatSync(fd) };
}
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
function integrity(db) {
  if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new MonitorError("BACKUP_INVALID");
}
async function snapshotCopy(source, destination) {
  if (resolve2(source) === resolve2(destination)) throw new MonitorError("BACKUP_TARGET_EXISTS");
  const db = readonly(source);
  let slot;
  try {
    slot = reserve(destination);
    await backup(db, destination, { rate: 64 });
    const now = lstatSync2(destination);
    if (now.ino !== slot.stat.ino || now.dev !== slot.stat.dev || now.nlink !== 1 || now.isSymbolicLink()) throw new MonitorError("UNSAFE_OUTPUT_PATH");
    const check = readonly(destination);
    try {
      integrity(check);
    } finally {
      check.close();
    }
  } finally {
    db.close();
    if (slot) closeSync(slot.fd);
  }
}
async function backupMonitor(database, destination) {
  database = safePath(database);
  destination = safePath(destination, true);
  const original = identity(database);
  await snapshotCopy(database, destination);
  const check = readonly(destination);
  let version;
  try {
    version = monitorVersion(check);
  } finally {
    check.close();
  }
  const sha256 = await hashFile(destination);
  if (identity(database) !== original) throw new MonitorError("MONITOR_REPLACED");
  const manifest = { application: "gpt-dsh-monitor-backup", createdAt: Date.now(), schemaVersion: version, sha256, bytes: lstatSync2(destination).size, sourceIdentity: createHash("sha256").update(original).digest("hex") };
  writeFileSync(destination + ".manifest.json", JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return manifest;
}
async function verifyBackup(path) {
  path = safePath(path);
  safePath(path + ".manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync2(path + ".manifest.json", "utf8"));
  } catch {
    throw new MonitorError("BACKUP_MANIFEST_INVALID");
  }
  if (manifest.application !== "gpt-dsh-monitor-backup" || !/^[0-9a-f]{64}$/.test(manifest.sha256) || manifest.sha256 !== await hashFile(path)) throw new MonitorError("BACKUP_HASH_MISMATCH");
  const db = readonly(path);
  try {
    integrity(db);
    const schemaVersion = monitorVersion(db), bytes = lstatSync2(path).size;
    if (schemaVersion !== manifest.schemaVersion || bytes !== manifest.bytes) throw new MonitorError("BACKUP_MANIFEST_INVALID");
    return { ok: true, schemaVersion, sha256: manifest.sha256, bytes };
  } finally {
    db.close();
  }
}
async function migrateMonitor(database, backupPath) {
  const original = identity(database), manifest = await backupMonitor(database, backupPath);
  await verifyBackup(backupPath);
  if (identity(database) !== original) throw new MonitorError("MONITOR_REPLACED");
  const store = new MonitorStore(database, { allowLegacyUpgrade: true });
  try {
    return { ok: true, schemaVersion: monitorVersion(store.db), backupSha256: manifest.sha256 };
  } finally {
    store.close();
  }
}
async function restoreMonitor(archive, destination) {
  await verifyBackup(archive);
  destination = safePath(destination, true);
  await snapshotCopy(archive, destination);
  const store = new MonitorStore(destination, { allowLegacyUpgrade: true });
  try {
    store.db.exec("BEGIN IMMEDIATE; DELETE FROM monitor_runtime; DELETE FROM collector_lease; COMMIT");
    store.gap("restored-snapshot", "restored-from-verified-backup");
    return { ok: true, schemaVersion: monitorVersion(store.db), currentRows: Number(store.db.prepare("SELECT count(*) n FROM source_rows").get().n) };
  } finally {
    store.close();
  }
}
function retentionPlan(database, days = 90, now = Date.now()) {
  if (!Number.isInteger(days) || days < 1 || days > 36500) throw new MonitorError("INVALID_RETENTION");
  const db = readonly(database);
  try {
    db.exec("BEGIN");
    const watermark = Number(db.prepare("SELECT coalesce(max(id),0) n FROM observations").get().n), cutoff = now - days * 864e5;
    const candidates = Number(db.prepare("SELECT count(*) n FROM observations WHERE observed_at<? AND id<=?").get(cutoff, watermark).n);
    db.exec("COMMIT");
    return { mode: "dry-run", policy: "observations-only", days, cutoff, watermark, candidates, currentRowsRetained: true, agentEventsRetained: true };
  } finally {
    db.close();
  }
}
function rowsHash(db, cutoff, watermark) {
  const hash = createHash("sha256");
  let count = 0;
  for (const row of db.prepare("SELECT * FROM observations WHERE observed_at<? AND id<=? ORDER BY id").iterate(cutoff, watermark)) {
    hash.update(JSON.stringify(row) + "\n");
    count++;
  }
  return { hash: hash.digest("hex"), count };
}
async function archiveHistory(database, destination, days = 90, apply = false) {
  const plan = retentionPlan(database, days);
  if (!apply) return plan;
  const original = identity(database);
  const archive = await backupMonitor(database, destination);
  await verifyBackup(destination);
  if (identity(database) !== original) throw new MonitorError("MONITOR_REPLACED");
  const store = new MonitorStore(database, { allowLegacyUpgrade: true }), db = store.db, copy = readonly(destination);
  try {
    db.exec("BEGIN IMMEDIATE");
    const current = rowsHash(db, plan.cutoff, plan.watermark), saved = rowsHash(copy, plan.cutoff, plan.watermark);
    if (current.count !== saved.count || current.hash !== saved.hash) throw new MonitorError("ARCHIVE_COVERAGE_MISMATCH");
    const removed = Number(db.prepare("DELETE FROM observations WHERE observed_at<? AND id<=?").run(plan.cutoff, plan.watermark).changes);
    db.prepare("INSERT INTO retention_runs(at,cutoff,watermark,removed,archive_hash) VALUES(?,?,?,?,?)").run(Date.now(), plan.cutoff, plan.watermark, removed, archive.sha256);
    store.gap("HISTORY_ARCHIVED", "history-preserved-in-archive");
    db.exec("COMMIT");
    return { ...plan, mode: "applied", removed, archiveSha256: archive.sha256 };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    copy.close();
    store.close();
  }
}

// packages/monitor/src/maintenance/cli.ts
async function main() {
  const args = process.argv.slice(2), command = args.shift();
  if (!["backup", "verify-backup", "restore", "retention", "archive", "migrate"].includes(command ?? "")) throw new MonitorError("INVALID_COMMAND");
  const values = {};
  let apply = false;
  while (args.length) {
    const key = args.shift();
    if (key === "--apply") {
      apply = true;
      continue;
    }
    if (!["--database", "--destination", "--days", "--backup"].includes(key) || !args.length || values[key]) throw new MonitorError("INVALID_ARGUMENT");
    values[key] = args.shift();
  }
  const database = values["--database"] ?? settings().database, destination = values["--destination"], archive = values["--backup"];
  if (apply && command !== "archive") throw new MonitorError("INVALID_ARGUMENT");
  let result;
  if (command === "backup") {
    if (!destination) throw new MonitorError("INVALID_ARGUMENT");
    result = await backupMonitor(database, destination);
  } else if (command === "verify-backup") {
    if (!archive) throw new MonitorError("INVALID_ARGUMENT");
    result = await verifyBackup(archive);
  } else if (command === "restore") {
    if (!archive || !destination) throw new MonitorError("INVALID_ARGUMENT");
    result = await restoreMonitor(archive, destination);
  } else if (command === "migrate") {
    if (!destination) throw new MonitorError("INVALID_ARGUMENT");
    result = await migrateMonitor(database, destination);
  } else {
    const days = Number(values["--days"] ?? 90);
    if (command === "archive" && apply && !destination) throw new MonitorError("INVALID_ARGUMENT");
    result = command === "archive" ? await archiveHistory(database, destination ?? "", days, apply) : retentionPlan(database, days);
  }
  console.log(JSON.stringify({ ok: true, ...result }));
}
main().catch((error) => {
  console.error(JSON.stringify({ ok: false, code: safeCode(error) }));
  process.exitCode = 1;
});
