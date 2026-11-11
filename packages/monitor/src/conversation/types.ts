import type { Item } from '../query.ts';

export type Round = { id: string; anchor: string; title: string; at: number; count: number; issue: string | null };
export type ConversationMessage = Item & { roundId: string; relationIssue: string | null; files: Artifact[] };
export type ArtifactLink = { id: string; collab: string | null; messageId: string | null; taskId: string | null; evidence: string; source: string; declaredAt: number | null; observedAt: number; note: string;declaredBy:string };
export type Artifact = { id: string; name: string; type: string; previewable:boolean; availability: string; checkedAt: number; links: ArtifactLink[] };
export type ConversationPage = { items: ConversationMessage[]; total: number; rounds: Round[]; files: Artifact[]; hits: { id: string; title: string; at: number }[]; older: number | null; newer: number | null; latestId: string | null; hiddenTests: number; navigationLimited: boolean };
export type Preview = { artifact: Artifact; kind: 'text' | 'image'; text?: string; image?: string; notice: string };
export type ConversationRequest = { collab?: string; includeTests?: boolean; q?: string; direction?: string; from?: number; to?: number; before?: number; after?: number; anchor?: string; limit?: number };
