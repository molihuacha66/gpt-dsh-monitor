import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { resolve, relative, isAbsolute, basename, extname, sep } from 'node:path';
import { MonitorStore } from '../store.ts';
import { MonitorQuery } from '../query.ts';
import type { Filters } from '../query.ts';
import { MonitorError } from '../errors.ts';
import { redactText } from '../redaction.ts';
import type { Artifact, ArtifactLink, Preview } from './types.ts';

export const BACKFILL = ['PHASE2-REPORT.md','PHASE3-REPORT.md','PHASE4-REPORT.md','docs/dashboard.jpg','docs/phase4-agents.jpg'];
const textTypes = new Set(['.md','.txt','.ts','.tsx','.js','.jsx','.css','.json','.csv','.yaml','.yml','.log']);
const attachmentTypes = new Set(['.png','.jpg','.jpeg','.pdf','.zip','.svg','.html','.docx','.xlsx','.pptx']);
const safeImages = new Set(['docs/dashboard.jpg','docs/phase4-agents.jpg','docs/phase5-chat.jpg','docs/phase5-mcp.jpg']);
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
const within = (root:string,p:string) => {const r=relative(root,p);return !!r&&!r.startsWith('..')&&!isAbsolute(r)};
function projectKey(root:string) {const s=realpathSync.native(root);return hash(process.platform==='win32'?s.toLowerCase():s)}
export function artifactLocation(root:string,input:unknown):string {
  if(typeof input!=='string'||input.length>800||/[\x00-\x1f]|\[REDACTED\]|^[a-z]+:\/\//i.test(input)) throw new MonitorError('ARTIFACT_PATH_DENIED');
  const p=resolve(root,input.replace(/[\\/]/g,sep));
  if(!within(root,p)) throw new MonitorError('ARTIFACT_PATH_DENIED');
  const rel=relative(root,p).replaceAll(sep,'/');
  if(rel.split('/').some(x=>x.startsWith('.')||['node_modules','data'].includes(x))||/(?:secret|password|passwd|credential|private[-_]?key|token)/i.test(rel)) throw new MonitorError('ARTIFACT_PATH_DENIED');
  if(!textTypes.has(extname(rel).toLowerCase())&&!attachmentTypes.has(extname(rel).toLowerCase())) throw new MonitorError('ARTIFACT_TYPE_UNSUPPORTED');
  return rel;
}
function safeStat(root:string,rel:string) {
  const p=resolve(root,rel);
  if(!within(root,p)) throw new MonitorError('ARTIFACT_PATH_DENIED');
  let cursor=root;
  for(const part of relative(root,p).split(sep)) {
    cursor=resolve(cursor,part);
    if(!existsSync(cursor)) throw new MonitorError('ARTIFACT_MISSING');
    if(lstatSync(cursor).isSymbolicLink()) throw new MonitorError('ARTIFACT_PATH_DENIED');
  }
  const stat=lstatSync(p);
  if(!stat.isFile()||stat.nlink>1||!within(realpathSync.native(root),realpathSync.native(p))) throw new MonitorError('ARTIFACT_PATH_DENIED');
  return {path:p,stat};
}
function status(root:string,rel:string) {
  try {safeStat(root,rel);return 'available'} catch(e) {return e instanceof MonitorError&&e.code==='ARTIFACT_MISSING'?'missing':e instanceof MonitorError?'denied':'unknown'}
}
export class ArtifactIndexer {
  store:MonitorStore; root:string; backfill:string[];
  constructor(database:string,root:string,backfill=BACKFILL) {
    this.backfill=backfill;
    this.root=realpathSync.native(root);
    for(const p of [database,`${database}-wal`,`${database}-shm`]) if(existsSync(p)&&(lstatSync(p).isSymbolicLink()||lstatSync(p).nlink>1)) throw new MonitorError('UNSAFE_OUTPUT_PATH');
    this.store=new MonitorStore(database);
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS artifact_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_registry(id TEXT PRIMARY KEY,relative_path TEXT NOT NULL UNIQUE,name TEXT NOT NULL,type TEXT NOT NULL,availability TEXT NOT NULL,checked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_links(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL,collab TEXT,message_id TEXT,task_id TEXT,evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('message-declared','task-declared','path-only')),source TEXT NOT NULL,declared_at INTEGER,observed_at INTEGER NOT NULL,note TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_artifact_links_scope ON artifact_links(collab,message_id);`);
    if(!this.store.db.prepare('PRAGMA table_info(artifact_links)').all().some(r=>r.name==='declared_by'))this.store.db.exec("ALTER TABLE artifact_links ADD COLUMN declared_by TEXT NOT NULL DEFAULT 'unknown'");
    this.store.db.prepare("INSERT OR IGNORE INTO artifact_meta VALUES('project',?)").run(projectKey(this.root));
    if(this.store.db.prepare("SELECT value FROM artifact_meta WHERE key='project'").get()!.value!==projectKey(this.root)){this.store.close();throw new MonitorError('ARTIFACT_PROJECT_MISMATCH')}
  }
  cycle() {
    const db=this.store.db,now=Date.now();db.exec('BEGIN IMMEDIATE');
    try {
      const register=(path:unknown,link:{collab:string|null;message:string|null;task:string|null;evidence:string;source:string;at:number|null;origin:string;note:string;by?:string})=>{
        let rel:string;try{rel=artifactLocation(this.root,path)}catch{return}
        const id='a_'+hash(rel.toLowerCase()).slice(0,24),name=redactText(basename(rel));
        db.prepare('INSERT INTO artifact_registry VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET availability=excluded.availability,checked_at=excluded.checked_at').run(id,rel,name,extname(rel).slice(1),status(this.root,rel),now);
        const linkId='l_'+hash(JSON.stringify([id,link.source,link.origin])).slice(0,24);
        db.prepare('INSERT INTO artifact_links VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET message_id=excluded.message_id WHERE artifact_links.source=\'manual-backfill\' AND artifact_links.message_id IS NULL AND excluded.message_id IS NOT NULL').run(linkId,id,link.collab,link.message,link.task,link.evidence,link.source,link.at,now,link.note,redactText(link.by??(link.source==='manual-backfill'?'codex':'unknown')));
      };
      const anchor=db.prepare("SELECT json_extract(payload,'$.id') AS id FROM source_rows WHERE table_name='messages' AND collab='default' AND source_present=1 AND instr(COALESCE(json_extract(payload,'$.body'),''),?)>0 ORDER BY CASE WHEN json_extract(payload,'$.kind')='evidence' THEN 0 ELSE 1 END,CAST(row_key AS INTEGER) LIMIT 1");
      for(const rel of this.backfill) register(rel,{collab:'default',message:anchor.get(basename(rel))?.id as string??null,task:null,evidence:'path-only',source:'manual-backfill',at:null,origin:rel,note:'已知阶段产物补录；锚点仅为文件名提及，历史版本未留存'});
      const rows=db.prepare("SELECT row_key,table_name,collab,payload FROM source_rows WHERE table_name IN ('messages','tasks') AND source_present=1 LIMIT 100001").all();
      if(rows.length>100000)throw new MonitorError('ARTIFACT_INDEX_LIMIT');
      let candidates=0;
      for(const row of rows){
        const data=JSON.parse(String(row.payload)),collab=row.collab==null?null:String(row.collab);
        let entries:unknown[]=[];const task=row.table_name==='tasks';
        if(task){try{const v=typeof data.artifacts==='string'?JSON.parse(data.artifacts):data.artifacts;if(Array.isArray(v))entries=v.slice(0,32)}catch{/* No invented fallback parsing. */}}
        else if(typeof data.body==='string'&&['codex','dsh'].includes(data.sender)){
          const blocks=[...data.body.matchAll(/```monitor-artifacts\s*\r?\n([\s\S]*?)```/g)].slice(0,4);
          for(const b of blocks){if(b[1]!.length>16384)continue;try{const v=JSON.parse(b[1]!);if(Array.isArray(v))entries.push(...v.slice(0,32))}catch{/* Invalid declaration is not a file. */}}
        }
        for(const [i,v]of entries.entries()){
          if(++candidates>5000)throw new MonitorError('ARTIFACT_INDEX_LIMIT');
          const obj=v&&typeof v==='object'?v as Record<string,unknown>:{};
          register(typeof v==='string'?v:obj.path??obj.file??obj.location,{collab,message:task?null:String(data.id),task:task?String(data.id):null,evidence:task?'task-declared':'message-declared',source:task?'task-artifacts':'explicit-message',at:Number(data.updated_at??data.created_at),origin:`${row.table_name}:${row.row_key}:${i}`,note:task?'任务声明文件，未推断具体消息轮次':'该消息明确声明，未验证历史内容版本',by:String(task?(data.assignee??data.creator??'unknown'):data.sender)});
        }
      }
      db.exec('COMMIT');return {files:Number(db.prepare('SELECT count(*) n FROM artifact_registry').get()!.n),links:Number(db.prepare('SELECT count(*) n FROM artifact_links').get()!.n)};
    }catch(e){db.exec('ROLLBACK');throw e}
  }
  close(){this.store.close()}
}
export class ArtifactQuery {
  query:MonitorQuery;root:string;
  constructor(database:string,root:string){this.query=new MonitorQuery(database);this.root=realpathSync.native(root)}
  list(f:Filters):Artifact[]{return this.query.read(db=>{
    if(!db.prepare("SELECT name FROM sqlite_master WHERE name='artifact_registry'").get())return [];
    if(db.prepare("SELECT value FROM artifact_meta WHERE key='project'").get()?.value!==projectKey(this.root))throw new MonitorError('ARTIFACT_PROJECT_MISMATCH');
    const wh=['1=1'],values:(string|number)[]=[];
    if(f.collab==='__unknown__')wh.push('l.collab IS NULL');else if(f.collab!=='__all__'){wh.push('l.collab=?');values.push(f.collab)}
    if(!f.includeTests)wh.push("(l.collab IS NULL OR (l.collab NOT GLOB 'test-*' AND l.collab NOT GLOB 'mcp-*'))");
    const scopeTime="CASE WHEN l.source='manual-backfill' AND l.message_id IS NOT NULL THEN (SELECT CAST(json_extract(payload,'$.created_at') AS INTEGER) FROM source_rows WHERE table_name='messages' AND json_extract(payload,'$.id')=l.message_id AND collab IS l.collab LIMIT 1) ELSE COALESCE(l.declared_at,l.observed_at) END";
    if(f.from!==null){wh.push(`${scopeTime}>=?`);values.push(f.from)}
    if(f.to!==null){wh.push(`${scopeTime}<=?`);values.push(f.to)}
    // Deletions in the monitored source remove active links, never manufacture a replacement anchor.
    const messageScope=this.query.where('messages',{...f,q:'',before:null});
    wh.push(`(l.message_id IS NULL OR EXISTS(SELECT 1 FROM source_rows WHERE ${messageScope.sql} AND collab IS l.collab AND json_extract(payload,'$.id')=l.message_id))`);values.push(...messageScope.values);
    wh.push("(l.task_id IS NULL OR EXISTS(SELECT 1 FROM source_rows t WHERE t.table_name='tasks' AND t.source_present=1 AND t.collab IS l.collab AND json_extract(t.payload,'$.id')=l.task_id))");
    const rows=db.prepare(`SELECT r.id,r.name,r.type,r.relative_path,r.availability,r.checked_at,l.id AS link_id,l.collab,l.message_id,l.task_id,l.evidence_kind,l.source,l.declared_at,l.observed_at,l.note,l.declared_by FROM artifact_registry r JOIN artifact_links l ON r.id=l.artifact_id WHERE ${wh.join(' AND ')} ORDER BY l.observed_at,r.name LIMIT 5001`).all(...values);
    if(rows.length>5000)throw new MonitorError('ARTIFACT_INDEX_LIMIT');
    const map=new Map<string,Artifact>();
    for(const r of rows){const id=String(r.id);let a=map.get(id);if(!a){a={id,name:String(r.name),type:String(r.type),previewable:textTypes.has('.'+String(r.type).toLowerCase())||safeImages.has(String(r.relative_path)),availability:String(r.availability),checkedAt:Number(r.checked_at),links:[]};map.set(id,a)}
      const link:ArtifactLink={id:String(r.link_id),collab:r.collab==null?null:String(r.collab),messageId:r.message_id==null?null:String(r.message_id),taskId:r.task_id==null?null:String(r.task_id),evidence:String(r.evidence_kind),source:String(r.source),declaredAt:r.declared_at==null?null:Number(r.declared_at),observedAt:Number(r.observed_at),note:String(r.note),declaredBy:String(r.declared_by)};a.links.push(link)}
    return [...map.values()];
  })}
  preview(id:string,f:Filters):Preview {
    if(!/^a_[0-9a-f]{24}$/.test(id))throw new MonitorError('INVALID_FILTER');
    const artifact=this.list(f).find(a=>a.id===id);if(!artifact)throw new MonitorError('NOT_FOUND');
    const rel=this.query.read(db=>String(db.prepare('SELECT relative_path FROM artifact_registry WHERE id=?').get(id)!.relative_path));
    artifactLocation(this.root,rel);if(!artifact.previewable)throw new MonitorError('ARTIFACT_TYPE_UNSUPPORTED');const {path,stat}=safeStat(this.root,rel);
    const image=safeImages.has(rel),limit=image?4*1024*1024:512*1024;
    if(stat.size>limit)throw new MonitorError('ARTIFACT_TOO_LARGE');
    const fd=openSync(path,'r');let bytes:Buffer;
    try{
      const s=fstatSync(fd);if(s.ino!==stat.ino||s.dev!==stat.dev||s.nlink>1||s.size!==stat.size)throw new MonitorError('ARTIFACT_CHANGED');
      safeStat(this.root,rel);bytes=Buffer.alloc(s.size);let n=0;while(n<bytes.length){const got=readSync(fd,bytes,n,bytes.length-n,n);if(!got)throw new MonitorError('ARTIFACT_CHANGED');n+=got}
      const after=fstatSync(fd);if(after.size!==s.size||after.mtimeMs!==s.mtimeMs)throw new MonitorError('ARTIFACT_CHANGED');
    }finally{closeSync(fd)}
    const notice='当前文件只读预览；历史版本未留存，存在不证明当轮生成。';
    if(image){if(bytes.length<4||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw new MonitorError('ARTIFACT_TYPE_UNSUPPORTED');return {artifact,kind:'image',image:`data:image/jpeg;base64,${bytes.toString('base64')}`,notice}}
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw new MonitorError('ARTIFACT_ENCODING_UNSUPPORTED')}
    return {artifact,kind:'text',text:redactText(text),notice};
  }
}
