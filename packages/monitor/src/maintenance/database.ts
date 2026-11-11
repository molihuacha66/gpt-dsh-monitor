import {settings} from '../config.ts';
import {DatabaseSync,backup} from 'node:sqlite';
import {existsSync,lstatSync,realpathSync,mkdirSync,openSync,closeSync,fstatSync,readFileSync,writeFileSync,createReadStream} from 'node:fs';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {MonitorError} from '../errors.ts';
import {monitorVersion,validateMonitorLayout,SCHEMA_VERSION} from '../schema.ts';
import {MonitorStore} from '../store.ts';
import {identity} from '../paths.ts';

const inside=(root:string,path:string)=>{const r=relative(resolve(root),resolve(path));return r===''||(!r.startsWith('..')&&!isAbsolute(r))};
const protectedRoots=[dirname(settings().source),settings().sessions];
function safePath(input:string,write=false){
  const path=resolve(input);if(write&&protectedRoots.some(root=>inside(root,path)))throw new MonitorError('UNSAFE_OUTPUT_PATH');
  const parts:string[]=[];let p=path;while(dirname(p)!==p){parts.push(p);p=dirname(p)}
  for(const file of parts.reverse())if(existsSync(file)){const s=lstatSync(file);if(s.isSymbolicLink()||(s.isFile()&&s.nlink>1))throw new MonitorError('UNSAFE_OUTPUT_PATH')}
  return path;
}
function readonly(path:string){safePath(path);const db=new DatabaseSync(path,{readOnly:true});try{db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000');const version=monitorVersion(db);validateMonitorLayout(db,version<SCHEMA_VERSION);return db}catch(error){db.close();throw error}}
function reserve(path:string){safePath(path,true);for(const file of [path,path+'-wal',path+'-shm',path+'-journal',path+'.manifest.json'])if(existsSync(file))throw new MonitorError('BACKUP_TARGET_EXISTS');mkdirSync(dirname(path),{recursive:true});const fd=openSync(path,'wx');return {fd,stat:fstatSync(fd)}}
async function hashFile(path:string){const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex')}
function integrity(db:DatabaseSync){if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new MonitorError('BACKUP_INVALID')}
async function snapshotCopy(source:string,destination:string){
  if(resolve(source)===resolve(destination))throw new MonitorError('BACKUP_TARGET_EXISTS');
  const db=readonly(source);let slot:ReturnType<typeof reserve>|undefined;
  try{slot=reserve(destination);await backup(db,destination,{rate:64});const now=lstatSync(destination);if(now.ino!==slot.stat.ino||now.dev!==slot.stat.dev||now.nlink!==1||now.isSymbolicLink())throw new MonitorError('UNSAFE_OUTPUT_PATH');const check=readonly(destination);try{integrity(check)}finally{check.close()}}
  finally{db.close();if(slot)closeSync(slot.fd)}
}
export async function backupMonitor(database:string,destination:string){
  database=safePath(database);destination=safePath(destination,true);
  const original=identity(database);
  await snapshotCopy(database,destination);
  const check=readonly(destination);let version:number;try{version=monitorVersion(check)}finally{check.close()}
  const sha256=await hashFile(destination);
  if(identity(database)!==original)throw new MonitorError('MONITOR_REPLACED');
  const manifest={application:'gpt-dsh-monitor-backup',createdAt:Date.now(),schemaVersion:version,sha256,bytes:lstatSync(destination).size,sourceIdentity:createHash('sha256').update(original).digest('hex')};
  writeFileSync(destination+'.manifest.json',JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}
export async function verifyBackup(path:string){
  path=safePath(path);safePath(path+'.manifest.json');
  let manifest;try{manifest=JSON.parse(readFileSync(path+'.manifest.json','utf8'))}catch{throw new MonitorError('BACKUP_MANIFEST_INVALID')}
  if(manifest.application!=='gpt-dsh-monitor-backup'||!/^[0-9a-f]{64}$/.test(manifest.sha256)||manifest.sha256!==await hashFile(path))throw new MonitorError('BACKUP_HASH_MISMATCH');
  const db=readonly(path);try{integrity(db);const schemaVersion=monitorVersion(db),bytes=lstatSync(path).size;if(schemaVersion!==manifest.schemaVersion||bytes!==manifest.bytes)throw new MonitorError('BACKUP_MANIFEST_INVALID');return {ok:true,schemaVersion,sha256:manifest.sha256,bytes}}finally{db.close()}
}
export async function migrateMonitor(database:string,backupPath:string){
  const original=identity(database),manifest=await backupMonitor(database,backupPath);await verifyBackup(backupPath);
  if(identity(database)!==original)throw new MonitorError('MONITOR_REPLACED');
  const store=new MonitorStore(database,{allowLegacyUpgrade:true});try{return {ok:true,schemaVersion:monitorVersion(store.db),backupSha256:manifest.sha256}}finally{store.close()}
}
export async function restoreMonitor(archive:string,destination:string){
  await verifyBackup(archive);destination=safePath(destination,true);await snapshotCopy(archive,destination);
  const store=new MonitorStore(destination,{allowLegacyUpgrade:true});try{store.db.exec('BEGIN IMMEDIATE; DELETE FROM monitor_runtime; DELETE FROM collector_lease; COMMIT');store.gap('restored-snapshot','restored-from-verified-backup');return {ok:true,schemaVersion:monitorVersion(store.db),currentRows:Number(store.db.prepare('SELECT count(*) n FROM source_rows').get()!.n)}}finally{store.close()}
}
export function retentionPlan(database:string,days=90,now=Date.now()){
  if(!Number.isInteger(days)||days<1||days>36500)throw new MonitorError('INVALID_RETENTION');
  const db=readonly(database);try{db.exec('BEGIN');const watermark=Number(db.prepare('SELECT coalesce(max(id),0) n FROM observations').get()!.n),cutoff=now-days*86400000;
    const candidates=Number(db.prepare('SELECT count(*) n FROM observations WHERE observed_at<? AND id<=?').get(cutoff,watermark)!.n);db.exec('COMMIT');return {mode:'dry-run',policy:'observations-only',days,cutoff,watermark,candidates,currentRowsRetained:true,agentEventsRetained:true};
  }finally{db.close()}
}
function rowsHash(db:DatabaseSync,cutoff:number,watermark:number){const hash=createHash('sha256');let count=0;for(const row of db.prepare('SELECT * FROM observations WHERE observed_at<? AND id<=? ORDER BY id').iterate(cutoff,watermark)){hash.update(JSON.stringify(row)+'\n');count++}return {hash:hash.digest('hex'),count}}
export async function archiveHistory(database:string,destination:string,days=90,apply=false){
  const plan=retentionPlan(database,days);if(!apply)return plan;
  const original=identity(database);const archive=await backupMonitor(database,destination);await verifyBackup(destination);
  if(identity(database)!==original)throw new MonitorError('MONITOR_REPLACED');
  const store=new MonitorStore(database,{allowLegacyUpgrade:true}),db=store.db,copy=readonly(destination);
  try{db.exec('BEGIN IMMEDIATE');const current=rowsHash(db,plan.cutoff,plan.watermark),saved=rowsHash(copy,plan.cutoff,plan.watermark);
    if(current.count!==saved.count||current.hash!==saved.hash)throw new MonitorError('ARCHIVE_COVERAGE_MISMATCH');
    const removed=Number(db.prepare('DELETE FROM observations WHERE observed_at<? AND id<=?').run(plan.cutoff,plan.watermark).changes);
    db.prepare('INSERT INTO retention_runs(at,cutoff,watermark,removed,archive_hash) VALUES(?,?,?,?,?)').run(Date.now(),plan.cutoff,plan.watermark,removed,archive.sha256);
    store.gap('HISTORY_ARCHIVED','history-preserved-in-archive');db.exec('COMMIT');return {...plan,mode:'applied',removed,archiveSha256:archive.sha256};
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error}finally{copy.close();store.close()}
}
