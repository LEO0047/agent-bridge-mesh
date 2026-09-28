import { z } from 'zod';
import { MessageType, Verdict } from './messaging/protocol.js';
const s = z.string(),
  name = s.default('draft.md'),
  version = z.number().int().min(0),
  reason = s.min(1);
export const schemas: Record<string, z.ZodRawShape> = {
  collaboration_start: {
    goal: s.min(1),
    initiator: z.enum(['codex', 'claude']).default('codex'),
    mode: z.enum(['collaborative_report', 'collaborative_coding']).default('collaborative_report'),
    required_sections: z.array(s).default([]),
    require_evidence: z.boolean().default(true),
    repository: s.optional(),
    test_command: z.array(s).min(1).default(['node', '--test']),
  },
  collaboration_status: {},
  collaboration_continue: {},
  collaboration_cancel: {},
  peer_send: {
    type: MessageType,
    content: s.min(1),
    reply_to: s.optional(),
    requires_reply: z.boolean().default(false),
    evidence_refs: z.array(s).default([]),
    artifact_refs: z.array(s).default([]),
  },
  peer_ask: { content: s, reply_to: s.optional() },
  peer_reply: { content: s, reply_to: s },
  peer_challenge: { content: s, evidence_refs: z.array(s).default([]) },
  peer_request_evidence: { content: s },
  peer_propose_change: { content: s },
  peer_accept_change: { content: s, reply_to: s },
  peer_reject_change: { content: s, reply_to: s },
  peer_request_review: { content: s },
  peer_submit_review: { ...Verdict.innerType().shape },
  peer_resolve_disagreement: {
    id: s,
    status: z.enum(['resolved_codex', 'resolved_claude', 'merged', 'uncertain']),
    reason,
    final_note: s.default(''),
  },
  messages_list: {},
  artifact_create: { name, content: s },
  artifact_read: { name },
  artifact_patch: { name, base_version: version, old_text: s.min(1), new_text: s, reason },
  artifact_replace_section: { name, base_version: version, heading: s, content: s, reason },
  artifact_comment: { name, content: s },
  artifact_history: { name },
  artifact_diff: { name, from: version, to: version },
  artifact_lock: { name },
  artifact_unlock: { name },
  disagreement_create: {
    topic: s,
    codex_position: s,
    claude_position: s,
    evidence: z.array(s).default([]),
  },
  disagreement_update: {
    id: s,
    status: z.enum(['open', 'resolved_codex', 'resolved_claude', 'merged', 'uncertain']),
    reason,
    final_note: s.default(''),
  },
  disagreement_list: {},
  review_submit: { ...Verdict.innerType().shape },
  review_status: {},
  evidence_add: { claim: s, source: s.url(), excerpt: s.min(1) },
  evidence_verify: { id: s, assessment: s.min(1) },
  evidence_list: {},
  decision_record: { decision: s, reason: s },
  role_assign: { synthesizer: z.enum(['codex', 'claude']), reason: s.min(1) },
  scope_set: { required_sections: z.array(s.min(1)).min(1), reason: s.min(1) },
  task_create: {
    title: s,
    assigned_to: z.enum(['codex', 'claude']),
    depends_on: z.array(s).default([]),
  },
  task_status: { id: s.optional() },
  task_update: {
    id: s,
    status: z.enum(['pending', 'running', 'done', 'cancelled']),
    result: s.default(''),
  },
  session_list: {},
  session_reset: { agent: z.enum(['codex', 'claude']) },
  workspace_list: {},
  workspace_read: { path: s, agent: z.enum(['codex', 'claude']).optional() },
  workspace_write: { path: s, content: s },
  workspace_diff: { agent: z.enum(['codex', 'claude']).optional() },
  workspace_test: {},
  workspace_resolve_conflict: { path: s, content: s },
};
export const descriptions: Record<string, string> = {
  collaboration_start:
    'Start autonomous symmetric Codex ↔ Claude collaboration. Returns id immediately; poll status. User has requested both agents.',
  collaboration_status: 'Read phase, messages, shared artifact, quality gate and final path.',
  collaboration_continue:
    'Resume interrupted or budget-limited collaboration with persisted sessions.',
  collaboration_cancel: 'Cancel collaboration and interrupt both runtimes.',
  peer_send: 'Send a persistent message to the other agent. Actor is assigned by Bridge.',
  peer_ask: 'Ask peer a question; peer is scheduled automatically; do not wait synchronously.',
  peer_reply: 'Answer a peer message by its message_id, closing its pending request.',
  peer_challenge: 'Challenge a substantive claim with reasons; opens a peer request.',
  peer_request_evidence: 'Ask peer for external evidence and provenance.',
  artifact_create: 'Create shared draft (once). Read existing artifact before editing.',
  artifact_patch:
    'Modify a UNIQUE exact text anchor in shared artifact with optimistic base_version. Re-read on STALE_VERSION.',
  artifact_replace_section:
    'Replace body under an exact Markdown heading, preserving subsequent headings.',
  review_submit:
    'Submit truthful APPROVE/REVISE of the current draft version. Approval invalidated by ANY subsequent edit.',
  evidence_add:
    'Register external source you actually retrieved, with claim and supporting excerpt.',
  evidence_verify:
    'Independently verify a peer source you actually inspected; self verification forbidden.',
  workspace_test:
    'Run user-configured test command in own isolated worktree (or merged tree at review). Only pre-authorized commands can execute.',
};
export const management = new Set([
  'collaboration_start',
  'collaboration_continue',
  'collaboration_cancel',
  'session_reset',
]);
export function toolDefinitions(forAgent = false) {
  return Object.entries(schemas)
    .filter(([n]) => !forAgent || !management.has(n))
    .map(([name, shape]) => ({
      name,
      description: descriptions[name] || name.replaceAll('_', ' '),
      schema: z.object(shape),
    }));
}
