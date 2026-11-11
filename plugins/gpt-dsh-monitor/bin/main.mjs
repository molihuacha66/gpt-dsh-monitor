import {readFileSync,writeFileSync,existsSync,mkdirSync,cpSync,unlinkSync,renameSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {createServer} from 'node:net';
import {dataHome,safePath,settings,configured} from '../lib/config.mjs';
import {inspectMcp} from '../lib/rpc.mjs';
const root=resolve(import.meta.dirname,'..'),version='0.7.0-beta.1';
const output=x=>console.log(JSON.stringify(x));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const inside=(a,b)=>{const r=relative(a,b);return !r||(!r.startsWith('..')&&!isAbsolute(r))};
const freePort=port=>new Promise(resolve=>{const server=createServer();server.once('error',()=>resolve(false));server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)))});
async function choosePort(value,fallback,reserved=[]){const explicit=value!==undefined,start=Number(value??fallback);if(!Number.isInteger(start)||start<1||start>65535)throw Error('INVALID_ARGUMENT');for(let port=start;port<=Math.min(65535,start+(explicit?0:63));port++)if(!reserved.includes(port)&&await freePort(port))return port;throw Error(explicit?'PORT_IN_USE':'NO_FREE_PORT')}
export async function control(home,path='/status'){
 const file=safePath(join(home,'instance.json'));if(!existsSync(file))return null;
 const instance=JSON.parse(readFileSync(file,'utf8'));if(instance.application!=='gpt-dsh-monitor-service'||!instance.token||!Number.isInteger(instance.port))return null;
 try{const response=await fetch(`http://127.0.0.1:${instance.port}${path}`,{method:path==='/stop'?'POST':'GET',headers:{authorization:`Bearer ${instance.token}`},signal:AbortSignal.timeout(2500)});const result=await response.json();return response.ok&&result.owner===instance.owner?result:null}catch{return null}
}
async function setup(values){
 const home=safePath(dataHome(values['--home']));if(inside(root,home))throw Error('DATA_HOME_INSIDE_PLUGIN');
 if(home===resolve(homedir())||home===resolve(process.env.USERPROFILE??homedir())||home===dirname(home))throw Error('UNSAFE_DATA_HOME');
 if(configured(home)){output({ok:true,code:'ALREADY_CONFIGURED',version});return}
 const demo=!!values['--demo'],project=safePath(resolve(values['--project']??join(home,demo?'demo-project':'project')));
 const cfg={application:'gpt-dsh-monitor',schemaVersion:1,version,project,port:Number(values['--port']??47832),bridgePort:Number(values['--bridge-port']??47831),collab:values['--collab']??'default',demo};
 if(values['--source'])cfg.source=safePath(resolve(values['--source']));else if(demo)cfg.source=join(home,'demo-source/bridge.sqlite');
 if(values['--sessions'])cfg.sessions=safePath(resolve(values['--sessions']));
 if(!Number.isInteger(cfg.port)||cfg.port<1||cfg.port>65535||!Number.isInteger(cfg.bridgePort)||cfg.bridgePort<1||cfg.bridgePort>65535||!/^[\w.-]{1,80}$/.test(cfg.collab))throw Error('INVALID_ARGUMENT');
 cfg.port=await choosePort(values['--port'],47832);if(!demo&&!values['--source'])cfg.bridgePort=await choosePort(values['--bridge-port'],47831,[cfg.port]);
 mkdirSync(home,{recursive:true});mkdirSync(project,{recursive:true});mkdirSync(join(home,'monitor'),{recursive:true});mkdirSync(join(home,'empty-sessions'),{recursive:true});
 if(demo){const {createDemo}=await import('../runtime/demo.mjs');createDemo(home,project)}
 writeFileSync(join(home,'settings.json'),JSON.stringify(cfg,null,2)+'\n',{flag:'wx',mode:0o600});
 mkdirSync(join(home,'bridge'),{recursive:true});writeFileSync(join(home,'bridge/config.json'),JSON.stringify({dataDir:join(home,'bridge/data'),port:cfg.bridgePort,defaultCollab:cfg.collab,collabAccess:{dsh:[cfg.collab],codex:[cfg.collab]},codexExe:'auto',codexCwd:project,codexSandbox:'read-only',wakeEnabled:false,autoWakeOnMessages:false,codexApproveForMe:false},null,2)+'\n',{flag:'wx',mode:0o600});
 output({ok:true,configured:true,mode:demo?'synthetic-demo':'local',port:cfg.port,bridgePort:cfg.bridgePort,version});
}
function generateCodex(home,withBridge=false,portable=false){
 const cfg=settings(home),integration=safePath(join(home,'integration')),name='fish-dragon';mkdirSync(integration,{recursive:true});
  if(withBridge&&(cfg.demo||resolve(cfg.source)!==resolve(join(cfg.bridgeHome,'data/bridge.sqlite'))))throw Error('MANAGED_BRIDGE_REQUIRED');
 const dest=join(integration,'plugins/gpt-dsh-monitor');cpSync(root,dest,{recursive:true});
  if(!portable&&existsSync(join(dest,'plugin.json')))renameSync(join(dest,'plugin.json'),join(dest,'plugin.portable.json.txt'));
 const cache=resolve(process.env.CODEX_HOME??join(process.env.USERPROFILE??process.env.HOME,'.codex'),'plugins/cache',name,'gpt-dsh-monitor',version);
 const mcp={mcpServers:{monitor:{command:process.execPath,args:[join(cache,'server/index.mjs')],cwd:cache,env:{MONITOR_HOME:home}}}};
 writeFileSync(join(dest,'.mcp.json'),JSON.stringify(mcp,null,2)+'\n');
  writeFileSync(join(dest,'mcp.json'),JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',mcpServers:{monitor:{...mcp.mcpServers.monitor,type:'stdio'}}},null,2)+'\n');
 const marketplace={name,interface:{displayName:'桥间 · GitHub'},plugins:[{name:'gpt-dsh-monitor',source:{source:'local',path:'./plugins/gpt-dsh-monitor'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}]};
  if(withBridge){
    const source=join(root,'optional-plugins/dsh-codex-bridge'),destination=join(integration,'plugins/dsh-codex-bridge');if(!existsSync(source))throw Error('BRIDGE_PACKAGE_MISSING');cpSync(source,destination,{recursive:true});
    if(!portable&&existsSync(join(destination,'plugin.json')))renameSync(join(destination,'plugin.json'),join(destination,'plugin.portable.json.txt'));
    const bridgeCache=resolve(process.env.CODEX_HOME??join(process.env.USERPROFILE??process.env.HOME,'.codex'),'plugins/cache',name,'dsh-codex-bridge',version);
    const servers={dsh_codex_bridge:{type:'stdio',command:process.execPath,args:[join(bridgeCache,'server/index.mjs')],cwd:bridgeCache,env:{MONITOR_HOME:home}}};
    writeFileSync(join(destination,'.mcp.json'),JSON.stringify({mcpServers:servers},null,2)+'\n');writeFileSync(join(destination,'mcp.json'),JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',mcpServers:servers},null,2)+'\n');
    marketplace.plugins.push({name:'dsh-codex-bridge',source:{source:'local',path:'./plugins/dsh-codex-bridge'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'});
  }
 mkdirSync(join(integration,'.agents/plugins'),{recursive:true});writeFileSync(join(integration,'.agents/plugins/marketplace.json'),JSON.stringify(marketplace,null,2)+'\n');
 return {integration,name,cfg};
}
async function main(){
 const [major,minor]=process.versions.node.split('.').map(Number);if(major<24||(major===24&&minor<12))throw Error('NODE_24_12_REQUIRED');
 const args=process.argv.slice(2),command=args.shift()??'help',values={};const booleans=new Set(['--demo','--background','--bridge','--mcp','--portable']);
 if(command==='maintenance'){const index=args.indexOf('--home');let selectedHome;if(index>=0){if(!args[index+1])throw Error('INVALID_ARGUMENT');selectedHome=args[index+1];args.splice(index,2)}const result=spawnSync(process.execPath,[join(root,'runtime/maintenance.mjs'),...args],{windowsHide:true,stdio:'inherit',env:{...process.env,MONITOR_HOME:safePath(dataHome(selectedHome))}});process.exitCode=result.status??1;return}
 const allowed=new Set(['--home','--project','--source','--sessions','--port','--bridge-port','--collab','--codex']);
 while(args.length){const key=args.shift();if(values[key]!==undefined)throw Error('INVALID_ARGUMENT');if(booleans.has(key)){values[key]=true;continue}if(!allowed.has(key)||!args.length)throw Error('INVALID_ARGUMENT');values[key]=args.shift()}
 const home=safePath(dataHome(values['--home']));
 if(command==='help'){output({ok:true,version,commands:['setup','start','stop','status','doctor','generate-codex','install-codex','maintenance','uninstall'],dataKeptOnUninstall:true});return}
 if(command==='setup')return setup(values);
 if(command==='doctor'){
  const service=await control(home);let mcp;try{if(values['--mcp'])mcp=await inspectMcp(join(root,'server/index.mjs'),home)}catch{mcp={code:'MCP_NOT_READY',ui:'not_verified'}}
  const healthy=service?.collector==='running',mcpHealthy=!values['--mcp']||(mcp?.schemaVersion===2&&mcp.readonly===true&&mcp.maintenanceDenied===true);
  output({ok:configured(home)&&healthy&&mcpHealthy,configured:configured(home),node:process.versions.node,collector:service?.collector??'not_running',mcp:mcp??{state:'not_checked',ui:'not_verified'},version});return;
 }
 if(!configured(home))throw Error('SETUP_REQUIRED');
 if(command==='status'){const service=await control(home);output({ok:true,state:service?'running':'stopped',collector:service?.collector??'not_running',bridge:service?.bridge??false,version});return}
 if(command==='stop'){const stopped=await control(home,'/stop');output({ok:true,state:stopped?'stopping':'not_running'});return}
 if(command==='start'){
  if(await control(home)){output({ok:true,code:'ALREADY_RUNNING'});return}
  if(values['--background']){const child=spawn(process.execPath,[join(root,'bin/main.mjs'),'start','--home',home,...(values['--bridge']?['--bridge']:[])],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,MONITOR_HOME:home}});child.unref();for(let i=0;i<80;i++){if(await control(home)){output({ok:true,state:'running',url:`http://127.0.0.1:${settings(home).port}`});return}await sleep(100)}throw Error('SERVICE_NOT_READY')}
  process.env.MONITOR_HOME=home;const {runService}=await import('../runtime/service.mjs');return runService(home,{bridge:!!values['--bridge']});
 }
 if(command==='generate-codex'||command==='install-codex'){
  const generated=generateCodex(home,!!values['--bridge'],!!values['--portable']);
  if(command==='install-codex'){
   const executable=values['--codex'];if(!executable||!isAbsolute(executable)||!existsSync(executable))throw Error('CODEX_EXECUTABLE_REQUIRED');
   try{execFileSync(executable,['plugin','marketplace','add',generated.integration],{windowsHide:true,stdio:'pipe'});execFileSync(executable,['plugin','add','gpt-dsh-monitor@'+generated.name,'--json'],{windowsHide:true,stdio:'pipe'});if(values['--bridge'])execFileSync(executable,['plugin','add','dsh-codex-bridge@'+generated.name,'--json'],{windowsHide:true,stdio:'pipe'})}catch{throw Error('CODEX_INSTALL_FAILED')}
  }
  output({ok:true,generated:true,installed:command==='install-codex',version});return;
 }
 if(command==='uninstall'){
  await control(home,'/stop');
  if(values['--codex']&&(!isAbsolute(values['--codex'])||!existsSync(values['--codex'])))throw Error('CODEX_EXECUTABLE_REQUIRED');
  if(values['--codex']){try{execFileSync(values['--codex'],['plugin','remove','gpt-dsh-monitor@fish-dragon','--json'],{windowsHide:true,stdio:'pipe'});if(values['--bridge'])execFileSync(values['--codex'],['plugin','remove','dsh-codex-bridge@fish-dragon','--json'],{windowsHide:true,stdio:'pipe'})}catch{throw Error('CODEX_UNINSTALL_FAILED')}}
  output({ok:true,dataRetained:true,bridgeConfigurationRetained:true});return;
 }
 throw Error('INVALID_COMMAND');
}
main().catch(error=>{console.error(JSON.stringify({ok:false,code:/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'OPERATION_FAILED'}));process.exitCode=1});
