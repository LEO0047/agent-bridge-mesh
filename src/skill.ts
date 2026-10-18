import type { Agent } from './messaging/protocol.js';
// SKILL.md installed into both clients. The initiating agent reads it before starting Bridge,
// so worker limits are stated here, where the goal gets split, not discovered mid-run.
export function skillMarkdown(launcher: string, initiator: Agent) {
  return `---
name: agent-bridge
description: Use when the user asks Codex and Claude to collaborate, 雙 Agent 協作, 跟 Claude 一起, or 跟 Codex 一起.
---
Bridge runs two sandboxed peers. The Claude worker has web research plus Bridge tools and cannot read local files or images; the Codex worker has a read-only sandbox. Peers deliver text, research, and code in their own worktrees.

1. Split the goal. Give Bridge the writing, research, and code. Keep your share: image generation, browser, screenshot and Safari checks, binary exports (PNG, GLB), commits to other repositories, push, and PRs. Write into the goal every fact the peers must see, such as what a reference image shows. Done when each requested deliverable is assigned to Bridge or to you, and the user knows which.
2. Start the bridge with \`${launcher} start\`, then call the agent-bridge MCP collaboration_start with the goal and \`${initiator}\` as initiator. Coding mode needs \`repository\`: a clean, committed git repository. Start collaborations only from your own session; a Bridge-managed session works inside its current collaboration.
3. Poll collaboration_status until completed, degraded, or cancelled. Queued means the daemon restarted and the run resumes.
4. Deliver. Completed: deliver final.md, which means both peers found no blocking issue in the same version, not that anything was run or viewed. Degraded: report the reason honestly and provide best-effort.md. Claim dual approval only for completed. In coding mode, review the integration worktree diff and adopt its branch yourself.
5. Finish your share from step 1, then report what is implemented, what you observed, and what is unverified.

CLI fallback: \`${launcher} new --initiator ${initiator} --goal '...'\`; status: \`${launcher} collaboration <id>\`.
`;
}
