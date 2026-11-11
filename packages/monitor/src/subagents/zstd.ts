import { zstdDecompressSync, constants } from 'node:zlib';
import { MonitorError } from '../errors.ts';

// Walk frame/block lengths; searching for magic bytes inside compressed blocks is unsafe.
// https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md
export function frameEnd(bytes: Buffer, start: number): number | null {
  let p = start;
  if (bytes.length - p < 5) return null;
  if (bytes.readUInt32LE(p) !== 0xfd2fb528) throw new MonitorError('AGENT_FRAME_UNSUPPORTED');
  p += 4;
  const d = bytes[p++]!;
  if (d & 8) throw new MonitorError('AGENT_FRAME_INVALID');
  const single = !!(d & 32), flag = d >>> 6;
  p += (single ? 0 : 1) + [0, 1, 2, 4][d & 3]! + (flag === 0 ? (single ? 1 : 0) : 1 << flag);
  if (p > bytes.length) return null;
  for (;;) {
    if (p + 3 > bytes.length) return null;
    const h = bytes.readUIntLE(p, 3); p += 3;
    const type = (h >>> 1) & 3;
    if (type === 3) throw new MonitorError('AGENT_FRAME_INVALID');
    p += type === 1 ? 1 : h >>> 3;
    if (p > bytes.length) return null;
    if (h & 1) break;
  }
  p += d & 4 ? 4 : 0;
  return p > bytes.length ? null : p;
}
export function decodeFrames(bytes: Buffer, outputLimit = 128 * 1024 * 1024, onDecoded?: (bytes: number) => void): { rows: unknown[]; consumed: number; pending: boolean } {
  const rows: unknown[] = []; let p = 0, decoded = 0;
  while (p < bytes.length) {
    const end = frameEnd(bytes, p);
    if (end === null) break;
    let plain: Buffer;
    if (decoded >= outputLimit) throw new MonitorError('AGENT_RESOURCE_LIMIT');
    try { plain = zstdDecompressSync(bytes.subarray(p, end), { maxOutputLength: Math.min(32 * 1024 * 1024, outputLimit - decoded), params: { [constants.ZSTD_d_windowLogMax]: 27 } }); }
    catch { throw new MonitorError('AGENT_DECOMPRESSION_FAILED'); }
    decoded += plain.length;
    onDecoded?.(plain.length);
    if (decoded > outputLimit) throw new MonitorError('AGENT_RESOURCE_LIMIT');
    // The DSH writer publishes newline-terminated JSONL per frame. Other layouts are unsupported.
    if (!plain.length || plain.at(-1) !== 10) throw new MonitorError('AGENT_JSONL_INCOMPLETE');
    try {
      for (const line of new TextDecoder('utf-8', { fatal: true }).decode(plain).split('\n')) {
        if (!line.trim()) continue;
        if (line.length > 16 * 1024 * 1024 || rows.length >= 100000) throw new MonitorError('AGENT_RESOURCE_LIMIT');
        rows.push(JSON.parse(line));
      }
    } catch (e) { if (e instanceof MonitorError) throw e; throw new MonitorError('AGENT_JSONL_INVALID'); }
    p = end;
  }
  return { rows, consumed: p, pending: p < bytes.length };
}
