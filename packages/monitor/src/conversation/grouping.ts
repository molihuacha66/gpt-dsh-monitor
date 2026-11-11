export type MessageMeta = { id: string; reply: string | null; title: string; at: number; seq: number; collab?:string|null };
// Navigation is derived. The chronological message stream is never rearranged to fit these groups.
export function deriveRounds(messages: MessageMeta[]) {
  const byId = new Map(messages.map(m => [m.id, m]));
  const groups = new Map<string, { root: string; issue: string | null }>();
  for (const message of messages) {
    if (groups.has(message.id)) continue;
    const path: string[] = [], seen = new Set<string>(); let id = message.id;
    let result: { root: string; issue: string | null };
    for (;;) {
      if (groups.has(id)) { result = groups.get(id)!; break; }
      if (seen.has(id)) { result = { root: [...path].sort()[0]!, issue: 'reply-cycle' }; break; }
      if (path.length >= 256) { result = { root: message.id, issue: 'reply-chain-limit' }; break; }
      const m = byId.get(id);
      if (!m) { result = { root: path.at(-1)!, issue: 'reference-not-visible' }; break; }
      seen.add(id); path.push(id);
      if (!m.reply) { result = { root: m.id, issue: null }; break; }
      if(byId.has(m.reply)&&(byId.get(m.reply)!.collab??null)!==(m.collab??null)){result={root:m.id,issue:'cross-collaboration-reference'};break}
      id = m.reply;
    }
    for (const p of path) groups.set(p, result);
  }
  const rounds = new Map<string, { id: string; anchor: string; title: string; at: number; count: number; issue: string | null }>();
  for (const m of messages) {
    const group = groups.get(m.id)!; const root = byId.get(group.root) ?? m;
    const round = rounds.get(group.root);
    if (round) round.count++;
    else rounds.set(group.root, { id: group.root, anchor: root.id, title: root.title || '未命名交流段', at: root.at, count: 1, issue: group.issue });
  }
  return { groups, rounds: [...rounds.values()].sort((a,b) => a.at-b.at || a.id.localeCompare(b.id)) };
}
