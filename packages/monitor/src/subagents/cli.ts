import {settings} from '../config.ts';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentCollector, DEFAULT_SESSIONS } from './collector.ts';
import { safeCode, MonitorError } from '../errors.ts';

let collector: AgentCollector | undefined;
try {
  const args = process.argv.slice(2), values: Record<string, string> = {};
  while (args.length) {
    const key = args.shift()!;
    if (!['--sessions', '--output'].includes(key) || !args.length) throw new MonitorError('INVALID_ARGUMENT');
    values[key] = args.shift()!;
  }
  collector = new AgentCollector(values['--sessions'] ?? DEFAULT_SESSIONS, values['--output'] ?? settings().database);
  console.log(JSON.stringify({ ok: true, ...collector.cycle() }));
} catch (e) { console.error(JSON.stringify({ ok: false, code: safeCode(e) })); process.exitCode = 1; }
finally { collector?.close(); }
