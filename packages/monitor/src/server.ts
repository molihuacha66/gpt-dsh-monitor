import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, extname, isAbsolute } from 'node:path';
import { MonitorQuery, filters } from './query.ts';
import { AgentQuery } from './subagents/query.ts';
import type { RuntimeStatus } from './query.ts';
import { MonitorError, safeCode } from './errors.ts';
import { ReadService } from './conversation/service.ts';
import {createHash} from 'node:crypto';
import type { ReadRequest } from './conversation/service.ts';

export function createDashboardServer(options: { database: string; assets: string; runtime: () => RuntimeStatus; project?:string }) {
  if (!existsSync(resolve(options.assets, 'index.html'))) throw new MonitorError('DASHBOARD_BUILD_REQUIRED');
  const query = new MonitorQuery(options.database);
  const agents = new AgentQuery(options.database);
  const service=options.project?new ReadService(options.database,options.project,options.runtime):null;
  const streams = new Set<ServerResponse>();
  const appPath=resolve(options.assets,'mcp-app.html');
  const appHtml=existsSync(appPath)?readFileSync(appPath,'utf8'):'';
  const appHashes=[...appHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>`'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`).join(' ');
  const send = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const server = createServer((req, res) => {
    const csp = req.url?.split('?')[0]==='/mcp-app.html'?`default-src 'none'; script-src ${appHashes}; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`:"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    res.setHeader('content-security-policy', csp); res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('cache-control', 'no-store');
    const address = server.address(); const port = address && typeof address !== 'string' ? address.port : 0;
    const expected = `127.0.0.1:${port}`;
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') || req.headers.host !== expected || (req.headers.origin && req.headers.origin !== `http://${expected}`) || req.headers['sec-fetch-site'] === 'cross-site') { send(res, 403, { ok: false, code: 'LOCAL_ACCESS_ONLY' }); return; }
    if (req.method !== 'GET') { res.setHeader('allow', 'GET'); send(res, 405, { ok: false, code: 'READ_ONLY' }); return; }
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new MonitorError('INVALID_FILTER');
      const url = new URL(req.url, `http://${expected}`); const f = filters(url.searchParams);
      if(url.pathname==='/api/read'){
        if(!service)throw new MonitorError('NOT_FOUND');
        const input:ReadRequest={...Object.fromEntries(url.searchParams),includeTests:f.includeTests};
        for(const key of ['from','to','before','after','limit','generation'] as const){const v=url.searchParams.get(key);if(v!==null){if(!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v)))throw new MonitorError('INVALID_FILTER');input[key]=Number(v)}}
        send(res,200,service.call(input));return;
      }
      if (url.pathname === '/api/overview') { send(res, 200, { ok: true, ...query.overview(f, options.runtime()) }); return; }
      if (url.pathname === '/api/agents/status') { send(res, 200, { ok: true, ...agents.summary(), runtime: options.runtime() }); return; }
      if (url.pathname === '/api/agents') { send(res, 200, { ok: true, ...agents.sessions(f.q, f.before, f.limit) }); return; }
      if (url.pathname === '/api/agents/events') { send(res, 200, { ok: true, ...agents.events(url.searchParams.get('file') ?? '', Number(url.searchParams.get('generation')), f.before, f.limit) }); return; }
      if (url.pathname === '/api/messages' || url.pathname === '/api/tasks') { send(res, 200, { ok: true, ...query.list(url.pathname.endsWith('messages') ? 'messages' : 'tasks', f) }); return; }
      if (url.pathname === '/api/message' || url.pathname === '/api/task') { send(res, 200, { ok: true, ...query.detail(url.pathname.endsWith('message') ? 'messages' : 'tasks', url.searchParams.get('id') ?? '', f) }); return; }
      if (url.pathname === '/api/events') {
        if (streams.size >= 16) { send(res, 429, { ok: false, code: 'TOO_MANY_STREAMS' }); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
        res.write('retry: 5000\nevent: update\ndata: {}\n\n'); streams.add(res);
        req.on('close', () => streams.delete(res)); return;
      }
      if (url.pathname.startsWith('/api/')) throw new MonitorError('NOT_FOUND');
      const asset = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      if (asset.includes('\\') || asset.includes('\0') || (!asset.startsWith('assets/') && !['index.html','legacy.html','app-preview.html','mcp-app.html'].includes(asset))) throw new MonitorError('NOT_FOUND');
      const root = realpathSync(options.assets); const path = resolve(root, asset);
      if (!existsSync(path) || !statSync(path).isFile()) throw new MonitorError('NOT_FOUND');
      const actual = realpathSync(path); const r = relative(root, actual);
      if (r.startsWith('..') || isAbsolute(r)) throw new MonitorError('NOT_FOUND');
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream' }); res.end(readFileSync(path));
    } catch (error) {
      const code = safeCode(error); send(res, ['NOT_FOUND','ARTIFACT_MISSING','ANCHOR_NOT_VISIBLE'].includes(code) ? 404 : ['INVALID_FILTER','INVALID_ACTION'].includes(code) ? 400 : code==='ARTIFACT_PATH_DENIED'?403:code==='ARTIFACT_TOO_LARGE'?413:['AGENT_CURSOR_INVALID','CONVERSATION_CURSOR_INVALID'].includes(code) ? 409 : 503, { ok: false, code });
    }
  });
  const heartbeat = setInterval(() => { for (const res of streams) res.write(': heartbeat\n\n'); }, 15000); heartbeat.unref();
  server.on('close', () => { clearInterval(heartbeat); for (const res of streams) res.end(); streams.clear(); });
  return {
    server,
    notify() { for (const res of streams) { if (res.writableLength > 65536) { res.destroy(); streams.delete(res); } else res.write('event: update\ndata: {}\n\n'); } },
    streamCount() { return streams.size; },
    closeStreams() { for (const res of streams) res.end(); streams.clear(); },
  };
}
