import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, linkSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { Collector } from '../src/collector.ts';
import { COLUMNS, TABLES, BridgeSource } from '../src/source.ts';
import { redact, redactText } from '../src/redaction.ts';
import { MonitorError } from '../src/errors.ts';
const PACKAGE_ROOT = resolve(import.meta.dirname, '..');

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'comm-monitor-verify-'));
  mkdirSync(join(root, 'source'));
  const source = join(root, 'source', 'bridge.sqlite');
  const output = join(root, 'monitor', 'monitor.sqlite');
  const db = new DatabaseSync(source);
  db.exec('PRAGMA journal_mode=WAL;');
  for (const table of TABLES) {
    const columns = COLUMNS[table].split(' ').map(c => c === 'seq' ? 'seq INTEGER PRIMARY KEY AUTOINCREMENT' : `${c} ${/^(version|at|.*_at)$/.test(c) ? 'INTEGER' : 'TEXT'}`);
    db.exec(`CREATE TABLE ${table}(${columns.join(',')}${table === 'record_docs' ? ',PRIMARY KEY(collab,key)' : ''})`);
  }
  db.exec("CREATE TABLE cursors(collab TEXT,participant TEXT,last_seq INTEGER); INSERT INTO cursors VALUES('default','dsh',11); CREATE TABLE budget(used_messages INTEGER); INSERT INTO budget VALUES(7)");
  function insert(table: string, row: Record<string, unknown>) {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(row) as any);
  }
  insert('messages', { seq: 2, id: 'm_0123456789ab', collab: 'default', sender: 'codex', recipient: 'dsh', kind: 'question', body: '可证明的消息', source: 'codex-mcp', state: 'saved', created_at: 1 });
  insert('messages', { seq: 9, id: 'm_abcdef012345', collab: 'default', sender: 'dsh', recipient: 'codex', kind: 'answer', reply_to: 'm_0123456789ab', body: '回复', source: 'dsh-plugin', state: 'saved', created_at: 2 });
  insert('tasks', { seq: 4, id: 't_0123456789ab', collab: 'default', title: '任务', assignee: 'dsh', creator: 'codex', state: 'created', deps: '[]', created_at: 1, updated_at: 1 });
  insert('task_events', { seq: 2, task_id: 't_0123456789ab', actor: 'codex', to_state: 'created', created_at: 1 });
  insert('record_docs', { collab: 'default', key: 'plan', version: 1, value: '{"goal":"只读"}', updated_by: 'dsh', updated_at: 1 });
  insert('record_history', { seq: 3, collab: 'default', key: 'plan', version: 1, value: '{"goal":"只读"}', updated_by: 'dsh', updated_at: 1 });
  insert('audit', { seq: 2, at: 1, actor: 'codex', action: 'message.send', detail: '{"id":"m_0123456789ab"}' });
  const collectors: Collector[] = [];
  function collect() { const c = new Collector(source, output); collectors.push(c); return c; }
  t.after(() => {
    for (const c of collectors) { try { c.close(); } catch {} }
    db.close();
    // Delete only the directory created by this test, never user paths.
    const r = relative(resolve(tmpdir()), resolve(root));
    assert.ok(!r.startsWith('..') && r.startsWith('comm-monitor-verify-'));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, source, output, db, insert, collect };
}
function rowDump(db: DatabaseSync) {
  return JSON.stringify([...TABLES, 'cursors', 'budget'].map(t => db.prepare(`SELECT * FROM ${t}`).all()));
}
function errorCode(code: string) { return (e: unknown) => e instanceof MonitorError && e.code === code; }

test('full backfill preserves explicit relationships, sparse seq and source rows/cursors/budget', t => {
  const f = fixture(t); const before = rowDump(f.db); const c = f.collect();
  assert.equal(c.cycle().added, 7);
  const p = c.store.db.prepare("SELECT payload FROM source_rows WHERE table_name='messages' AND row_key='9'").get();
  assert.equal(JSON.parse(String(p!.payload)).reply_to, 'm_0123456789ab');
  assert.equal(c.store.db.prepare("SELECT max_seq FROM checkpoints WHERE table_name='messages'").get()!.max_seq, 9);
  assert.equal(rowDump(f.db), before);
  assert.equal(c.cycle({ verify: true }).ok, true);
});
test('source SQL connection is actually read-only even with query_only disabled', t => {
  const f = fixture(t); const db = new DatabaseSync(f.source, { readOnly: true });
  try { db.exec('PRAGMA query_only=OFF'); assert.throws(() => db.exec("UPDATE messages SET state='read'")); }
  finally { db.close(); }
});
test('repeated collection and process restart do not duplicate observations', t => {
  const f = fixture(t); let c = f.collect(); c.cycle();
  assert.equal(c.cycle().added, 0);
  assert.equal(c.store.db.prepare('SELECT count(*) n FROM observations').get()!.n, 7);
  c.close(); c = f.collect(); assert.equal(c.cycle().changed, 0);
  assert.equal(c.store.db.prepare('SELECT count(*) n FROM observations').get()!.n, 7);
});
test('old message state, task result and current record updates are reobserved', t => {
  const f = fixture(t); const c = f.collect(); c.cycle();
  f.db.exec("UPDATE messages SET state='delivered',delivered_at=30 WHERE seq=2; UPDATE tasks SET state='done',result='完成',updated_at=30; UPDATE record_docs SET version=2,value='新版',updated_at=30");
  assert.equal(c.cycle().changed, 3);
  assert.equal(c.store.db.prepare("SELECT count(*) n FROM observations WHERE table_name='messages' AND row_key='2'").get()!.n, 2);
  assert.equal(c.cycle({ verify: true }).ok, true);
});
test('history larger than transcript cap backfills completely', t => {
  const f = fixture(t); for (let i = 20; i < 270; i++) f.insert('messages', { seq: i, id: `m_${i}`, collab: 'test-fixture', body: '历史', created_at: i });
  const c = f.collect(); c.cycle(); assert.equal(c.store.db.prepare("SELECT count(*) n FROM source_rows WHERE table_name='messages'").get()!.n, 252);
});
test('interruption rolls back data, observations, binding and checkpoints then recovers', t => {
  const f = fixture(t); const c = f.collect();
  assert.throws(() => c.cycle({ failAfter: 3 }), errorCode('SIMULATED_INTERRUPTION'));
  for (const table of ['source_rows', 'observations', 'source_binding', 'checkpoints']) assert.equal(c.store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
  assert.equal(c.cycle().added, 7);
  assert.equal(c.store.db.prepare("SELECT status FROM collection_gaps WHERE code='SIMULATED_INTERRUPTION'").get()!.status, 'recovered');
});
test('source deletion is a visible gap; old monitor data is retained', t => {
  const f = fixture(t); const c = f.collect(); c.cycle(); f.db.exec('DELETE FROM messages WHERE seq=2');
  assert.throws(() => c.cycle(), errorCode('SOURCE_HISTORY_CHANGED'));
  assert.equal(c.store.db.prepare('SELECT count(*) n FROM source_rows').get()!.n, 7);
});
test('schema additions stop collection without persisting unknown fields', t => {
  const f = fixture(t); const c = f.collect(); c.cycle(); f.db.exec('ALTER TABLE messages ADD COLUMN credential_blob TEXT');
  assert.throws(() => c.cycle(), errorCode('SOURCE_SCHEMA_CHANGED'));
  assert.equal(c.store.db.prepare("SELECT status FROM collection_gaps WHERE code='SOURCE_SCHEMA_CHANGED'").get()!.status, 'collection-error');
});
test('source replacement with identical schema and rows is detected', t => {
  const f = fixture(t); const c = f.collect(); c.cycle();
  const replacement = join(f.root, 'other.sqlite');
  // Test-owned source only: checkpoint the synthetic writer before copying an identical source.
  f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); copyFileSync(f.source, replacement);
  const original = c.source.path; c.source.path = replacement;
  assert.throws(() => c.cycle(), errorCode('SOURCE_REPLACED')); c.source.path = original;
});
test('audit uses action-specific ownership, unknowns remain unassigned', t => {
  const f = fixture(t);
  f.insert('audit', { seq: 7, at: 2, actor: 'dsh', action: 'record.patch', detail: '{"key":"facts","version":2}' });
  f.insert('audit', { seq: 11, at: 3, actor: 'dsh', action: 'codex.wake', detail: '{"collab":"default","ok":false}' });
  const c = f.collect(); c.cycle();
  assert.equal(c.store.db.prepare("SELECT collab FROM source_rows WHERE table_name='audit' AND row_key='2'").get()!.collab, 'default');
  assert.equal(c.store.db.prepare("SELECT collab FROM source_rows WHERE table_name='audit' AND row_key='7'").get()!.collab, null);
  assert.equal(c.store.db.prepare("SELECT collab FROM source_rows WHERE table_name='audit' AND row_key='11'").get()!.collab, 'default');
});
test('structured secrets, nested JSON, plaintext credentials and high entropy strings are redacted before disk', t => {
  const f = fixture(t);
  const secrets = ['sk-proj-TESTONLYabcdefghijklmnop123456', 'TESTONLY-short-password', 'AbCdEfGhIjKlMnOpQrStUvWx0123456789', 'TESTONLY multi word password'];
  f.db.prepare('UPDATE messages SET body=? WHERE seq=2').run(`普通消息\nAuthorization: Bearer ${secrets[0]}\npassword=${secrets[3]}\n${secrets[2]}`);
  f.db.prepare('UPDATE record_docs SET value=?').run(JSON.stringify({ api_key: secrets[0], nested: JSON.stringify({ password: secrets[1] }), safe: '保留普通正文' }));
  const c = f.collect(); c.cycle();
  const data = JSON.stringify(c.store.db.prepare('SELECT payload FROM source_rows UNION ALL SELECT payload FROM observations').all());
  assert.ok(data.includes('保留普通正文'));
  for (const secret of secrets) assert.ok(!data.includes(secret));
  for (const p of [f.output, `${f.output}-wal`, `${f.output}-shm`].filter(existsSync)) {
    const bytes = readFileSync(p);
    for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false);
  }
  c.close();
  const disk = readFileSync(f.output).toString('utf8');
  for (const secret of secrets) assert.ok(!disk.includes(secret));
});
test('redactor covers private keys, URL credentials, JSON keys and multiline text', () => {
  assert.ok(!redactText('https://name:TESTONLY-password@example.test').includes('TESTONLY-password'));
  assert.ok(!redactText('-----BEGIN PRIVATE KEY-----\nTESTONLY-PRIVATE\n-----END PRIVATE KEY-----').includes('TESTONLY-PRIVATE'));
  assert.equal((redact({ access_token: 'TESTONLY', text: '你好' }) as any).access_token, '[REDACTED]');
});
test('output inside source directory is rejected before writes', t => {
  const f = fixture(t);
  assert.throws(() => new Collector(f.source, f.source), errorCode('UNSAFE_OUTPUT_PATH'));
  assert.throws(() => new Collector(f.source, join(f.root, 'source', 'monitor.sqlite')), errorCode('UNSAFE_OUTPUT_PATH'));
});
test('output hardlink is rejected before writes when platform permits creating links', t => {
  const f = fixture(t); mkdirSync(join(f.root, 'monitor'));
  try { linkSync(f.source, f.output); } catch (e: any) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) { t.skip('Current environment cannot create hardlinks; requires independent supported-platform verification'); return; }
    throw e;
  }
  assert.throws(() => new Collector(f.source, f.output), errorCode('UNSAFE_OUTPUT_PATH'));
});
test('arbitrary existing database is rejected without changes', t => {
  const f = fixture(t); mkdirSync(join(f.root, 'monitor'));
  const d = new DatabaseSync(f.output); d.exec('CREATE TABLE unrelated(x); INSERT INTO unrelated VALUES(9)'); d.close();
  const before = readFileSync(f.output);
  assert.throws(() => f.collect(), errorCode('OUTPUT_NOT_MONITOR_DATABASE'));
  assert.deepEqual(readFileSync(f.output), before);
});
test('verify detects drift instead of silently updating rows', t => {
  const f = fixture(t); const c = f.collect(); c.cycle(); f.db.exec("UPDATE messages SET state='read' WHERE seq=9");
  assert.throws(() => c.cycle({ verify: true }), errorCode('VERIFY_MISMATCH_RUN_COLLECT'));
  assert.equal(c.cycle().changed, 1); assert.equal(c.cycle({ verify: true }).ok, true);
});
test('source snapshot releases WAL transaction before returning', t => {
  const f = fixture(t); const s = new BridgeSource(f.source); assert.equal(s.snapshot().rows.messages.length, 2);
  f.db.exec("UPDATE messages SET state='read' WHERE seq=9");
  assert.equal(s.snapshot().rows.messages[1].state, 'read');
});
test('CLI failure prints fixed code rather than source path or raw exception', t => {
  const f = fixture(t); const pathSecret = join(f.root, 'TESTONLY-password-do-not-print.sqlite');
  const child = spawnSync(process.execPath, [resolve(PACKAGE_ROOT,'src/cli.ts'), 'once', '--source', pathSecret, '--output', f.output], { encoding: 'utf8',cwd:PACKAGE_ROOT });
  assert.equal(child.status, 1); assert.ok(child.stderr.includes('SOURCE_UNAVAILABLE')); assert.ok(!child.stderr.includes(pathSecret));
});
test('explicitly accepting deletion preserves history and allows later restoration', t => {
  const f = fixture(t); const c = f.collect(); c.cycle(); const saved = f.db.prepare('SELECT * FROM messages WHERE seq=2').get()!;
  f.db.exec('DELETE FROM messages WHERE seq=2');
  assert.throws(() => c.cycle(), errorCode('SOURCE_HISTORY_CHANGED'));
  assert.equal(c.cycle({ acceptHistoryChange: true }).removed, 1);
  assert.equal(c.store.db.prepare("SELECT source_present FROM source_rows WHERE table_name='messages' AND row_key='2'").get()!.source_present, 0);
  assert.equal(c.cycle({ verify: true }).ok, true);
  // Restoring the owner also reassigns its audit row from unknown to default.
  f.insert('messages', saved); assert.equal(c.cycle().changed, 2);
  assert.equal(c.store.db.prepare("SELECT source_present FROM source_rows WHERE table_name='messages' AND row_key='2'").get()!.source_present, 1);
});
test('same row count delete-plus-insert is detected', t => {
  const f = fixture(t); const c = f.collect(); c.cycle(); f.db.exec('DELETE FROM messages WHERE seq=2');
  f.insert('messages', { seq: 10, id: 'm_000000000010', body: '新行' });
  assert.throws(() => c.cycle(), errorCode('SOURCE_HISTORY_CHANGED'));
});
test('structural UUID in audit JSON survives, secret keys and free text remain redacted', t => {
  const f = fixture(t); const uuid = '01a1489e-3798-7cc1-afa5-28fa07cc6956';
  f.insert('audit', { seq: 20, at: 2, actor: 'dsh', action: 'codex.wake', detail: JSON.stringify({ collab: 'default', session_id: uuid, wake_target: `session-${uuid}`, token: uuid }) });
  const c = f.collect(); c.cycle();
  const outer = JSON.parse(String(c.store.db.prepare("SELECT payload FROM source_rows WHERE table_name='audit' AND row_key='20'").get()!.payload));
  const detail = JSON.parse(outer.detail); assert.equal(detail.session_id, uuid); assert.equal(detail.wake_target, `session-${uuid}`); assert.equal(detail.token, '[REDACTED]');
  assert.equal(redactText(uuid), '[REDACTED]');
});
test('observation capacity degrades history without stopping current state or checkpoint', t => {
  const f = fixture(t); const c = f.collect(); c.store.observationLimit = 1;
  assert.equal(c.cycle().observationsSkipped, 6);
  assert.equal(c.store.db.prepare('SELECT count(*) n FROM source_rows').get()!.n, 7);
  f.db.exec("UPDATE messages SET state='read' WHERE seq=2");
  assert.equal(c.cycle().observationsSkipped, 1);
  assert.equal(c.store.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.equal(c.store.db.prepare("SELECT status FROM collection_gaps WHERE code='OBSERVATIONS_CAP_REACHED'").get()!.status, 'degraded-history');
  assert.equal(c.cycle({ verify: true }).ok, true);
});
test('current record checkpoint has NULL sequence and real row count', t => {
  const f = fixture(t); const c = f.collect(); c.cycle();
  const record = c.store.db.prepare("SELECT max_seq,row_count FROM checkpoints WHERE table_name='record_docs'").get()!;
  assert.equal(record.max_seq, null); assert.equal(record.row_count, 1);
});
test('abrupt child process exit during monitor transaction leaves no partial commit', t => {
  const f = fixture(t);
  const code = `import {Collector} from './src/collector.ts'; const c=new Collector(${JSON.stringify(f.source)},${JSON.stringify(f.output)}); c.store.db.exec("BEGIN IMMEDIATE; INSERT INTO observations(table_name,row_key,observed_at,payload,digest) VALUES('messages','crash',1,'test-only','test-only')"); process.exit(19);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8',cwd:PACKAGE_ROOT });
  assert.equal(child.status, 19);
  const c = f.collect(); assert.equal(c.store.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0); assert.equal(c.cycle().added, 7);
});
test('plaintext credential split after label is suppressed before persistence', () => {
  assert.ok(!redactText('Password:\nTESTONLY-short-secret').includes('TESTONLY-short-secret'));
  assert.ok(!redactText('the password is TESTONLY-short-secret').includes('TESTONLY-short-secret'));
});
test('two collector processes serialize snapshots and atomically consistent checkpoints',async t=>{
  const f=fixture(t);const marker=join(f.root,'writer-has-lock');const prefix=`import {Collector} from './src/collector.ts';import{writeFileSync}from'node:fs';const c=new Collector(${JSON.stringify(f.source)},${JSON.stringify(f.output)});`;
  function child(code:string){const p=spawn(process.execPath,['--input-type=module','-e',prefix+code],{cwd:PACKAGE_ROOT,stdio:['ignore','pipe','pipe']});const ended=new Promise<number|null>((resolve,reject)=>{p.on('error',reject);p.on('exit',resolve)});return {p,ended}}
  const first=child(`const read=c.source.snapshot.bind(c.source);c.source.snapshot=()=>{writeFileSync(${JSON.stringify(marker)},'test-only');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);return read()};try{c.cycle()}finally{c.close()}`);
  const deadline=Date.now()+5000;while(!existsSync(marker)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.ok(existsSync(marker));
  const second=child(`try{c.cycle()}finally{c.close()}`);
  const killTimer=setTimeout(()=>{first.p.kill();second.p.kill()},8000);
  try{assert.equal(await first.ended,0);assert.equal(await second.ended,0)}finally{clearTimeout(killTimer)}
  const c=f.collect();assert.equal(c.cycle({verify:true}).ok,true);assert.equal(c.store.db.prepare('SELECT count(*) n FROM observations').get()!.n,7);assert.equal(c.store.db.prepare("SELECT row_count FROM checkpoints WHERE table_name='messages'").get()!.row_count,2);
});
