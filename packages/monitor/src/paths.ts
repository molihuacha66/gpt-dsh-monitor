import { existsSync, realpathSync, statSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { MonitorError } from './errors.ts';

export function identity(path: string): string {
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}
function canonical(path: string): string {
  const full = resolve(path);
  if (existsSync(full)) return realpathSync.native(full);
  return resolve(canonical(dirname(full)), relative(dirname(full), full));
}
function inside(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}
export function guardOutputLocation(source:string,output:string):void{
  if(inside(canonical(dirname(resolve(source))),canonical(output)))throw new MonitorError('UNSAFE_OUTPUT_PATH');
}
export function guardPaths(source: string, output: string): { source: string; output: string } {
  if (!existsSync(source) || !statSync(source).isFile()) throw new MonitorError('SOURCE_UNAVAILABLE');
  const src = realpathSync.native(resolve(source));
  const out = canonical(output);
  if (inside(dirname(src), out)) throw new MonitorError('UNSAFE_OUTPUT_PATH');
  const sourceFiles = [src, `${src}-wal`, `${src}-shm`, `${src}-journal`].filter(existsSync);
  for (const path of [resolve(output), `${resolve(output)}-wal`, `${resolve(output)}-shm`, `${resolve(output)}-journal`]) {
    if (existsSync(path)) {
      if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || statSync(path).nlink > 1) {
        throw new MonitorError('UNSAFE_OUTPUT_PATH');
      }
      if (sourceFiles.some(s => identity(s) === identity(path))) throw new MonitorError('UNSAFE_OUTPUT_PATH');
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  return { source: src, output: out };
}
