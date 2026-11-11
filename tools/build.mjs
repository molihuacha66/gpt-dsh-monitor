import {readFileSync,writeFileSync,mkdirSync,cpSync,existsSync,readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {build}=await import(process.env.BRIDGE_BUILD_MODULES?pathToFileURL(join(process.env.BRIDGE_BUILD_MODULES,'esbuild/lib/main.js')).href:'esbuild');
const root=resolve(import.meta.dirname,'..'),source=join(root,'packages/monitor'),plugin=join(root,'plugins/gpt-dsh-monitor'),version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
const developmentModules=process.env.BRIDGE_BUILD_MODULES;
const nodePaths=developmentModules?[developmentModules]:[];
const metadata=[];
async function compile(entry,outfile,extra={}){mkdirSync(dirname(outfile),{recursive:true});const result=await build({entryPoints:[entry],outfile,bundle:true,platform:'node',format:'esm',target:'node24',metafile:true,nodePaths,absWorkingDir:root,banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"},...extra});metadata.push(result.metafile)}
const workerPlugin={name:'bundled-worker-location',setup(b){b.onLoad({filter:/runtime[\\/]controller\.ts$/},async args=>({contents:readFileSync(args.path,'utf8').replace("new URL('./worker.ts',import.meta.url)","new URL('./worker.mjs',import.meta.url)"),loader:'ts'}))}};
await compile(join(source,'src/runtime/worker.ts'),join(plugin,'runtime/worker.mjs'));
await compile(join(root,'bin/service.ts'),join(plugin,'runtime/service.mjs'),{plugins:[workerPlugin]});
await compile(join(root,'bin/demo.ts'),join(plugin,'runtime/demo.mjs'));
await compile(join(source,'src/maintenance/cli.ts'),join(plugin,'runtime/maintenance.mjs'));
await compile(join(source,'src/mcp/stdio.ts'),join(plugin,'server/index.mjs'));
// Browser build is self-contained and does not require a runtime npm install.
const ui=await build({entryPoints:[join(source,'web/mcp.tsx')],outfile:'app.js',bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',minify:true,nodePaths,metafile:true,absWorkingDir:root,define:{'process.env.NODE_ENV':'"production"'}});metadata.push(ui.metafile);
const js=ui.outputFiles.find(f=>f.path.endsWith('.js')).text.replace(/<\/script/gi,'<\\/script'),css=(ui.outputFiles.find(f=>f.path.endsWith('.css'))?.text??'').replace(/<\/style/gi,'<\\/style');
mkdirSync(join(plugin,'dist/assets'),{recursive:true});mkdirSync(join(plugin,'ui'),{recursive:true});
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>桥间 · GPT × DSH</title><style>${css}</style></head><body><div id="root"></div><script type="module">${js}</script></body></html>`;
writeFileSync(join(plugin,'ui/monitor.html'),html);writeFileSync(join(plugin,'dist/mcp-app.html'),html);
const web=await build({entryPoints:[join(source,'web/main.tsx')],outdir:join(plugin,'dist/assets'),bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,nodePaths,metafile:true,absWorkingDir:root,define:{'process.env.NODE_ENV':'"production"'}});metadata.push(web.metafile);
writeFileSync(join(plugin,'dist/index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>桥间 · 通信监控</title><link rel="stylesheet" href="/assets/main.css"></head><body><div id="root"></div><script type="module" src="/assets/main.js"></script></body></html>');
cpSync(join(root,'components/bridge'),join(plugin,'components/bridge'),{recursive:true});
const bridgePlugin=join(root,'plugins/dsh-codex-bridge');mkdirSync(join(bridgePlugin,'server'),{recursive:true});
const bridgeEntry=join(root,'tools/bridge-entry.mjs');writeFileSync(bridgeEntry,"import {dataHome} from '../plugins/gpt-dsh-monitor/lib/config.mjs';\nimport {join} from 'node:path';\nprocess.env.DSH_CODEX_BRIDGE_HOME??=join(dataHome(),'bridge');\nawait import('../components/bridge/mcp-server.mjs');\n");await compile(bridgeEntry,join(bridgePlugin,'server/index.mjs'));
// Preserve actual license files for every npm package included in bundles.
const packages=new Map();for(const meta of metadata)for(const input of Object.keys(meta.inputs)){
 let cursor=dirname(resolve(root,input));while(cursor!==dirname(cursor)){
  const file=join(cursor,'package.json');if(existsSync(file)){try{const p=JSON.parse(readFileSync(file,'utf8'));if(p.name&&!p.private)packages.set(p.name+'@'+p.version,{root:cursor,name:p.name,version:p.version,license:p.license??'UNDECLARED'});break}catch{}}cursor=dirname(cursor);
 }
}
const notices=[];mkdirSync(join(root,'third-party-licenses'),{recursive:true});
for(const p of [...packages.values()].sort((a,b)=>a.name.localeCompare(b.name))){
 const files=readdirSync(p.root).filter(n=>/^(licen[sc]e|copying|notice)(\.|$)/i.test(n));
 if(!files.length)throw Error('DEPENDENCY_LICENSE_MISSING: '+p.name);
 for(const file of files){const name=p.name.replaceAll('/','__').replace('@','')+'-'+p.version+'-'+file;cpSync(join(p.root,file),join(root,'third-party-licenses',name));}
 notices.push({name:p.name,version:p.version,license:p.license,files:files.map(file=>p.name.replaceAll('/','__').replace('@','')+'-'+p.version+'-'+file)});
}
writeFileSync(join(root,'THIRD-PARTY-NOTICES.json'),JSON.stringify(notices,null,2)+'\n');
cpSync(join(root,'third-party-licenses'),join(plugin,'third-party-licenses'),{recursive:true});
cpSync(join(root,'THIRD-PARTY-NOTICES.json'),join(plugin,'THIRD-PARTY-NOTICES.json'));
if(existsSync(join(root,'LICENSE'))){cpSync(join(root,'LICENSE'),join(plugin,'LICENSE'));cpSync(join(root,'LICENSE'),join(bridgePlugin,'LICENSE'))}
cpSync(bridgePlugin,join(plugin,'optional-plugins/dsh-codex-bridge'),{recursive:true});
if(existsSync(join(root,'THIRD-PARTY-NOTICES.md')))cpSync(join(root,'THIRD-PARTY-NOTICES.md'),join(plugin,'THIRD-PARTY-NOTICES.md'));
writeFileSync(join(root,'BUILD-INFO.json'),JSON.stringify({version,node:process.versions.node,dependenciesBundled:packages.size,monitorRuntimeRequiresNpmInstall:false,workerBuiltSeparately:true},null,2)+'\n');
console.log(JSON.stringify({ok:true,version,dependencies:packages.size}));
