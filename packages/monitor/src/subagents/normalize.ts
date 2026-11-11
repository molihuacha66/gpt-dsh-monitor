import { redactText } from '../redaction.ts';
import { MonitorError } from '../errors.ts';

type Obj = Record<string, unknown>;
export const object = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
export function sessionId(v: unknown): string | null {
  return typeof v === 'string' && /^(?:(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|session-\d{1,10})$/i.test(v) ? v : null;
}
export type AgentState = {
  id: string; parent_id: string | null; is_child: boolean; is_seeded: boolean; depth: number; created_at: number;
  seed_cut: number; last_seq: number; descriptor: boolean; initial_seen: boolean; label: string; mode: string;
  status: string; status_at: number | null;
};
export type AgentEvent = { seq: number; at: number; kind: string; sender_id: string | null; recipient_id: string | null; text: string; reason: string | null; evidence: string };
const time = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000 ? v : null;
export function header(value: unknown): AgentState {
  const h = object(value), id = sessionId(h.id), parent = h.parentSession == null ? null : sessionId(h.parentSession);
  if (h.type !== 'session' || h.version !== 4) throw new MonitorError('AGENT_FORMAT_UNSUPPORTED');
  if (!id || (h.parentSession != null && !parent) || parent === id || typeof h.isSeeded !== 'boolean' || time(h.createdAt) === null || !Number.isSafeInteger(h.delegationDepth) || Number(h.delegationDepth) < 0 || Number(h.delegationDepth) > 100) throw new MonitorError('AGENT_HEADER_INVALID');
  return { id, parent_id: parent, is_child: h.origin === 'subagent', is_seeded: h.isSeeded, depth: Number(h.delegationDepth), created_at: Number(h.createdAt), seed_cut: -1, last_seq: -1, descriptor: false, initial_seen: false, label: '', mode: 'unknown', status: 'unknown', status_at: null };
}
function textOnly(message: Obj): string {
  if (!Array.isArray(message.content)) return '';
  // Never serialize message/source blocks, tools, attachments, reasoning or runtime context.
  const parts: string[] = []; let size = 0;
  for (const block of message.content) {
    const b = object(block);
    if (b.type !== 'text' || typeof b.text !== 'string') continue;
    size += b.text.length;
    if (size > 1024 * 1024) throw new MonitorError('AGENT_TEXT_LIMIT');
    parts.push(b.text);
  }
  return redactText(parts.join('\n'));
}
export function normalize(state: AgentState, values: unknown[], initial: boolean): AgentEvent[] {
  const events = values.map(object);
  let next = state.last_seq + 1;
  for (const e of events) {
    if (e.seq !== next++ || typeof e.type !== 'string' || time(e.time) === null) throw new MonitorError('AGENT_SEQUENCE_INVALID');
  }
  const markers = events.filter(e => e.type === 'session/end-seed' && object(e.data).inherited === true);
  if (initial) {
    if (state.is_seeded && !markers.length) throw new MonitorError('AGENT_SEED_BOUNDARY_MISSING');
    if (!state.is_seeded && markers.length) throw new MonitorError('AGENT_SEED_BOUNDARY_INVALID');
    state.seed_cut = markers.length ? Number(markers.at(-1)!.seq) : -1;
  } else if (markers.length) throw new MonitorError('AGENT_SEED_BOUNDARY_CHANGED');
  const out: AgentEvent[] = [];
  for (const e of events) {
    state.last_seq = Number(e.seq);
    if (state.last_seq <= state.seed_cut) continue;
    const d = object(e.data), at = Number(e.time);
    const emit = (kind: string, sender: string | null, recipient: string | null, text = '', reason: string | null = null, evidence = 'explicit-source') => out.push({ seq: state.last_seq, at, kind, sender_id: sender, recipient_id: recipient, text, reason, evidence });
    if (state.is_child && e.type === 'subagent/descriptor') {
      if (d.version !== 3 || !['one-shot', 'continuable'].includes(String(d.mode))) throw new MonitorError('AGENT_DESCRIPTOR_UNSUPPORTED');
      if (!state.descriptor) {
        state.descriptor = true; state.mode = String(d.mode);
        state.label = typeof d.label === 'string' ? redactText(d.label).slice(0, 200) : '';
        emit('descriptor', state.parent_id, state.id, state.label, null, 'session-metadata');
      }
    } else if (e.type === 'user/message') {
      const source = object(d.source), sender = sessionId(source.senderSessionId);
      if (['agent-message', 'subagent-settled'].includes(String(source.kind)) && sender && sender !== state.id) {
        emit(source.kind === 'agent-message' ? 'received' : 'settlement-notice', sender, state.id, textOnly(d));
      } else if (state.is_child && state.parent_id && state.descriptor && !state.initial_seen && source.kind === 'user') {
        state.initial_seen = true;
        emit('initial-delegation', state.parent_id, state.id, textOnly(d), null, 'position-inference');
      }
    } else if (state.is_child && e.type === 'assistant/message') {
      const message = object(d.message);
      if (message.role === 'assistant') { const text = textOnly(message); if (text) emit('output', state.id, null, text, null, 'output-only-delivery-unproven'); }
    } else if (state.is_child && (e.type === 'turn/start' || e.type === 'turn/end')) {
      const r = object(d.reason).kind;
      const reason = e.type === 'turn/start' ? null : ['completed', 'aborted', 'error', 'max-tokens', 'refusal', 'interrupted', 'blocked', 'forked'].includes(String(r)) ? String(r) : 'unknown';
      // A fork's synthetic closers do not prove that this child has executed anything.
      if (reason === 'forked') continue;
      state.status = e.type === 'turn/start' ? 'observed-running' : reason === 'completed' ? 'turn-ended' : `turn-${reason}`;
      state.status_at = at;
      emit(e.type === 'turn/start' ? 'turn-start' : 'turn-end', state.id, null, '', reason, 'persisted-turn');
    }
  }
  // Structural IDs only; free text always goes through the existing redactor first.
  // All remaining fields are fixed enums, numbers or grammar-validated structural IDs.
  return out;
}
