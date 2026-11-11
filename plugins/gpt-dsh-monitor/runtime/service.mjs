import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);

// bin/service.ts
import { createServer as createServer2 } from "node:http";
import { existsSync as existsSync6, readFileSync as readFileSync3, writeFileSync, openSync as openSync2, closeSync as closeSync2, unlinkSync, lstatSync as lstatSync5 } from "node:fs";
import { join as join2, resolve as resolve4 } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID as randomUUID2 } from "node:crypto";

// packages/monitor/src/runtime/controller.ts
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
var CollectionController = class {
  worker = null;
  snapshot = null;
  error = null;
  restarts = 0;
  stopped = false;
  owner = randomUUID();
  timer;
  watchdog;
  lastMessage = Date.now();
  failures = 0;
  options;
  changed;
  workerURL;
  constructor(options, changed = () => {
  }, workerURL = new URL("./worker.mjs", import.meta.url)) {
    this.options = options;
    this.changed = changed;
    this.workerURL = workerURL;
    this.start();
    this.watchdog = setInterval(() => {
      if (this.worker && Date.now() - this.lastMessage > 9e4) {
        this.error = "COLLECTOR_WORKER_TIMEOUT";
        void this.worker.terminate();
      }
    }, 5e3);
    this.watchdog.unref();
  }
  start() {
    if (this.stopped) return;
    this.lastMessage = Date.now();
    this.snapshot = null;
    let worker;
    try {
      worker = new Worker(this.workerURL, { workerData: { ...this.options, owner: this.owner, restarts: this.restarts }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 }, stdout: true, stderr: true });
    } catch {
      this.error = "COLLECTOR_WORKER_START_FAILED";
      this.retry();
      return;
    }
    this.worker = worker;
    worker.stdout?.resume();
    worker.stderr?.resume();
    worker.on("message", (value) => {
      if (this.worker !== worker) return;
      this.lastMessage = Date.now();
      if (value.error) {
        this.error = "WORKER_STATE_WRITE_FAILED";
      } else {
        this.snapshot = value;
        this.error = null;
        this.failures = 0;
      }
      this.changed();
    });
    worker.on("error", (error) => {
      if (this.worker === worker) this.error = ["COLLECTOR_ALREADY_RUNNING", "MONITOR_UPGRADE_REQUIRED", "MONITOR_MIGRATION_REQUIRES_BACKUP", "UNSAFE_OUTPUT_PATH"].includes(error.message) ? error.message : "COLLECTOR_WORKER_FAILED";
    });
    worker.on("exit", () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.snapshot = null;
      if (this.stopped) return;
      this.error ??= "COLLECTOR_WORKER_EXITED";
      this.retry();
    });
  }
  retry() {
    if (this.stopped) return;
    this.restarts++;
    this.failures++;
    this.changed();
    this.timer = setTimeout(() => this.start(), Math.min(6e4, 1e3 * 2 ** Math.min(this.failures - 1, 6)));
  }
  runtime() {
    const bridge = this.snapshot?.jobs.find((j) => j.name === "bridge"), agent = this.snapshot?.jobs.find((j) => j.name === "agents");
    return { collecting: !this.stopped, lastError: this.error ?? (bridge?.phase === "error" ? bridge.code : null) ?? null, agentError: agent?.phase === "error" || agent?.phase === "degraded" ? agent.code : null, intervalMs: this.options.intervalMs, workerRestarts: this.restarts };
  }
  async close() {
    this.stopped = true;
    clearInterval(this.watchdog);
    if (this.timer) clearTimeout(this.timer);
    const worker = this.worker;
    if (!worker) return;
    await new Promise((resolve5) => {
      const timer = setTimeout(() => {
        void worker.terminate();
      }, 5e3);
      worker.once("exit", () => {
        clearTimeout(timer);
        resolve5();
      });
      worker.postMessage("stop");
    });
  }
};

// packages/monitor/src/server.ts
import { createServer } from "node:http";
import { readFileSync, existsSync as existsSync4, realpathSync as realpathSync3, statSync as statSync2 } from "node:fs";
import { resolve as resolve2, relative as relative2, extname as extname2, isAbsolute as isAbsolute2 } from "node:path";

// packages/monitor/src/query.ts
import { DatabaseSync } from "node:sqlite";

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

// packages/monitor/src/schema.ts
var SCHEMA_VERSION = 2;
function monitorVersion(db) {
  if (db.prepare("SELECT value FROM monitor_meta WHERE key='application'").get()?.value !== "gpt-dsh-monitor-v1") throw new MonitorError("NOT_MONITOR_DATABASE");
  const raw = db.prepare("SELECT value FROM monitor_meta WHERE key='schema_version'").get()?.value;
  if (raw === void 0) return 1;
  if (!/^\d+$/.test(String(raw)) || Number(raw) < 1) throw new MonitorError("MONITOR_SCHEMA_INVALID");
  const version = Number(raw);
  if (version > SCHEMA_VERSION) throw new MonitorError("MONITOR_UPGRADE_REQUIRED");
  return version;
}

// packages/monitor/src/runtime/health.ts
import { existsSync as existsSync2, lstatSync as lstatSync2 } from "node:fs";
import { createHash } from "node:crypto";

// packages/monitor/src/paths.ts
import { existsSync, realpathSync, statSync, lstatSync, mkdirSync } from "node:fs";
function identity(path) {
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}

// packages/monitor/src/runtime/health.ts
function databaseId(path) {
  return createHash("sha256").update(identity(path)).digest("hex");
}
function storedRuntime(db, path, now = Date.now()) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='monitor_runtime'").get()) return { live: false, snapshot: null };
  const row = db.prepare("SELECT updated_at,payload FROM monitor_runtime WHERE id=1").get();
  if (!row) return { live: false, snapshot: null };
  try {
    const value = JSON.parse(String(row.payload));
    if (value.databaseId !== databaseId(path) || !Array.isArray(value.jobs) || value.jobs.length > 3) return { live: false, snapshot: null };
    const live = !value.stopped && Number(row.updated_at) <= now + 1e3 && now - Number(row.updated_at) < 2e4;
    return { live, snapshot: value };
  } catch {
    return { live: false, snapshot: null };
  }
}
function healthSummary(db, path) {
  const version = monitorVersion(db), count = (table) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) ? Number(db.prepare(`SELECT count(*) n FROM ${table}`).get().n) : 0;
  const bytes = (file) => {
    try {
      return existsSync2(file) ? lstatSync2(file).size : 0;
    } catch {
      return 0;
    }
  };
  const pageSize = Number(db.prepare("PRAGMA page_size").get().page_size), pages = Number(db.prepare("PRAGMA page_count").get().page_count), freePages = Number(db.prepare("PRAGMA freelist_count").get().freelist_count);
  const counts = { currentRows: count("source_rows"), observations: count("observations"), agentEvents: count("agent_events"), files: count("artifact_registry") };
  const runtime = storedRuntime(db, path);
  const archives = db.prepare("SELECT name FROM sqlite_master WHERE name='retention_runs'").get() ? db.prepare("SELECT at,cutoff,watermark,removed FROM retention_runs ORDER BY id DESC LIMIT 10").all() : [];
  return { schemaVersion: version, collector: runtime.live ? "running" : runtime.snapshot?.stopped ? "stopped" : "not_confirmed", runtime: runtime.snapshot, database: { bytes: bytes(path), walBytes: bytes(path + "-wal"), allocatedBytes: pages * pageSize, reusableBytes: freePages * pageSize, counts }, retention: { mode: "keep-all-by-default", observationCap: 1e5, agentEventCap: 1e5, archived: archives }, warnings: [...counts.observations >= 9e4 ? ["OBSERVATIONS_NEAR_CAP"] : [], ...counts.agentEvents >= 9e4 ? ["AGENT_EVENTS_NEAR_CAP"] : []] };
}

// packages/monitor/src/query.ts
function integer(value, nullable = true) {
  if (value === null || value === "") {
    if (nullable) return null;
    throw new MonitorError("INVALID_FILTER");
  }
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) throw new MonitorError("INVALID_FILTER");
  return n;
}
function filters(params) {
  const collab = params.get("collab") ?? "__all__";
  const q = params.get("q") ?? "";
  const direction = params.get("direction") ?? "all";
  const status = params.get("status") ?? "all";
  if (collab.length > 200 || q.length > 200 || /[\x00-\x1f]/.test(collab + q)) throw new MonitorError("INVALID_FILTER");
  if (!["all", "gpt-dsh", "dsh-gpt", "broadcast"].includes(direction)) throw new MonitorError("INVALID_FILTER");
  if (!["all", "created", "accepted", "running", "done", "failed", "rejected", "transferred", "cancelled"].includes(status)) throw new MonitorError("INVALID_FILTER");
  const tests = params.get("includeTests") ?? "0";
  if (!["0", "1"].includes(tests)) throw new MonitorError("INVALID_FILTER");
  const from = integer(params.get("from")), to = integer(params.get("to")), before = integer(params.get("before"));
  const limit = integer(params.get("limit") ?? "30", false);
  if (limit < 1 || limit > 100 || from !== null && to !== null && from > to) throw new MonitorError("INVALID_FILTER");
  return { collab, q, direction, status, includeTests: tests === "1", from, to, before, limit };
}
function decode(row) {
  let value;
  try {
    value = JSON.parse(String(row.payload));
  } catch {
    throw new MonitorError("MONITOR_DATA_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MonitorError("MONITOR_DATA_INVALID");
  return { key: String(row.row_key), collab: row.collab == null ? null : String(row.collab), sourcePresent: row.source_present === 1, data: value };
}
var MonitorQuery = class {
  path;
  constructor(path) {
    this.path = path;
  }
  read(fn) {
    let db;
    try {
      db = new DatabaseSync(this.path, { readOnly: true });
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN");
      if (db.prepare("SELECT value FROM monitor_meta WHERE key='application'").get()?.value !== "gpt-dsh-monitor-v1") throw new MonitorError("NOT_MONITOR_DATABASE");
      monitorVersion(db);
      const result = fn(db);
      db.exec("COMMIT");
      return result;
    } catch (e) {
      if (e instanceof MonitorError) throw e;
      throw new MonitorError("MONITOR_UNAVAILABLE");
    } finally {
      db?.close();
    }
  }
  where(table, f, options = {}) {
    const sql = ["table_name=?", "source_present=1"];
    const values = [table];
    if (f.collab !== "__all__") {
      if (f.collab === "__unknown__") sql.push("collab IS NULL");
      else {
        sql.push("collab=?");
        values.push(f.collab);
      }
    }
    if (!f.includeTests && !options.ignoreTests) sql.push("(collab IS NULL OR (collab NOT GLOB 'test-*' AND collab NOT GLOB 'mcp-*'))");
    if (f.q) {
      const fields = table === "messages" ? ["subject", "body", "id", "reply_to", "source", "sender", "recipient", "kind", "state", "collab"] : ["title", "brief", "result", "id", "parent_id", "creator", "assignee", "state", "collab"];
      const content = fields.map((key) => `COALESCE(CAST(json_extract(payload,'$.${key}') AS TEXT),'')`).join("||char(10)||");
      sql.push(`instr(lower(${content}),lower(?))>0`);
      values.push(f.q);
    }
    if (f.from !== null) {
      sql.push("CAST(json_extract(payload,'$.created_at') AS INTEGER)>=?");
      values.push(f.from);
    }
    if (f.to !== null) {
      sql.push("CAST(json_extract(payload,'$.created_at') AS INTEGER)<=?");
      values.push(f.to);
    }
    if (table === "messages" && f.direction !== "all") {
      if (f.direction === "broadcast") sql.push("json_extract(payload,'$.recipient')='both'");
      else {
        sql.push("json_extract(payload,'$.sender')=? AND json_extract(payload,'$.recipient')=?");
        values.push(...f.direction === "gpt-dsh" ? ["codex", "dsh"] : ["dsh", "codex"]);
      }
    }
    if (table === "tasks" && f.status !== "all") {
      sql.push("json_extract(payload,'$.state')=?");
      values.push(f.status);
    }
    if (options.cursor && f.before !== null) {
      sql.push("CAST(row_key AS INTEGER)<?");
      values.push(f.before);
    }
    return { sql: sql.join(" AND "), values };
  }
  list(table, f) {
    return this.read((db) => {
      const page = this.where(table, f, { cursor: true });
      const all = this.where(table, f);
      const unhidden = this.where(table, f, { ignoreTests: true });
      const rows = db.prepare(`SELECT row_key,collab,source_present,payload FROM source_rows WHERE ${page.sql} ORDER BY CAST(row_key AS INTEGER) DESC LIMIT ?`).all(...page.values, f.limit + 1);
      const more = rows.length > f.limit;
      const items = rows.slice(0, f.limit).map((r) => decode(r));
      const total = Number(db.prepare(`SELECT count(*) n FROM source_rows WHERE ${all.sql}`).get(...all.values).n);
      const withTests = Number(db.prepare(`SELECT count(*) n FROM source_rows WHERE ${unhidden.sql}`).get(...unhidden.values).n);
      return { items, total, hiddenTests: Math.max(0, withTests - total), nextBefore: more ? Number(items.at(-1).key) : null };
    });
  }
  detail(table, id, f) {
    if (!id || id.length > 128) throw new MonitorError("INVALID_FILTER");
    return this.read((db) => {
      const scoped = { ...f, q: "", from: null, to: null, before: null, direction: "all", status: "all" };
      const base = this.where(table, scoped);
      const row = db.prepare(`SELECT row_key,collab,source_present,payload FROM source_rows WHERE ${base.sql} AND json_extract(payload,'$.id')=?`).get(...base.values, id);
      if (!row) throw new MonitorError("NOT_FOUND");
      const item = decode(row);
      const events = table === "tasks" ? db.prepare("SELECT row_key,collab,source_present,payload FROM source_rows WHERE table_name='task_events' AND source_present=1 AND json_extract(payload,'$.task_id')=? AND collab IS ? ORDER BY CAST(row_key AS INTEGER)").all(id, item.collab).map((r) => decode(r)) : [];
      return { item, events };
    });
  }
  overview(f, runtime) {
    return this.read((db) => {
      if (runtime.useStoredRuntime) {
        const stored = storedRuntime(db, this.path);
        const bridge = stored.snapshot?.jobs.find((job) => job.name === "bridge");
        runtime = { ...runtime, collecting: stored.live, lastError: stored.live && bridge?.phase === "error" ? bridge.code : null, intervalMs: stored.snapshot?.intervalMs ?? runtime.intervalMs };
      }
      const count = (table) => {
        const w = this.where(table, f);
        return Number(db.prepare(`SELECT count(*) n FROM source_rows WHERE ${w.sql}`).get(...w.values).n);
      };
      const checkpoints = db.prepare("SELECT table_name,row_count,captured_at FROM checkpoints ORDER BY table_name").all();
      const capturedAt = checkpoints.length ? Math.min(...checkpoints.map((r) => Number(r.captured_at))) : null;
      const ageMs = capturedAt === null ? null : Math.max(0, Date.now() - capturedAt);
      const storedGaps = db.prepare("SELECT code,status,first_seen_at,last_seen_at,occurrences FROM collection_gaps ORDER BY code").all();
      const hasError = runtime.lastError !== null || storedGaps.some((g) => g.status === "collection-error");
      const freshness = !runtime.collecting ? "snapshot" : hasError || ageMs === null || ageMs > 3e5 ? "error" : ageMs > runtime.intervalMs * 2 ? "stale" : "fresh";
      const collabs = db.prepare("SELECT collab,count(*) n FROM source_rows WHERE table_name='messages' AND source_present=1 GROUP BY collab ORDER BY collab").all().map((r) => ({ id: r.collab == null ? "__unknown__" : String(r.collab), count: Number(r.n), test: /^(test-|mcp-)/.test(String(r.collab)) }));
      return { messages: count("messages"), tasks: count("tasks"), capturedAt, ageMs, freshness, runtime, checkpoints, gaps: storedGaps, collabs, coverage: "bridge-persisted-only" };
    });
  }
};

// packages/monitor/src/subagents/query.ts
var AgentQuery = class {
  query;
  constructor(database) {
    this.query = new MonitorQuery(database);
  }
  summary() {
    return this.query.read((db) => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_scan'").get()) return { scan: null, children: 0, events: 0, coverage: "not-connected" };
      const scan = db.prepare("SELECT scanned_at,status,files,parsed,errors,pending,discovery_errors FROM agent_scan WHERE id=1").get() ?? null;
      const children = Number(db.prepare("SELECT count(*) n FROM agent_sessions s JOIN agent_files f ON s.file_key=f.file_key AND s.generation=f.generation WHERE is_child=1").get().n);
      const events = Number(db.prepare("SELECT count(*) n FROM agent_events").get().n);
      const issues = db.prepare("SELECT status,count(*) AS count FROM agent_files WHERE status NOT IN ('parsed','pending-tail') GROUP BY status ORDER BY status").all();
      return { scan, children, events, issues, coverage: "persisted-v4-selected-events", attribution: "unknown-collaboration" };
    });
  }
  sessions(q, before, limit) {
    if (q.length > 200 || /[\x00-\x1f]/.test(q)) throw new MonitorError("INVALID_FILTER");
    return this.query.read((db) => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE name='agent_sessions'").get()) return { items: [], total: 0, nextBefore: null };
      const where = "s.is_child=1 AND instr(lower(s.session_id||' '||COALESCE(s.parent_id,'')||' '||COALESCE(json_extract(s.state,'$.label'),'')),lower(?))>0";
      const total = Number(db.prepare(`SELECT count(*) n FROM agent_sessions s WHERE ${where}`).get(q).n);
      const rows = db.prepare(`SELECT s.rowid AS key,s.file_key,s.generation,s.state,f.status AS file_status,f.scanned_at,CASE WHEN s.generation=f.generation THEN 1 ELSE 0 END AS current FROM agent_sessions s JOIN agent_files f ON s.file_key=f.file_key WHERE ${where} AND (? IS NULL OR s.rowid<?) ORDER BY s.rowid DESC LIMIT ?`).all(q, before, before, limit + 1);
      const items = rows.slice(0, limit).map((r) => ({ key: Number(r.key), fileKey: r.file_key, generation: r.generation, current: !!r.current, fileStatus: r.file_status, scannedAt: r.scanned_at, state: JSON.parse(String(r.state)) }));
      return { items, total, nextBefore: rows.length > limit ? items.at(-1).key : null };
    });
  }
  events(file, generation, before, limit) {
    if (!/^[0-9a-f]{64}$/.test(file) || !Number.isSafeInteger(generation) || generation < 1) throw new MonitorError("INVALID_FILTER");
    return this.query.read((db) => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE name='agent_sessions'").get()) throw new MonitorError("NOT_FOUND");
      const session = db.prepare("SELECT state FROM agent_sessions WHERE file_key=? AND generation=? AND is_child=1").get(file, generation);
      if (!session) throw new MonitorError("NOT_FOUND");
      const state = JSON.parse(String(session.state));
      const source = db.prepare("SELECT generation,status,scanned_at FROM agent_files WHERE file_key=?").get(file);
      if (!source) throw new MonitorError("NOT_FOUND");
      const current = source.generation === generation;
      const where = `(e.file_key=? AND e.generation=?) OR (?=1 AND e.sender_id=? AND e.recipient_id=? AND e.kind IN ('received','settlement-notice') AND EXISTS(SELECT 1 FROM agent_files f WHERE f.file_key=e.file_key AND f.generation=e.generation))`;
      const values = [file, generation, current ? 1 : 0, state.id, state.parent_id];
      if (before !== null && !db.prepare(`SELECT 1 FROM agent_events e WHERE e.id=? AND (${where})`).get(before, ...values)) throw new MonitorError("AGENT_CURSOR_INVALID");
      const rows = db.prepare(`SELECT e.id,e.payload,s.session_id AS logged_in FROM agent_events e JOIN agent_sessions s ON s.file_key=e.file_key AND s.generation=e.generation WHERE (${where}) AND (? IS NULL OR (e.at,e.id)<(SELECT at,id FROM agent_events WHERE id=?)) ORDER BY e.at DESC,e.id DESC LIMIT ?`).all(...values, before, before, limit + 1);
      return { state, source: { current, status: source.status, scannedAt: source.scanned_at }, items: rows.slice(0, limit).map((r) => ({ key: Number(r.id), loggedIn: String(r.logged_in), ...JSON.parse(String(r.payload)) })), nextBefore: rows.length > limit ? Number(rows[limit - 1].id) : null };
    });
  }
};

// packages/monitor/src/conversation/artifacts.ts
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync3, lstatSync as lstatSync3, realpathSync as realpathSync2, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { resolve, relative, isAbsolute, basename, extname, sep } from "node:path";

// packages/monitor/src/store.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// packages/monitor/src/redaction.ts
var HIDDEN = "[REDACTED]";
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

// packages/monitor/src/conversation/artifacts.ts
var textTypes = /* @__PURE__ */ new Set([".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".css", ".json", ".csv", ".yaml", ".yml", ".log"]);
var attachmentTypes = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".pdf", ".zip", ".svg", ".html", ".docx", ".xlsx", ".pptx"]);
var safeImages = /* @__PURE__ */ new Set(["docs/dashboard.jpg", "docs/phase4-agents.jpg", "docs/phase5-chat.jpg", "docs/phase5-mcp.jpg"]);
var hash = (s) => createHash2("sha256").update(s).digest("hex");
var within = (root, p) => {
  const r = relative(root, p);
  return !!r && !r.startsWith("..") && !isAbsolute(r);
};
function projectKey(root) {
  const s = realpathSync2.native(root);
  return hash(process.platform === "win32" ? s.toLowerCase() : s);
}
function artifactLocation(root, input) {
  if (typeof input !== "string" || input.length > 800 || /[\x00-\x1f]|\[REDACTED\]|^[a-z]+:\/\//i.test(input)) throw new MonitorError("ARTIFACT_PATH_DENIED");
  const p = resolve(root, input.replace(/[\\/]/g, sep));
  if (!within(root, p)) throw new MonitorError("ARTIFACT_PATH_DENIED");
  const rel = relative(root, p).replaceAll(sep, "/");
  if (rel.split("/").some((x) => x.startsWith(".") || ["node_modules", "data"].includes(x)) || /(?:secret|password|passwd|credential|private[-_]?key|token)/i.test(rel)) throw new MonitorError("ARTIFACT_PATH_DENIED");
  if (!textTypes.has(extname(rel).toLowerCase()) && !attachmentTypes.has(extname(rel).toLowerCase())) throw new MonitorError("ARTIFACT_TYPE_UNSUPPORTED");
  return rel;
}
function safeStat(root, rel) {
  const p = resolve(root, rel);
  if (!within(root, p)) throw new MonitorError("ARTIFACT_PATH_DENIED");
  let cursor = root;
  for (const part of relative(root, p).split(sep)) {
    cursor = resolve(cursor, part);
    if (!existsSync3(cursor)) throw new MonitorError("ARTIFACT_MISSING");
    if (lstatSync3(cursor).isSymbolicLink()) throw new MonitorError("ARTIFACT_PATH_DENIED");
  }
  const stat = lstatSync3(p);
  if (!stat.isFile() || stat.nlink > 1 || !within(realpathSync2.native(root), realpathSync2.native(p))) throw new MonitorError("ARTIFACT_PATH_DENIED");
  return { path: p, stat };
}
var ArtifactQuery = class {
  query;
  root;
  constructor(database, root) {
    this.query = new MonitorQuery(database);
    this.root = realpathSync2.native(root);
  }
  list(f) {
    return this.query.read((db) => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE name='artifact_registry'").get()) return [];
      if (db.prepare("SELECT value FROM artifact_meta WHERE key='project'").get()?.value !== projectKey(this.root)) throw new MonitorError("ARTIFACT_PROJECT_MISMATCH");
      const wh = ["1=1"], values = [];
      if (f.collab === "__unknown__") wh.push("l.collab IS NULL");
      else if (f.collab !== "__all__") {
        wh.push("l.collab=?");
        values.push(f.collab);
      }
      if (!f.includeTests) wh.push("(l.collab IS NULL OR (l.collab NOT GLOB 'test-*' AND l.collab NOT GLOB 'mcp-*'))");
      const scopeTime = "CASE WHEN l.source='manual-backfill' AND l.message_id IS NOT NULL THEN (SELECT CAST(json_extract(payload,'$.created_at') AS INTEGER) FROM source_rows WHERE table_name='messages' AND json_extract(payload,'$.id')=l.message_id AND collab IS l.collab LIMIT 1) ELSE COALESCE(l.declared_at,l.observed_at) END";
      if (f.from !== null) {
        wh.push(`${scopeTime}>=?`);
        values.push(f.from);
      }
      if (f.to !== null) {
        wh.push(`${scopeTime}<=?`);
        values.push(f.to);
      }
      const messageScope = this.query.where("messages", { ...f, q: "", before: null });
      wh.push(`(l.message_id IS NULL OR EXISTS(SELECT 1 FROM source_rows WHERE ${messageScope.sql} AND collab IS l.collab AND json_extract(payload,'$.id')=l.message_id))`);
      values.push(...messageScope.values);
      wh.push("(l.task_id IS NULL OR EXISTS(SELECT 1 FROM source_rows t WHERE t.table_name='tasks' AND t.source_present=1 AND t.collab IS l.collab AND json_extract(t.payload,'$.id')=l.task_id))");
      const rows = db.prepare(`SELECT r.id,r.name,r.type,r.relative_path,r.availability,r.checked_at,l.id AS link_id,l.collab,l.message_id,l.task_id,l.evidence_kind,l.source,l.declared_at,l.observed_at,l.note,l.declared_by FROM artifact_registry r JOIN artifact_links l ON r.id=l.artifact_id WHERE ${wh.join(" AND ")} ORDER BY l.observed_at,r.name LIMIT 5001`).all(...values);
      if (rows.length > 5e3) throw new MonitorError("ARTIFACT_INDEX_LIMIT");
      const map = /* @__PURE__ */ new Map();
      for (const r of rows) {
        const id = String(r.id);
        let a = map.get(id);
        if (!a) {
          a = { id, name: String(r.name), type: String(r.type), previewable: textTypes.has("." + String(r.type).toLowerCase()) || safeImages.has(String(r.relative_path)), availability: String(r.availability), checkedAt: Number(r.checked_at), links: [] };
          map.set(id, a);
        }
        const link = { id: String(r.link_id), collab: r.collab == null ? null : String(r.collab), messageId: r.message_id == null ? null : String(r.message_id), taskId: r.task_id == null ? null : String(r.task_id), evidence: String(r.evidence_kind), source: String(r.source), declaredAt: r.declared_at == null ? null : Number(r.declared_at), observedAt: Number(r.observed_at), note: String(r.note), declaredBy: String(r.declared_by) };
        a.links.push(link);
      }
      return [...map.values()];
    });
  }
  preview(id, f) {
    if (!/^a_[0-9a-f]{24}$/.test(id)) throw new MonitorError("INVALID_FILTER");
    const artifact = this.list(f).find((a) => a.id === id);
    if (!artifact) throw new MonitorError("NOT_FOUND");
    const rel = this.query.read((db) => String(db.prepare("SELECT relative_path FROM artifact_registry WHERE id=?").get(id).relative_path));
    artifactLocation(this.root, rel);
    if (!artifact.previewable) throw new MonitorError("ARTIFACT_TYPE_UNSUPPORTED");
    const { path, stat } = safeStat(this.root, rel);
    const image = safeImages.has(rel), limit = image ? 4 * 1024 * 1024 : 512 * 1024;
    if (stat.size > limit) throw new MonitorError("ARTIFACT_TOO_LARGE");
    const fd = openSync(path, "r");
    let bytes;
    try {
      const s = fstatSync(fd);
      if (s.ino !== stat.ino || s.dev !== stat.dev || s.nlink > 1 || s.size !== stat.size) throw new MonitorError("ARTIFACT_CHANGED");
      safeStat(this.root, rel);
      bytes = Buffer.alloc(s.size);
      let n = 0;
      while (n < bytes.length) {
        const got = readSync(fd, bytes, n, bytes.length - n, n);
        if (!got) throw new MonitorError("ARTIFACT_CHANGED");
        n += got;
      }
      const after = fstatSync(fd);
      if (after.size !== s.size || after.mtimeMs !== s.mtimeMs) throw new MonitorError("ARTIFACT_CHANGED");
    } finally {
      closeSync(fd);
    }
    const notice = "\u5F53\u524D\u6587\u4EF6\u53EA\u8BFB\u9884\u89C8\uFF1B\u5386\u53F2\u7248\u672C\u672A\u7559\u5B58\uFF0C\u5B58\u5728\u4E0D\u8BC1\u660E\u5F53\u8F6E\u751F\u6210\u3002";
    if (image) {
      if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new MonitorError("ARTIFACT_TYPE_UNSUPPORTED");
      return { artifact, kind: "image", image: `data:image/jpeg;base64,${bytes.toString("base64")}`, notice };
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new MonitorError("ARTIFACT_ENCODING_UNSUPPORTED");
    }
    return { artifact, kind: "text", text: redactText(text), notice };
  }
};

// packages/monitor/src/conversation/grouping.ts
function deriveRounds(messages) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const groups = /* @__PURE__ */ new Map();
  for (const message of messages) {
    if (groups.has(message.id)) continue;
    const path = [], seen = /* @__PURE__ */ new Set();
    let id = message.id;
    let result;
    for (; ; ) {
      if (groups.has(id)) {
        result = groups.get(id);
        break;
      }
      if (seen.has(id)) {
        result = { root: [...path].sort()[0], issue: "reply-cycle" };
        break;
      }
      if (path.length >= 256) {
        result = { root: message.id, issue: "reply-chain-limit" };
        break;
      }
      const m = byId.get(id);
      if (!m) {
        result = { root: path.at(-1), issue: "reference-not-visible" };
        break;
      }
      seen.add(id);
      path.push(id);
      if (!m.reply) {
        result = { root: m.id, issue: null };
        break;
      }
      if (byId.has(m.reply) && (byId.get(m.reply).collab ?? null) !== (m.collab ?? null)) {
        result = { root: m.id, issue: "cross-collaboration-reference" };
        break;
      }
      id = m.reply;
    }
    for (const p of path) groups.set(p, result);
  }
  const rounds = /* @__PURE__ */ new Map();
  for (const m of messages) {
    const group = groups.get(m.id);
    const root = byId.get(group.root) ?? m;
    const round = rounds.get(group.root);
    if (round) round.count++;
    else rounds.set(group.root, { id: group.root, anchor: root.id, title: root.title || "\u672A\u547D\u540D\u4EA4\u6D41\u6BB5", at: root.at, count: 1, issue: group.issue });
  }
  return { groups, rounds: [...rounds.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)) };
}

// packages/monitor/src/conversation/query.ts
var ConversationQuery = class {
  query;
  constructor(database) {
    this.query = new MonitorQuery(database);
  }
  exportRound(f, files, anchor) {
    const page = this.page({ ...f, limit: 1, before: null }, files, anchor);
    const root = page.items[0]?.roundId;
    if (!root) throw new MonitorError("ANCHOR_NOT_VISIBLE");
    return this.query.read((db) => {
      const w = this.query.where("messages", { ...f, q: "", before: null });
      const rows = db.prepare(`SELECT row_key,collab,json_extract(payload,'$.id') id,json_extract(payload,'$.reply_to') reply,json_extract(payload,'$.subject') title,CAST(json_extract(payload,'$.created_at') AS INTEGER) at FROM source_rows WHERE ${w.sql} ORDER BY at,CAST(row_key AS INTEGER) LIMIT 20001`).all(...w.values);
      if (rows.length > 2e4) throw new MonitorError("CONVERSATION_LIMIT");
      const meta = rows.map((r) => ({ id: String(r.id), reply: r.reply == null ? null : String(r.reply), title: String(r.title ?? ""), at: Number(r.at), seq: Number(r.row_key), collab: r.collab == null ? null : String(r.collab) }));
      const groups = deriveRounds(meta).groups, chosen = meta.filter((m) => groups.get(m.id)?.root === root);
      if (chosen.length > 500) throw new MonitorError("EXPORT_LIMIT");
      const safe = (s) => s.replace(/[\\`*_{}\[\]()#+.!|<>]/g, "\\$&").replace(/[\r\n]/g, " ");
      let markdown = `# ${safe(page.rounds.find((r) => r.id === root)?.title ?? "\u4EA4\u6D41\u6BB5")}

\u53EA\u8BFB\u901A\u4FE1\u8BB0\u5F55\u5BFC\u51FA\u3002\u5185\u5BB9\u5DF2\u8FC7\u6EE4\uFF1B\u8F6E\u6B21\u6309\u56DE\u590D\u5173\u8054\u6574\u7406\uFF0C\u6587\u4EF6\u58F0\u660E\u4E0D\u8BC1\u660E\u751F\u6210\u65F6\u95F4\uFF0C\u5386\u53F2\u6587\u4EF6\u7248\u672C\u672A\u7559\u5B58\u3002

`;
      const get = db.prepare("SELECT payload FROM source_rows WHERE table_name='messages' AND row_key=? AND source_present=1");
      for (const m of chosen) {
        const row = get.get(String(m.seq));
        if (!row) continue;
        const d = JSON.parse(String(row.payload));
        const body = String(d.body ?? "");
        const runs = body.match(/`+/g) ?? [];
        const fence = "`".repeat(runs.reduce((max, s) => Math.max(max, s.length + 1), 3));
        markdown += `## ${d.sender === "codex" ? "GPT" : "DSH"} \xB7 ${new Date(m.at).toISOString()}

${safe(m.title)}

\u6D88\u606F\u7F16\u53F7\uFF1A${m.id}

${fence}text
${body}
${fence}

`;
        for (const a of files.filter((a2) => a2.links.some((l) => l.messageId === m.id))) markdown += `- \u6587\u4EF6\uFF1A${safe(a.name)}\uFF1B\u6765\u6E90\uFF1A${a.links.some((l) => l.source === "manual-backfill") ? "\u8865\u5F55\u5173\u8054" : "\u6D88\u606F/\u4EFB\u52A1\u58F0\u660E"}\uFF1B\u53EF\u7528\u6027\uFF1A${a.availability}\uFF1B\u5386\u53F2\u7248\u672C\u672A\u7559\u5B58
`;
        if (Buffer.byteLength(markdown) > 1024 * 1024) throw new MonitorError("EXPORT_LIMIT");
      }
      return { filename: `conversation-${root}.md`, markdown, messages: chosen.length };
    });
  }
  page(f, files, anchor, after = null) {
    if (anchor && !/^m_[0-9a-f]{12}$/.test(anchor)) throw new MonitorError("INVALID_FILTER");
    if (after !== null && (!Number.isSafeInteger(after) || after < 0)) throw new MonitorError("INVALID_FILTER");
    return this.query.read((db) => {
      const base = this.query.where("messages", { ...f, q: "", before: null });
      const rows = db.prepare(`SELECT row_key,collab,json_extract(payload,'$.id') AS id,json_extract(payload,'$.reply_to') AS reply,json_extract(payload,'$.subject') AS title,CAST(json_extract(payload,'$.created_at') AS INTEGER) AS at FROM source_rows WHERE ${base.sql} ORDER BY at,CAST(row_key AS INTEGER) LIMIT 20001`).all(...base.values);
      if (rows.length > 2e4) throw new MonitorError("CONVERSATION_LIMIT");
      const metadata = rows.map((r) => ({ id: String(r.id), reply: r.reply == null ? null : String(r.reply), title: String(r.title ?? ""), at: Number(r.at), seq: Number(r.row_key), collab: r.collab == null ? null : String(r.collab) }));
      const grouped = deriveRounds(metadata);
      let end = metadata.length, start = Math.max(0, end - f.limit);
      if (anchor) {
        const index = metadata.findIndex((m) => m.id === anchor);
        if (index < 0) throw new MonitorError("ANCHOR_NOT_VISIBLE");
        start = Math.max(0, index - Math.floor(f.limit / 2));
        end = Math.min(metadata.length, start + f.limit);
      } else if (f.before !== null) {
        end = metadata.findIndex((m) => m.seq === f.before);
        if (end < 0) throw new MonitorError("CONVERSATION_CURSOR_INVALID");
        start = Math.max(0, end - f.limit);
      } else if (after !== null) {
        const index = metadata.findIndex((m) => m.seq === after);
        if (index < 0) throw new MonitorError("CONVERSATION_CURSOR_INVALID");
        start = index + 1;
        end = Math.min(metadata.length, start + f.limit);
      }
      const selected = metadata.slice(start, end);
      const get = db.prepare("SELECT row_key,collab,source_present,payload FROM source_rows WHERE table_name='messages' AND row_key=? AND source_present=1");
      const visibleIds = new Set(metadata.map((m) => m.id));
      const scopedFiles = files.map((a) => ({ ...a, links: a.links.filter((l) => l.messageId === null || visibleIds.has(l.messageId)) })).filter((a) => a.links.length);
      const items = selected.map((m) => {
        const r = get.get(String(m.seq));
        const item = { key: String(r.row_key), collab: r.collab == null ? null : String(r.collab), sourcePresent: true, data: JSON.parse(String(r.payload)) };
        const group = grouped.groups.get(m.id);
        return { ...item, roundId: group.root, relationIssue: group.issue, files: scopedFiles.filter((a) => a.links.some((l) => l.messageId === m.id)) };
      });
      const search = this.query.where("messages", { ...f, before: null });
      const hits = f.q ? db.prepare(`SELECT json_extract(payload,'$.id') AS id,json_extract(payload,'$.subject') AS title,CAST(json_extract(payload,'$.created_at') AS INTEGER) AS at FROM source_rows WHERE ${search.sql} ORDER BY at DESC LIMIT 100`).all(...search.values).map((r) => ({ id: String(r.id), title: String(r.title ?? "\u65E0\u6807\u9898\u8BB0\u5F55"), at: Number(r.at) })) : [];
      const unhidden = this.query.where("messages", { ...f, q: "", before: null }, { ignoreTests: true });
      const allCount = Number(db.prepare(`SELECT count(*) AS n FROM source_rows WHERE ${unhidden.sql}`).get(...unhidden.values).n);
      return { items, total: metadata.length, rounds: grouped.rounds.slice(-500), files: scopedFiles, hits, older: start > 0 ? metadata[start].seq : null, newer: end < metadata.length && end > 0 ? metadata[end - 1].seq : null, latestId: metadata.at(-1)?.id ?? null, hiddenTests: Math.max(0, allCount - metadata.length), navigationLimited: grouped.rounds.length > 500 };
    });
  }
};

// packages/monitor/src/conversation/service.ts
var ReadService = class {
  query;
  agents;
  artifacts;
  conversations;
  runtime;
  constructor(database, project, runtime) {
    this.query = new MonitorQuery(database);
    this.agents = new AgentQuery(database);
    this.artifacts = new ArtifactQuery(database, project);
    this.conversations = new ConversationQuery(database);
    this.runtime = runtime;
  }
  call(input) {
    const p = new URLSearchParams();
    for (const key of ["collab", "q", "direction", "from", "to", "before", "limit"]) if (input[key] !== void 0) p.set(key, String(input[key]));
    p.set("includeTests", input.includeTests ? "1" : "0");
    const f = filters(p);
    switch (input.action ?? "conversation") {
      case "health":
        return { ok: true, ...this.query.read((db) => healthSummary(db, this.query.path)) };
      case "conversation":
        return { ok: true, ...this.conversations.page(f, this.artifacts.list(f), input.anchor, input.after ?? null) };
      case "overview":
        return { ok: true, ...this.query.overview(f, this.runtime()), agentStatus: this.agents.summary() };
      case "preview":
        return { ok: true, ...this.artifacts.preview(input.id ?? "", f) };
      case "export":
        return { ok: true, ...this.conversations.exportRound(f, this.artifacts.list(f), input.anchor ?? "") };
      case "tasks":
        return { ok: true, ...this.query.list("tasks", f) };
      case "task":
        return { ok: true, ...this.query.detail("tasks", input.id ?? "", f), files: this.artifacts.list(f).filter((a) => a.links.some((l) => l.taskId === input.id)) };
      case "agents":
        return { ok: true, ...this.agents.sessions(f.q, f.before, f.limit), summary: this.agents.summary() };
      case "agent-events":
        return { ok: true, ...this.agents.events(input.file ?? "", input.generation ?? 0, f.before, f.limit) };
      default:
        throw new MonitorError("INVALID_ACTION");
    }
  }
  result(input) {
    try {
      return this.call(input);
    } catch (e) {
      return { ok: false, code: safeCode(e) };
    }
  }
};

// packages/monitor/src/server.ts
import { createHash as createHash3 } from "node:crypto";
function createDashboardServer(options) {
  if (!existsSync4(resolve2(options.assets, "index.html"))) throw new MonitorError("DASHBOARD_BUILD_REQUIRED");
  const query = new MonitorQuery(options.database);
  const agents = new AgentQuery(options.database);
  const service = options.project ? new ReadService(options.database, options.project, options.runtime) : null;
  const streams = /* @__PURE__ */ new Set();
  const appPath = resolve2(options.assets, "mcp-app.html");
  const appHtml = existsSync4(appPath) ? readFileSync(appPath, "utf8") : "";
  const appHashes = [...appHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash3("sha256").update(m[1]).digest("base64")}'`).join(" ");
  const send = (res, status, value) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  };
  const server = createServer((req, res) => {
    const csp = req.url?.split("?")[0] === "/mcp-app.html" ? `default-src 'none'; script-src ${appHashes}; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'` : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    res.setHeader("content-security-policy", csp);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    const expected = `127.0.0.1:${port}`;
    if (!["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") || req.headers.host !== expected || req.headers.origin && req.headers.origin !== `http://${expected}` || req.headers["sec-fetch-site"] === "cross-site") {
      send(res, 403, { ok: false, code: "LOCAL_ACCESS_ONLY" });
      return;
    }
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      send(res, 405, { ok: false, code: "READ_ONLY" });
      return;
    }
    try {
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) throw new MonitorError("INVALID_FILTER");
      const url = new URL(req.url, `http://${expected}`);
      const f = filters(url.searchParams);
      if (url.pathname === "/api/read") {
        if (!service) throw new MonitorError("NOT_FOUND");
        const input = { ...Object.fromEntries(url.searchParams), includeTests: f.includeTests };
        for (const key of ["from", "to", "before", "after", "limit", "generation"]) {
          const v = url.searchParams.get(key);
          if (v !== null) {
            if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new MonitorError("INVALID_FILTER");
            input[key] = Number(v);
          }
        }
        send(res, 200, service.call(input));
        return;
      }
      if (url.pathname === "/api/overview") {
        send(res, 200, { ok: true, ...query.overview(f, options.runtime()) });
        return;
      }
      if (url.pathname === "/api/agents/status") {
        send(res, 200, { ok: true, ...agents.summary(), runtime: options.runtime() });
        return;
      }
      if (url.pathname === "/api/agents") {
        send(res, 200, { ok: true, ...agents.sessions(f.q, f.before, f.limit) });
        return;
      }
      if (url.pathname === "/api/agents/events") {
        send(res, 200, { ok: true, ...agents.events(url.searchParams.get("file") ?? "", Number(url.searchParams.get("generation")), f.before, f.limit) });
        return;
      }
      if (url.pathname === "/api/messages" || url.pathname === "/api/tasks") {
        send(res, 200, { ok: true, ...query.list(url.pathname.endsWith("messages") ? "messages" : "tasks", f) });
        return;
      }
      if (url.pathname === "/api/message" || url.pathname === "/api/task") {
        send(res, 200, { ok: true, ...query.detail(url.pathname.endsWith("message") ? "messages" : "tasks", url.searchParams.get("id") ?? "", f) });
        return;
      }
      if (url.pathname === "/api/events") {
        if (streams.size >= 16) {
          send(res, 429, { ok: false, code: "TOO_MANY_STREAMS" });
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "connection": "keep-alive", "x-accel-buffering": "no" });
        res.write("retry: 5000\nevent: update\ndata: {}\n\n");
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
      }
      if (url.pathname.startsWith("/api/")) throw new MonitorError("NOT_FOUND");
      const asset = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      if (asset.includes("\\") || asset.includes("\0") || !asset.startsWith("assets/") && !["index.html", "legacy.html", "app-preview.html", "mcp-app.html"].includes(asset)) throw new MonitorError("NOT_FOUND");
      const root = realpathSync3(options.assets);
      const path = resolve2(root, asset);
      if (!existsSync4(path) || !statSync2(path).isFile()) throw new MonitorError("NOT_FOUND");
      const actual = realpathSync3(path);
      const r = relative2(root, actual);
      if (r.startsWith("..") || isAbsolute2(r)) throw new MonitorError("NOT_FOUND");
      const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
      res.writeHead(200, { "content-type": mime[extname2(path)] ?? "application/octet-stream" });
      res.end(readFileSync(path));
    } catch (error) {
      const code = safeCode(error);
      send(res, ["NOT_FOUND", "ARTIFACT_MISSING", "ANCHOR_NOT_VISIBLE"].includes(code) ? 404 : ["INVALID_FILTER", "INVALID_ACTION"].includes(code) ? 400 : code === "ARTIFACT_PATH_DENIED" ? 403 : code === "ARTIFACT_TOO_LARGE" ? 413 : ["AGENT_CURSOR_INVALID", "CONVERSATION_CURSOR_INVALID"].includes(code) ? 409 : 503, { ok: false, code });
    }
  });
  const heartbeat = setInterval(() => {
    for (const res of streams) res.write(": heartbeat\n\n");
  }, 15e3);
  heartbeat.unref();
  server.on("close", () => {
    clearInterval(heartbeat);
    for (const res of streams) res.end();
    streams.clear();
  });
  return {
    server,
    notify() {
      for (const res of streams) {
        if (res.writableLength > 65536) {
          res.destroy();
          streams.delete(res);
        } else res.write("event: update\ndata: {}\n\n");
      }
    },
    streamCount() {
      return streams.size;
    },
    closeStreams() {
      for (const res of streams) res.end();
      streams.clear();
    }
  };
}

// plugins/gpt-dsh-monitor/lib/config.mjs
import { homedir } from "node:os";
import { join, resolve as resolve3, dirname, isAbsolute as isAbsolute3 } from "node:path";
import { existsSync as existsSync5, lstatSync as lstatSync4, readFileSync as readFileSync2 } from "node:fs";
function dataHome(value = process.env.MONITOR_HOME) {
  return resolve3(value ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".local/share"), "BridgeBetween"));
}
function safePath(value) {
  const full = resolve3(value);
  let part = full;
  while (dirname(part) !== part) {
    if (existsSync5(part)) {
      const s = lstatSync4(part);
      if (s.isSymbolicLink() || s.isFile() && s.nlink > 1) throw Error("UNSAFE_PATH");
    }
    part = dirname(part);
  }
  return full;
}
function settings(value) {
  const home = dataHome(value), file = safePath(join(home, "settings.json"));
  let raw = {};
  if (existsSync5(file)) {
    raw = JSON.parse(readFileSync2(file, "utf8"));
    if (raw.application !== "gpt-dsh-monitor" || raw.schemaVersion !== 1) throw Error("SETTINGS_INVALID");
  }
  const path = (v, fallback) => {
    if (v !== void 0 && (typeof v !== "string" || !isAbsolute3(v))) throw Error("SETTINGS_INVALID");
    return resolve3(v ?? fallback);
  };
  const result = { ...raw, application: "gpt-dsh-monitor", schemaVersion: 1, home, database: path(raw.database, join(home, "monitor/monitor.sqlite")), source: path(raw.source, join(home, "bridge/data/bridge.sqlite")), sessions: path(raw.sessions, join(home, "empty-sessions")), project: path(raw.project, join(home, "project")), port: raw.port ?? 47832, bridgePort: raw.bridgePort ?? 47831, collab: raw.collab ?? "default", bridgeHome: join(home, "bridge") };
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535 || !Number.isInteger(result.bridgePort) || result.bridgePort < 1 || result.bridgePort > 65535 || typeof result.collab !== "string" || !/^[\w.-]{1,80}$/.test(result.collab)) throw Error("SETTINGS_INVALID");
  return result;
}

// bin/service.ts
async function runService(home, options) {
  const config = settings(home), root = resolve4(import.meta.dirname, ".."), record = safePath(join2(home, "instance.json")), owner = randomUUID2(), token = randomBytes(32).toString("hex");
  let slot, controller, app, bridge, control, closing = false;
  if (existsSync6(record)) {
    const prior = JSON.parse(readFileSync3(record, "utf8"));
    if (prior.application !== "gpt-dsh-monitor-service") throw Error("SERVICE_STATE_INVALID");
    let live = true;
    try {
      process.kill(prior.pid, 0);
    } catch (error) {
      live = error.code !== "ESRCH";
    }
    if (live) throw Error("SERVICE_STATE_UNCERTAIN");
    unlinkSync(record);
  }
  slot = openSync2(record, "wx", 384);
  writeFileSync(slot, JSON.stringify({ application: "gpt-dsh-monitor-service", pid: process.pid, owner, state: "starting" }));
  closeSync2(slot);
  slot = void 0;
  const identity2 = lstatSync5(record).ino;
  let finish;
  const finished = new Promise((r) => {
    finish = r;
  });
  async function close() {
    if (closing) return;
    closing = true;
    try {
      app?.closeStreams();
      await controller?.close();
      if (app) {
        app.server.closeAllConnections();
        await new Promise((r) => app.server.close(() => r()));
      }
      await bridge?.close();
      if (control) {
        control.closeAllConnections();
        await new Promise((r) => control.close(() => r()));
      }
    } finally {
      if (existsSync6(record) && lstatSync5(record).ino === identity2) unlinkSync(record);
      finish();
    }
  }
  try {
    if (options.bridge) {
      if (config.demo || resolve4(config.source) !== resolve4(join2(config.bridgeHome, "data/bridge.sqlite"))) throw Error("EXTERNAL_SOURCE_BRIDGE_START_DENIED");
      const mod = await import(pathToFileURL(join2(root, "components/bridge/server.mjs")).href), bridgeConfig = JSON.parse(readFileSync3(join2(config.bridgeHome, "config.json"), "utf8"));
      if (bridgeConfig.host && bridgeConfig.host !== "127.0.0.1") throw Error("LOCAL_ACCESS_ONLY");
      bridge = mod.createBridge({ ...bridgeConfig, host: "127.0.0.1", dataDir: join2(config.bridgeHome, "data"), port: config.bridgePort, defaultCollab: config.collab, collabAccess: { dsh: [config.collab], codex: [config.collab] } });
      await bridge.listen();
    }
    if (!existsSync6(config.source)) throw Error("SOURCE_UNAVAILABLE");
    app = createDashboardServer({ database: config.database, project: config.project, assets: join2(root, "dist"), runtime: () => controller?.runtime() ?? { collecting: false, lastError: null, intervalMs: 5e3 } });
    await new Promise((r, j) => {
      app.server.once("error", j);
      app.server.listen(config.port, "127.0.0.1", r);
    });
    process.env.MONITOR_HOME = home;
    controller = new CollectionController({ source: config.source, output: config.database, sessions: config.sessions, project: config.project, intervalMs: 5e3 });
    control = createServer2((req, res) => {
      const address2 = control.address(), port = typeof address2 === "object" && address2 ? address2.port : 0;
      if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (req.url === "/status" && req.method === "GET" || req.url === "/stop" && req.method === "POST") {
        const jobs = controller?.snapshot?.jobs ?? [], collector = jobs.some((j) => j.phase === "error") ? "degraded" : jobs.some((j) => j.name === "bridge" && j.lastSuccess) ? "running" : "starting";
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true, owner, collector, bridge: !!bridge, version: "0.7.0-beta.1", jobs: jobs.map((j) => ({ name: j.name, phase: j.phase, code: j.code })) }));
        if (req.url === "/stop") setImmediate(() => void close());
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r, j) => {
      control.once("error", j);
      control.listen(0, "127.0.0.1", r);
    });
    const address = control.address();
    writeFileSync(record, JSON.stringify({ application: "gpt-dsh-monitor-service", owner, token, port: address.port, pid: process.pid }), { mode: 384 });
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
    console.log(JSON.stringify({ ok: true, state: "running", url: `http://127.0.0.1:${config.port}`, bridge: !!bridge }));
    await finished;
  } catch (error) {
    await close();
    throw error;
  }
}
export {
  runService
};
