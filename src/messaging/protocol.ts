import { z } from 'zod';
export const Agent = z.enum(['codex', 'claude']);
export type Agent = z.infer<typeof Agent>;
export const peer = (a: Agent): Agent => (a === 'codex' ? 'claude' : 'codex');
export const MessageType = z.enum([
  'question',
  'answer',
  'proposal',
  'challenge',
  'evidence',
  'review',
  'revision_request',
  'agreement',
  'disagreement',
  'status',
  'artifact_update',
  'final_candidate',
  'approval',
]);
export const MessageInput = z.object({
  type: MessageType,
  content: z.string().min(1).max(30000),
  reply_to: z.string().optional(),
  requires_reply: z.boolean().default(false),
  artifact_refs: z.array(z.string()).default([]),
  evidence_refs: z.array(z.string()).default([]),
});
export const Verdict = z
  .object({
    artifact_version: z.number().int().positive(),
    verdict: z.enum(['APPROVE', 'REVISE']),
    blocking_issues: z.array(z.string()),
    required_changes: z.array(z.string()).default([]),
    non_blocking_notes: z.array(z.string()).default([]),
    confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  })
  .refine(
    (v) =>
      v.verdict !== 'APPROVE' ||
      (v.blocking_issues.length === 0 && v.required_changes.length === 0),
    'APPROVE cannot contain blocking issues',
  );
export interface Context {
  actor: Agent | 'user';
  collaboration_id?: string;
  run_id?: string;
}
export const TurnResult = z.object({ summary: z.string(), ready_for_next_phase: z.boolean() });
export const turnSchema = {
  type: 'object',
  properties: { summary: { type: 'string' }, ready_for_next_phase: { type: 'boolean' } },
  required: ['summary', 'ready_for_next_phase'],
  additionalProperties: false,
};
