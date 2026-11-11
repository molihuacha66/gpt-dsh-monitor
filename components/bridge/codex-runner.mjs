// Modified for portable distribution: local configuration, isolated lifecycle and explicit cursor commits.
/**
 * codex-runner.mjs — DSH → Codex 的「主动唤醒」通道。
 *
 * 本机验证过的事实（`codex exec --help`）：
 *   codex exec [OPTIONS] [PROMPT]                     新会话跑一轮
 *   codex exec resume [SESSION_ID] [PROMPT]           恢复指定会话并追加一轮
 *   --json                    stdout 打 JSONL 事件
 *   -o, --output-last-message 最后一条回复写到文件
 *   -C, --cd <DIR>            工作目录
 *   -s, --sandbox <MODE>      read-only | workspace-write | danger-full-access
 *   --skip-git-repo-check
 *
 * 这一层只负责「起进程、等结果、把结果交回去」，不理解业务语义。
 */

import { spawn } from 'node:child_process';
import { resolveCodexExecutable } from './codex-locator.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class CodexRunError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CodexRunError';
    this.code = code;
    this.details = details;
  }
}

/** 从 JSONL 事件流里捞出最后一段助手文本（--json 输出形状未公开，这里做宽松兜底）。 */
function lastAssistantTextFromJsonl(text) {
  let last = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    const candidates = [
      event?.message?.content,
      event?.item?.text,
      event?.text,
      event?.delta,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') last = candidate;
      else if (Array.isArray(candidate)) {
        const joined = candidate
          .filter((part) => part && typeof part.text === 'string')
          .map((part) => part.text)
          .join('');
        if (joined.trim() !== '') last = joined;
      }
    }
  }
  return last;
}

/**
 * @param {object} options
 * @param {string} options.codexExe   codex.exe 绝对路径
 * @param {string} [options.cwd]      默认工作目录
 * @param {number} [options.timeoutMs] 单次唤醒上限
 * @param {string} [options.sandbox]  read-only / workspace-write / danger-full-access
 */
export function createCodexRunner({ codexExe, cwd, timeoutMs = 600000, sandbox = 'read-only', approveForMe = true } = {}) {
  /** 同一 Codex 会话同时只跑一个进程：并发会抢 thread 写锁。 */
  const inflight = new Map();

  async function run({ sessionId, prompt, workdir, signal, sandbox: sandboxOverride, model, approve }) {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new CodexRunError('bad_argument', 'prompt 不能为空');
    }
    let executable;
    try { executable = await resolveCodexExecutable(codexExe); }
    catch { return { ok: false, code: 'codex_not_found', duration_ms: 0 }; }
    const key = sessionId ? `s:${sessionId}` : 'fresh';
    if (inflight.has(key)) {
      throw new CodexRunError('busy', `Codex 会话 ${sessionId ?? '(新会话)'} 正在执行上一轮唤醒，请稍后`, {
        running_since: inflight.get(key).startedAt,
      });
    }

    const dir = workdir || cwd || process.cwd();
    const outDir = mkdtempSync(join(tmpdir(), 'codex-bridge-'));
    const outFile = join(outDir, 'last-message.txt');

    const args = ['exec'];
    if (sessionId) {
      args.push('resume', String(sessionId));
    }
    args.push(
      '--json',
      '-o', outFile,
      '-C', dir,
      '--skip-git-repo-check',
    );
    // 实测（2026-11-07）：`codex exec` 默认 approval_policy=never，MCP 工具调用会被
    // 自动审批直接拒掉（"自动审批以'审批策略为 never'拒绝了该调用"）。
    // --approve-for-me 把审批请求交给自动审查，非交互下才走得通。
    // 它自带 workspace-write 沙箱，且**与 --sandbox 互斥**（CLI 会直接报错退出）。
    if (approve === undefined ? approveForMe : approve) {
      args.push('--approve-for-me');
    } else {
      args.push('-s', sandboxOverride || sandbox);
    }
    if (model) args.push('-m', String(model));
    // Official CLI stdin mode avoids the Windows command-line length limit.
    args.push('-');

    const startedAt = Date.now();
    const entry = { startedAt, promise: null };
    inflight.set(key, entry);

    entry.promise = new Promise((resolve) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let stdout = '';
      let stderr = '';
      let child;

      let finished = false;
      const finish = (payload) => {
        if (finished) return;
        finished = true;
        payload.codex_exe = executable;
        clearTimeout(timer);
        inflight.delete(key);
        try {
          const text = readFileSync(outFile, 'utf8');
          if (text && text.trim() !== '') payload.last_message = text.trim();
        } catch { /* 没写就是没有 */ }
        try { rmSync(outDir, { recursive: true, force: true }); } catch { /* 清不掉也不影响 */ }
        resolve(payload);
      };

      try {
        child = spawn(executable, args, {
          cwd: dir,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: controller.signal,
        });
      } catch (error) {
        finish({ ok: false, code: 'spawn_failed', message: String(error?.message ?? error), duration_ms: Date.now() - startedAt });
        return;
      }

      child.stdin?.on('error', () => {}); // A startup failure may close stdin before the prompt is consumed.
      child.stdin?.end(String(prompt), 'utf8');
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

      child.on('error', (error) => {
        finish({
          ok: false,
          code: error?.name === 'AbortError' ? 'timeout' : 'spawn_failed',
          message: `${String(error?.message ?? error)}`,
          stderr: stderr.slice(-4000),
          duration_ms: Date.now() - startedAt,
        });
      });

      child.on('close', (code) => {
        const tail = lastAssistantTextFromJsonl(stdout);
        finish({
          ok: code === 0,
          code: code === 0 ? 'ok' : 'nonzero_exit',
          exit_code: code,
          duration_ms: Date.now() - startedAt,
          last_message: tail,
          stdout_tail: stdout.slice(-2000),
          stderr: stderr.slice(-4000),
        });
      });

      // 供外部取消
      entry.cancel = () => controller.abort();
    });

    return entry.promise;
  }

  return {
    run,
    isBusy(sessionId) {
      return inflight.has(sessionId ? `s:${sessionId}` : 'fresh');
    },
    busyKeys() {
      return [...inflight.keys()];
    },
  };
}

/**
 * Codex 是否具备基本可用性（只做只读探测，不消耗一轮对话）。
 * 注意：`codex --version` 不需要登录，也不花额度。
 */
export async function probeCodex(codexExe) {
  let executable;
  try { executable = await resolveCodexExecutable(codexExe); }
  catch { return { ok: false, error: 'codex_not_found' }; }
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(executable, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) });
      return;
    }
    child.stdout?.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr?.on('data', (c) => { err += c.toString('utf8'); });
    child.on('error', (error) => resolve({ ok: false, error: String(error?.message ?? error) }));
    child.on('close', (code) => resolve({
      ok: code === 0,
      exit_code: code,
      resolved_exe: executable,
      version: out.trim().split(/\r?\n/)[0] ?? '',
      stderr: err.trim().slice(0, 500),
    }));
  });
}