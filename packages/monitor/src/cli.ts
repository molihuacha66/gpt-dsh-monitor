import {settings} from './config.ts';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Collector } from './collector.ts';
import { MonitorError, safeCode } from './errors.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE = settings().source;
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.shift() ?? 'once';
  if (!['once', 'watch', 'verify'].includes(mode)) throw new MonitorError('INVALID_COMMAND');
  const options: Record<string, string> = {};
  let acceptHistoryChange = false;
  while (args.length) {
    const key = args.shift();
    if (key === '--accept-history-change') { acceptHistoryChange = true; continue; }
    const value = args.shift();
    if (!key || !['--source', '--output', '--interval'].includes(key) || !value || options[key]) throw new MonitorError('INVALID_ARGUMENT');
    options[key] = value;
  }
  if (acceptHistoryChange && mode !== 'once') throw new MonitorError('HISTORY_ACCEPT_REQUIRES_ONCE');
  const interval = Number(options['--interval'] ?? 5000);
  if (!Number.isInteger(interval) || interval < 1000) throw new MonitorError('INVALID_INTERVAL');
  let stop = false;
  const abort = new AbortController();
  const quit = () => { stop = true; abort.abort(); };
  process.once('SIGINT', quit); process.once('SIGTERM', quit);
  const collector = new Collector(options['--source'] ?? DEFAULT_SOURCE, options['--output'] ?? settings().database);
  try {
    do {
      try { console.log(JSON.stringify(collector.cycle({ verify: mode === 'verify', acceptHistoryChange }))); }
      catch (error) {
        if (mode !== 'watch') throw error;
        console.error(JSON.stringify({ ok: false, code: safeCode(error) }));
      }
      if (mode !== 'watch' || stop) break;
      try { await delay(interval, undefined, { signal: abort.signal }); } catch { break; }
    } while (!stop);
  } finally { collector.close(); }
}
main().catch(error => { console.error(JSON.stringify({ ok: false, code: safeCode(error) })); process.exitCode = 1; });
