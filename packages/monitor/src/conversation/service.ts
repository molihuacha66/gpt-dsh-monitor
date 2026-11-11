import { filters, MonitorQuery } from '../query.ts';
import type { RuntimeStatus } from '../query.ts';
import { AgentQuery } from '../subagents/query.ts';
import { ArtifactQuery } from './artifacts.ts';
import { ConversationQuery } from './query.ts';
import { MonitorError, safeCode } from '../errors.ts';
import {healthSummary} from '../runtime/health.ts';
import type { ConversationRequest } from './types.ts';

export type ReadRequest = ConversationRequest & { action?:string; id?:string; kind?:string; file?:string; generation?:number };
export class ReadService {
  query:MonitorQuery;agents:AgentQuery;artifacts:ArtifactQuery;conversations:ConversationQuery;runtime:()=>RuntimeStatus;
  constructor(database:string,project:string,runtime:()=>RuntimeStatus){this.query=new MonitorQuery(database);this.agents=new AgentQuery(database);this.artifacts=new ArtifactQuery(database,project);this.conversations=new ConversationQuery(database);this.runtime=runtime}
  call(input:ReadRequest):Record<string,unknown>{
    const p=new URLSearchParams();
    for(const key of ['collab','q','direction','from','to','before','limit'] as const)if(input[key]!==undefined)p.set(key,String(input[key]));
    p.set('includeTests',input.includeTests?'1':'0');const f=filters(p);
    switch(input.action??'conversation'){
      case 'health':return {ok:true,...this.query.read(db=>healthSummary(db,this.query.path))};
      case 'conversation':return {ok:true,...this.conversations.page(f,this.artifacts.list(f),input.anchor,input.after??null)};
      case 'overview':return {ok:true,...this.query.overview(f,this.runtime()),agentStatus:this.agents.summary()};
      case 'preview':return {ok:true,...this.artifacts.preview(input.id??'',f)};
      case 'export':return {ok:true,...this.conversations.exportRound(f,this.artifacts.list(f),input.anchor??'')};
      case 'tasks':return {ok:true,...this.query.list('tasks',f)};
      case 'task':return {ok:true,...this.query.detail('tasks',input.id??'',f),files:this.artifacts.list(f).filter(a=>a.links.some(l=>l.taskId===input.id))};
      case 'agents':return {ok:true,...this.agents.sessions(f.q,f.before,f.limit),summary:this.agents.summary()};
      case 'agent-events':return {ok:true,...this.agents.events(input.file??'',input.generation??0,f.before,f.limit)};
      default:throw new MonitorError('INVALID_ACTION');
    }
  }
  result(input:ReadRequest){try{return this.call(input)}catch(e){return {ok:false,code:safeCode(e)}}}
}
