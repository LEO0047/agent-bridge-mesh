import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

const settings = z.object({
  collaboration: z.object({
    autonomous: z.literal(true),
    max_discussion_rounds: z.number().int().min(1),
    max_revision_rounds: z.number().int().min(1),
    max_total_agent_turns: z.number().int().min(6),
    max_duplicate_messages: z.number().int().min(1),
    require_dual_approval: z.literal(true),
    unresolved_disagreement: z.object({ strategy: z.literal('preserve_uncertainty') }),
  }),
  sessions: z.object({
    persistent: z.literal(true),
    agent_timeout_ms: z.number().min(1000),
    collaboration_timeout_ms: z.number().min(1000),
    max_retries: z.number().int().min(0).max(5),
  }),
  artifacts: z.object({ versioning: z.literal(true), optimistic_locking: z.literal(true) }),
  agents: z.object({
    codex: z.object({
      enabled: z.literal(true),
      command: z.string(),
      model: z.string().optional(),
    }),
    claude: z.object({
      enabled: z.literal(true),
      command: z.string(),
      model: z.string().optional(),
    }),
  }),
  permissions: z.object({ destructive_actions: z.literal('require_approval') }),
  logging: z.object({
    messages: z.literal(true),
    artifacts: z.literal(true),
    decisions: z.literal(true),
  }),
});
export const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export function loadConfig(root = process.env.AGENT_BRIDGE_ROOT || projectRoot) {
  const config = settings.parse(
    parse(readFileSync(join(root, 'agent-bridge.config.yaml'), 'utf8')),
  );
  // SQLite and socket must remain on a local disk, not an iCloud/network filesystem.
  const state = resolve(
    process.env.AGENT_BRIDGE_STATE || join(homedir(), '.local', 'state', 'agent-bridge'),
  );
  for (const p of [state, join(state, 'logs'), join(root, 'artifacts')])
    mkdirSync(p, { recursive: true, mode: 0o700 });
  return {
    ...config,
    root,
    state,
    db: join(state, 'bridge.sqlite'),
    socket: join(state, 'bridge.sock'),
    artifactsRoot: join(root, 'artifacts'),
  };
}
export type Config = ReturnType<typeof loadConfig>;
