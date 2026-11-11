import {homedir} from 'node:os';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
export function dataHome(value=process.env.MONITOR_HOME){return resolve(value??join(process.env.LOCALAPPDATA??join(homedir(),'.local/share'),'BridgeBetween'))}
export function safePath(value){const full=resolve(value);let part=full;while(dirname(part)!==part){if(existsSync(part)){const s=lstatSync(part);if(s.isSymbolicLink()||(s.isFile()&&s.nlink>1))throw Error('UNSAFE_PATH')}part=dirname(part)}return full}
export function settings(value){
 const home=dataHome(value),file=safePath(join(home,'settings.json'));let raw={};
 if(existsSync(file)){raw=JSON.parse(readFileSync(file,'utf8'));if(raw.application!=='gpt-dsh-monitor'||raw.schemaVersion!==1)throw Error('SETTINGS_INVALID')}
 const path=(v,fallback)=>{if(v!==undefined&&(typeof v!=='string'||!isAbsolute(v)))throw Error('SETTINGS_INVALID');return resolve(v??fallback)};
 const result={...raw,application:'gpt-dsh-monitor',schemaVersion:1,home,database:path(raw.database,join(home,'monitor/monitor.sqlite')),source:path(raw.source,join(home,'bridge/data/bridge.sqlite')),sessions:path(raw.sessions,join(home,'empty-sessions')),project:path(raw.project,join(home,'project')),port:raw.port??47832,bridgePort:raw.bridgePort??47831,collab:raw.collab??'default',bridgeHome:join(home,'bridge')};
 if(!Number.isInteger(result.port)||result.port<1||result.port>65535||!Number.isInteger(result.bridgePort)||result.bridgePort<1||result.bridgePort>65535||typeof result.collab!=='string'||!/^[\w.-]{1,80}$/.test(result.collab))throw Error('SETTINGS_INVALID');return result;
}
export function configured(home){return existsSync(join(dataHome(home),'settings.json'))}
