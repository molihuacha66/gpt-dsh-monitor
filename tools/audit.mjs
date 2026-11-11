import {readdirSync,lstatSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),ignored=new Set(['node_modules','.git','.pnpm-store']),files=[],problems=[];
function walk(dir){for(const name of readdirSync(dir)){if(ignored.has(name))continue;const path=join(dir,name),rel=relative(root,path).replaceAll('\\','/'),stat=lstatSync(path);if(stat.isSymbolicLink()){problems.push({file:rel,code:'LINK_DENIED'});continue}if(stat.isDirectory()){walk(path);continue}if(rel==='FILE-MANIFEST.json')continue;
 if(/\.sqlite(?:-|$)|\.zip$|^(token(?:-codex)?\.txt|settings\.json|instance\.json|endpoint\.json|config\.json)$/.test(name))problems.push({file:rel,code:'RUNTIME_DATA_DENIED'});
 const bytes=readFileSync(path),text=bytes.toString('utf8');
 const privateFragments=['C:/Users/'+'170'+'00','C:\\\\Users\\\\'+'170'+'00','D:/大肥鱼'+'和龙娘','D:\\大肥鱼'+'和龙娘'];
 if(privateFragments.some(v=>text.includes(v)))problems.push({file:rel,code:'MACHINE_PATH_DENIED'});
 if(!rel.includes('/test/')&&!rel.startsWith('test/')&&/(?:gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/]{20,})/.test(text))problems.push({file:rel,code:'POSSIBLE_CREDENTIAL'});
 if(name.endsWith('.json'))try{JSON.parse(text)}catch{problems.push({file:rel,code:'JSON_INVALID'})}
 files.push({path:rel,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}}
walk(root);
for(const required of ['LICENSE','README.md','docs/INSTALL.md','docs/COMPATIBILITY.md','THIRD-PARTY-NOTICES.json','plugins/gpt-dsh-monitor/plugin.json','plugins/gpt-dsh-monitor/runtime/worker.mjs','plugins/gpt-dsh-monitor/runtime/service.mjs','plugins/gpt-dsh-monitor/server/index.mjs','plugins/gpt-dsh-monitor/LICENSE','plugins/gpt-dsh-monitor/THIRD-PARTY-NOTICES.json'])if(!existsSync(join(root,required)))problems.push({file:required,code:'REQUIRED_FILE_MISSING'});
for(const plugin of ['gpt-dsh-monitor','dsh-codex-bridge']){const portable=JSON.parse(readFileSync(join(root,'plugins',plugin,'plugin.json'),'utf8')),legacy=JSON.parse(readFileSync(join(root,'plugins',plugin,'.codex-plugin/plugin.json'),'utf8'));if(portable.name!==legacy.name||portable.version!==legacy.version)problems.push({file:plugin,code:'PLUGIN_IDENTITY_MISMATCH'})}
const notices=JSON.parse(readFileSync(join(root,'THIRD-PARTY-NOTICES.json'),'utf8'));for(const p of notices)for(const name of p.files)if(!existsSync(join(root,'third-party-licenses',name)))problems.push({file:p.name,code:'THIRD_PARTY_LICENSE_MISSING'});
writeFileSync(join(root,'FILE-MANIFEST.json'),JSON.stringify({version:'0.7.0-beta.1',files:files.sort((a,b)=>a.path.localeCompare(b.path)),audit:{ok:problems.length===0,problems},limits:'Pattern scan and allowlist packaging do not prove absence of all possible secrets.'},null,2)+'\n');
console.log(JSON.stringify({ok:problems.length===0,files:files.length,bytes:files.reduce((a,f)=>a+f.bytes,0),dependencies:notices.length,problems}));if(problems.length)process.exitCode=1;
