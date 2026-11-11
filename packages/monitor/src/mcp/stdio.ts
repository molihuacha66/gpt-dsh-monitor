import {settings} from '../config.ts';
import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMonitorMcp} from './server.ts';
import {safeCode} from '../errors.ts';

// Bundled plugin config supplies paths. No tools accept database, project roots or commands.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
try{
  const server=createMonitorMcp({database:process.env.MONITOR_DATABASE??settings().database,project:process.env.MONITOR_PROJECT??settings().project,html:process.env.MONITOR_APP_HTML??resolve(root,'dist/mcp-app.html')});
  await server.connect(new StdioServerTransport());
  process.on('SIGINT',()=>void server.close().finally(()=>process.exit(0)));
}catch(e){console.error(JSON.stringify({ok:false,code:safeCode(e)}));process.exitCode=1}
