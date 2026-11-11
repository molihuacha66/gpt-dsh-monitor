import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);

// packages/monitor/src/runtime/worker.ts
import { parentPort, workerData } from "node:worker_threads";
import { existsSync as existsSync7 } from "node:fs";
import { DatabaseSync as DatabaseSync5 } from "node:sqlite";

// packages/monitor/src/collector.ts
import { createHash as createHash2 } from "node:crypto";

// packages/monitor/src/paths.ts
import { existsSync, realpathSync, statSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";

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

// packages/monitor/src/paths.ts
function identity(path) {
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}
function canonical(path) {
  const full = resolve(path);
  if (existsSync(full)) return realpathSync.native(full);
  return resolve(canonical(dirname(full)), relative(dirname(full), full));
}
function inside(parent, child) {
  const r = relative(parent, child);
  return r === "" || !r.startsWith("..") && !isAbsolute(r);
}
function guardOutputLocation(source, output) {
  if (inside(canonical(dirname(resolve(source))), canonical(output))) throw new MonitorError("UNSAFE_OUTPUT_PATH");
}
function guardPaths(source, output) {
  if (!existsSync(source) || !statSync(source).isFile()) throw new MonitorError("SOURCE_UNAVAILABLE");
  const src = realpathSync.native(resolve(source));
  const out = canonical(output);
  if (inside(dirname(src), out)) throw new MonitorError("UNSAFE_OUTPUT_PATH");
  const sourceFiles = [src, `${src}-wal`, `${src}-shm`, `${src}-journal`].filter(existsSync);
  for (const path of [resolve(output), `${resolve(output)}-wal`, `${resolve(output)}-shm`, `${resolve(output)}-journal`]) {
    if (existsSync(path)) {
      if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || statSync(path).nlink > 1) {
        throw new MonitorError("UNSAFE_OUTPUT_PATH");
      }
      if (sourceFiles.some((s) => identity(s) === identity(path))) throw new MonitorError("UNSAFE_OUTPUT_PATH");
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  return { source: src, output: out };
}

// packages/monitor/src/source.ts
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
var COLUMNS = {
  messages: "seq id collab sender recipient kind subject body source reply_to client_msg_id state created_at delivered_at read_at replied_at",
  tasks: "seq id collab parent_id title brief assignee creator state deps result artifacts created_at updated_at",
  task_events: "seq task_id actor from_state to_state note created_at",
  record_docs: "collab key version value updated_by updated_at",
  record_history: "seq collab key version value updated_by updated_at",
  audit: "seq at actor action detail"
};
var TABLES = Object.keys(COLUMNS);
var BridgeSource = class {
  path;
  maxSnapshotBytes = 64 * 1024 * 1024;
  constructor(path) {
    this.path = path;
  }
  snapshot() {
    const before = identity(this.path);
    const db2 = new DatabaseSync(this.path, { readOnly: true, enableDoubleQuotedStringLiterals: false });
    try {
      db2.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN");
      const schema = [];
      const rows = {};
      let count = 0;
      let bytes = 0;
      for (const table of TABLES) {
        const info = db2.prepare(`PRAGMA table_info("${table}")`).all();
        const expected = COLUMNS[table].split(" ");
        if (info.length !== expected.length || info.some((v, i) => v.name !== expected[i])) throw new MonitorError("SOURCE_SCHEMA_CHANGED");
        const type = db2.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(table);
        if (type?.type !== "table") throw new MonitorError("SOURCE_SCHEMA_CHANGED");
        schema.push([table, info]);
        const selected = expected.map((c) => `"${c}"`).join(",");
        const usage = db2.prepare(`SELECT count(*) n,coalesce(sum(${expected.map((c) => `coalesce(length(CAST("${c}" AS BLOB)),0)`).join("+")}),0) bytes FROM "${table}"`).get();
        bytes += Number(usage.bytes);
        if (bytes > this.maxSnapshotBytes) throw new MonitorError("SOURCE_BYTE_LIMIT");
        if (count + Number(usage.n) > 1e5) throw new MonitorError("SOURCE_TOO_LARGE");
        rows[table] = db2.prepare(`SELECT ${selected} FROM "${table}" ORDER BY ${table === "record_docs" ? "collab,key" : "seq"} LIMIT 100001`).all();
        count += rows[table].length;
        if (count > 1e5) throw new MonitorError("SOURCE_TOO_LARGE");
      }
      db2.exec("COMMIT");
      if (identity(this.path) !== before) throw new MonitorError("SOURCE_REPLACED");
      return { identity: before, schema: createHash("sha256").update(JSON.stringify(schema)).digest("hex"), rows, capturedAt: Date.now() };
    } finally {
      db2.close();
    }
  }
};

// packages/monitor/src/store.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { existsSync as existsSync2 } from "node:fs";

// packages/monitor/src/schema.ts
var SCHEMA_VERSION = 2;
function validateMonitorLayout(db2, allowMissingV2 = false) {
  const tables = { monitor_meta: "key value", source_binding: "id identity schema_hash policy", source_rows: "table_name row_key collab payload digest first_seen_at last_changed_at source_present", observations: "id table_name row_key observed_at payload digest", checkpoints: "table_name max_seq row_count captured_at", collection_gaps: "code status first_seen_at last_seen_at occurrences", monitor_runtime: "id updated_at payload", collector_lease: "id owner pid heartbeat", retention_runs: "id at cutoff watermark removed archive_hash" };
  for (const [table, names] of Object.entries(tables)) {
    const columns = db2.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
    if (allowMissingV2 && !columns.length && ["monitor_runtime", "collector_lease", "retention_runs"].includes(table)) continue;
    if (columns.join(" ") !== names) throw new MonitorError("MONITOR_SCHEMA_INVALID");
  }
}
function monitorVersion(db2) {
  if (db2.prepare("SELECT value FROM monitor_meta WHERE key='application'").get()?.value !== "gpt-dsh-monitor-v1") throw new MonitorError("NOT_MONITOR_DATABASE");
  const raw = db2.prepare("SELECT value FROM monitor_meta WHERE key='schema_version'").get()?.value;
  if (raw === void 0) return 1;
  if (!/^\d+$/.test(String(raw)) || Number(raw) < 1) throw new MonitorError("MONITOR_SCHEMA_INVALID");
  const version = Number(raw);
  if (version > SCHEMA_VERSION) throw new MonitorError("MONITOR_UPGRADE_REQUIRED");
  return version;
}

// packages/monitor/src/store.ts
var COVERAGE_GAPS = ["wake-input-not-in-bridge", "cli-trace-not-collected", "subagents-not-collected", "recipient-delivery-not-proven", "audit-may-be-incomplete"];
var MonitorStore = class {
  db;
  observationLimit = 1e5;
  constructor(path, options2 = {}) {
    if (existsSync2(path)) {
      const probe = new DatabaseSync2(path, { readOnly: true });
      try {
        if (probe.prepare("SELECT value FROM monitor_meta WHERE key='application'").get()?.value !== "gpt-dsh-monitor-v1") {
          throw new MonitorError("OUTPUT_NOT_MONITOR_DATABASE");
        }
        const version = monitorVersion(probe);
        validateMonitorLayout(probe, version < SCHEMA_VERSION);
        if (version < SCHEMA_VERSION && !options2.allowLegacyUpgrade) throw new MonitorError("MONITOR_MIGRATION_REQUIRES_BACKUP");
      } catch (error) {
        if (error instanceof MonitorError && error.code.startsWith("MONITOR_")) throw error;
        throw new MonitorError("OUTPUT_NOT_MONITOR_DATABASE");
      } finally {
        probe.close();
      }
    }
    this.db = new DatabaseSync2(path);
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
  gap(code, status2 = "collection-error") {
    this.db.prepare(`INSERT INTO collection_gaps VALUES(?,?,?,?,1) ON CONFLICT(code) DO UPDATE SET last_seen_at=excluded.last_seen_at,occurrences=occurrences+1,status=excluded.status`).run(code, status2, Date.now(), Date.now());
  }
  close() {
    this.db.close();
  }
};

// packages/monitor/src/redaction.ts
var HIDDEN = "[REDACTED]";
var POLICY_VERSION = "redaction-v1";
var sensitiveKey = /(?:api[-_ ]?key|password|passwd|pwd|secret|token|authorization|cookie|credential|private[-_ ]?key|密码|口令|密钥|令牌)/i;
function redactText(input) {
  const trimmed = input.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}") || trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      return JSON.stringify(redact(JSON.parse(trimmed)));
    } catch {
    }
  }
  if (/(?:api[-_ ]?key|password|passwd|pwd|secret|token|authorization|cookie|credential|密码|口令|密钥|令牌)\s*["']?\s*[:=：]\s*(?:\r?\n|$)/i.test(input)) return HIDDEN;
  let text = input.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, HIDDEN);
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, HIDDEN);
  text = text.replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, HIDDEN);
  text = text.split(/\r?\n/).map((line) => /(?:api[-_ ]?key|password|passwd|pwd|secret|token|authorization|cookie|credential|密码|口令|密钥|令牌)\s*["']?\s*[:=：]|(?:密码|密钥|令牌)\s*(?:是|为)|\b(?:password|secret|token|api[-_ ]?key)\s+is\b/i.test(line) ? HIDDEN : line).join("\n");
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${HIDDEN}@`);
  return text.replace(/[A-Za-z0-9_+/=-]{24,}/g, (value) => {
    const counts = /* @__PURE__ */ new Map();
    for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let entropy = 0;
    for (const n of counts.values()) {
      const p = n / value.length;
      entropy -= p * Math.log2(p);
    }
    return entropy >= 3.3 ? HIDDEN : value;
  });
}
function redact(value, depth = 0) {
  if (depth > 30) return "[SUPPRESSED:DEPTH]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => {
      const structuralId = /^(?:id|session_id|thread_id|task_id|parent_id|sender_id|recipient_id|reply_to|wake_target)$/.test(key) && typeof v === "string" && /^(?:(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[mt]_[0-9a-f]{12})$/i.test(v);
      return [redactText(key), sensitiveKey.test(key) ? HIDDEN : structuralId ? v : redact(v, depth + 1)];
    }));
  }
  return value;
}

// packages/monitor/src/collector.ts
function entries(snapshot) {
  const owners = /* @__PURE__ */ new Map();
  for (const row of [...snapshot.rows.messages, ...snapshot.rows.tasks]) owners.set(String(row.id), String(row.collab));
  const result = [];
  for (const table of TABLES) {
    const seen = /* @__PURE__ */ new Set();
    for (const row of snapshot.rows[table]) {
      let collab = row.collab == null ? null : String(row.collab);
      if (table === "task_events") collab = owners.get(String(row.task_id)) ?? null;
      if (table === "audit") {
        try {
          const detail = JSON.parse(String(row.detail));
          if (row.action === "codex.wake") collab = typeof detail?.collab === "string" ? detail.collab : null;
          if (["message.send", "task.create", "task.move"].includes(String(row.action))) collab = owners.get(String(detail?.id)) ?? null;
        } catch {
        }
      }
      const clean = redact(row);
      const key = table === "record_docs" ? JSON.stringify([clean.collab, clean.key]) : String(row.seq);
      if (seen.has(key)) throw new MonitorError("REDACTED_KEY_COLLISION");
      seen.add(key);
      const payload = JSON.stringify(clean);
      result.push({ table, key, collab: collab == null ? null : String(redact(collab)), payload, digest: createHash2("sha256").update(payload).digest("hex") });
    }
  }
  return result;
}
var Collector = class {
  source;
  store;
  constructor(source, output) {
    const paths = guardPaths(source, output);
    this.source = new BridgeSource(paths.source);
    this.store = new MonitorStore(paths.output);
  }
  cycle(options2 = {}) {
    const db2 = this.store.db;
    let transaction = false;
    try {
      db2.exec("BEGIN IMMEDIATE");
      transaction = true;
      const snapshot = this.source.snapshot();
      const binding = db2.prepare("SELECT * FROM source_binding WHERE id=1").get();
      if (binding && binding.identity !== snapshot.identity) throw new MonitorError("SOURCE_REPLACED");
      if (binding && binding.schema_hash !== snapshot.schema) throw new MonitorError("SOURCE_SCHEMA_CHANGED");
      if (binding && binding.policy !== POLICY_VERSION) throw new MonitorError("POLICY_CHANGED_REBUILD_REQUIRED");
      if (options2.verify && !binding) throw new MonitorError("NOT_COLLECTED");
      const data = entries(snapshot);
      let observationCount = Number(db2.prepare("SELECT count(*) n FROM observations").get().n);
      let observationsSkipped = 0;
      const observe = db2.prepare("INSERT INTO observations(table_name,row_key,observed_at,payload,digest) VALUES(?,?,?,?,?)");
      const appendObservation = (table, key, payload, digest) => {
        if (observationCount >= this.store.observationLimit) {
          observationsSkipped++;
          return;
        }
        observe.run(table, key, snapshot.capturedAt, payload, digest);
        observationCount++;
      };
      const byTable = new Map(TABLES.map((t) => [t, new Set(data.filter((e) => e.table === t).map((e) => e.key))]));
      let removed = 0;
      const removedPayload = JSON.stringify({ coverage: "removed-from-source" });
      for (const old of db2.prepare("SELECT table_name,row_key FROM source_rows WHERE source_present=1").all()) {
        if (!byTable.get(old.table_name)?.has(String(old.row_key))) {
          if (!options2.acceptHistoryChange || options2.verify) throw new MonitorError("SOURCE_HISTORY_CHANGED");
          db2.prepare("UPDATE source_rows SET source_present=0,last_changed_at=? WHERE table_name=? AND row_key=?").run(snapshot.capturedAt, old.table_name, old.row_key);
          appendObservation(String(old.table_name), String(old.row_key), removedPayload, createHash2("sha256").update(removedPayload).digest("hex"));
          removed++;
        }
      }
      if (removed) this.store.gap("source-history-removed", "known-source-gap");
      let added = 0, changed = 0;
      const find = db2.prepare("SELECT digest,collab,source_present FROM source_rows WHERE table_name=? AND row_key=?");
      const upsert = db2.prepare(`INSERT INTO source_rows(table_name,row_key,collab,payload,digest,first_seen_at,last_changed_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(table_name,row_key) DO UPDATE SET collab=excluded.collab,payload=excluded.payload,digest=excluded.digest,last_changed_at=excluded.last_changed_at,source_present=1`);
      let written = 0;
      for (const entry of data) {
        const previous = find.get(entry.table, entry.key);
        if (!previous || previous.digest !== entry.digest || previous.collab !== entry.collab || previous.source_present !== 1) {
          if (options2.verify) throw new MonitorError("VERIFY_MISMATCH_RUN_COLLECT");
          if (previous) changed++;
          else added++;
          upsert.run(entry.table, entry.key, entry.collab, entry.payload, entry.digest, snapshot.capturedAt, snapshot.capturedAt);
          appendObservation(entry.table, entry.key, entry.payload, entry.digest);
          if (++written === options2.failAfter) throw new MonitorError("SIMULATED_INTERRUPTION");
        }
      }
      const counts = {};
      for (const table of TABLES) {
        const rows = snapshot.rows[table];
        const maxSeq = table === "record_docs" ? null : rows.reduce((n, r) => Math.max(n, Number(r.seq ?? 0)), 0);
        counts[table] = rows.length;
        if (!options2.verify) db2.prepare(`INSERT INTO checkpoints VALUES(?,?,?,?) ON CONFLICT(table_name) DO UPDATE SET max_seq=excluded.max_seq,row_count=excluded.row_count,captured_at=excluded.captured_at`).run(table, maxSeq, rows.length, snapshot.capturedAt);
      }
      if (!options2.verify) {
        if (observationsSkipped) this.store.gap("OBSERVATIONS_CAP_REACHED", "degraded-history");
        db2.prepare("INSERT OR IGNORE INTO source_binding VALUES(1,?,?,?)").run(snapshot.identity, snapshot.schema, POLICY_VERSION);
        db2.prepare("UPDATE collection_gaps SET status='recovered' WHERE status='collection-error'").run();
      }
      db2.exec("COMMIT");
      transaction = false;
      return { ok: true, mode: options2.verify ? "verify" : "collect", added, changed, removed, observationsSkipped, counts, capturedAt: snapshot.capturedAt, coverage: "bridge-persisted-only" };
    } catch (error) {
      if (transaction) db2.exec("ROLLBACK");
      this.store.gap(safeCode(error));
      throw new MonitorError(safeCode(error));
    }
  }
  close() {
    this.store.close();
  }
};

// packages/monitor/src/config.ts
import { homedir } from "node:os";
import { join, resolve as resolve2 } from "node:path";
import { existsSync as existsSync3, readFileSync } from "node:fs";
function settings() {
  const home = resolve2(process.env.MONITOR_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".local/share"), "BridgeBetween"));
  const file = join(home, "settings.json");
  let raw = {};
  if (existsSync3(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw.application !== "gpt-dsh-monitor" || raw.schemaVersion !== 1) throw new Error();
    } catch {
      throw new MonitorError("SETTINGS_INVALID");
    }
  }
  return { home, database: resolve2(raw.database ?? join(home, "monitor/monitor.sqlite")), source: resolve2(raw.source ?? join(home, "bridge/data/bridge.sqlite")), project: resolve2(raw.project ?? join(home, "project")), sessions: resolve2(raw.sessions ?? join(home, "empty-sessions")), port: raw.port ?? 47832 };
}

// packages/monitor/src/subagents/collector.ts
import { openSync, closeSync, fstatSync, readSync, readdirSync, lstatSync as lstatSync2, realpathSync as realpathSync2, existsSync as existsSync4, mkdirSync as mkdirSync2 } from "node:fs";
import { resolve as resolve3, join as join2, relative as relative2, isAbsolute as isAbsolute2, dirname as dirname2 } from "node:path";
import { createHash as createHash3 } from "node:crypto";

// packages/monitor/src/subagents/zstd.ts
import { zstdDecompressSync, constants } from "node:zlib";
function frameEnd(bytes, start) {
  let p = start;
  if (bytes.length - p < 5) return null;
  if (bytes.readUInt32LE(p) !== 4247762216) throw new MonitorError("AGENT_FRAME_UNSUPPORTED");
  p += 4;
  const d = bytes[p++];
  if (d & 8) throw new MonitorError("AGENT_FRAME_INVALID");
  const single = !!(d & 32), flag = d >>> 6;
  p += (single ? 0 : 1) + [0, 1, 2, 4][d & 3] + (flag === 0 ? single ? 1 : 0 : 1 << flag);
  if (p > bytes.length) return null;
  for (; ; ) {
    if (p + 3 > bytes.length) return null;
    const h = bytes.readUIntLE(p, 3);
    p += 3;
    const type = h >>> 1 & 3;
    if (type === 3) throw new MonitorError("AGENT_FRAME_INVALID");
    p += type === 1 ? 1 : h >>> 3;
    if (p > bytes.length) return null;
    if (h & 1) break;
  }
  p += d & 4 ? 4 : 0;
  return p > bytes.length ? null : p;
}
function decodeFrames(bytes, outputLimit = 128 * 1024 * 1024, onDecoded) {
  const rows = [];
  let p = 0, decoded = 0;
  while (p < bytes.length) {
    const end = frameEnd(bytes, p);
    if (end === null) break;
    let plain;
    if (decoded >= outputLimit) throw new MonitorError("AGENT_RESOURCE_LIMIT");
    try {
      plain = zstdDecompressSync(bytes.subarray(p, end), { maxOutputLength: Math.min(32 * 1024 * 1024, outputLimit - decoded), params: { [constants.ZSTD_d_windowLogMax]: 27 } });
    } catch {
      throw new MonitorError("AGENT_DECOMPRESSION_FAILED");
    }
    decoded += plain.length;
    onDecoded?.(plain.length);
    if (decoded > outputLimit) throw new MonitorError("AGENT_RESOURCE_LIMIT");
    if (!plain.length || plain.at(-1) !== 10) throw new MonitorError("AGENT_JSONL_INCOMPLETE");
    try {
      for (const line of new TextDecoder("utf-8", { fatal: true }).decode(plain).split("\n")) {
        if (!line.trim()) continue;
        if (line.length > 16 * 1024 * 1024 || rows.length >= 1e5) throw new MonitorError("AGENT_RESOURCE_LIMIT");
        rows.push(JSON.parse(line));
      }
    } catch (e) {
      if (e instanceof MonitorError) throw e;
      throw new MonitorError("AGENT_JSONL_INVALID");
    }
    p = end;
  }
  return { rows, consumed: p, pending: p < bytes.length };
}

// packages/monitor/src/subagents/normalize.ts
var object = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
function sessionId(v) {
  return typeof v === "string" && /^(?:(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|session-\d{1,10})$/i.test(v) ? v : null;
}
var time = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 864e13 ? v : null;
function header(value) {
  const h = object(value), id = sessionId(h.id), parent = h.parentSession == null ? null : sessionId(h.parentSession);
  if (h.type !== "session" || h.version !== 4) throw new MonitorError("AGENT_FORMAT_UNSUPPORTED");
  if (!id || h.parentSession != null && !parent || parent === id || typeof h.isSeeded !== "boolean" || time(h.createdAt) === null || !Number.isSafeInteger(h.delegationDepth) || Number(h.delegationDepth) < 0 || Number(h.delegationDepth) > 100) throw new MonitorError("AGENT_HEADER_INVALID");
  return { id, parent_id: parent, is_child: h.origin === "subagent", is_seeded: h.isSeeded, depth: Number(h.delegationDepth), created_at: Number(h.createdAt), seed_cut: -1, last_seq: -1, descriptor: false, initial_seen: false, label: "", mode: "unknown", status: "unknown", status_at: null };
}
function textOnly(message) {
  if (!Array.isArray(message.content)) return "";
  const parts = [];
  let size = 0;
  for (const block of message.content) {
    const b = object(block);
    if (b.type !== "text" || typeof b.text !== "string") continue;
    size += b.text.length;
    if (size > 1024 * 1024) throw new MonitorError("AGENT_TEXT_LIMIT");
    parts.push(b.text);
  }
  return redactText(parts.join("\n"));
}
function normalize(state, values, initial) {
  const events = values.map(object);
  let next = state.last_seq + 1;
  for (const e of events) {
    if (e.seq !== next++ || typeof e.type !== "string" || time(e.time) === null) throw new MonitorError("AGENT_SEQUENCE_INVALID");
  }
  const markers = events.filter((e) => e.type === "session/end-seed" && object(e.data).inherited === true);
  if (initial) {
    if (state.is_seeded && !markers.length) throw new MonitorError("AGENT_SEED_BOUNDARY_MISSING");
    if (!state.is_seeded && markers.length) throw new MonitorError("AGENT_SEED_BOUNDARY_INVALID");
    state.seed_cut = markers.length ? Number(markers.at(-1).seq) : -1;
  } else if (markers.length) throw new MonitorError("AGENT_SEED_BOUNDARY_CHANGED");
  const out = [];
  for (const e of events) {
    state.last_seq = Number(e.seq);
    if (state.last_seq <= state.seed_cut) continue;
    const d = object(e.data), at = Number(e.time);
    const emit = (kind, sender, recipient, text = "", reason = null, evidence = "explicit-source") => out.push({ seq: state.last_seq, at, kind, sender_id: sender, recipient_id: recipient, text, reason, evidence });
    if (state.is_child && e.type === "subagent/descriptor") {
      if (d.version !== 3 || !["one-shot", "continuable"].includes(String(d.mode))) throw new MonitorError("AGENT_DESCRIPTOR_UNSUPPORTED");
      if (!state.descriptor) {
        state.descriptor = true;
        state.mode = String(d.mode);
        state.label = typeof d.label === "string" ? redactText(d.label).slice(0, 200) : "";
        emit("descriptor", state.parent_id, state.id, state.label, null, "session-metadata");
      }
    } else if (e.type === "user/message") {
      const source = object(d.source), sender = sessionId(source.senderSessionId);
      if (["agent-message", "subagent-settled"].includes(String(source.kind)) && sender && sender !== state.id) {
        emit(source.kind === "agent-message" ? "received" : "settlement-notice", sender, state.id, textOnly(d));
      } else if (state.is_child && state.parent_id && state.descriptor && !state.initial_seen && source.kind === "user") {
        state.initial_seen = true;
        emit("initial-delegation", state.parent_id, state.id, textOnly(d), null, "position-inference");
      }
    } else if (state.is_child && e.type === "assistant/message") {
      const message = object(d.message);
      if (message.role === "assistant") {
        const text = textOnly(message);
        if (text) emit("output", state.id, null, text, null, "output-only-delivery-unproven");
      }
    } else if (state.is_child && (e.type === "turn/start" || e.type === "turn/end")) {
      const r = object(d.reason).kind;
      const reason = e.type === "turn/start" ? null : ["completed", "aborted", "error", "max-tokens", "refusal", "interrupted", "blocked", "forked"].includes(String(r)) ? String(r) : "unknown";
      if (reason === "forked") continue;
      state.status = e.type === "turn/start" ? "observed-running" : reason === "completed" ? "turn-ended" : `turn-${reason}`;
      state.status_at = at;
      emit(e.type === "turn/start" ? "turn-start" : "turn-end", state.id, null, "", reason, "persisted-turn");
    }
  }
  return out;
}

// packages/monitor/src/subagents/collector.ts
var DEFAULT_SESSIONS = settings().sessions;
var BATCH = 64 * 1024 * 1024;
var fileIdentity = (s) => `${s.dev}:${s.ino}:${s.birthtimeMs}`;
function inside2(root, path) {
  const r = relative2(root, path);
  return r === "" || !r.startsWith("..") && !isAbsolute2(r);
}
function canonical2(path) {
  return existsSync4(path) ? realpathSync2.native(path) : resolve3(canonical2(dirname2(path)), relative2(dirname2(path), path));
}
function agentOutputPath(root, output) {
  if (inside2(canonical2(resolve3(root)), canonical2(resolve3(output)))) throw new MonitorError("UNSAFE_OUTPUT_PATH");
  for (const p of [output, `${output}-wal`, `${output}-shm`, `${output}-journal`]) {
    if (existsSync4(p)) {
      const s = lstatSync2(p);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink > 1) throw new MonitorError("UNSAFE_OUTPUT_PATH");
    }
  }
  mkdirSync2(dirname2(resolve3(output)), { recursive: true });
  return resolve3(output);
}
var AgentCollector = class {
  root;
  output;
  store;
  readBudget = 128 * 1024 * 1024;
  decodeBudget = 256 * 1024 * 1024;
  maxFilesPerCycle = 512;
  constructor(root, output) {
    this.root = resolve3(root);
    this.output = agentOutputPath(this.root, output);
    this.store = new MonitorStore(this.output);
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_source(id INTEGER PRIMARY KEY CHECK(id=1),root_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_files(file_key TEXT PRIMARY KEY,identity TEXT NOT NULL,generation INTEGER NOT NULL,byte_offset INTEGER NOT NULL,source_size INTEGER NOT NULL,mtime REAL NOT NULL,state TEXT,status TEXT NOT NULL,scanned_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_sessions(file_key TEXT NOT NULL,generation INTEGER NOT NULL,session_id TEXT NOT NULL,parent_id TEXT,is_child INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(file_key,generation));
      CREATE TABLE IF NOT EXISTS agent_events(id INTEGER PRIMARY KEY AUTOINCREMENT,file_key TEXT NOT NULL,generation INTEGER NOT NULL,seq INTEGER NOT NULL,at INTEGER NOT NULL,kind TEXT NOT NULL,sender_id TEXT,recipient_id TEXT,payload TEXT NOT NULL,UNIQUE(file_key,generation,seq));
      CREATE INDEX IF NOT EXISTS ix_agent_session_id ON agent_sessions(session_id);
      CREATE INDEX IF NOT EXISTS ix_agent_event_file ON agent_events(file_key,generation,id);
      CREATE TABLE IF NOT EXISTS agent_scan(id INTEGER PRIMARY KEY CHECK(id=1),scanned_at INTEGER NOT NULL,status TEXT NOT NULL,files INTEGER NOT NULL,parsed INTEGER NOT NULL,errors INTEGER NOT NULL,pending INTEGER NOT NULL,discovery_errors INTEGER NOT NULL);
      UPDATE agent_events SET payload=json_set(payload,'$.evidence','output-only-delivery-unproven') WHERE kind='output' AND json_extract(payload,'$.evidence')='[REDACTED]';
    `);
    const rootName = canonical2(this.root);
    const rootKey = createHash3("sha256").update(process.platform === "win32" ? rootName.toLowerCase() : rootName).digest("hex");
    this.store.db.prepare("INSERT OR IGNORE INTO agent_source VALUES(1,?)").run(rootKey);
    if (this.store.db.prepare("SELECT root_key FROM agent_source WHERE id=1").get().root_key !== rootKey) {
      this.store.close();
      throw new MonitorError("AGENT_SOURCE_REPLACED");
    }
  }
  discover() {
    const files = [];
    let errors = 0;
    if (!existsSync4(this.root)) throw new MonitorError("AGENT_SOURCE_MISSING");
    if (lstatSync2(this.root).isSymbolicLink()) throw new MonitorError("AGENT_SOURCE_LINK");
    for (const project of readdirSync(this.root, { withFileTypes: true })) {
      if (project.isSymbolicLink()) {
        errors++;
        continue;
      }
      if (!project.isDirectory()) continue;
      try {
        for (const session of readdirSync(join2(this.root, project.name), { withFileTypes: true })) {
          if (session.isSymbolicLink()) {
            errors++;
            continue;
          }
          if (!session.isDirectory()) continue;
          const p = join2(this.root, project.name, session.name, "session.v4.jsonl.zstd");
          if (!existsSync4(p)) {
            if (readdirSync(join2(this.root, project.name, session.name)).some((n) => /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(n))) errors++;
            continue;
          }
          const s = lstatSync2(p);
          if (s.isSymbolicLink() || !s.isFile() || s.nlink > 1 || !inside2(realpathSync2.native(this.root), realpathSync2.native(p))) {
            errors++;
            continue;
          }
          files.push(p);
          if (files.length > 512) throw new MonitorError("AGENT_RESOURCE_LIMIT");
        }
      } catch (e) {
        if (e instanceof MonitorError) throw e;
        errors++;
      }
    }
    return { files: files.sort(), errors };
  }
  decode(bytes) {
    if (this.decodeBudget <= 0) throw new MonitorError("AGENT_CYCLE_BUDGET");
    try {
      return decodeFrames(bytes, Math.min(128 * 1024 * 1024, this.decodeBudget), (n) => {
        this.decodeBudget -= n;
      });
    } catch (e) {
      if (safeCode(e) === "AGENT_DECOMPRESSION_FAILED") {
        const limited = this.decodeBudget < 32 * 1024 * 1024;
        this.decodeBudget = Math.max(0, this.decodeBudget - 32 * 1024 * 1024);
        if (limited) throw new MonitorError("AGENT_CYCLE_BUDGET");
      }
      throw e;
    }
  }
  scanFile(path, key, now) {
    const db2 = this.store.db;
    const old = db2.prepare("SELECT * FROM agent_files WHERE file_key=?").get(key);
    const fd = openSync(path, "r");
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.nlink > 1 || lstatSync2(path).isSymbolicLink() || !inside2(realpathSync2.native(this.root), realpathSync2.native(path))) throw new MonitorError("AGENT_SOURCE_CHANGED");
      guardPaths(path, this.output);
      const identity2 = fileIdentity(s);
      const prefix = Buffer.alloc(Math.min(s.size, 65536));
      const gotPrefix = readSync(fd, prefix, 0, prefix.length, 0);
      const prefixEnd = frameEnd(prefix.subarray(0, gotPrefix), 0);
      if (prefixEnd === null) throw new MonitorError("AGENT_HEADER_PENDING");
      const firstRows = this.decode(prefix.subarray(0, prefixEnd)).rows;
      const currentHeader = header(firstRows[0]);
      let previous = null, corrupt = false;
      if (old?.state) {
        try {
          previous = JSON.parse(String(old.state));
          if (!previous || typeof previous !== "object" || Array.isArray(previous) || typeof previous.last_seq !== "number" || !Number.isInteger(previous.last_seq) || previous.last_seq < -1) corrupt = true;
        } catch {
          corrupt = true;
        }
      }
      const headerChanged = previous !== null && ["id", "parent_id", "is_child", "is_seeded", "depth", "created_at"].some((k) => previous[k] !== currentHeader[k]);
      const reset = !!old && (corrupt || headerChanged || old.identity !== identity2 || s.size < Number(old.source_size) || s.size === Number(old.source_size) && s.mtimeMs !== old.mtime);
      const generation = old ? Number(old.generation) + (reset ? 1 : 0) : 1;
      const offset = old && !reset ? Number(old.byte_offset) : 0;
      if (s.size - offset > BATCH && (offset === 0 && (!old?.state || reset))) throw new MonitorError("AGENT_RESOURCE_LIMIT");
      if (Math.min(BATCH, s.size - offset) > this.readBudget) throw new MonitorError("AGENT_CYCLE_BUDGET");
      this.readBudget -= Math.min(BATCH, s.size - offset);
      const bytes = Buffer.alloc(Math.min(BATCH, s.size - offset));
      let n = 0;
      while (n < bytes.length) {
        const got = readSync(fd, bytes, n, bytes.length - n, offset + n);
        if (!got) throw new MonitorError("AGENT_SOURCE_CHANGED");
        n += got;
      }
      const frames = this.decode(bytes);
      const rows = frames.rows;
      let state = old && !reset ? previous : null;
      const initial = state === null;
      if (!state) {
        if (!rows.length) throw new MonitorError("AGENT_HEADER_PENDING");
        state = header(rows.shift());
      }
      const events = normalize(state, rows, initial);
      const after = fstatSync(fd);
      if (fileIdentity(after) !== identity2 || after.size < s.size || after.size === s.size && after.mtimeMs !== s.mtimeMs) throw new MonitorError("AGENT_SOURCE_CHANGED");
      if (reset) this.store.gap("agent-source-rewritten", "known-source-gap");
      const status2 = frames.pending ? "pending-tail" : offset + frames.consumed < s.size ? "catching-up" : "parsed";
      const json = JSON.stringify(state);
      db2.prepare("INSERT INTO agent_files VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(file_key) DO UPDATE SET identity=excluded.identity,generation=excluded.generation,byte_offset=excluded.byte_offset,source_size=excluded.source_size,mtime=excluded.mtime,state=excluded.state,status=excluded.status,scanned_at=excluded.scanned_at").run(key, identity2, generation, offset + frames.consumed, s.size, s.mtimeMs, json, status2, now);
      db2.prepare("INSERT INTO agent_sessions VALUES(?,?,?,?,?,?) ON CONFLICT(file_key,generation) DO UPDATE SET state=excluded.state").run(key, generation, state.id, state.parent_id, state.is_child ? 1 : 0, json);
      if (Number(db2.prepare("SELECT count(*) n FROM agent_events").get().n) + events.length > 1e5) throw new MonitorError("AGENT_EVENT_LIMIT");
      const insert = db2.prepare("INSERT INTO agent_events(file_key,generation,seq,at,kind,sender_id,recipient_id,payload) VALUES(?,?,?,?,?,?,?,?)");
      for (const e of events) insert.run(key, generation, e.seq, e.at, e.kind, e.sender_id, e.recipient_id, JSON.stringify(e));
      return { parsed: 1, pending: status2 === "parsed" ? 0 : 1 };
    } finally {
      closeSync(fd);
    }
  }
  cycle() {
    const db2 = this.store.db, now = Date.now();
    this.readBudget = 128 * 1024 * 1024;
    this.decodeBudget = 256 * 1024 * 1024;
    db2.exec("BEGIN IMMEDIATE");
    try {
      let discovery;
      try {
        discovery = this.discover();
      } catch (e) {
        const status3 = safeCode(e);
        db2.prepare("INSERT OR REPLACE INTO agent_scan VALUES(1,?,?,0,0,1,0,1)").run(now, status3);
        db2.exec("COMMIT");
        return { status: status3, files: 0, parsed: 0, errors: 1, pending: 0 };
      }
      if (!Number.isInteger(this.maxFilesPerCycle) || this.maxFilesPerCycle < 1 || this.maxFilesPerCycle > 512) throw new MonitorError("INVALID_SCAN_BUDGET");
      const all = discovery.files.map((path) => ({ path, key: createHash3("sha256").update(relative2(this.root, path)).digest("hex") }));
      let ordered = all;
      if (this.maxFilesPerCycle < 512) {
        ordered = all.slice().sort((a, b) => a.key.localeCompare(b.key));
        const cursor = String(db2.prepare("SELECT value FROM monitor_meta WHERE key='agent_rotation_cursor'").get()?.value ?? "");
        const found = ordered.findIndex((file) => file.key > cursor), start = found < 0 ? 0 : found;
        ordered = [...ordered.slice(start), ...ordered.slice(0, start)];
      }
      const selected = ordered.slice(0, this.maxFilesPerCycle), deferred = all.length - selected.length;
      let parsed = 0, errors = 0, pending = deferred, budgetLimited = false;
      const seen = all.map((file) => file.key);
      for (const { path, key } of selected) {
        db2.exec("SAVEPOINT agent_file");
        try {
          const r = this.scanFile(path, key, now);
          parsed += r.parsed;
          pending += r.pending;
          db2.exec("RELEASE agent_file");
        } catch (e) {
          db2.exec("ROLLBACK TO agent_file; RELEASE agent_file");
          const code = safeCode(e);
          if (code === "AGENT_CYCLE_BUDGET") budgetLimited = true;
          if (["AGENT_SEED_BOUNDARY_MISSING", "AGENT_HEADER_PENDING", "AGENT_CYCLE_BUDGET"].includes(code)) pending++;
          else errors++;
          db2.prepare("INSERT INTO agent_files VALUES(?,'unknown',1,0,0,0,NULL,?,?) ON CONFLICT(file_key) DO UPDATE SET status=excluded.status,scanned_at=excluded.scanned_at").run(key, code, now);
        }
      }
      if (this.maxFilesPerCycle < 512 && selected.length) {
        const cursor = (budgetLimited ? selected[0] : selected.at(-1)).key;
        db2.prepare("INSERT INTO monitor_meta VALUES('agent_rotation_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(cursor);
      }
      const missing = db2.prepare("SELECT file_key FROM agent_files").all().filter((r) => !seen.includes(String(r.file_key)));
      for (const row of missing) db2.prepare("UPDATE agent_files SET status=?,scanned_at=? WHERE file_key=?").run(discovery.errors ? "discovery-unknown" : "source-missing", now, row.file_key);
      if (!discovery.errors) errors += missing.length;
      const status2 = errors || discovery.errors ? "partial-error" : pending ? "pending" : "scanned";
      db2.prepare("INSERT OR REPLACE INTO agent_scan VALUES(1,?,?,?,?,?,?,?)").run(now, status2, discovery.files.length, parsed, errors, pending, discovery.errors);
      this.store.gap("subagents-not-collected", "partial-persisted-logs");
      db2.exec("COMMIT");
      return { status: status2, files: discovery.files.length, parsed, errors, pending, discoveryErrors: discovery.errors, deferred };
    } catch (e) {
      db2.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.store.close();
  }
};

// packages/monitor/src/conversation/artifacts.ts
import { createHash as createHash5 } from "node:crypto";
import { existsSync as existsSync5, lstatSync as lstatSync3, realpathSync as realpathSync3, openSync as openSync2, fstatSync as fstatSync2, readSync as readSync2, closeSync as closeSync2 } from "node:fs";
import { resolve as resolve4, relative as relative3, isAbsolute as isAbsolute3, basename, extname, sep } from "node:path";

// packages/monitor/src/query.ts
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";

// packages/monitor/src/runtime/health.ts
import { createHash as createHash4 } from "node:crypto";
function databaseId(path) {
  return createHash4("sha256").update(identity(path)).digest("hex");
}

// packages/monitor/src/conversation/artifacts.ts
var BACKFILL = ["PHASE2-REPORT.md", "PHASE3-REPORT.md", "PHASE4-REPORT.md", "docs/dashboard.jpg", "docs/phase4-agents.jpg"];
var textTypes = /* @__PURE__ */ new Set([".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".css", ".json", ".csv", ".yaml", ".yml", ".log"]);
var attachmentTypes = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".pdf", ".zip", ".svg", ".html", ".docx", ".xlsx", ".pptx"]);
var hash = (s) => createHash5("sha256").update(s).digest("hex");
var within = (root, p) => {
  const r = relative3(root, p);
  return !!r && !r.startsWith("..") && !isAbsolute3(r);
};
function projectKey(root) {
  const s = realpathSync3.native(root);
  return hash(process.platform === "win32" ? s.toLowerCase() : s);
}
function artifactLocation(root, input) {
  if (typeof input !== "string" || input.length > 800 || /[\x00-\x1f]|\[REDACTED\]|^[a-z]+:\/\//i.test(input)) throw new MonitorError("ARTIFACT_PATH_DENIED");
  const p = resolve4(root, input.replace(/[\\/]/g, sep));
  if (!within(root, p)) throw new MonitorError("ARTIFACT_PATH_DENIED");
  const rel = relative3(root, p).replaceAll(sep, "/");
  if (rel.split("/").some((x) => x.startsWith(".") || ["node_modules", "data"].includes(x)) || /(?:secret|password|passwd|credential|private[-_]?key|token)/i.test(rel)) throw new MonitorError("ARTIFACT_PATH_DENIED");
  if (!textTypes.has(extname(rel).toLowerCase()) && !attachmentTypes.has(extname(rel).toLowerCase())) throw new MonitorError("ARTIFACT_TYPE_UNSUPPORTED");
  return rel;
}
function safeStat(root, rel) {
  const p = resolve4(root, rel);
  if (!within(root, p)) throw new MonitorError("ARTIFACT_PATH_DENIED");
  let cursor = root;
  for (const part of relative3(root, p).split(sep)) {
    cursor = resolve4(cursor, part);
    if (!existsSync5(cursor)) throw new MonitorError("ARTIFACT_MISSING");
    if (lstatSync3(cursor).isSymbolicLink()) throw new MonitorError("ARTIFACT_PATH_DENIED");
  }
  const stat = lstatSync3(p);
  if (!stat.isFile() || stat.nlink > 1 || !within(realpathSync3.native(root), realpathSync3.native(p))) throw new MonitorError("ARTIFACT_PATH_DENIED");
  return { path: p, stat };
}
function status(root, rel) {
  try {
    safeStat(root, rel);
    return "available";
  } catch (e) {
    return e instanceof MonitorError && e.code === "ARTIFACT_MISSING" ? "missing" : e instanceof MonitorError ? "denied" : "unknown";
  }
}
var ArtifactIndexer = class {
  store;
  root;
  backfill;
  constructor(database, root, backfill = BACKFILL) {
    this.backfill = backfill;
    this.root = realpathSync3.native(root);
    for (const p of [database, `${database}-wal`, `${database}-shm`]) if (existsSync5(p) && (lstatSync3(p).isSymbolicLink() || lstatSync3(p).nlink > 1)) throw new MonitorError("UNSAFE_OUTPUT_PATH");
    this.store = new MonitorStore(database);
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS artifact_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_registry(id TEXT PRIMARY KEY,relative_path TEXT NOT NULL UNIQUE,name TEXT NOT NULL,type TEXT NOT NULL,availability TEXT NOT NULL,checked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_links(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL,collab TEXT,message_id TEXT,task_id TEXT,evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('message-declared','task-declared','path-only')),source TEXT NOT NULL,declared_at INTEGER,observed_at INTEGER NOT NULL,note TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_artifact_links_scope ON artifact_links(collab,message_id);`);
    if (!this.store.db.prepare("PRAGMA table_info(artifact_links)").all().some((r) => r.name === "declared_by")) this.store.db.exec("ALTER TABLE artifact_links ADD COLUMN declared_by TEXT NOT NULL DEFAULT 'unknown'");
    this.store.db.prepare("INSERT OR IGNORE INTO artifact_meta VALUES('project',?)").run(projectKey(this.root));
    if (this.store.db.prepare("SELECT value FROM artifact_meta WHERE key='project'").get().value !== projectKey(this.root)) {
      this.store.close();
      throw new MonitorError("ARTIFACT_PROJECT_MISMATCH");
    }
  }
  cycle() {
    const db2 = this.store.db, now = Date.now();
    db2.exec("BEGIN IMMEDIATE");
    try {
      const register = (path, link) => {
        let rel;
        try {
          rel = artifactLocation(this.root, path);
        } catch {
          return;
        }
        const id = "a_" + hash(rel.toLowerCase()).slice(0, 24), name = redactText(basename(rel));
        db2.prepare("INSERT INTO artifact_registry VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET availability=excluded.availability,checked_at=excluded.checked_at").run(id, rel, name, extname(rel).slice(1), status(this.root, rel), now);
        const linkId = "l_" + hash(JSON.stringify([id, link.source, link.origin])).slice(0, 24);
        db2.prepare("INSERT INTO artifact_links VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET message_id=excluded.message_id WHERE artifact_links.source='manual-backfill' AND artifact_links.message_id IS NULL AND excluded.message_id IS NOT NULL").run(linkId, id, link.collab, link.message, link.task, link.evidence, link.source, link.at, now, link.note, redactText(link.by ?? (link.source === "manual-backfill" ? "codex" : "unknown")));
      };
      const anchor = db2.prepare("SELECT json_extract(payload,'$.id') AS id FROM source_rows WHERE table_name='messages' AND collab='default' AND source_present=1 AND instr(COALESCE(json_extract(payload,'$.body'),''),?)>0 ORDER BY CASE WHEN json_extract(payload,'$.kind')='evidence' THEN 0 ELSE 1 END,CAST(row_key AS INTEGER) LIMIT 1");
      for (const rel of this.backfill) register(rel, { collab: "default", message: anchor.get(basename(rel))?.id ?? null, task: null, evidence: "path-only", source: "manual-backfill", at: null, origin: rel, note: "\u5DF2\u77E5\u9636\u6BB5\u4EA7\u7269\u8865\u5F55\uFF1B\u951A\u70B9\u4EC5\u4E3A\u6587\u4EF6\u540D\u63D0\u53CA\uFF0C\u5386\u53F2\u7248\u672C\u672A\u7559\u5B58" });
      const rows = db2.prepare("SELECT row_key,table_name,collab,payload FROM source_rows WHERE table_name IN ('messages','tasks') AND source_present=1 LIMIT 100001").all();
      if (rows.length > 1e5) throw new MonitorError("ARTIFACT_INDEX_LIMIT");
      let candidates = 0;
      for (const row of rows) {
        const data = JSON.parse(String(row.payload)), collab = row.collab == null ? null : String(row.collab);
        let entries2 = [];
        const task = row.table_name === "tasks";
        if (task) {
          try {
            const v = typeof data.artifacts === "string" ? JSON.parse(data.artifacts) : data.artifacts;
            if (Array.isArray(v)) entries2 = v.slice(0, 32);
          } catch {
          }
        } else if (typeof data.body === "string" && ["codex", "dsh"].includes(data.sender)) {
          const blocks = [...data.body.matchAll(/```monitor-artifacts\s*\r?\n([\s\S]*?)```/g)].slice(0, 4);
          for (const b of blocks) {
            if (b[1].length > 16384) continue;
            try {
              const v = JSON.parse(b[1]);
              if (Array.isArray(v)) entries2.push(...v.slice(0, 32));
            } catch {
            }
          }
        }
        for (const [i, v] of entries2.entries()) {
          if (++candidates > 5e3) throw new MonitorError("ARTIFACT_INDEX_LIMIT");
          const obj = v && typeof v === "object" ? v : {};
          register(typeof v === "string" ? v : obj.path ?? obj.file ?? obj.location, { collab, message: task ? null : String(data.id), task: task ? String(data.id) : null, evidence: task ? "task-declared" : "message-declared", source: task ? "task-artifacts" : "explicit-message", at: Number(data.updated_at ?? data.created_at), origin: `${row.table_name}:${row.row_key}:${i}`, note: task ? "\u4EFB\u52A1\u58F0\u660E\u6587\u4EF6\uFF0C\u672A\u63A8\u65AD\u5177\u4F53\u6D88\u606F\u8F6E\u6B21" : "\u8BE5\u6D88\u606F\u660E\u786E\u58F0\u660E\uFF0C\u672A\u9A8C\u8BC1\u5386\u53F2\u5185\u5BB9\u7248\u672C", by: String(task ? data.assignee ?? data.creator ?? "unknown" : data.sender) });
        }
      }
      db2.exec("COMMIT");
      return { files: Number(db2.prepare("SELECT count(*) n FROM artifact_registry").get().n), links: Number(db2.prepare("SELECT count(*) n FROM artifact_links").get().n) };
    } catch (e) {
      db2.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.store.close();
  }
};

// packages/monitor/src/runtime/scheduler.ts
var JobScheduler = class {
  jobs = [];
  running = false;
  intervalMs;
  maxBackoffMs;
  clock;
  constructor(intervalMs = 5e3, maxBackoffMs = 6e4, clock = Date.now) {
    this.intervalMs = intervalMs;
    this.maxBackoffMs = maxBackoffMs;
    this.clock = clock;
  }
  add(name, run) {
    this.jobs.push({ run, state: { name, phase: "waiting", runs: 0, failures: 0, lastStarted: null, lastCompleted: null, lastSuccess: null, durationMs: 0, nextAt: 0, code: null, metrics: {} } });
  }
  snapshot() {
    return this.jobs.map((job) => structuredClone(job.state));
  }
  async tick(changed = () => {
  }) {
    if (this.running) return false;
    this.running = true;
    try {
      for (const job of this.jobs) {
        if (this.clock() < job.state.nextAt) continue;
        const s = job.state;
        s.phase = "running";
        s.lastStarted = this.clock();
        s.runs++;
        changed();
        try {
          const outcome = await job.run();
          s.phase = outcome.degraded ? "degraded" : "ok";
          s.failures = 0;
          s.code = outcome.code ?? null;
          s.metrics = outcome.metrics ?? {};
          if (!outcome.degraded) s.lastSuccess = this.clock();
        } catch (error) {
          s.phase = "error";
          s.failures++;
          s.code = safeCode(error);
        }
        s.lastCompleted = this.clock();
        s.durationMs = Math.max(0, s.lastCompleted - s.lastStarted);
        s.nextAt = s.lastCompleted + Math.min(this.maxBackoffMs, this.intervalMs * 2 ** Math.min(s.failures, 6));
        changed();
      }
      return true;
    } finally {
      this.running = false;
    }
  }
};

// packages/monitor/src/maintenance/database.ts
import { DatabaseSync as DatabaseSync4, backup } from "node:sqlite";
import { existsSync as existsSync6, lstatSync as lstatSync4, mkdirSync as mkdirSync3, openSync as openSync3, closeSync as closeSync3, fstatSync as fstatSync3, readFileSync as readFileSync2, writeFileSync, createReadStream } from "node:fs";
import { dirname as dirname3, resolve as resolve5, relative as relative4, isAbsolute as isAbsolute4 } from "node:path";
import { createHash as createHash6 } from "node:crypto";
var inside3 = (root, path) => {
  const r = relative4(resolve5(root), resolve5(path));
  return r === "" || !r.startsWith("..") && !isAbsolute4(r);
};
var protectedRoots = [dirname3(settings().source), settings().sessions];
function safePath(input, write = false) {
  const path = resolve5(input);
  if (write && protectedRoots.some((root) => inside3(root, path))) throw new MonitorError("UNSAFE_OUTPUT_PATH");
  const parts = [];
  let p = path;
  while (dirname3(p) !== p) {
    parts.push(p);
    p = dirname3(p);
  }
  for (const file of parts.reverse()) if (existsSync6(file)) {
    const s = lstatSync4(file);
    if (s.isSymbolicLink() || s.isFile() && s.nlink > 1) throw new MonitorError("UNSAFE_OUTPUT_PATH");
  }
  return path;
}
function readonly(path) {
  safePath(path);
  const db2 = new DatabaseSync4(path, { readOnly: true });
  try {
    db2.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000");
    const version = monitorVersion(db2);
    validateMonitorLayout(db2, version < SCHEMA_VERSION);
    return db2;
  } catch (error) {
    db2.close();
    throw error;
  }
}
function reserve(path) {
  safePath(path, true);
  for (const file of [path, path + "-wal", path + "-shm", path + "-journal", path + ".manifest.json"]) if (existsSync6(file)) throw new MonitorError("BACKUP_TARGET_EXISTS");
  mkdirSync3(dirname3(path), { recursive: true });
  const fd = openSync3(path, "wx");
  return { fd, stat: fstatSync3(fd) };
}
async function hashFile(path) {
  const hash2 = createHash6("sha256");
  for await (const bytes of createReadStream(path)) hash2.update(bytes);
  return hash2.digest("hex");
}
function integrity(db2) {
  if (db2.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new MonitorError("BACKUP_INVALID");
}
async function snapshotCopy(source, destination) {
  if (resolve5(source) === resolve5(destination)) throw new MonitorError("BACKUP_TARGET_EXISTS");
  const db2 = readonly(source);
  let slot;
  try {
    slot = reserve(destination);
    await backup(db2, destination, { rate: 64 });
    const now = lstatSync4(destination);
    if (now.ino !== slot.stat.ino || now.dev !== slot.stat.dev || now.nlink !== 1 || now.isSymbolicLink()) throw new MonitorError("UNSAFE_OUTPUT_PATH");
    const check = readonly(destination);
    try {
      integrity(check);
    } finally {
      check.close();
    }
  } finally {
    db2.close();
    if (slot) closeSync3(slot.fd);
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
  const manifest = { application: "gpt-dsh-monitor-backup", createdAt: Date.now(), schemaVersion: version, sha256, bytes: lstatSync4(destination).size, sourceIdentity: createHash6("sha256").update(original).digest("hex") };
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
  const db2 = readonly(path);
  try {
    integrity(db2);
    const schemaVersion = monitorVersion(db2), bytes = lstatSync4(path).size;
    if (schemaVersion !== manifest.schemaVersion || bytes !== manifest.bytes) throw new MonitorError("BACKUP_MANIFEST_INVALID");
    return { ok: true, schemaVersion, sha256: manifest.sha256, bytes };
  } finally {
    db2.close();
  }
}
async function migrateMonitor(database, backupPath) {
  const original = identity(database), manifest = await backupMonitor(database, backupPath);
  await verifyBackup(backupPath);
  if (identity(database) !== original) throw new MonitorError("MONITOR_REPLACED");
  const store2 = new MonitorStore(database, { allowLegacyUpgrade: true });
  try {
    return { ok: true, schemaVersion: monitorVersion(store2.db), backupSha256: manifest.sha256 };
  } finally {
    store2.close();
  }
}

// packages/monitor/src/runtime/worker.ts
var options = workerData;
if (!parentPort) throw new MonitorError("WORKER_REQUIRED");
guardOutputLocation(options.source, options.output);
agentOutputPath(options.sessions, options.output);
try {
  guardPaths(options.source, options.output);
} catch (error) {
  if (!(error instanceof MonitorError) || error.code !== "SOURCE_UNAVAILABLE") throw error;
}
if (existsSync7(options.output)) {
  const probe = new DatabaseSync5(options.output, { readOnly: true });
  let version;
  try {
    version = monitorVersion(probe);
  } finally {
    probe.close();
  }
  if (version < SCHEMA_VERSION) await migrateMonitor(options.output, options.output + ".pre-v2-" + options.owner + ".sqlite");
}
var store = new MonitorStore(options.output);
var db = store.db;
var alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};
db.exec("BEGIN IMMEDIATE");
try {
  const lease = db.prepare("SELECT owner,pid FROM collector_lease WHERE id=1").get();
  if (lease && lease.owner !== options.owner && alive(Number(lease.pid))) throw new MonitorError("COLLECTOR_ALREADY_RUNNING");
  db.prepare("INSERT OR REPLACE INTO collector_lease VALUES(1,?,?,?)").run(options.owner, process.pid, Date.now());
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  store.close();
  throw error;
}
var bridge;
var agents;
var artifacts;
var stopped = false;
var scheduler = new JobScheduler(options.intervalMs);
scheduler.add("bridge", () => {
  bridge ??= new Collector(options.source, options.output);
  const result = bridge.cycle();
  return { metrics: { added: Number(result.added ?? 0), changed: Number(result.changed ?? 0) } };
});
scheduler.add("agents", () => {
  agents ??= new AgentCollector(options.sessions, options.output);
  agents.maxFilesPerCycle = 32;
  const result = agents.cycle();
  if (!["scanned", "pending", "partial-error"].includes(result.status)) throw new MonitorError(result.status);
  return { degraded: result.errors > 0, code: result.errors ? "AGENT_SCAN_PARTIAL" : void 0, metrics: { files: result.files, parsed: result.parsed, pending: result.pending, errors: result.errors, deferred: result.deferred ?? 0 } };
});
scheduler.add("artifacts", () => {
  artifacts ??= new ArtifactIndexer(options.output, options.project, []);
  const result = artifacts.cycle();
  return { metrics: { files: result.files, links: result.links } };
});
var startedAt = Date.now();
var fingerprint = databaseId(options.output);
var lastStored = 0;
function publish() {
  const value = { owner: options.owner, databaseId: fingerprint, pid: process.pid, updatedAt: Date.now(), startedAt, stopped, intervalMs: options.intervalMs, rssBytes: process.memoryUsage().rss, heapBytes: process.memoryUsage().heapUsed, restarts: options.restarts, jobs: scheduler.snapshot() };
  if (stopped || value.updatedAt - lastStored >= 5e3) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO monitor_runtime VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload").run(value.updatedAt, JSON.stringify(value));
      db.prepare("UPDATE collector_lease SET heartbeat=? WHERE id=1 AND owner=?").run(value.updatedAt, options.owner);
      db.exec("COMMIT");
      lastStored = value.updatedAt;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
  parentPort.postMessage(value);
}
var timer;
async function loop() {
  if (stopped) return;
  try {
    await scheduler.tick(publish);
    publish();
  } catch {
    parentPort.postMessage({ error: "WORKER_STATE_WRITE_FAILED" });
  }
  if (!stopped) timer = setTimeout(() => void loop(), Math.min(options.intervalMs, 1e3));
}
parentPort.on("message", (message) => {
  if (message !== "stop" || stopped) return;
  stopped = true;
  if (timer) clearTimeout(timer);
  try {
    publish();
  } finally {
    try {
      bridge?.close();
      agents?.close();
      artifacts?.close();
      db.prepare("DELETE FROM collector_lease WHERE owner=?").run(options.owner);
    } finally {
      store.close();
      parentPort.close();
    }
  }
});
void loop().catch((error) => {
  parentPort.postMessage({ error: safeCode(error) });
  process.exitCode = 1;
  parentPort.close();
});
