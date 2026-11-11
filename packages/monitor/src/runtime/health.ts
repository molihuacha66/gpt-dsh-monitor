import type {DatabaseSync} from 'node:sqlite';
import {existsSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {identity} from '../paths.ts';
import {monitorVersion} from '../schema.ts';
import type {JobState} from './scheduler.ts';
export type WorkerSnapshot={owner:string;databaseId:string;pid:number;updatedAt:number;startedAt:number;stopped:boolean;intervalMs:number;rssBytes:number;heapBytes:number;restarts:number;jobs:JobState[]};
export function databaseId(path:string){return createHash('sha256').update(identity(path)).digest('hex')}
export function storedRuntime(db:DatabaseSync,path:string,now=Date.now()):{live:boolean;snapshot:WorkerSnapshot|null}{
  if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='monitor_runtime'").get())return {live:false,snapshot:null};
  const row=db.prepare('SELECT updated_at,payload FROM monitor_runtime WHERE id=1').get();
  if(!row)return {live:false,snapshot:null};
  try{const value=JSON.parse(String(row.payload)) as WorkerSnapshot;
    if(value.databaseId!==databaseId(path)||!Array.isArray(value.jobs)||value.jobs.length>3)return {live:false,snapshot:null};
    const live=!value.stopped&&Number(row.updated_at)<=now+1000&&now-Number(row.updated_at)<20000;
    return {live,snapshot:value};
  }catch{return {live:false,snapshot:null}}
}
export function healthSummary(db:DatabaseSync,path:string){
  const version=monitorVersion(db),count=(table:string)=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)?Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n):0;
  const bytes=(file:string)=>{try{return existsSync(file)?lstatSync(file).size:0}catch{return 0}};
  const pageSize=Number(db.prepare('PRAGMA page_size').get()!.page_size),pages=Number(db.prepare('PRAGMA page_count').get()!.page_count),freePages=Number(db.prepare('PRAGMA freelist_count').get()!.freelist_count);
  const counts={currentRows:count('source_rows'),observations:count('observations'),agentEvents:count('agent_events'),files:count('artifact_registry')};
  const runtime=storedRuntime(db,path);
  const archives=db.prepare("SELECT name FROM sqlite_master WHERE name='retention_runs'").get()?db.prepare('SELECT at,cutoff,watermark,removed FROM retention_runs ORDER BY id DESC LIMIT 10').all():[];
  return {schemaVersion:version,collector:runtime.live?'running':runtime.snapshot?.stopped?'stopped':'not_confirmed',runtime:runtime.snapshot,database:{bytes:bytes(path),walBytes:bytes(path+'-wal'),allocatedBytes:pages*pageSize,reusableBytes:freePages*pageSize,counts},retention:{mode:'keep-all-by-default',observationCap:100000,agentEventCap:100000,archived:archives},warnings:[...(counts.observations>=90000?['OBSERVATIONS_NEAR_CAP']:[]),...(counts.agentEvents>=90000?['AGENT_EVENTS_NEAR_CAP']:[])]};
}
