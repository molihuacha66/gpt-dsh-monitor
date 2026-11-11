import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,appendFileSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {zstdCompressSync} from 'node:zlib';
import {createServer} from 'node:http';
import {MonitorStore} from '../src/store.ts';
import {MonitorQuery,filters} from '../src/query.ts';
import {monitorVersion} from '../src/schema.ts';
import {backupMonitor,verifyBackup,restoreMonitor,migrateMonitor,retentionPlan,archiveHistory} from '../src/maintenance/database.ts';
import {JobScheduler} from '../src/runtime/scheduler.ts';
import {CollectionController} from '../src/runtime/controller.ts';
import {storedRuntime,databaseId} from '../src/runtime/health.ts';
import {AgentCollector} from '../src/subagents/collector.ts';
import {BridgeSource,COLUMNS,TABLES} from '../src/source.ts';
import {createDashboardServer} from '../src/server.ts';
import {spawnSync} from 'node:child_process';

function fixture(t:any){
 const root=mkdtempSync(join(tmpdir(),'comm-monitor-operations-'));const close:(()=>void|Promise<void>)[]=[];
 const database=join(root,'monitor.sqlite'),store=new MonitorStore(database);close.push(()=>store.close());
 t.after(async()=>{for(const f of close.reverse())await f();const r=relative(resolve(tmpdir()),resolve(root));assert.ok(r&&!r.startsWith('..'));rmSync(root,{recursive:true,force:true})});
 const insert=(at=1)=>store.db.prepare('INSERT INTO observations(table_name,row_key,observed_at,payload,digest) VALUES(?,?,?,?,?)').run('messages','one',at,'{"body":"fixture"}','fixture');
 return {root,database,store,close,insert};
}
async function until(predicate:()=>boolean,timeout=10000){const start=Date.now();while(!predicate()){if(Date.now()-start>timeout)assert.fail('condition timed out');await new Promise(r=>setTimeout(r,25))}}
function sourceFile(root:string){
 const path=join(root,'source/bridge.sqlite');mkdirSync(join(root,'source'),{recursive:true});const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL');
 for(const table of TABLES){const columns=COLUMNS[table].split(' ').map(c=>c==='seq'?'seq INTEGER PRIMARY KEY AUTOINCREMENT':`${c} ${/^(version|at|.*_at)$/.test(c)?'INTEGER':'TEXT'}`);db.exec(`CREATE TABLE ${table}(${columns.join(',')}${table==='record_docs'?',PRIMARY KEY(collab,key)':''})`)}
 db.prepare("INSERT INTO messages(id,collab,sender,recipient,kind,body,state,created_at) VALUES(?,?,?,?,?,?,?,?)").run('m_0123456789ab','default','dsh','codex','answer','fixture','saved',1);
 return {path,db};
}
test('future schema is refused for both reads and writes without modifying it',t=>{
 const x=fixture(t);x.store.db.prepare("UPDATE monitor_meta SET value='999' WHERE key='schema_version'").run();
 assert.throws(()=>new MonitorStore(x.database),/MONITOR_UPGRADE_REQUIRED/);
 assert.throws(()=>new MonitorQuery(x.database).overview(filters(new URLSearchParams()),{collecting:false,lastError:null,intervalMs:5000}),/MONITOR_UPGRADE_REQUIRED/);
 assert.equal(x.store.db.prepare("SELECT value FROM monitor_meta WHERE key='schema_version'").get()!.value,'999');
});
test('legacy writes require a verified backup and migrate atomically with data intact',async t=>{
 const x=fixture(t);x.insert();x.store.db.exec("DELETE FROM monitor_meta WHERE key='schema_version';DROP TABLE monitor_runtime;DROP TABLE collector_lease;DROP TABLE retention_runs;");
 assert.throws(()=>new MonitorStore(x.database),/MONITOR_MIGRATION_REQUIRES_BACKUP/);
 const archive=join(x.root,'legacy.sqlite');await migrateMonitor(x.database,archive);
 assert.equal(monitorVersion(x.store.db),2);assert.equal(x.store.db.prepare('SELECT count(*) n FROM observations').get()!.n,1);
 assert.equal((await verifyBackup(archive)).schemaVersion,1);
});
test('SQLite backup includes committed WAL pages and leaves the input connection usable',async t=>{
 const x=fixture(t);x.insert();assert.ok(existsSync(x.database+'-wal'));
 const archive=join(x.root,'backup.sqlite');await backupMonitor(x.database,archive);
 const copy=new DatabaseSync(archive,{readOnly:true});try{assert.equal(copy.prepare('SELECT count(*) n FROM observations').get()!.n,1)}finally{copy.close()}
 x.insert();assert.equal(x.store.db.prepare('SELECT count(*) n FROM observations').get()!.n,2);assert.equal((await verifyBackup(archive)).ok,true);
});
test('backup target, orphan sidecar and hardlinked/symlink parents cannot be overwritten',async t=>{
 const x=fixture(t),existing=join(x.root,'existing');writeFileSync(existing,'keep');await assert.rejects(backupMonitor(x.database,existing),/BACKUP_TARGET_EXISTS/);assert.equal(readFileSync(existing,'utf8'),'keep');
 const sidecar=join(x.root,'sidecar.sqlite');writeFileSync(sidecar+'-wal','keep');await assert.rejects(backupMonitor(x.database,sidecar),/BACKUP_TARGET_EXISTS/);
 const elsewhere=join(x.root,'elsewhere');mkdirSync(elsewhere);symlinkSync(elsewhere,join(x.root,'linked'),'junction');await assert.rejects(backupMonitor(x.database,join(x.root,'linked/a.sqlite')),/UNSAFE_OUTPUT_PATH/);
});
test('damaged backup is rejected before creating a restore target',async t=>{
 const x=fixture(t),archive=join(x.root,'backup.sqlite'),destination=join(x.root,'restored.sqlite');await backupMonitor(x.database,archive);appendFileSync(archive,'damage');
 await assert.rejects(verifyBackup(archive),/BACKUP_HASH_MISMATCH/);await assert.rejects(restoreMonitor(archive,destination),/BACKUP_HASH_MISMATCH/);assert.equal(existsSync(destination),false);
});
test('restoring legacy data creates the new runtime tables and clears copied live status',async t=>{
 const x=fixture(t);x.insert();x.store.db.exec("DELETE FROM monitor_meta WHERE key='schema_version';DROP TABLE monitor_runtime;DROP TABLE collector_lease;DROP TABLE retention_runs;");
 const archive=join(x.root,'backup.sqlite'),destination=join(x.root,'restored.sqlite');await backupMonitor(x.database,archive);await restoreMonitor(archive,destination);
 const restored=new DatabaseSync(destination,{readOnly:true});try{assert.equal(monitorVersion(restored),2);assert.equal(restored.prepare('SELECT count(*) n FROM monitor_runtime').get()!.n,0);assert.equal(restored.prepare('SELECT count(*) n FROM observations').get()!.n,1)}finally{restored.close()}
 await assert.rejects(restoreMonitor(archive,destination),/BACKUP_TARGET_EXISTS/);
});
test('default retention is a dry run and never removes current data or observations',async t=>{
 const x=fixture(t);x.insert();const archive=join(x.root,'archive.sqlite');assert.equal(retentionPlan(x.database).candidates,1);assert.equal((await archiveHistory(x.database,archive,90,false)).mode,'dry-run');assert.equal(existsSync(archive),false);assert.equal(x.store.db.prepare('SELECT count(*) n FROM observations').get()!.n,1);
});
test('explicit archive verifies a full backup then removes only old observations',async t=>{
 const x=fixture(t);x.insert();x.insert(Date.now());x.store.db.exec("INSERT INTO source_rows VALUES('messages','one','default','{}','fixture',1,1,1);CREATE TABLE agent_events(id INTEGER PRIMARY KEY,payload TEXT);INSERT INTO agent_events VALUES(1,'{}');");
 const archive=join(x.root,'archive.sqlite');const result=await archiveHistory(x.database,archive,90,true);assert.equal(result.mode,'applied');assert.equal(x.store.db.prepare('SELECT count(*) n FROM observations').get()!.n,1);assert.equal(x.store.db.prepare('SELECT count(*) n FROM source_rows').get()!.n,1);assert.equal(x.store.db.prepare('SELECT count(*) n FROM agent_events').get()!.n,1);
 const old=new DatabaseSync(archive,{readOnly:true});try{assert.equal(old.prepare('SELECT count(*) n FROM observations').get()!.n,2)}finally{old.close()}
});
test('archive failure leaves history intact and cannot overwrite its destination',async t=>{
 const x=fixture(t);x.insert();const target=join(x.root,'occupied');writeFileSync(target,'keep');await assert.rejects(archiveHistory(x.database,target,90,true),/BACKUP_TARGET_EXISTS/);assert.equal(x.store.db.prepare('SELECT count(*) n FROM observations').get()!.n,1);assert.equal(readFileSync(target,'utf8'),'keep');
});
test('restored/copied runtime identity is never treated as the new database collector',t=>{
 const x=fixture(t);x.store.db.prepare('INSERT INTO monitor_runtime VALUES(1,?,?)').run(Date.now(),JSON.stringify({databaseId:'other',updatedAt:Date.now(),stopped:false,jobs:[]}));assert.equal(storedRuntime(x.store.db,x.database).live,false);assert.notEqual(databaseId(x.database),'other');
});
test('scheduler backs off one failing source without delaying another and resets on recovery',async()=>{
 let clock=1000,fail=true,bridge=0,agents=0;const s=new JobScheduler(100,1000,()=>clock);s.add('bridge',()=>{bridge++;if(fail)throw new Error('native error');return {}});s.add('agents',()=>{agents++;return {}});
 await s.tick();assert.equal(s.snapshot()[0].code,'IO_OR_DATABASE_ERROR');clock=1100;await s.tick();assert.equal(bridge,1);assert.equal(agents,2);fail=false;clock=1200;await s.tick();assert.equal(bridge,2);assert.equal(s.snapshot()[0].failures,0);
});
test('scheduler cannot overlap executions when a caller ticks again before completion',async()=>{
 let finish!:()=>void;const s=new JobScheduler();s.add('bridge',()=>new Promise(resolve=>{finish=()=>resolve({})}));const first=s.tick();assert.equal(await s.tick(),false);finish();await first;assert.equal(s.snapshot()[0].runs,1);
});
test('rotating agent scans retain full discovery and never mark deferred files missing',t=>{
 const x=fixture(t),sessions=join(x.root,'sessions');mkdirSync(sessions);for(let i=0;i<4;i++){const id=`4fad9b9d-6e2f-4aa8-9d3e-43f16aa3ca8${i}`,dir=join(sessions,'project',id);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'session.v4.jsonl.zstd'),zstdCompressSync(Buffer.from(JSON.stringify({type:'session',version:4,id,createdAt:1,parentSession:'session-36bf694d-84c7-4408-89cd-acdef7de655e',isSeeded:false,origin:'subagent',delegationDepth:1})+'\n')))}
 const c=new AgentCollector(sessions,x.database);x.close.push(()=>c.close());c.maxFilesPerCycle=1;for(let i=0;i<4;i++){const r=c.cycle();assert.equal(r.files,4);assert.equal(r.deferred,3)}assert.equal(x.store.db.prepare('SELECT count(*) n FROM agent_files').get()!.n,4);assert.equal(x.store.db.prepare("SELECT count(*) n FROM agent_files WHERE status='source-missing'").get()!.n,0);
});
test('source byte budget is checked without modifying or copying the source',t=>{
 const x=fixture(t),source=sourceFile(x.root);x.close.push(()=>source.db.close());const reader=new BridgeSource(source.path);reader.maxSnapshotBytes=1;assert.throws(()=>reader.snapshot(),/SOURCE_BYTE_LIMIT/);assert.equal(source.db.prepare('SELECT count(*) n FROM messages').get()!.n,1);
});
test('real worker recovers after termination without duplicating collected rows',async t=>{
 const x=fixture(t),source=sourceFile(x.root),sessions=join(x.root,'sessions');mkdirSync(sessions);x.close.push(()=>source.db.close());
 const c=new CollectionController({source:source.path,output:x.database,sessions,project:x.root,intervalMs:100});x.close.push(()=>c.close());
 await until(()=>c.snapshot?.jobs.find(j=>j.name==='bridge')?.phase==='ok');const before=Number(x.store.db.prepare('SELECT count(*) n FROM observations').get()!.n),thread=c.worker!.threadId,started=c.snapshot!.startedAt;await c.worker!.terminate();await until(()=>c.restarts>0&&!!c.worker&&c.worker.threadId!==thread&&!!c.snapshot&&c.snapshot.startedAt>started&&c.snapshot.jobs.find(j=>j.name==='bridge')?.phase==='ok');
 assert.equal(x.store.db.prepare('SELECT count(*) n FROM observations').get()!.n,before);assert.equal(x.store.db.prepare("SELECT count(*) n FROM source_rows WHERE table_name='messages'").get()!.n,1);
});

test('malformed legacy layout is refused before migration changes or backup files',async t=>{
 const x=fixture(t);x.insert();x.store.db.exec("DELETE FROM monitor_meta WHERE key='schema_version';DROP TABLE monitor_runtime;CREATE TABLE monitor_runtime(wrong TEXT);");
 const target=join(x.root,'invalid.sqlite');await assert.rejects(migrateMonitor(x.database,target),/MONITOR_SCHEMA_INVALID/);
 assert.equal(existsSync(target),false);assert.equal(x.store.db.prepare("SELECT value FROM monitor_meta WHERE key='schema_version'").get(),undefined);assert.equal(x.store.db.prepare('SELECT count(*) n FROM observations').get()!.n,1);
});

test('archive under a competing write lock cannot remove any history',async t=>{
 const x=fixture(t);x.insert();const lock=new DatabaseSync(x.database);lock.exec('BEGIN IMMEDIATE');
 try{await assert.rejects(archiveHistory(x.database,join(x.root,'locked.sqlite'),90,true));assert.equal(x.store.db.prepare('SELECT count(*) n FROM observations').get()!.n,1)}finally{lock.exec('ROLLBACK');lock.close()}
});

test('manifest schema and byte metadata must match the verified database',async t=>{
 const x=fixture(t),path=join(x.root,'copy.sqlite');await backupMonitor(x.database,path);const manifest=JSON.parse(readFileSync(path+'.manifest.json','utf8'));manifest.schemaVersion=1;writeFileSync(path+'.manifest.json',JSON.stringify(manifest));await assert.rejects(verifyBackup(path),/BACKUP_MANIFEST_INVALID/);
});

test('a second live collector is refused and clean close releases the lease',async t=>{
 const x=fixture(t),source=sourceFile(x.root),sessions=join(x.root,'sessions');mkdirSync(sessions);x.close.push(()=>source.db.close());
 const options={source:source.path,output:x.database,sessions,project:x.root,intervalMs:100};
 const first=new CollectionController(options);x.close.push(()=>first.close());await until(()=>first.snapshot?.jobs.find(j=>j.name==='bridge')?.phase==='ok');
 const second=new CollectionController(options);x.close.push(()=>second.close());await until(()=>second.error==='COLLECTOR_ALREADY_RUNNING');assert.equal(second.snapshot,null);await second.close();await first.close();
 assert.equal(x.store.db.prepare('SELECT count(*) n FROM collector_lease').get()!.n,0);assert.equal(storedRuntime(x.store.db,x.database).snapshot?.stopped,true);
 const third=new CollectionController(options);x.close.push(()=>third.close());await until(()=>third.snapshot?.jobs.find(j=>j.name==='bridge')?.phase==='ok');
});

test('synchronous Worker startup failure is reported and close cancels its retry',async t=>{
 const x=fixture(t);const c=new CollectionController({source:'absent',output:x.database,sessions:x.root,project:x.root,intervalMs:100},()=>{},new URL('https://invalid.example/worker.js'));x.close.push(()=>c.close());
 assert.equal(c.error,'COLLECTOR_WORKER_START_FAILED');assert.equal(c.restarts,1);await c.close();await new Promise(r=>setTimeout(r,1100));assert.equal(c.restarts,1);assert.equal(c.worker,null);
});

test('HTTP remains responsive while the collection Worker performs synchronous CPU work',async t=>{
 const x=fixture(t),assets=join(x.root,'assets');mkdirSync(assets);writeFileSync(join(assets,'index.html'),'fixture');
 const worker=join(x.root,'busy.mjs');writeFileSync(worker,"import {parentPort} from 'node:worker_threads';parentPort.postMessage({jobs:[]});const end=Date.now()+1500;while(Date.now()<end){};parentPort.on('message',()=>parentPort.close());");
 const c=new CollectionController({source:'absent',output:x.database,sessions:x.root,project:x.root,intervalMs:100},()=>{},pathToFileURL(worker));x.close.push(()=>c.close());
 const app=createDashboardServer({database:x.database,assets,runtime:()=>c.runtime()});await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));x.close.push(()=>new Promise<void>(r=>{app.server.closeAllConnections();app.server.close(()=>r())}));await until(()=>!!c.snapshot);
 const address=app.server.address() as {port:number},start=Date.now();for(let i=0;i<3;i++){const response=await fetch(`http://127.0.0.1:${address.port}/api/overview`);assert.equal(response.status,200);await response.json()}assert.ok(Date.now()-start<1200,'HTTP blocked by Worker CPU job');
});

test('maintenance CLI exercises backup, verification, restore, dry-run, archive and migration',t=>{
 const x=fixture(t);x.insert();const archive=join(x.root,'cli-backup.sqlite'),restore=join(x.root,'cli-restored.sqlite');
 const call=(...args:string[])=>{const result=spawnSync(process.execPath,['src/maintenance/cli.ts',...args],{cwd:resolve(import.meta.dirname,'..'),encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout)};
 assert.equal(call('backup','--database',x.database,'--destination',archive).schemaVersion,2);
 assert.equal(call('verify-backup','--backup',archive).ok,true);assert.equal(call('restore','--backup',archive,'--destination',restore).ok,true);
 assert.equal(call('retention','--database',x.database).mode,'dry-run');assert.equal(call('archive','--database',x.database).mode,'dry-run');
 assert.equal(call('archive','--database',x.database,'--destination',join(x.root,'cli-archive.sqlite'),'--apply').removed,1);
 assert.equal(call('migrate','--database',restore,'--destination',join(x.root,'cli-pre-migrate.sqlite')).schemaVersion,2);
 const invalid=spawnSync(process.execPath,['src/maintenance/cli.ts','restore','--backup',archive,'--destination',restore,'--apply'],{cwd:resolve(import.meta.dirname,'..'),encoding:'utf8',windowsHide:true});assert.equal(invalid.status,1);assert.equal(JSON.parse(invalid.stderr).code,'INVALID_ARGUMENT');
});
test('missing bridge source can recover while the independent agent source keeps scanning',async t=>{
 const x=fixture(t),path=join(x.root,'source/bridge.sqlite'),sessions=join(x.root,'sessions');mkdirSync(sessions);
 const c=new CollectionController({source:path,output:x.database,sessions,project:x.root,intervalMs:100});x.close.push(()=>c.close());await until(()=>c.snapshot?.jobs.find(j=>j.name==='bridge')?.phase==='error'&&c.snapshot?.jobs.find(j=>j.name==='agents')?.phase==='ok');
 const source=sourceFile(x.root);x.close.unshift(()=>source.db.close());await until(()=>c.snapshot?.jobs.find(j=>j.name==='bridge')?.phase==='ok');assert.equal(c.snapshot?.jobs.find(j=>j.name==='bridge')?.failures,0);
});
