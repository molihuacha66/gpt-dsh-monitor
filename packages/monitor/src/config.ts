import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {MonitorError} from './errors.ts';
export function settings(){
 const home=resolve(process.env.MONITOR_HOME??join(process.env.LOCALAPPDATA??join(homedir(),'.local/share'),'BridgeBetween'));
 const file=join(home,'settings.json');let raw:Record<string,any>={};
 if(existsSync(file)){try{raw=JSON.parse(readFileSync(file,'utf8'));if(raw.application!=='gpt-dsh-monitor'||raw.schemaVersion!==1)throw new Error()}catch{throw new MonitorError('SETTINGS_INVALID')}}
 return {home,database:resolve(raw.database??join(home,'monitor/monitor.sqlite')),source:resolve(raw.source??join(home,'bridge/data/bridge.sqlite')),project:resolve(raw.project??join(home,'project')),sessions:resolve(raw.sessions??join(home,'empty-sessions')),port:raw.port??47832};
}
