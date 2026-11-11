import './app-preview.css';
import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
import {browserReader} from './reader.ts';
import {readSchema} from '../src/mcp/schema.ts';

// Local verification host, not ChatGPT. The real app uses exactly the same MCP Apps bridge.
const frame=document.getElementById('app') as HTMLIFrameElement;
const badge=document.getElementById('status')!;
const bridge=new AppBridge(null,{name:'Monitor local verification host',version:'0.5.0'},{serverTools:{},serverResources:{}},{hostContext:{theme:'light',displayMode:'fullscreen',availableDisplayModes:['inline','fullscreen'],platform:'web'}});
bridge.oncalltool=async params=>{
  if(params.name!=='monitor_read')return {isError:true,content:[{type:'text',text:'READ_ONLY_TOOL_REQUIRED'}]};
  const parsed=readSchema.safeParse(params.arguments??{});if(!parsed.success)return {isError:true,content:[{type:'text',text:'INVALID_FILTER'}],structuredContent:{ok:false,code:'INVALID_FILTER'}};
  try{const data=await browserReader<Record<string,unknown>>(parsed.data);return {content:[{type:'text',text:'只读监控查询'}],structuredContent:data}}catch{return {isError:true,content:[{type:'text',text:'MONITOR_UNAVAILABLE'}],structuredContent:{ok:false,code:'MONITOR_UNAVAILABLE'}}}
};
bridge.oninitialized=()=>{badge.textContent='MCP Apps 握手已完成 · 本地验证宿主'};
bridge.onerror=()=>{badge.textContent='连接遇到问题，请刷新重试'};
await bridge.connect(new PostMessageTransport(frame.contentWindow!,frame.contentWindow!));
frame.src='/mcp-app.html';
