import { MonitorQuery } from '../query.ts';
import type { Filters, Item } from '../query.ts';
import { MonitorError } from '../errors.ts';
import { deriveRounds } from './grouping.ts';
import type { MessageMeta } from './grouping.ts';
import type { ConversationPage, Artifact } from './types.ts';

export class ConversationQuery {
  query: MonitorQuery;
  constructor(database: string) { this.query = new MonitorQuery(database); }
  exportRound(f:Filters,files:Artifact[],anchor:string){
    const page=this.page({...f,limit:1,before:null},files,anchor);
    const root=page.items[0]?.roundId;if(!root)throw new MonitorError('ANCHOR_NOT_VISIBLE');
    return this.query.read(db=>{
      const w=this.query.where('messages',{...f,q:'',before:null});
      const rows=db.prepare(`SELECT row_key,collab,json_extract(payload,'$.id') id,json_extract(payload,'$.reply_to') reply,json_extract(payload,'$.subject') title,CAST(json_extract(payload,'$.created_at') AS INTEGER) at FROM source_rows WHERE ${w.sql} ORDER BY at,CAST(row_key AS INTEGER) LIMIT 20001`).all(...w.values);
      if(rows.length>20000)throw new MonitorError('CONVERSATION_LIMIT');
      const meta:MessageMeta[]=rows.map(r=>({id:String(r.id),reply:r.reply==null?null:String(r.reply),title:String(r.title??''),at:Number(r.at),seq:Number(r.row_key),collab:r.collab==null?null:String(r.collab)}));
      const groups=deriveRounds(meta).groups,chosen=meta.filter(m=>groups.get(m.id)?.root===root);
      if(chosen.length>500)throw new MonitorError('EXPORT_LIMIT');
      const safe=(s:string)=>s.replace(/[\\`*_{}\[\]()#+.!|<>]/g,'\\$&').replace(/[\r\n]/g,' ');
      let markdown=`# ${safe(page.rounds.find(r=>r.id===root)?.title??'交流段')}\n\n只读通信记录导出。内容已过滤；轮次按回复关联整理，文件声明不证明生成时间，历史文件版本未留存。\n\n`;
      const get=db.prepare("SELECT payload FROM source_rows WHERE table_name='messages' AND row_key=? AND source_present=1");
      for(const m of chosen){const row=get.get(String(m.seq));if(!row)continue;const d=JSON.parse(String(row.payload));const body=String(d.body??'');const runs=body.match(/`+/g)??[];const fence='`'.repeat(runs.reduce((max,s)=>Math.max(max,s.length+1),3));
        markdown+=`## ${d.sender==='codex'?'GPT':'DSH'} · ${new Date(m.at).toISOString()}\n\n${safe(m.title)}\n\n消息编号：${m.id}\n\n${fence}text\n${body}\n${fence}\n\n`;
        for(const a of files.filter(a=>a.links.some(l=>l.messageId===m.id)))markdown+=`- 文件：${safe(a.name)}；来源：${a.links.some(l=>l.source==='manual-backfill')?'补录关联':'消息/任务声明'}；可用性：${a.availability}；历史版本未留存\n`;
        if(Buffer.byteLength(markdown)>1024*1024)throw new MonitorError('EXPORT_LIMIT');
      }
      return {filename:`conversation-${root}.md`,markdown,messages:chosen.length};
    });
  }
  page(f: Filters, files: Artifact[], anchor?: string, after: number | null = null): ConversationPage {
    if (anchor && !/^m_[0-9a-f]{12}$/.test(anchor)) throw new MonitorError('INVALID_FILTER');
    if (after !== null && (!Number.isSafeInteger(after) || after < 0)) throw new MonitorError('INVALID_FILTER');
    return this.query.read(db => {
      const base = this.query.where('messages', { ...f, q: '', before: null });
      const rows = db.prepare(`SELECT row_key,collab,json_extract(payload,'$.id') AS id,json_extract(payload,'$.reply_to') AS reply,json_extract(payload,'$.subject') AS title,CAST(json_extract(payload,'$.created_at') AS INTEGER) AS at FROM source_rows WHERE ${base.sql} ORDER BY at,CAST(row_key AS INTEGER) LIMIT 20001`).all(...base.values);
      if (rows.length > 20000) throw new MonitorError('CONVERSATION_LIMIT');
      const metadata: MessageMeta[] = rows.map(r => ({ id:String(r.id), reply:r.reply==null?null:String(r.reply), title:String(r.title??''), at:Number(r.at), seq:Number(r.row_key),collab:r.collab==null?null:String(r.collab) }));
      const grouped = deriveRounds(metadata);
      let end = metadata.length, start = Math.max(0,end-f.limit);
      if (anchor) {
        const index = metadata.findIndex(m => m.id === anchor);
        if (index < 0) throw new MonitorError('ANCHOR_NOT_VISIBLE');
        start = Math.max(0,index-Math.floor(f.limit/2)); end = Math.min(metadata.length,start+f.limit);
      } else if (f.before !== null) {
        end = metadata.findIndex(m => m.seq === f.before);
        if (end < 0) throw new MonitorError('CONVERSATION_CURSOR_INVALID');
        start = Math.max(0,end-f.limit);
      } else if (after !== null) {
        const index = metadata.findIndex(m => m.seq === after);
        if (index < 0) throw new MonitorError('CONVERSATION_CURSOR_INVALID');
        start = index+1; end = Math.min(metadata.length,start+f.limit);
      }
      const selected = metadata.slice(start,end);
      const get = db.prepare("SELECT row_key,collab,source_present,payload FROM source_rows WHERE table_name='messages' AND row_key=? AND source_present=1");
      const visibleIds = new Set(metadata.map(m => m.id));
      const scopedFiles = files.map(a => ({...a,links:a.links.filter(l => l.messageId === null || visibleIds.has(l.messageId))})).filter(a => a.links.length);
      const items = selected.map(m => {
        const r = get.get(String(m.seq))!;
        const item: Item = { key:String(r.row_key),collab:r.collab==null?null:String(r.collab),sourcePresent:true,data:JSON.parse(String(r.payload)) };
        const group = grouped.groups.get(m.id)!;
        return {...item,roundId:group.root,relationIssue:group.issue,files:scopedFiles.filter(a => a.links.some(l => l.messageId === m.id))};
      });
      const search = this.query.where('messages', {...f,before:null});
      const hits = f.q ? db.prepare(`SELECT json_extract(payload,'$.id') AS id,json_extract(payload,'$.subject') AS title,CAST(json_extract(payload,'$.created_at') AS INTEGER) AS at FROM source_rows WHERE ${search.sql} ORDER BY at DESC LIMIT 100`).all(...search.values).map(r => ({id:String(r.id),title:String(r.title??'无标题记录'),at:Number(r.at)})) : [];
      const unhidden = this.query.where('messages',{...f,q:'',before:null},{ignoreTests:true});
      const allCount=Number(db.prepare(`SELECT count(*) AS n FROM source_rows WHERE ${unhidden.sql}`).get(...unhidden.values)!.n);
      return {items,total:metadata.length,rounds:grouped.rounds.slice(-500),files:scopedFiles,hits,older:start>0?metadata[start]!.seq:null,newer:end<metadata.length&&end>0?metadata[end-1]!.seq:null,latestId:metadata.at(-1)?.id??null,hiddenTests:Math.max(0,allCount-metadata.length),navigationLimited:grouped.rounds.length>500};
    });
  }
}
