import {dataHome} from '../plugins/gpt-dsh-monitor/lib/config.mjs';
import {join} from 'node:path';
process.env.DSH_CODEX_BRIDGE_HOME??=join(dataHome(),'bridge');
await import('../components/bridge/mcp-server.mjs');
