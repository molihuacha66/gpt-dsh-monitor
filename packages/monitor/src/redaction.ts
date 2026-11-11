const HIDDEN = '[REDACTED]';
export const POLICY_VERSION = 'redaction-v1';
const sensitiveKey = /(?:api[-_ ]?key|password|passwd|pwd|secret|token|authorization|cookie|credential|private[-_ ]?key|密码|口令|密钥|令牌)/i;

export function redactText(input: string): string {
  // Parse JSON-shaped text before free-text filtering; values/history/detail are JSON strings.
  const trimmed = input.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { return JSON.stringify(redact(JSON.parse(trimmed))); } catch { /* Free text below. */ }
  }
  if (/(?:api[-_ ]?key|password|passwd|pwd|secret|token|authorization|cookie|credential|密码|口令|密钥|令牌)\s*["']?\s*[:=：]\s*(?:\r?\n|$)/i.test(input)) return HIDDEN;
  let text = input.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, HIDDEN);
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, HIDDEN);
  text = text.replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, HIDDEN);
  // Suppress the whole line for credential assignments, including multiword passwords.
  text = text.split(/\r?\n/).map(line =>
    /(?:api[-_ ]?key|password|passwd|pwd|secret|token|authorization|cookie|credential|密码|口令|密钥|令牌)\s*["']?\s*[:=：]|(?:密码|密钥|令牌)\s*(?:是|为)|\b(?:password|secret|token|api[-_ ]?key)\s+is\b/i.test(line)
      ? HIDDEN : line).join('\n');
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${HIDDEN}@`);
  // Opaque credential-like values (also intentionally hides benign long hashes).
  return text.replace(/[A-Za-z0-9_+/=-]{24,}/g, value => {
    const counts = new Map<string, number>();
    for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let entropy = 0;
    for (const n of counts.values()) { const p = n / value.length; entropy -= p * Math.log2(p); }
    return entropy >= 3.3 ? HIDDEN : value;
  });
}
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 30) return '[SUPPRESSED:DEPTH]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => {
      const structuralId = /^(?:id|session_id|thread_id|task_id|parent_id|sender_id|recipient_id|reply_to|wake_target)$/.test(key)
        && typeof v === 'string' && /^(?:(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[mt]_[0-9a-f]{12})$/i.test(v);
      return [redactText(key), sensitiveKey.test(key) ? HIDDEN : structuralId ? v : redact(v, depth + 1)];
    }));
  }
  return value;
}
