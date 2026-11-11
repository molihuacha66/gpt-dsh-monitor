import {settings} from '../config.ts';
import { openSync, closeSync, fstatSync, readSync, readdirSync, lstatSync, realpathSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { MonitorStore } from '../store.ts';
import { MonitorError, safeCode } from '../errors.ts';
import { guardPaths } from '../paths.ts';
import { decodeFrames, frameEnd } from './zstd.ts';
import { header, normalize } from './normalize.ts';
import type { AgentState } from './normalize.ts';

export const DEFAULT_SESSIONS = settings().sessions;
const BATCH = 64 * 1024 * 1024;
const fileIdentity = (s: ReturnType<typeof fstatSync>) => `${s.dev}:${s.ino}:${s.birthtimeMs}`;
function inside(root: string, path: string) { const r = relative(root, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); }
function canonical(path: string): string { return existsSync(path) ? realpathSync.native(path) : resolve(canonical(dirname(path)), relative(dirname(path), path)); }
export function agentOutputPath(root: string, output: string): string {
  if (inside(canonical(resolve(root)), canonical(resolve(output)))) throw new MonitorError('UNSAFE_OUTPUT_PATH');
  // Reuse all sidecar/symlink/hardlink checks before opening the monitor DB.
  for (const p of [output, `${output}-wal`, `${output}-shm`, `${output}-journal`]) {
    if (existsSync(p)) { const s = lstatSync(p); if (!s.isFile() || s.isSymbolicLink() || s.nlink > 1) throw new MonitorError('UNSAFE_OUTPUT_PATH'); }
  }
  mkdirSync(dirname(resolve(output)), { recursive: true });
  return resolve(output);
}
export class AgentCollector {
  root: string; output: string; store: MonitorStore; readBudget = 128 * 1024 * 1024; decodeBudget = 256 * 1024 * 1024;
  maxFilesPerCycle=512;
  constructor(root: string, output: string) {
    this.root = resolve(root); this.output = agentOutputPath(this.root, output); this.store = new MonitorStore(this.output);
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
    const rootName = canonical(this.root);
    const rootKey = createHash('sha256').update(process.platform === 'win32' ? rootName.toLowerCase() : rootName).digest('hex');
    this.store.db.prepare('INSERT OR IGNORE INTO agent_source VALUES(1,?)').run(rootKey);
    if (this.store.db.prepare('SELECT root_key FROM agent_source WHERE id=1').get()!.root_key !== rootKey) {
      this.store.close(); throw new MonitorError('AGENT_SOURCE_REPLACED');
    }
  }
  discover(): { files: string[]; errors: number } {
    const files: string[] = []; let errors = 0;
    if (!existsSync(this.root)) throw new MonitorError('AGENT_SOURCE_MISSING');
    if (lstatSync(this.root).isSymbolicLink()) throw new MonitorError('AGENT_SOURCE_LINK');
    for (const project of readdirSync(this.root, { withFileTypes: true })) {
      if (project.isSymbolicLink()) { errors++; continue; }
      if (!project.isDirectory()) continue;
      try {
        for (const session of readdirSync(join(this.root, project.name), { withFileTypes: true })) {
          if (session.isSymbolicLink()) { errors++; continue; }
          if (!session.isDirectory()) continue;
          const p = join(this.root, project.name, session.name, 'session.v4.jsonl.zstd');
          if (!existsSync(p)) { if (readdirSync(join(this.root, project.name, session.name)).some(n => /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(n))) errors++; continue; }
          const s = lstatSync(p);
          if (s.isSymbolicLink() || !s.isFile() || s.nlink > 1 || !inside(realpathSync.native(this.root), realpathSync.native(p))) { errors++; continue; }
          files.push(p);
          if (files.length > 512) throw new MonitorError('AGENT_RESOURCE_LIMIT');
        }
      } catch (e) { if (e instanceof MonitorError) throw e; errors++; }
    }
    return { files: files.sort(), errors };
  }
  decode(bytes: Buffer) {
    if (this.decodeBudget <= 0) throw new MonitorError('AGENT_CYCLE_BUDGET');
    try { return decodeFrames(bytes, Math.min(128 * 1024 * 1024, this.decodeBudget), n => { this.decodeBudget -= n; }); }
    catch (e) {
      if (safeCode(e) === 'AGENT_DECOMPRESSION_FAILED') {
        const limited = this.decodeBudget < 32 * 1024 * 1024;
        this.decodeBudget = Math.max(0, this.decodeBudget - 32 * 1024 * 1024);
        if (limited) throw new MonitorError('AGENT_CYCLE_BUDGET');
      }
      throw e;
    }
  }
  scanFile(path: string, key: string, now: number) {
    const db = this.store.db;
    const old = db.prepare('SELECT * FROM agent_files WHERE file_key=?').get(key);
    const fd = openSync(path, 'r');
    try {
      const s = fstatSync(fd);
      // Also guard replacement between discovery and open.
      if (!s.isFile() || s.nlink > 1 || lstatSync(path).isSymbolicLink() || !inside(realpathSync.native(this.root), realpathSync.native(path))) throw new MonitorError('AGENT_SOURCE_CHANGED');
      guardPaths(path, this.output);
      const identity = fileIdentity(s);
      // Recheck the small independent header frame, even when the file only grew.
      const prefix = Buffer.alloc(Math.min(s.size, 65536));
      const gotPrefix = readSync(fd, prefix, 0, prefix.length, 0);
      const prefixEnd = frameEnd(prefix.subarray(0, gotPrefix), 0);
      if (prefixEnd === null) throw new MonitorError('AGENT_HEADER_PENDING');
      const firstRows = this.decode(prefix.subarray(0, prefixEnd)).rows;
      const currentHeader = header(firstRows[0]);
      let previous: AgentState | null = null, corrupt = false;
      if (old?.state) {
        try { previous = JSON.parse(String(old.state)) as AgentState; if (!previous || typeof previous !== 'object' || Array.isArray(previous) || typeof previous.last_seq !== 'number' || !Number.isInteger(previous.last_seq) || previous.last_seq < -1) corrupt = true; }
        catch { corrupt = true; }
      }
      const headerChanged = previous !== null && (['id','parent_id','is_child','is_seeded','depth','created_at'] as const).some(k => previous[k] !== currentHeader[k]);
      const reset = !!old && (corrupt || headerChanged || old.identity !== identity || s.size < Number(old.source_size) || (s.size === Number(old.source_size) && s.mtimeMs !== old.mtime));
      const generation = old ? Number(old.generation) + (reset ? 1 : 0) : 1;
      const offset = old && !reset ? Number(old.byte_offset) : 0;
      if (s.size - offset > BATCH && (offset === 0 && (!old?.state || reset))) throw new MonitorError('AGENT_RESOURCE_LIMIT');
      if (Math.min(BATCH, s.size - offset) > this.readBudget) throw new MonitorError('AGENT_CYCLE_BUDGET');
      this.readBudget -= Math.min(BATCH, s.size - offset);
      const bytes = Buffer.alloc(Math.min(BATCH, s.size - offset));
      let n = 0;
      while (n < bytes.length) { const got = readSync(fd, bytes, n, bytes.length - n, offset + n); if (!got) throw new MonitorError('AGENT_SOURCE_CHANGED'); n += got; }
      const frames = this.decode(bytes);
      const rows = frames.rows;
      let state: AgentState | null = old && !reset ? previous : null;
      const initial = state === null;
      if (!state) {
        if (!rows.length) throw new MonitorError('AGENT_HEADER_PENDING');
        state = header(rows.shift());
      }
      const events = normalize(state, rows, initial);
      const after = fstatSync(fd);
      if (fileIdentity(after) !== identity || after.size < s.size || (after.size === s.size && after.mtimeMs !== s.mtimeMs)) throw new MonitorError('AGENT_SOURCE_CHANGED');
      if (reset) this.store.gap('agent-source-rewritten', 'known-source-gap');
      const status = frames.pending ? 'pending-tail' : offset + frames.consumed < s.size ? 'catching-up' : 'parsed';
      const json = JSON.stringify(state);
      db.prepare('INSERT INTO agent_files VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(file_key) DO UPDATE SET identity=excluded.identity,generation=excluded.generation,byte_offset=excluded.byte_offset,source_size=excluded.source_size,mtime=excluded.mtime,state=excluded.state,status=excluded.status,scanned_at=excluded.scanned_at').run(key, identity, generation, offset + frames.consumed, s.size, s.mtimeMs, json, status, now);
      db.prepare('INSERT INTO agent_sessions VALUES(?,?,?,?,?,?) ON CONFLICT(file_key,generation) DO UPDATE SET state=excluded.state').run(key, generation, state.id, state.parent_id, state.is_child ? 1 : 0, json);
      if (Number(db.prepare('SELECT count(*) n FROM agent_events').get()!.n) + events.length > 100000) throw new MonitorError('AGENT_EVENT_LIMIT');
      const insert = db.prepare('INSERT INTO agent_events(file_key,generation,seq,at,kind,sender_id,recipient_id,payload) VALUES(?,?,?,?,?,?,?,?)');
      for (const e of events) insert.run(key, generation, e.seq, e.at, e.kind, e.sender_id, e.recipient_id, JSON.stringify(e));
      return { parsed: 1, pending: status === 'parsed' ? 0 : 1 };
    } finally { closeSync(fd); }
  }
  cycle():{status:string;files:number;parsed:number;errors:number;pending:number;discoveryErrors?:number;deferred?:number} {
    const db = this.store.db, now = Date.now();
    this.readBudget = 128 * 1024 * 1024;
    this.decodeBudget = 256 * 1024 * 1024;
    db.exec('BEGIN IMMEDIATE');
    try {
      let discovery: { files: string[]; errors: number };
      try { discovery = this.discover(); }
      catch (e) {
        const status = safeCode(e);
        db.prepare('INSERT OR REPLACE INTO agent_scan VALUES(1,?,?,0,0,1,0,1)').run(now, status);
        db.exec('COMMIT'); return { status, files: 0, parsed: 0, errors: 1, pending: 0 };
      }
      if(!Number.isInteger(this.maxFilesPerCycle)||this.maxFilesPerCycle<1||this.maxFilesPerCycle>512)throw new MonitorError('INVALID_SCAN_BUDGET');
      const all=discovery.files.map(path=>({path,key:createHash('sha256').update(relative(this.root,path)).digest('hex')}));
      let ordered=all;
      if(this.maxFilesPerCycle<512){
        ordered=all.slice().sort((a,b)=>a.key.localeCompare(b.key));
        const cursor=String(db.prepare("SELECT value FROM monitor_meta WHERE key='agent_rotation_cursor'").get()?.value??'');
        const found=ordered.findIndex(file=>file.key>cursor),start=found<0?0:found;ordered=[...ordered.slice(start),...ordered.slice(0,start)];
      }
      const selected=ordered.slice(0,this.maxFilesPerCycle),deferred=all.length-selected.length;
      let parsed = 0, errors = 0, pending = deferred,budgetLimited=false;
      const seen=all.map(file=>file.key);
      for (const {path,key} of selected) {
        // Hash only path metadata; never hash or copy raw communication content.
        db.exec('SAVEPOINT agent_file');
        try { const r = this.scanFile(path, key, now); parsed += r.parsed; pending += r.pending; db.exec('RELEASE agent_file'); }
        catch (e) {
          db.exec('ROLLBACK TO agent_file; RELEASE agent_file');
          const code = safeCode(e);
          if(code==='AGENT_CYCLE_BUDGET')budgetLimited=true;
          if (['AGENT_SEED_BOUNDARY_MISSING', 'AGENT_HEADER_PENDING', 'AGENT_CYCLE_BUDGET'].includes(code)) pending++; else errors++;
          db.prepare("INSERT INTO agent_files VALUES(?,'unknown',1,0,0,0,NULL,?,?) ON CONFLICT(file_key) DO UPDATE SET status=excluded.status,scanned_at=excluded.scanned_at").run(key, code, now);
        }
      }
      if(this.maxFilesPerCycle<512&&selected.length){
        // Budget failure shifts the first position next time; successful batches advance by the batch.
        const cursor=(budgetLimited?selected[0]:selected.at(-1))!.key;
        db.prepare("INSERT INTO monitor_meta VALUES('agent_rotation_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(cursor);
      }
      const missing = db.prepare('SELECT file_key FROM agent_files').all().filter(r => !seen.includes(String(r.file_key)));
      for (const row of missing) db.prepare('UPDATE agent_files SET status=?,scanned_at=? WHERE file_key=?').run(discovery.errors ? 'discovery-unknown' : 'source-missing', now, row.file_key);
      if (!discovery.errors) errors += missing.length;
      const status = errors || discovery.errors ? 'partial-error' : pending ? 'pending' : 'scanned';
      db.prepare('INSERT OR REPLACE INTO agent_scan VALUES(1,?,?,?,?,?,?,?)').run(now, status, discovery.files.length, parsed, errors, pending, discovery.errors);
      this.store.gap('subagents-not-collected', 'partial-persisted-logs');
      db.exec('COMMIT');
      return { status, files: discovery.files.length, parsed, errors, pending, discoveryErrors: discovery.errors,deferred };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  close() { this.store.close(); }
}
