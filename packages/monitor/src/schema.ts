import type {DatabaseSync} from 'node:sqlite';
import {MonitorError} from './errors.ts';

export const SCHEMA_VERSION=2;
export function validateMonitorLayout(db:DatabaseSync,allowMissingV2=false){
  const tables:Record<string,string>={monitor_meta:'key value',source_binding:'id identity schema_hash policy',source_rows:'table_name row_key collab payload digest first_seen_at last_changed_at source_present',observations:'id table_name row_key observed_at payload digest',checkpoints:'table_name max_seq row_count captured_at',collection_gaps:'code status first_seen_at last_seen_at occurrences',monitor_runtime:'id updated_at payload',collector_lease:'id owner pid heartbeat',retention_runs:'id at cutoff watermark removed archive_hash'};
  for(const [table,names]of Object.entries(tables)){
    const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(row=>String(row.name));
    if(allowMissingV2&&!columns.length&&['monitor_runtime','collector_lease','retention_runs'].includes(table))continue;
    if(columns.join(' ')!==names)throw new MonitorError('MONITOR_SCHEMA_INVALID');
  }
}
export function monitorVersion(db:DatabaseSync):number{
  if(db.prepare("SELECT value FROM monitor_meta WHERE key='application'").get()?.value!=='gpt-dsh-monitor-v1')throw new MonitorError('NOT_MONITOR_DATABASE');
  const raw=db.prepare("SELECT value FROM monitor_meta WHERE key='schema_version'").get()?.value;
  if(raw===undefined)return 1;
  if(!/^\d+$/.test(String(raw))||Number(raw)<1)throw new MonitorError('MONITOR_SCHEMA_INVALID');
  const version=Number(raw);
  if(version>SCHEMA_VERSION)throw new MonitorError('MONITOR_UPGRADE_REQUIRED');
  return version;
}
