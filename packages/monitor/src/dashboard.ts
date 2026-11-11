import {settings} from './config.ts';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {CollectionController} from './runtime/controller.ts';
import { createDashboardServer } from './server.ts';
import { MonitorError, safeCode } from './errors.ts';
import { DEFAULT_SESSIONS } from './subagents/collector.ts';


async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2); let collecting = true; const values: Record<string, string> = {};
  while (args.length) { const key = args.shift()!; if (key === '--no-collect') { collecting = false; continue; } if (!['--source', '--output', '--port', '--sessions'].includes(key) || !args.length) throw new MonitorError('INVALID_ARGUMENT'); values[key] = args.shift()!; }
  const port = Number(values['--port'] ?? settings().port); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MonitorError('INVALID_PORT');
  const source = values['--source'] ?? settings().source;
  const output = values['--output'] ?? settings().database;
  let controller:CollectionController|undefined,closing=false;
  const app=createDashboardServer({database:output,assets:resolve(root,'dist'),project:settings().project,runtime:()=>controller?.runtime()??({collecting:false,lastError:null,intervalMs:5000})});
  await new Promise<void>((resolve,reject)=>{app.server.once('error',reject);app.server.listen(port,'127.0.0.1',resolve)});
  if(collecting)controller=new CollectionController({source,output,sessions:values['--sessions']??DEFAULT_SESSIONS,project:settings().project,intervalMs:5000},()=>app.notify());
  console.log(JSON.stringify({ok:true,url:`http://127.0.0.1:${port}`,collecting}));
  const shutdown=()=>{if(closing)return;closing=true;app.closeStreams();app.server.closeIdleConnections();void (async()=>{await controller?.close();await new Promise<void>(resolve=>app.server.close(()=>resolve()));process.exit(0)})()};
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
main().catch(error => { console.error(JSON.stringify({ ok: false, code: safeCode(error) })); process.exitCode = 1; });
