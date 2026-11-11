import {createServer} from 'node:http';
import {existsSync,readFileSync,writeFileSync,openSync,closeSync,unlinkSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {CollectionController} from '../packages/monitor/src/runtime/controller.ts';
import {createDashboardServer} from '../packages/monitor/src/server.ts';
import {settings,safePath} from '../plugins/gpt-dsh-monitor/lib/config.mjs';

export async function runService(home:string,options:{bridge:boolean}){
 const config=settings(home),root=resolve(import.meta.dirname,'..'),record=safePath(join(home,'instance.json')),owner=randomUUID(),token=randomBytes(32).toString('hex');
 let slot:number|undefined,controller:CollectionController|undefined,app:ReturnType<typeof createDashboardServer>|undefined,bridge:any,control:ReturnType<typeof createServer>|undefined,closing=false;
 if(existsSync(record)){
  const prior=JSON.parse(readFileSync(record,'utf8'));if(prior.application!=='gpt-dsh-monitor-service')throw Error('SERVICE_STATE_INVALID');
  let live=true;try{process.kill(prior.pid,0)}catch(error){live=(error as NodeJS.ErrnoException).code!=='ESRCH'}
  if(live)throw Error('SERVICE_STATE_UNCERTAIN');unlinkSync(record);
 }
 slot=openSync(record,'wx',0o600);writeFileSync(slot,JSON.stringify({application:'gpt-dsh-monitor-service',pid:process.pid,owner,state:'starting'}));closeSync(slot);slot=undefined;const identity=lstatSync(record).ino;
 let finish!:()=>void;const finished=new Promise<void>(r=>{finish=r});
 async function close(){if(closing)return;closing=true;
  try{app?.closeStreams();await controller?.close();if(app){app.server.closeAllConnections();await new Promise<void>(r=>app!.server.close(()=>r()))}await bridge?.close();if(control){control.closeAllConnections();await new Promise<void>(r=>control!.close(()=>r()))}}
  finally{if(existsSync(record)&&lstatSync(record).ino===identity)unlinkSync(record);finish()}
 }
 try{
  if(options.bridge){
   if(config.demo||resolve(config.source)!==resolve(join(config.bridgeHome,'data/bridge.sqlite')))throw Error('EXTERNAL_SOURCE_BRIDGE_START_DENIED');
   const mod=await import(pathToFileURL(join(root,'components/bridge/server.mjs')).href),bridgeConfig=JSON.parse(readFileSync(join(config.bridgeHome,'config.json'),'utf8'));
   if(bridgeConfig.host&&bridgeConfig.host!=='127.0.0.1')throw Error('LOCAL_ACCESS_ONLY');
   bridge=mod.createBridge({...bridgeConfig,host:'127.0.0.1',dataDir:join(config.bridgeHome,'data'),port:config.bridgePort,defaultCollab:config.collab,collabAccess:{dsh:[config.collab],codex:[config.collab]}});await bridge.listen();
  }
  if(!existsSync(config.source))throw Error('SOURCE_UNAVAILABLE');
  app=createDashboardServer({database:config.database,project:config.project,assets:join(root,'dist'),runtime:()=>controller?.runtime()??{collecting:false,lastError:null,intervalMs:5000}});
  await new Promise<void>((r,j)=>{app!.server.once('error',j);app!.server.listen(config.port,'127.0.0.1',r)});
  process.env.MONITOR_HOME=home;
  controller=new CollectionController({source:config.source,output:config.database,sessions:config.sessions,project:config.project,intervalMs:5000});
  control=createServer((req,res)=>{
   const address=control!.address(),port=typeof address==='object'&&address?address.port:0;
   if(req.headers.host!==`127.0.0.1:${port}`||req.headers.origin||req.headers.authorization!==`Bearer ${token}`){res.writeHead(403);res.end();return}
   if((req.url==='/status'&&req.method==='GET')||(req.url==='/stop'&&req.method==='POST')){
    const jobs=controller?.snapshot?.jobs??[],collector=jobs.some(j=>j.phase==='error')?'degraded':jobs.some(j=>j.name==='bridge'&&j.lastSuccess)?'running':'starting';
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({ok:true,owner,collector,bridge:!!bridge,version:'0.7.0-beta.1',jobs:jobs.map(j=>({name:j.name,phase:j.phase,code:j.code}))}));
    if(req.url==='/stop')setImmediate(()=>void close());return;
   }res.writeHead(404);res.end();
  });
  await new Promise<void>((r,j)=>{control!.once('error',j);control!.listen(0,'127.0.0.1',r)});
  const address=control.address() as {port:number};writeFileSync(record,JSON.stringify({application:'gpt-dsh-monitor-service',owner,token,port:address.port,pid:process.pid}),{mode:0o600});
  process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
  console.log(JSON.stringify({ok:true,state:'running',url:`http://127.0.0.1:${config.port}`,bridge:!!bridge}));
  await finished;
 }catch(error){await close();throw error}
}
