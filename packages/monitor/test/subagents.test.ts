import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, utimesSync, linkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync, constants } from 'node:zlib';
import { AgentCollector } from '../src/subagents/collector.ts';
import { AgentQuery } from '../src/subagents/query.ts';
import { header, normalize } from '../src/subagents/normalize.ts';
import { decodeFrames, frameEnd } from '../src/subagents/zstd.ts';
import { createDashboardServer } from '../src/server.ts';

const child = '4fad9b9d-6e2f-4aa8-9d3e-43f16aa3ca89', parent = 'session-36bf694d-84c7-4408-89cd-acdef7de655e';
const h = (extra={}) => ({type:'session',version:4,id:child,createdAt:1000,parentSession:parent,isSeeded:false,origin:'subagent',delegationDepth:1,...extra});
const event = (seq:number,type:string,data:unknown) => ({seq,type,time:2000+seq,data});
const message = (text:string,source:unknown={kind:'user'}) => ({role:'user',source,content:[{type:'text',text}]});
const descriptor = () => ({version:3,mode:'continuable',provider:'spawn',label:'测试子会话'});
const frame = (rows:unknown[],checksum=false) => zstdCompressSync(Buffer.from(rows.map(x=>JSON.stringify(x)).join('\n')+'\n'),{params:{[constants.ZSTD_c_checksumFlag]:checksum?1:0}});
function fixture(t:any, rows:unknown[]=[h(),event(0,'subagent/descriptor',descriptor()),event(1,'user/message',message('初始委派'))]) {
  const dir=mkdtempSync(join(tmpdir(),'comm-monitor-agents-')), root=join(dir,'sessions'), session=join(root,'project',child), output=join(dir,'monitor.sqlite');
  mkdirSync(session,{recursive:true});const path=join(session,'session.v4.jsonl.zstd');writeFileSync(path,frame(rows));
  let collector=new AgentCollector(root,output);
  const x={dir,root,path,output,get collector(){return collector},query:new AgentQuery(output),restart(){collector.close();collector=new AgentCollector(root,output)}};
  t.after(()=>{collector.close();assert.ok(dir.startsWith(join(tmpdir(),'comm-monitor-agents-')));rmSync(dir,{recursive:true,force:true})});return x;
}

test('zstd decoder walks concatenated frames and buffers every truncated prefix',()=>{
  const a=frame([h()]),b=frame([event(0,'turn/start',{turn:1})],true),both=Buffer.concat([a,b]);
  assert.equal(frameEnd(both,0),a.length);assert.equal(decodeFrames(both).rows.length,2);
  for(let n=1;n<b.length;n++){const d=decodeFrames(Buffer.concat([a,b.subarray(0,n)]));assert.equal(d.consumed,a.length);assert.equal(d.pending,true);assert.equal(d.rows.length,1)}
});
test('invalid frames, checksum corruption and incomplete JSONL are explicit failures',()=>{
  assert.throws(()=>decodeFrames(Buffer.from('not-a-frame')),/AGENT_FRAME_UNSUPPORTED/);
  const b=frame([h()],true);b[b.length-1]^=1;assert.throws(()=>decodeFrames(b),/AGENT_DECOMPRESSION_FAILED/);
  assert.throws(()=>decodeFrames(zstdCompressSync(Buffer.from('{}'))),/AGENT_JSONL_INCOMPLETE/);
  assert.throws(()=>decodeFrames(frame([h()]),1),/AGENT_DECOMPRESSION_FAILED|AGENT_RESOURCE_LIMIT/);
});
test('normalization uses exact source whitelist, not user/message alone',()=>{
  const s=header(h());const out=normalize(s,[event(0,'subagent/descriptor',descriptor()),event(1,'user/message',message('INJECTED',{kind:'runtime-context'})),event(2,'user/message',message('PROMPT')),event(3,'user/message',message('LATER HUMAN')),event(4,'assistant/message',{message:{role:'assistant',source:{kind:'model'},content:[{type:'thinking',text:'THINKING'},{type:'tool-call',text:'TOOL'},{type:'text',text:'OUTPUT'}]}})],true);
  const all=JSON.stringify(out);assert.ok(all.includes('PROMPT')&&all.includes('OUTPUT'));for(const bad of ['INJECTED','LATER HUMAN','THINKING','TOOL'])assert.ok(!all.includes(bad));assert.equal(out.find(e=>e.kind==='initial-delegation')!.evidence,'position-inference');assert.equal(out.find(e=>e.kind==='output')!.recipient_id,null);
});
test('root human/model messages never enter normalized communication',()=>{
  const s=header(h({id:parent,origin:undefined,parentSession:undefined,delegationDepth:0}));
  assert.equal(normalize(s,[event(0,'user/message',message('HUMAN')),event(1,'assistant/message',{message:{role:'assistant',content:[{type:'text',text:'ROOT MODEL'}]}})],true).length,0);
});
test('last inherited marker isolates nested seeded prefixes',()=>{
  const s=header(h({isSeeded:true}));const out=normalize(s,[event(0,'subagent/descriptor',descriptor()),event(1,'user/message',message('INHERITED-A')),event(2,'session/end-seed',{inherited:true}),event(3,'assistant/message',{message:{role:'assistant',content:[{type:'text',text:'INHERITED-B'}]}}),event(4,'session/end-seed',{inherited:true}),event(5,'turn/end',{reason:{kind:'forked'}}),event(6,'subagent/descriptor',descriptor()),event(7,'user/message',message('OWN'))],true);
  assert.equal(s.seed_cut,4);assert.ok(out.every(e=>e.seq>4));assert.ok(!JSON.stringify(out).includes('INHERITED'));assert.equal(out.find(e=>e.kind==='initial-delegation')?.text,'OWN');assert.equal(s.status,'unknown');
});
test('missing seed boundary or a later inherited marker fails without leaking content',()=>{
  assert.throws(()=>normalize(header(h({isSeeded:true})),[event(0,'subagent/descriptor',descriptor())],true),/AGENT_SEED_BOUNDARY_MISSING/);
  const s=header(h());normalize(s,[],true);assert.throws(()=>normalize(s,[event(0,'session/end-seed',{inherited:true})],false),/AGENT_SEED_BOUNDARY_CHANGED/);
  assert.throws(()=>normalize(header(h()),[event(0,'session/end-seed',{inherited:true})],true),/AGENT_SEED_BOUNDARY_INVALID/);
});
test('dense seq, header format and descriptor versions are validated',()=>{
  assert.throws(()=>header(h({version:5})),/AGENT_FORMAT_UNSUPPORTED/);assert.throws(()=>header(h({id:'not-an-id'})),/AGENT_HEADER_INVALID/);
  assert.throws(()=>normalize(header(h()),[event(1,'turn/start',{})],true),/AGENT_SEQUENCE_INVALID/);
  assert.throws(()=>normalize(header(h()),[event(0,'subagent/descriptor',{...descriptor(),version:99})],true),/AGENT_DESCRIPTOR_UNSUPPORTED/);
});
test('completed means one turn ended, and an explicit next turn resumes observation',()=>{
  const s=header(h());normalize(s,[event(0,'turn/start',{}),event(1,'turn/end',{reason:{kind:'completed'}})],true);assert.equal(s.status,'turn-ended');normalize(s,[event(2,'turn/start',{})],false);assert.equal(s.status,'observed-running');normalize(s,[event(3,'turn/end',{reason:{kind:'error',message:'RAW_ERROR_SECRET'}})],false);assert.equal(s.status,'turn-error');assert.ok(!JSON.stringify(s).includes('RAW_ERROR_SECRET'));
});
test('credentials and omitted tool/system content never reach monitor files',t=>{
  const x=fixture(t,[h(),event(0,'subagent/descriptor',{...descriptor(),label:'password: TOP_SECRET_LABEL'}),event(1,'user/message',message('password: TOP_SECRET_BODY\n正常指令')),event(2,'tool/call',{token:'TOP_SECRET_TOOL'}),event(3,'user/message',message('TOP_SECRET_CONTEXT',{kind:'time-context'})),event(4,'assistant/message',{message:{role:'assistant',content:[{type:'thinking',text:'TOP_SECRET_REASON'},{type:'text',text:'Authorization: Bearer abcd1234\n正常结果'}]}})]);
  assert.equal(x.collector.cycle().errors,0);const all=JSON.stringify(x.collector.store.db.prepare('SELECT * FROM agent_events').all());assert.ok(all.includes('[REDACTED]'));for(const secret of ['TOP_SECRET_LABEL','TOP_SECRET_BODY','TOP_SECRET_TOOL','TOP_SECRET_CONTEXT','TOP_SECRET_REASON']){assert.ok(!all.includes(secret));for(const suffix of ['','-wal']){try{assert.ok(!readFileSync(x.output+suffix).includes(Buffer.from(secret)))}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}}
});
test('incremental restart is idempotent and does not infer later human messages',t=>{
  const x=fixture(t);x.collector.cycle();const n=x.query.summary().events;x.restart();x.collector.cycle();assert.equal(x.query.summary().events,n);
  appendFileSync(x.path,frame([event(2,'user/message',message('NOT-A-DELEGATION')),event(3,'turn/end',{reason:{kind:'completed'}})]));x.collector.cycle();assert.equal(x.query.summary().events,n+1);assert.ok(!JSON.stringify(x.collector.store.db.prepare('SELECT * FROM agent_events').all()).includes('NOT-A-DELEGATION'));
});
test('partial appended frame is retried with checkpoint only after complete frame',t=>{
  const x=fixture(t);x.collector.cycle();const offset=x.collector.store.db.prepare('SELECT byte_offset FROM agent_files').get()!.byte_offset;
  const b=frame([event(2,'turn/start',{})],true);appendFileSync(x.path,b.subarray(0,b.length-2));assert.equal(x.collector.cycle().pending,1);assert.equal(x.collector.store.db.prepare('SELECT byte_offset FROM agent_files').get()!.byte_offset,offset);
  appendFileSync(x.path,b.subarray(b.length-2));assert.equal(x.collector.cycle().pending,0);assert.equal(x.query.summary().events,3);
});
test('initial partial inherited snapshot cannot expose a prefix before final cut',t=>{
  const x=fixture(t,[h({isSeeded:true}),event(0,'subagent/descriptor',descriptor()),event(1,'user/message',message('INHERITED'))]);assert.equal(x.collector.cycle().pending,1);assert.equal(x.query.summary().events,0);
  appendFileSync(x.path,frame([event(2,'session/end-seed',{inherited:true}),event(3,'subagent/descriptor',descriptor()),event(4,'user/message',message('OWN'))]));assert.equal(x.collector.cycle().errors,0);assert.ok(!JSON.stringify(x.collector.store.db.prepare('SELECT * FROM agent_events').all()).includes('INHERITED'));assert.equal(x.query.summary().events,2);
});
test('file failure rolls back new events and checkpoint; safe error is visible',t=>{
  const x=fixture(t);x.collector.cycle();const before=x.collector.store.db.prepare('SELECT byte_offset FROM agent_files').get()!.byte_offset;
  x.collector.store.db.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON agent_events BEGIN SELECT RAISE(ABORT,'RAW SECRET ERROR'); END");appendFileSync(x.path,frame([event(2,'turn/start',{})]));assert.equal(x.collector.cycle().errors,1);assert.equal(x.collector.store.db.prepare('SELECT byte_offset FROM agent_files').get()!.byte_offset,before);assert.equal(x.collector.store.db.prepare('SELECT status FROM agent_files').get()!.status,'IO_OR_DATABASE_ERROR');
  x.collector.store.db.exec('DROP TRIGGER inject_failure');assert.equal(x.collector.cycle().errors,0);assert.equal(x.query.summary().events,3);
});
test('source replacement keeps historical generation and adds a gap',t=>{
  const x=fixture(t);x.collector.cycle();renameSync(x.path,x.path+'.old');writeFileSync(x.path,frame([h(),event(0,'subagent/descriptor',descriptor())]));assert.equal(x.collector.cycle().errors,0);const rows=x.query.sessions('',null,20).items;assert.equal(rows.length,2);assert.equal(rows.filter(s=>s.current).length,1);assert.equal(x.collector.store.db.prepare("SELECT status FROM collection_gaps WHERE code='agent-source-rewritten'").get()!.status,'known-source-gap');
});
test('same-size rewrite is detected using mtime, absent source preserves history',t=>{
  const x=fixture(t);x.collector.cycle();utimesSync(x.path,new Date(3000),new Date(3000));x.collector.cycle();assert.equal(x.query.sessions('',null,20).items.length,2);renameSync(x.path,x.path+'.missing');assert.equal(x.collector.cycle().errors,1);assert.equal(x.query.summary().children,1);assert.equal(x.query.sessions('',null,20).items[0].fileStatus,'source-missing');
});
test('scanned zero differs from unavailable or unsupported source',t=>{
  const x=fixture(t,[h({id:parent,origin:undefined,parentSession:undefined,delegationDepth:0})]);assert.equal(x.collector.cycle().status,'scanned');assert.equal(x.query.summary().children,0);renameSync(x.root,x.root+'.away');assert.equal(x.collector.cycle().status,'AGENT_SOURCE_MISSING');renameSync(x.root+'.away',x.root);writeFileSync(x.path,frame([h({version:5})]));assert.equal(x.collector.cycle().errors,1);assert.equal(x.collector.store.db.prepare('SELECT status FROM agent_files').get()!.status,'AGENT_FORMAT_UNSUPPORTED');
});
test('unsafe output inside sessions and hardlinked source are refused',t=>{
  const x=fixture(t);assert.throws(()=>new AgentCollector(x.root,join(x.root,'monitor.sqlite')),/UNSAFE_OUTPUT_PATH/);linkSync(x.path,x.path+'.link');assert.ok(x.collector.cycle().discoveryErrors!>0);
});
test('parent receipt is explicit, child output does not fabricate delivery',t=>{
  const x=fixture(t,[h(),event(0,'subagent/descriptor',descriptor()),event(1,'assistant/message',{message:{role:'assistant',content:[{type:'text',text:'OWN OUTPUT'}]}})]);x.collector.cycle();const s=x.query.sessions('',null,20).items[0];let e=x.query.events(String(s.fileKey),Number(s.generation),null,20);assert.equal(e.items.find((r:any)=>r.kind==='output').recipient_id,null);
  const dir=join(x.root,'project',parent);mkdirSync(dir);writeFileSync(join(dir,'session.v4.jsonl.zstd'),frame([h({id:parent,origin:undefined,parentSession:undefined,delegationDepth:0}),event(0,'user/message',message('ACTUALLY RECEIVED',{kind:'agent-message',form:'relay',senderSessionId:child}))]));x.collector.cycle();e=x.query.events(String(s.fileKey),Number(s.generation),null,20);assert.equal(e.items.filter((r:any)=>r.kind==='received').length,1);assert.equal(e.items.find((r:any)=>r.kind==='received').sender_id,child);
});
test('agent queries paginate, search parameter values and do not mutate DB',t=>{
  const x=fixture(t);x.collector.cycle();const s=x.query.sessions('测试子会话',null,20).items[0];assert.ok(s);assert.equal(x.query.sessions("' OR 1=1--",null,20).total,0);assert.equal(x.query.sessions('',s.key,20).items.length,0);const before=JSON.stringify(x.collector.store.db.prepare('SELECT * FROM agent_files').all());const a=x.query.events(String(s.fileKey),Number(s.generation),null,1);assert.ok(a.nextBefore);assert.equal(x.query.events(String(s.fileKey),Number(s.generation),a.nextBefore,1).items.length,1);assert.equal(JSON.stringify(x.collector.store.db.prepare('SELECT * FROM agent_files').all()),before);assert.throws(()=>x.query.events('invalid',1,null,20),/INVALID_FILTER/);
});
test('partial discovery never turns an unenumerated source into confirmed missing',t=>{
  const x=fixture(t);x.collector.cycle();const original=x.collector.discover.bind(x.collector);x.collector.discover=()=>({files:[],errors:1});assert.equal(x.collector.cycle().status,'partial-error');assert.equal(x.collector.store.db.prepare('SELECT status FROM agent_files').get()!.status,'discovery-unknown');assert.equal(x.query.summary().children,1);x.collector.discover=original;x.collector.cycle();assert.equal(x.collector.store.db.prepare('SELECT status FROM agent_files').get()!.status,'parsed');
});
test('corrupt saved checkpoint recovers into a new generation with a gap',t=>{
  const x=fixture(t);x.collector.cycle();x.collector.store.db.prepare("UPDATE agent_files SET state='broken-json'").run();assert.equal(x.collector.cycle().errors,0);assert.equal(x.collector.store.db.prepare('SELECT generation FROM agent_files').get()!.generation,2);assert.equal(x.query.sessions('',null,20).total,2);
});
test('child received from parent and parent received from child are both visible without reversing either',t=>{
  const x=fixture(t);appendFileSync(x.path,frame([event(2,'user/message',message('TO CHILD',{kind:'agent-message',senderSessionId:parent}))]));
  const dir=join(x.root,'project',parent);mkdirSync(dir);writeFileSync(join(dir,'session.v4.jsonl.zstd'),frame([h({id:parent,origin:undefined,parentSession:undefined,delegationDepth:0}),event(0,'user/message',message('TO PARENT',{kind:'agent-message',senderSessionId:child}))]));x.collector.cycle();const s=x.query.sessions('',null,20).items[0];const es=x.query.events(String(s.fileKey),Number(s.generation),null,20).items.filter((e:any)=>e.kind==='received');assert.equal(es.length,2);assert.ok(es.some((e:any)=>e.sender_id===parent&&e.recipient_id===child&&e.text==='TO CHILD'));assert.ok(es.some((e:any)=>e.sender_id===child&&e.recipient_id===parent&&e.text==='TO PARENT'));
});
test('communication order uses source time with composite cursor, invalid cursor is explicit',t=>{
  const x=fixture(t,[h(),event(0,'subagent/descriptor',descriptor()),{...event(1,'turn/start',{}),time:9000},{...event(2,'turn/end',{reason:{kind:'completed'}}),time:8000}]);x.collector.cycle();const s=x.query.sessions('',null,20).items[0];const a=x.query.events(String(s.fileKey),Number(s.generation),null,1);assert.equal(a.items[0].at,9000);const b=x.query.events(String(s.fileKey),Number(s.generation),a.nextBefore,1);assert.equal(b.items[0].at,8000);assert.throws(()=>x.query.events(String(s.fileKey),Number(s.generation),999999,1),/AGENT_CURSOR_INVALID/);
});
test('historical child generation does not merge current parent receipts',t=>{
  const x=fixture(t);x.collector.cycle();const old=x.query.sessions('',null,20).items[0];const dir=join(x.root,'project',parent);mkdirSync(dir);writeFileSync(join(dir,'session.v4.jsonl.zstd'),frame([h({id:parent,origin:undefined,parentSession:undefined,delegationDepth:0}),event(0,'user/message',message('CURRENT RECEIPT',{kind:'agent-message',senderSessionId:child}))]));renameSync(x.path,x.path+'.old');writeFileSync(x.path,frame([h(),event(0,'subagent/descriptor',descriptor())]));x.collector.cycle();const es=x.query.events(String(old.fileKey),Number(old.generation),null,20);assert.equal(es.source.current,false);assert.ok(!es.items.some((e:any)=>e.kind==='received'));const current=x.query.sessions('',null,20).items.find(s=>s.current)!;assert.ok(x.query.events(String(current.fileKey),Number(current.generation),null,20).items.some((e:any)=>e.kind==='received'));
});
test('cycle decompression budget is charged per frame and blocks more work',t=>{
  const x=fixture(t);x.collector.decodeBudget=1000;const b=frame([h()]);x.collector.decode(b);assert.ok(x.collector.decodeBudget<1000);x.collector.decodeBudget=0;assert.throws(()=>x.collector.decode(b),/AGENT_CYCLE_BUDGET/);
});
test('one monitor cannot accidentally mix two different session roots',t=>{
  const x=fixture(t);x.collector.cycle();const root2=join(x.dir,'other-sessions');mkdirSync(root2);assert.throws(()=>new AgentCollector(root2,x.output),/AGENT_SOURCE_REPLACED/);assert.equal(x.query.summary().children,1);
});
test('malformed UTF8 fails explicitly instead of replacing bytes in captured text',()=>{
  const bytes=Buffer.concat([Buffer.from('{"text":"'),Buffer.from([0xff]),Buffer.from('"}\n')]);assert.throws(()=>decodeFrames(zstdCompressSync(bytes)),/AGENT_JSONL_INVALID/);
});
test('agent API shares GET-only and local-origin protection and validates parameters',async t=>{
  const x=fixture(t);x.collector.cycle();const assets=join(x.dir,'dist');mkdirSync(assets);writeFileSync(join(assets,'index.html'),'test-only');const app=createDashboardServer({database:x.output,assets,runtime:()=>({collecting:false,lastError:null,intervalMs:5000})});await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.closeStreams();app.server.closeAllConnections();await new Promise<void>(r=>app.server.close(()=>r()))});const addr=app.server.address();assert.ok(addr&&typeof addr!=='string');const base=`http://127.0.0.1:${addr.port}`;
  const s=await (await fetch(base+'/api/agents/status')).json();assert.equal(s.children,1);assert.equal(s.runtime.collecting,false);assert.equal((await (await fetch(base+'/api/agents')).json()).total,1);assert.equal((await fetch(base+'/api/agents/events?file=nope&generation=1')).status,400);assert.equal((await fetch(base+'/api/agents?limit=101')).status,400);assert.equal((await fetch(base+'/api/agents',{method:'POST'})).status,405);assert.equal((await fetch(base+'/api/agents',{headers:{origin:'https://example.invalid'}})).status,403);
});
