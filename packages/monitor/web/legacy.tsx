import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Item, Payload } from '../src/query.ts';
import './style.css';
import { Agents, AgentSourceStatus } from './agents.tsx';

type Page = { items: Item[]; total: number; hiddenTests: number; nextBefore: number | null };
type Overview = { messages: number; tasks: number; capturedAt: number | null; ageMs: number | null; freshness: string; runtime: { collecting: boolean; lastError: string | null }; gaps: {code:string;status:string;occurrences:number}[]; checkpoints: {table_name:string;row_count:number;captured_at:number}[]; collabs: {id:string;count:number;test:boolean}[] };
type Detail = { item: Item; events: Item[] };
const text = (value: unknown) => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const date = (value: unknown) => value == null ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { timeZone:'Asia/Shanghai', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).format(new Date(Number(value)));
const person = (v: unknown) => v === 'codex' ? 'GPT' : v === 'dsh' ? 'DSH' : v === 'both' ? '双方（广播）' : text(v) || '未知';
const labels: Record<string,string> = {saved:'已保存',delivered:'已送达',read:'已读',replied:'已回复',created:'待接受',accepted:'已接受',running:'执行中',done:'已完成',failed:'失败',rejected:'已拒绝',transferred:'已转交',cancelled:'已取消',question:'提问',answer:'回复',discussion:'讨论',progress:'进展',evidence:'证据',decision:'决定',note:'备注',task:'任务'};
const label = (v: unknown) => labels[text(v)] ?? text(v);
const gapNames: Record<string,string> = {'wake-input-not-in-bridge':'主动唤醒的输入未保存在桥内','cli-trace-not-collected':'尚未采集 GPT 完整执行过程','subagents-not-collected':'子智能体通信覆盖范围有限','agent-source-rewritten':'子会话日志曾重写，旧版本已保留','recipient-delivery-not-proven':'无法证明每位接收者实际收到消息','audit-may-be-incomplete':'原始审计可能存在缺口','source-history-removed':'源中曾有记录被移除','OBSERVATIONS_CAP_REACHED':'观察历史已达容量上限，当前状态仍在更新'};
const tableNames: Record<string,string> = {messages:'通信消息',tasks:'任务',task_events:'任务状态记录',record_docs:'当前共同记录',record_history:'共同记录历史',audit:'操作审计'};
const errorNames: Record<string,string> = {MONITOR_UNAVAILABLE:'监控快照暂时不可用，请检查采集服务',SOURCE_UNAVAILABLE:'暂时无法访问通信记录',IO_OR_DATABASE_ERROR:'采集遇到读取或数据库问题',SOURCE_HISTORY_CHANGED:'源记录已变化，需要确认历史恢复方式',SOURCE_REPLACED:'源数据库已更换，需要重新确认数据来源',SOURCE_SCHEMA_CHANGED:'源数据格式变化，采集已暂停',INVALID_FILTER:'筛选条件无效，请检查起止时间',NOT_FOUND:'这条记录不在当前可见快照中',LOCAL_ACCESS_ONLY:'仅允许本机页面访问'};
function Icon({name,size=20}:{name:string;size?:number}) {
  const paths: Record<string,React.ReactNode> = {
    bridge:<><path d="M4 16V8m16 8V8M4 10c5 5 11 5 16 0M4 16h16M8 12v4m4-3v3m4-4v4"/></>,
    messages:<><path d="M20 11a8 8 0 0 1-8 8H5l-3 3v-8a8 8 0 1 1 18-3Z"/><path d="M7 9h8M7 13h5"/></>,
    tasks:<><rect x="4" y="4" width="16" height="17" rx="3"/><path d="M9 3h6v4H9zM8 13l2 2 5-5M8 18h7"/></>,
    status:<><path d="M3 12h4l3-8 4 16 3-8h4"/></>,
    search:<><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,
    arrow:<path d="M4 12h16m-5-5 5 5-5 5"/>,
    lock:<><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></>,
    refresh:<><path d="M20 8V3l-4 4a8 8 0 1 0 3 10M20 3h-5"/></>,
    clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.messages}</svg>;
}
async function api<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url,{signal}); const json = await res.json();
  if (!res.ok || !json.ok) throw new Error(json.code??'MONITOR_UNAVAILABLE'); return json;
}
function App() {
  const [view,setView] = useState('messages'); const [collab,setCollab] = useState('__all__'); const [includeTests,setIncludeTests] = useState(false);
  const [q,setQ] = useState(''); const [search,setSearch] = useState(''); const [direction,setDirection] = useState('all'); const [status,setStatus] = useState('all');
  const [from,setFrom] = useState(''); const [to,setTo] = useState(''); const [cursors,setCursors] = useState<(number|null)[]>([null]);
  const [overview,setOverview] = useState<Overview|null>(null); const [page,setPage] = useState<Page|null>(null); const [detail,setDetail] = useState<Detail|null>(null);
  const [detailType,setDetailType] = useState('messages'); const [detailError,setDetailError] = useState(''); const [selected,setSelected] = useState('');
  const [error,setError] = useState(''); const [tick,setTick] = useState(0); const [loading,setLoading] = useState(true); const [connection,setConnection] = useState(true);
  useEffect(()=>{const timer=setTimeout(()=>setSearch(q),300);return()=>clearTimeout(timer)},[q]);
  const makeParams = (cursor=true) => {
    const p=new URLSearchParams({collab,includeTests:includeTests?'1':'0',q:search,direction:view==='messages'?direction:'all',status:view==='tasks'?status:'all',limit:'20'});
    if(from)p.set('from',String(Date.parse(`${from}+08:00`))); if(to)p.set('to',String(Date.parse(`${to}+08:00`)));
    const before=cursors.at(-1);if(cursor&&before!==null&&before!==undefined)p.set('before',String(before));return p;
  };
  const params=makeParams().toString();
  useEffect(()=>{setCursors([null]);setDetail(null);setSelected('');setDetailError('')},[view,collab,includeTests,search,direction,status,from,to]);
  useEffect(()=>{
    const c=new AbortController();setLoading(true);
    Promise.all([api<Overview>(`/api/overview?${params}`,c.signal),['status','agents'].includes(view)?Promise.resolve(null):api<Page>(`/api/${view}?${params}`,c.signal)])
      .then(([o,p])=>{setOverview(o);setPage(p);setError('')}).catch(e=>{if(e.name!=='AbortError')setError(e.message)}).finally(()=>{if(!c.signal.aborted)setLoading(false)});
    return()=>c.abort();
  },[params,tick,view]);
  useEffect(()=>{
    const events=new EventSource('/api/events');events.addEventListener('update',()=>{setConnection(true);setTick(t=>t+1)});events.onerror=()=>setConnection(false);
    const timer=setInterval(()=>setTick(t=>t+1),10000);return()=>{events.close();clearInterval(timer)};
  },[]);
  useEffect(()=>{if(!selected)return;const c=new AbortController();const p=makeParams(false);p.set('id',selected);
    api<Detail>(`/api/${detailType==='tasks'?'task':'message'}?${p}`,c.signal).then(d=>{setDetail(d);setDetailError('')}).catch(e=>{if(e.name!=='AbortError'){setDetail(null);setDetailError(e.message)}});return()=>c.abort();
  },[selected,detailType,tick,params]);
  const choose=(item:Item,type=view)=>{setDetail(item?{item,events:[]}:null);setDetailType(type);setSelected(text(item.data.id));setDetailError('')};
  const chooseId=(id:unknown,type:string)=>{setDetail(null);setDetailType(type);setSelected(text(id));setDetailError('')};
  const fresh=error?'error':overview?.freshness??'snapshot';
  const statusTitle=error?'暂时无法连接':fresh==='fresh'?'采集中':fresh==='stale'?'更新延迟':fresh==='error'?'需要关注':'历史快照';
  const pageTitle=view==='messages'?'通信时间线':view==='tasks'?'任务进展':view==='agents'?'子智能体交流':'采集状态';
  const reset=()=>{setQ('');setSearch('');setDirection('all');setStatus('all');setFrom('');setTo('');setCollab('__all__');setIncludeTests(false)};
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="/"><span className="brand-mark"><Icon name="bridge" size={25}/></span><span>桥间<small>COMMUNICATION MONITOR</small></span></a>
      <div className="workspace-label">合作工作台</div><nav aria-label="主导航">{[['messages','通信时间线'],['tasks','任务进展'],['agents','子智能体'],['status','采集状态']].map(([id,title])=><button key={id} className={`nav-item ${view===id?'active':''}`} onClick={()=>setView(id)}><Icon name={id}/>{title}{id==='messages'&&overview&&<span>{overview.messages}</span>}</button>)}</nav>
      <div className="sidebar-project"><span className="project-symbol">鱼</span><div>大肥鱼和龙娘<small>GPT × DSH 合作项目</small></div></div>
      <div className="sidebar-footer"><Icon name="lock" size={16}/><div>本地 · 只读查看<small>展示经过过滤的通信内容</small></div></div>
    </aside>
    <main><header className="topbar"><div className="breadcrumb">合作项目<span>/</span><strong>通信监控</strong></div><span className={`status-pill ${fresh}`}><i/>{statusTitle}</span></header>
      <div className="main-inner"><section className="page-heading"><div><div className="eyebrow">GPT × DEEPSEEK HARNESS</div><h1>{pageTitle}</h1><p>看见每一次交流，跟进每一项协作。</p></div><button className="button secondary refresh" onClick={()=>setTick(t=>t+1)} aria-label="刷新快照"><Icon name="refresh" size={16}/>刷新</button></section>
      {overview&&!overview.runtime.collecting&&<div className="notice snapshot-notice"><Icon name="clock" size={17}/>当前为历史快照，未实时采集。最后采集：{date(overview.capturedAt)}</div>}
      {!connection&&<div className="notice">实时连接暂时中断，正在自动重连；每 10 秒继续检查快照。</div>}
      {error?<div className="error-state" role="alert"><Icon name="status" size={28}/><h2>暂时无法读取监控快照</h2><p>{errorNames[error]??'服务暂不可用，请稍后重试。'}</p><button className="button" onClick={()=>setTick(t=>t+1)}>重新检查</button><button className="text-button" onClick={reset}>重置筛选</button></div>:<>
      <div className="metrics"><div className="metric"><span>可见通信</span><strong>{overview?.messages??'—'}<small>条</small></strong><div><i className="mini-dot blue"/>当前筛选范围</div></div><div className="metric"><span>关联任务</span><strong>{overview?.tasks??'—'}<small>项</small></strong><div><i className="mini-dot teal"/>有记录可追溯</div></div><div className="metric"><span>最近采集</span><strong className="metric-time">{overview?.capturedAt?date(overview.capturedAt):'暂无快照'}</strong><div><Icon name="clock" size={13}/>{overview?.ageMs==null?'等待首次采集':Math.floor(overview.ageMs/1000)<60?`${Math.floor(overview.ageMs/1000)} 秒前更新`:`已 ${Math.floor(overview.ageMs/60000)} 分钟未更新`}</div></div><div className="metric coverage-metric"><span>数据范围</span><strong className="metric-scope">桥记录 + 子会话日志</strong><div>子智能体页查看独立采集范围</div></div></div>
      {view==='agents'?<Agents tick={tick}/>:view==='status'?<Status overview={overview} tick={tick}/>:<>
      <section className="filter-panel" aria-label="筛选"><div className="filter-row"><label className="search-field"><Icon name="search" size={18}/><input aria-label="搜索通信或任务" placeholder={view==='messages'?'搜索消息、标题或编号…':'搜索任务、结果或编号…'} value={q} onChange={e=>setQ(e.target.value)}/>{q&&<button onClick={()=>setQ('')} aria-label="清空搜索">×</button>}</label><select aria-label="协作筛选" value={collab} onChange={e=>setCollab(e.target.value)}><option value="__all__">全部实际协作</option>{overview?.collabs.filter(c=>includeTests||!c.test).map(c=><option value={c.id} key={c.id}>{c.id==='__unknown__'?'未知归属':c.id}</option>)}</select>{view==='messages'?<select aria-label="通信方向" value={direction} onChange={e=>setDirection(e.target.value)}><option value="all">全部方向</option><option value="gpt-dsh">GPT → DSH</option><option value="dsh-gpt">DSH → GPT</option><option value="broadcast">广播给双方</option></select>:<select aria-label="任务状态" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">全部状态</option>{['created','accepted','running','done','failed','rejected','transferred','cancelled'].map(s=><option key={s} value={s}>{label(s)}</option>)}</select>}</div>
      <div className="filter-row second-row"><label>从<input aria-label="起始时间" type="datetime-local" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>至<input aria-label="结束时间" type="datetime-local" value={to} onChange={e=>setTo(e.target.value)}/></label><span className="timezone-label">北京时间</span><label className="test-toggle"><input type="checkbox" checked={includeTests} onChange={e=>setIncludeTests(e.target.checked)}/>包含测试记录</label><button className="text-button" onClick={reset}>重置</button></div></section>
      <div className="list-heading"><h2>{view==='messages'?'最近通信':'任务列表'}<span>{page?.total??0}</span></h2><span>{page?.hiddenTests?<>已隐藏 {page.hiddenTests} 条测试记录 <button className="text-button" onClick={()=>setIncludeTests(true)}>显示全部</button></>:'按记录顺序 · 最新在前'}</span></div>
      <div className={`content-grid ${selected?'with-detail':''}`}><section className="record-list" aria-label={view==='messages'?'消息列表':'任务列表'} aria-busy={loading}>
        {!page?.items.length?<div className="empty-state"><Icon name={view} size={34}/><h3>{loading?'正在读取快照…':'没有符合条件的记录'}</h3><p>可以调整关键词、方向或时间范围。</p>{!loading&&<button className="text-button" onClick={reset}>重置筛选</button>}</div>:page.items.map(item=>view==='messages'?<Message key={item.key} item={item} active={selected===item.data.id} onSelect={()=>choose(item)}/>:<Task key={item.key} item={item} active={selected===item.data.id} onSelect={()=>choose(item)}/>)}
        {!!page?.items.length&&<div className="pagination"><span>第 {cursors.length} 页 · {page.items.length} 条</span><div><button className="button secondary" disabled={cursors.length===1} onClick={()=>setCursors(c=>c.slice(0,-1))}>上一页</button><button className="button secondary" disabled={page.nextBefore===null} onClick={()=>setCursors(c=>[...c,page.nextBefore])}>下一页</button></div></div>}
      </section>{selected&&<aside className="detail-panel" aria-label="记录详情"><div className="detail-heading"><h2>{detailType==='tasks'?'任务详情':'消息详情'}</h2><button aria-label="关闭详情" className="close-button" onClick={()=>{setSelected('');setDetail(null)}}>×</button></div>{detailError?<div className="detail-empty">{errorNames[detailError]??'暂时无法读取详情'}</div>:detail?<DetailView detail={detail} type={detailType} onRelated={chooseId}/>:<div className="detail-empty">正在读取…</div>}</aside>}</div>
      </>}
      <footer className="page-footer"><Icon name="lock" size={13}/><span>只读查看 · 已过滤敏感字段 · 时间均为北京时间</span><span>GPT–DSH Communication Monitor</span></footer>
      </>}
      </div>
    </main>
  </div>;
}
function Message({item,active,onSelect}:{item:Item;active:boolean;onSelect:()=>void}) {
  const d=item.data;const gpt=d.sender==='codex';
  return <button className={`message-card ${active?'selected':''}`} onClick={onSelect}><div className={`avatar ${gpt?'gpt':'dsh'}`}>{gpt?'G':'D'}</div><div className="message-main"><div className="message-meta"><strong>{person(d.sender)}</strong><Icon name="arrow" size={14}/><span>{person(d.recipient)}</span><span className={`kind-tag ${gpt?'gpt':'dsh'}`}>{label(d.kind)||'消息'}</span><time>{date(d.created_at)}</time></div><h3>{text(d.subject)||'无标题消息'}</h3><p>{text(d.body).slice(0,190)}{text(d.body).length>190?'…':''}</p><div className="message-bottom"><span className={`state-badge ${text(d.state)}`}>{label(d.state)}</span><code>{text(d.id)}</code>{Boolean(d.reply_to)&&<span className="reply-mark">↳ 关联回复</span>}<span className="collab-tag">{item.collab??'未知归属'}</span></div></div><span className="card-chevron">›</span></button>;
}
function Task({item,active,onSelect}:{item:Item;active:boolean;onSelect:()=>void}) {
  const d=item.data;return <button className={`task-card ${active?'selected':''}`} onClick={onSelect}><div className={`task-state-icon ${text(d.state)}`}><Icon name="tasks"/></div><div className="message-main"><div className="message-meta"><span className={`state-badge ${text(d.state)}`}>{label(d.state)}</span><span>{person(d.creator)} 分配给 {person(d.assignee)}</span><time>{date(d.updated_at??d.created_at)}</time></div><h3>{text(d.title)}</h3><p>{text(d.result??d.brief)||'尚无任务说明'}</p><div className="message-bottom"><code>{text(d.id)}</code>{Boolean(d.parent_id)&&<span>有父任务</span>}<span className="collab-tag">{item.collab??'未知归属'}</span></div></div><span className="card-chevron">›</span></button>;
}
function DetailView({detail,type,onRelated}:{detail:Detail;type:string;onRelated:(id:unknown,type:string)=>void}) {
  const d=detail.item.data;
  let deps:string[]=[];try{const parsed=JSON.parse(text(d.deps)||'[]');if(Array.isArray(parsed))deps=parsed.map(text)}catch{}
  return <div className="detail-body"><span className={`state-badge ${text(d.state)}`}>{label(d.state)}</span><h3>{text(d.subject??d.title)||'无标题记录'}</h3><dl><dt>编号</dt><dd><code>{text(d.id)}</code></dd><dt>协作</dt><dd>{detail.item.collab??'未知归属'}</dd><dt>{type==='tasks'?'负责人':'发送方'}</dt><dd>{person(type==='tasks'?d.assignee:d.sender)}</dd>{type!=='tasks'&&<><dt>接收方</dt><dd>{person(d.recipient)}</dd><dt>来源标签</dt><dd>{text(d.source)||'未知'}</dd></>}<dt>创建时间</dt><dd>{date(d.created_at)}</dd>{type==='messages'&&<><dt>已送达</dt><dd>{d.delivered_at?date(d.delivered_at):'未记录'}</dd><dt>已读</dt><dd>{d.read_at?date(d.read_at):'未记录'}</dd></>}</dl>
    {Boolean(d.reply_to)&&<button className="related-button" onClick={()=>onRelated(d.reply_to,'messages')}>↳ 查看关联消息 <code>{text(d.reply_to)}</code></button>}
    {Boolean(d.parent_id)&&<button className="related-button" onClick={()=>onRelated(d.parent_id,'tasks')}>父任务 <code>{text(d.parent_id)}</code></button>}
    {type==='tasks'&&<><h4>执行结果</h4><pre className="full-content">{text(d.result)||'尚未记录完成结果'}</pre><h4>任务说明</h4><pre className="full-content">{text(d.brief)||'无补充说明'}</pre><h4>依赖任务</h4>{deps.length?deps.map(id=><button className="related-button" key={id} onClick={()=>onRelated(id,'tasks')}>{id}</button>):<p className="muted">未记录依赖</p>}<h4>状态记录</h4>{detail.events.length?<ol className="state-timeline">{detail.events.map(e=><li key={e.key}><strong>{label(e.data.to_state)}</strong><time>{date(e.data.created_at)}</time><p>{text(e.data.note)||`${person(e.data.actor)} 更新状态`}</p></li>)}</ol>:<p className="muted">此快照没有可用的状态历史</p>}</>}
    {type==='messages'&&<details className="content-details" open><summary>完整内容（已脱敏）</summary><pre className="full-content">{text(d.body)}</pre></details>}
    <p className="detail-footnote">状态来自原记录；“已送达”不代表任务完成，广播无法区分每位接收者。</p></div>;
}
function Status({overview,tick}:{overview:Overview|null;tick:number}) {
  if(!overview)return null;const active=overview.gaps.filter(g=>g.status!=='recovered');return <div className="status-grid"><section className="panel"><h2>采集运行</h2><dl className="status-dl"><dt>当前模式</dt><dd>{overview.runtime.collecting?'持续采集 · 每 5 秒':'历史快照 · 未实时采集'}</dd><dt>最后快照</dt><dd>{date(overview.capturedAt)}</dd><dt>最近问题</dt><dd>{overview.runtime.lastError?errorNames[overview.runtime.lastError]??'采集遇到问题，请检查服务日志':'未报告运行错误'}</dd></dl><p className="muted">这里反映采集器状态，不代表原始通信一定完整。</p></section><section className="panel"><h2>可见数据范围</h2><div className="scope-row"><span>桥内已保存的消息与任务</span><span className="scope-badge">已接入</span></div><div className="scope-row"><span>DSH 与子智能体交流</span><span className="scope-badge">持久日志 · 部分范围</span></div><div className="scope-row"><span>GPT 完整执行过程</span><span className="scope-badge pending">尚未接入</span></div></section><AgentSourceStatus tick={tick}/><section className="panel gaps-panel"><h2>覆盖缺口与提醒<span>{active.length}</span></h2>{active.length?active.map(g=><div className="gap-row" key={g.code}><span className="gap-dot"/><div><strong>{gapNames[g.code]??errorNames[g.code]??'数据采集存在待检查项'}</strong><p>{g.status==='partial-persisted-logs'?'仅采可识别的持久日志；不含全部通道、工具或思考':g.status==='unknown-not-captured'?'源中未保存或当前阶段尚未采集':g.status==='degraded-history'?'历史观察已降级，最新状态继续更新':g.status==='known-source-gap'?'已确认的历史缺口':'需要检查采集服务'}</p></div></div>):<p className="muted">未报告额外缺口</p>}</section><section className="panel"><h2>快照组成<span>全库统计</span></h2><p className="muted">包含测试记录，不受列表筛选影响。</p><div className="table-counts">{overview.checkpoints.map(r=><div key={r.table_name}><code>{tableNames[r.table_name]??r.table_name}</code><strong>{r.row_count}</strong></div>)}</div></section></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
