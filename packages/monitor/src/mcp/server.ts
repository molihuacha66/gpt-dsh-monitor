import {McpServer} from '@modelcontextprotocol/server';
import {registerAppResource,registerAppTool,RESOURCE_MIME_TYPE} from '@modelcontextprotocol/ext-apps/server';
import {z} from 'zod';
import {readSchema} from './schema.ts';
import {readFileSync} from 'node:fs';
import {ReadService} from '../conversation/service.ts';
import type {ReadRequest} from '../conversation/service.ts';

export const APP_URI='ui://gpt-dsh-monitor/v0.7.0-beta.1.html';
export function createMonitorMcp(options:{database:string;project:string;html:string}){
  const service=new ReadService(options.database,options.project,()=>({collecting:false,lastError:null,intervalMs:5000,useStoredRuntime:true}));
  const server=new McpServer({name:'gpt-dsh-monitor',version:'0.7.0-beta.1'},{instructions:'只读监控GPT与DSH已经采集并脱敏的通信。不能发送消息、确认已读、改任务或唤醒。会话段是按回复派生，文件声明不证明当轮生成，历史文件版本未留存。'});
  const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
  registerAppResource(server,'communication-monitor',APP_URI,{},async()=>({contents:[{uri:APP_URI,mimeType:RESOURCE_MIME_TYPE,text:readFileSync(options.html,'utf8'),_meta:{ui:{prefersBorder:false,csp:{connectDomains:[],resourceDomains:[],frameDomains:[]}},'openai/ui':{preferredDisplayMode:'fullscreen',availableDisplayModes:['fullscreen','inline']}}}]}));
  registerAppTool(server,'open_monitor',{title:'GPT 与 DSH 协作会话',description:'打开只读会话监控：GPT与DSH对话、关联文件、任务和子会话。',inputSchema:z.object({collab:z.string().max(200).optional()}).strict(),annotations,_meta:{ui:{resourceUri:APP_URI},'openai/ui':{entrypoints:[{type:'global'},{type:'thread'}]}}},async({collab})=>{
    const data=service.result({action:'overview',collab});
    return {isError:data.ok!==true,content:[{type:'text' as const,text:data.ok?`只读监控：${data.messages}条可见消息，${data.tasks}项任务。界面查询已脱敏快照，不向原桥写入。`:`监控暂不可用：${data.code}`}],structuredContent:data};
  });
  server.registerTool('monitor_read',{title:'查询已脱敏的协作记录',description:'只读查询会话上下文、导航、任务、子会话或已登记文件预览。文件使用artifact ID，不能传任意路径。',inputSchema:readSchema,annotations},async(input)=>{
    const data=service.result(input as ReadRequest);
    const text=data.ok?input.action==='conversation'||!input.action?`已读取${Array.isArray(data.items)?data.items.length:0}条消息；完整已脱敏记录在structuredContent。`:input.action==='preview'?`只读文件预览：${(data.artifact as {name?:string})?.name??''}。历史版本未留存。`:'已读取监控快照；结果见structuredContent。':`查询失败：${data.code}`;
    return {isError:data.ok!==true,content:[{type:'text' as const,text}],structuredContent:data};
  });
  return server;
}
