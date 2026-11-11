import {parentPort,workerData} from 'node:worker_threads';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Collector} from '../collector.ts';
import {AgentCollector} from '../subagents/collector.ts';
import {ArtifactIndexer} from '../conversation/artifacts.ts';
import {MonitorStore} from '../store.ts';
import {MonitorError,safeCode} from '../errors.ts';
import {guardPaths,guardOutputLocation} from '../paths.ts';
import {agentOutputPath} from '../subagents/collector.ts';
import {databaseId} from './health.ts';
import {JobScheduler} from './scheduler.ts';
import {monitorVersion,SCHEMA_VERSION} from '../schema.ts';
import {migrateMonitor} from '../maintenance/database.ts';

const options=workerData as {source:string;output:string;sessions:string;project:string;owner:string;intervalMs:number;restarts:number};
if(!parentPort)throw new MonitorError('WORKER_REQUIRED');
guardOutputLocation(options.source,options.output);
agentOutputPath(options.sessions,options.output);
// If bridge source is absent the agents can still run; a present source must pass its path boundary first.
try{guardPaths(options.source,options.output)}catch(error){if(!(error instanceof MonitorError)||error.code!=='SOURCE_UNAVAILABLE')throw error}
if(existsSync(options.output)){
  const probe=new DatabaseSync(options.output,{readOnly:true});let version:number;try{version=monitorVersion(probe)}finally{probe.close()}
  if(version<SCHEMA_VERSION)await migrateMonitor(options.output,options.output+'.pre-v2-'+options.owner+'.sqlite');
}
const store=new MonitorStore(options.output),db=store.db;
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH'}};
db.exec('BEGIN IMMEDIATE');
try{const lease=db.prepare('SELECT owner,pid FROM collector_lease WHERE id=1').get();if(lease&&lease.owner!==options.owner&&alive(Number(lease.pid)))throw new MonitorError('COLLECTOR_ALREADY_RUNNING');db.prepare('INSERT OR REPLACE INTO collector_lease VALUES(1,?,?,?)').run(options.owner,process.pid,Date.now());db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');store.close();throw error}
let bridge:Collector|undefined,agents:AgentCollector|undefined,artifacts:ArtifactIndexer|undefined,stopped=false;
const scheduler=new JobScheduler(options.intervalMs);
scheduler.add('bridge',()=>{bridge??=new Collector(options.source,options.output);const result=bridge.cycle();return {metrics:{added:Number(result.added??0),changed:Number(result.changed??0)}}});
scheduler.add('agents',()=>{agents??=new AgentCollector(options.sessions,options.output);agents.maxFilesPerCycle=32;const result=agents.cycle();if(!['scanned','pending','partial-error'].includes(result.status))throw new MonitorError(result.status);return {degraded:result.errors>0,code:result.errors?'AGENT_SCAN_PARTIAL':undefined,metrics:{files:result.files,parsed:result.parsed,pending:result.pending,errors:result.errors,deferred:result.deferred??0}}});
scheduler.add('artifacts',()=>{artifacts??=new ArtifactIndexer(options.output,options.project,[]);const result=artifacts.cycle();return {metrics:{files:result.files,links:result.links}}});
const startedAt=Date.now(),fingerprint=databaseId(options.output);let lastStored=0;
function publish(){const value={owner:options.owner,databaseId:fingerprint,pid:process.pid,updatedAt:Date.now(),startedAt,stopped,intervalMs:options.intervalMs,rssBytes:process.memoryUsage().rss,heapBytes:process.memoryUsage().heapUsed,restarts:options.restarts,jobs:scheduler.snapshot()};
  if(stopped||value.updatedAt-lastStored>=5000){
    db.exec('BEGIN IMMEDIATE');try{
      db.prepare('INSERT INTO monitor_runtime VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload').run(value.updatedAt,JSON.stringify(value));
      db.prepare('UPDATE collector_lease SET heartbeat=? WHERE id=1 AND owner=?').run(value.updatedAt,options.owner);db.exec('COMMIT');lastStored=value.updatedAt;
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error}
  }
  parentPort!.postMessage(value)
}
let timer:ReturnType<typeof setTimeout>|undefined;
async function loop(){if(stopped)return;try{await scheduler.tick(publish);publish()}catch{parentPort!.postMessage({error:'WORKER_STATE_WRITE_FAILED'})}if(!stopped)timer=setTimeout(()=>void loop(),Math.min(options.intervalMs,1000))}
parentPort.on('message',message=>{if(message!=='stop'||stopped)return;stopped=true;if(timer)clearTimeout(timer);try{publish()}finally{try{bridge?.close();agents?.close();artifacts?.close();db.prepare('DELETE FROM collector_lease WHERE owner=?').run(options.owner)}finally{store.close();parentPort!.close()}}});
void loop().catch(error=>{parentPort!.postMessage({error:safeCode(error)});process.exitCode=1;parentPort!.close()});
