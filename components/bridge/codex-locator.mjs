// Modified for portable distribution: local configuration, isolated lifecycle and explicit cursor commits.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,lstatSync,readdirSync,realpathSync} from 'node:fs';
import {basename,isAbsolute,join,relative,resolve} from 'node:path';

const execute=promisify(execFile);
const inside=(root,path)=>{const part=relative(resolve(root),resolve(path));return !!part&&!part.startsWith('..')&&!isAbsolute(part)};
const validFile=(path,root)=>{try{return existsSync(path)&&!lstatSync(path).isSymbolicLink()&&lstatSync(path).isFile()&&(!root||inside(realpathSync(root),realpathSync(path)))}catch{return false}};
function missing(){const error=new Error('CODEX_EXECUTABLE_NOT_FOUND');error.code='codex_not_found';return error}
async function installedPackages(){
  const powershell=join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const {stdout}=await execute(powershell,['-NoProfile','-NonInteractive','-Command','[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Get-AppxPackage -Name OpenAI.Codex | Select-Object Name,Version,InstallLocation | ConvertTo-Json -Compress'],{windowsHide:true,timeout:5000,maxBuffer:65536,encoding:'utf8'});
  const parsed=JSON.parse(stdout.trim()||'[]');return Array.isArray(parsed)?parsed:[parsed];
}
export async function resolveCodexExecutable(configured,{localAppData=process.env.LOCALAPPDATA,programFiles=process.env.ProgramFiles,queryPackages=installedPackages}={}){
  if(configured!=='auto'){
    if(typeof configured!=='string'||!isAbsolute(configured)||!validFile(configured))throw missing();
    return realpathSync(configured);
  }
  // Resolve afresh for every probe/run. Never execute a PATH entry or guess a global shim.
  if(programFiles){
    const root=join(programFiles,'WindowsApps');
    let packages=[];try{packages=await queryPackages()}catch{/* Appx lookup may be unavailable; use only the vendor's bounded cache below. */}
    // Publisher family is deliberately pinned; a vendor package identity change requires review.
    packages=packages.filter(p=>p?.Name==='OpenAI.Codex'&&typeof p.InstallLocation==='string'&&inside(root,p.InstallLocation)&&/^OpenAI\.Codex_[0-9.]+_(?:x64|arm64)__2p2nqsd0c76g0$/i.test(basename(p.InstallLocation)));
    packages.sort((a,b)=>String(b.Version??'').localeCompare(String(a.Version??''),undefined,{numeric:true}));
    for(const p of packages){const file=join(p.InstallLocation,'app/resources/codex.exe');if(validFile(file,root))return realpathSync(file)}
  }
  if(localAppData){
    const root=join(localAppData,'OpenAI/Codex/bin');let candidates=[];
    try{candidates=readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory()&&/^[a-f0-9]{16}$/i.test(d.name)).slice(0,64).map(d=>join(root,d.name,'codex.exe')).filter(file=>validFile(file,root)).map(file=>({file,time:lstatSync(file).mtimeMs})).sort((a,b)=>b.time-a.time||a.file.localeCompare(b.file))}catch{/* No installed cache. */}
    if(candidates.length)return realpathSync(candidates[0].file);
  }
  throw missing();
}
