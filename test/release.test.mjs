import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,rmSync,mkdirSync,writeFileSync,cpSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {spawnSync,spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {inspectMcp} from '../plugins/gpt-dsh-monitor/lib/rpc.mjs';
import {createBridge} from '../components/bridge/server.mjs';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'..'),cli=join(root,'bin/bridge-between.mjs');
const cleanup=new Map();
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'bridge-release-中文 space-'));cleanup.set(dir,[]);t.after(async()=>{const errors=[];for(const close of cleanup.get(dir).reverse())try{await close()}catch(e){errors.push(e)}const r=relative(resolve(tmpdir()),dir);assert.ok(r&&!r.startsWith('..'));rmSync(dir,{recursive:true,force:true});cleanup.delete(dir);if(errors.length)throw new AggregateError(errors,'TEST_CLEANUP_FAILED')});return dir}
function call(...args){const r=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function until(run){for(let i=0;i<150;i++){if(await run())return;await new Promise(r=>setTimeout(r,100))}assert.fail('condition timed out')}
test('setup rejects user-home and drive roots and detects explicitly occupied ports before writing',async t=>{
 const forbidden=spawnSync(process.execPath,[cli,'setup','--home',homedir()],{encoding:'utf8',windowsHide:true});assert.equal(forbidden.status,1);assert.match(forbidden.stderr,/UNSAFE_DATA_HOME/);
 const drive=spawnSync(process.execPath,[cli,'setup','--home',resolve(homedir(),'/')],{encoding:'utf8',windowsHide:true});assert.equal(drive.status,1);assert.match(drive.stderr,/UNSAFE_DATA_HOME/);
 const home=fixture(t),server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;cleanup.get(home).push(()=>new Promise(r=>server.close(r)));
 const dir=join(home,'occupied'),result=spawnSync(process.execPath,[cli,'setup','--home',dir,'--demo','--port',String(p)],{encoding:'utf8',windowsHide:true});assert.equal(result.status,1);assert.match(result.stderr,/PORT_IN_USE/);assert.equal(existsSync(join(dir,'settings.json')),false);
});
test('portable setup preserves existing data, rejects bad args and generates both MCP formats',t=>{
 const home=fixture(t);assert.equal(call('setup','--home',home,'--demo').mode,'synthetic-demo');
 const before=readFileSync(join(home,'settings.json'),'utf8');assert.equal(call('setup','--home',home).code,'ALREADY_CONFIGURED');assert.equal(readFileSync(join(home,'settings.json'),'utf8'),before);
 assert.equal(call('generate-codex','--home',home).generated,true);
 assert.equal(existsSync(join(home,'integration/plugins/gpt-dsh-monitor/plugin.json')),false);assert.ok(existsSync(join(home,'integration/plugins/gpt-dsh-monitor/plugin.portable.json.txt')));
 const managed=join(home,'managed');call('setup','--home',managed);assert.equal(call('generate-codex','--home',managed,'--bridge').generated,true);assert.equal(JSON.parse(readFileSync(join(managed,'integration/.agents/plugins/marketplace.json'),'utf8')).plugins.length,2);
 const plugin=join(home,'integration/plugins/gpt-dsh-monitor'),legacy=JSON.parse(readFileSync(join(plugin,'.mcp.json'),'utf8')),portable=JSON.parse(readFileSync(join(plugin,'mcp.json'),'utf8'));
 assert.equal(legacy.mcpServers.monitor.env.MONITOR_HOME,home);assert.equal(portable.mcpServers.monitor.env.MONITOR_HOME,home);assert.ok(!legacy.mcpServers.monitor.args[0].includes('${'));
 assert.equal(call('uninstall','--home',home).dataRetained,true);assert.ok(existsSync(join(home,'demo-source/bridge.sqlite')));
 const invalid=spawnSync(process.execPath,[cli,'setup','--home',join(home,'bad'),'--port','NaN'],{encoding:'utf8',windowsHide:true});assert.equal(invalid.status,1);assert.match(invalid.stderr,/INVALID_ARGUMENT/);assert.ok(!existsSync(join(home,'bad/settings.json')));
});
test('self-contained collector, HTTP, readonly MCP, file declarations and stop work without node_modules',async t=>{
 const home=fixture(t),p=await port(),clean=join(home,'runtime-copy');mkdirSync(join(clean,'bin'),{recursive:true});cpSync(join(root,'plugins/gpt-dsh-monitor'),join(clean,'plugins/gpt-dsh-monitor'),{recursive:true});cpSync(cli,join(clean,'bin/bridge-between.mjs'));assert.equal(existsSync(join(clean,'node_modules')),false);call('setup','--home',home,'--demo','--port',String(p));
 const child=spawn(process.execPath,[join(clean,'bin/bridge-between.mjs'),'start','--home',home],{windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
 cleanup.get(home).push(async()=>{try{call('stop','--home',home)}catch{}if(child.exitCode===null){await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,6000))]);if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r))}}});
 await until(async()=>{try{return (await(await fetch(`http://127.0.0.1:${p}/api/read?action=health`)).json()).collector==='running'}catch{return false}});
 let page;await until(async()=>{page=await(await fetch(`http://127.0.0.1:${p}/api/read?action=conversation`)).json();return page.total===2&&page.files?.length===1});assert.equal(page.files[0].name,'demo-result.md');
 const mcp=await inspectMcp(join(clean,'plugins/gpt-dsh-monitor/server/index.mjs'),home);assert.equal(mcp.schemaVersion,2);assert.equal(mcp.collector,'running');assert.equal(mcp.readonly,true);assert.equal(mcp.maintenanceDenied,true);assert.equal(mcp.ui,'not_verified');
 const archive=join(home,'verified-backup.sqlite');assert.equal(call('maintenance','backup','--home',home,'--destination',archive).schemaVersion,2);assert.equal(call('maintenance','verify-backup','--home',home,'--backup',archive).ok,true);
 assert.equal((await fetch(`http://127.0.0.1:${p}/api/read?action=health`,{method:'POST'})).status,405);
 assert.equal(call('start','--home',home).code,'ALREADY_RUNNING');assert.ok(!log.includes('token'));call('stop','--home',home);await until(()=>child.exitCode!==null);assert.ok(existsSync(join(home,'monitor/monitor.sqlite')));assert.equal(call('status','--home',home).state,'stopped');
});

test('suite-managed optional bridge starts in its own data home and stops without deleting records',async t=>{
 const home=fixture(t),p=await port(),bp=await port();call('setup','--home',home,'--port',String(p),'--bridge-port',String(bp));
 const child=spawn(process.execPath,[cli,'start','--home',home,'--bridge'],{windowsHide:true,stdio:'ignore'});cleanup.get(home).push(async()=>{try{call('stop','--home',home)}catch{}if(child.exitCode===null){await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r))}}});
 await until(async()=>{try{return (await(await fetch(`http://127.0.0.1:${bp}/api/health`)).json()).features.manual_poll_cursor===true}catch{return false}});assert.equal(call('status','--home',home).bridge,true);
 const config=JSON.parse(readFileSync(join(home,'bridge/config.json'),'utf8'));assert.equal(config.wakeEnabled,false);assert.equal(config.autoWakeOnMessages,false);assert.equal(config.codexApproveForMe,false);
 call('stop','--home',home);await until(()=>child.exitCode!==null);assert.ok(existsSync(join(home,'bridge/data/bridge.sqlite')));assert.ok(existsSync(join(home,'bridge/data/token.txt')));
});
test('bridge runs isolated with wake disabled and explicit cursor commits preserve undelivered messages',async t=>{
 const home=fixture(t),bridge=createBridge({dataDir:join(home,'data'),port:0,codexExe:'auto',wakeEnabled:false,autoWakeOnMessages:false,collabAccess:{dsh:['default'],codex:['default']}});await bridge.listen();cleanup.get(home).push(()=>{bridge.server.closeAllConnections();return bridge.close()});
 const endpoint=JSON.parse(readFileSync(join(home,'data/endpoint.json'),'utf8'));
 const api=async(who,path,body)=>{const token=readFileSync(join(home,'data',who==='dsh'?'token.txt':'token-codex.txt'),'utf8').trim();return (await fetch(endpoint.url+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined})).json()};
 const result=await api('codex','/api/send',{collab:'default',recipient:'dsh',kind:'task',body:'Synthetic task'});assert.equal(result.auto_wake.status,'not_requested');
 const polled=await api('dsh','/api/poll',{collab:'default',since:0,commit_cursor:false});assert.equal(polled.messages.length,1);assert.equal((await api('dsh','/api/cursor?collab=default')).seq,0);
 await api('dsh','/api/cursor',{collab:'default',seq:polled.next_since});assert.equal((await api('dsh','/api/cursor?collab=default')).seq,polled.next_since);
 await api('codex','/api/cursor',{collab:'default',participant:'dsh',seq:999});assert.equal((await api('dsh','/api/cursor?collab=default')).seq,polled.next_since);
 const denied=await api('codex','/api/send',{collab:'other',recipient:'dsh',kind:'note',body:'must not cross scope'});assert.equal(denied.ok,false);assert.equal(denied.error.code,'forbidden');
 assert.equal((await api('dsh','/api/wake-codex',{collab:'default',prompt:'must not execute'})).ok,false);
});

test('DSH native adapter commits only after delivery to a bound target, never on failure or cooldown',async t=>{
 const home=fixture(t),data=join(home,'bridge/data'),bridge=createBridge({dataDir:data,port:0,wakeEnabled:false,autoWakeOnMessages:false,collabAccess:{dsh:['default'],codex:['default']}});await bridge.listen();cleanup.get(home).push(()=>{bridge.server.closeAllConnections();return bridge.close()});
 const endpoint=JSON.parse(readFileSync(join(data,'endpoint.json'),'utf8')),token=who=>readFileSync(join(data,who==='dsh'?'token.txt':'token-codex.txt'),'utf8').trim();
 const api=async(who,path,body)=>(await fetch(endpoint.url+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token(who),'content-type':'application/json'},body:body?JSON.stringify(body):undefined})).json();
 const envKeys=['DSH_CODEX_BRIDGE_HOME','DSH_CODEX_BRIDGE_DIR','DSH_CODEX_AUTO_FOLLOWUP','DSH_CODEX_TARGET_AGENT','DSH_CODEX_COLLAB'];const prior=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{DSH_CODEX_BRIDGE_HOME:join(home,'bridge'),DSH_CODEX_BRIDGE_DIR:'',DSH_CODEX_AUTO_FOLLOWUP:'1',DSH_CODEX_COLLAB:'default'});delete process.env.DSH_CODEX_TARGET_AGENT;
 const mod=await import(pathToFileURL(join(root,'components/dsh-plugin/index.js')).href+'?test='+Date.now());const timers=[],disposers=[];let poll,fail=true,deliveries=0,clock=Date.now();
 const original=setInterval;globalThis.setInterval=(fn)=>{poll=fn;const handle=original(()=>{},2147483647);handle.unref();return handle};
 try{mod.apply({tools:{register(){return()=>{}}},agents:{list:()=>[{id:'fixture-agent',followup:async()=>{if(fail)throw Error('synthetic failure');deliveries++}}]},sessions:{flush:async()=>{}},effect:fn=>disposers.push(fn()),logger:{info(){}}},{now:()=>clock})}finally{globalThis.setInterval=original}
 cleanup.get(home).push(()=>{for(const dispose of disposers)dispose();for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value}});
 await api('codex','/api/send',{collab:'default',recipient:'dsh',kind:'task',body:'Synthetic delivery'});await poll();assert.equal((await api('dsh','/api/cursor?collab=default')).seq,0);
 process.env.DSH_CODEX_TARGET_AGENT='fixture-agent';await poll();assert.equal((await api('dsh','/api/cursor?collab=default')).seq,0);
 fail=false;clock+=10000;await poll();await until(async()=>(await api('dsh','/api/cursor?collab=default')).seq>0);assert.equal(deliveries,1);
  const before=(await api('dsh','/api/cursor?collab=default')).seq;await api('codex','/api/send',{collab:'default',recipient:'dsh',kind:'task',body:'Synthetic cooldown'});await poll();assert.equal((await api('dsh','/api/cursor?collab=default')).seq,before);assert.equal(deliveries,1);
});
