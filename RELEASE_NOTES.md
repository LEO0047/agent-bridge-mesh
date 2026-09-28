# AgentBridgeMesh v1.0.0

Codex and Claude Code can now collaborate as peers through a local persistent runtime: exchange questions and evidence, edit one versioned artifact, track disagreements, revise, and approve the exact same final candidate.

- Official Codex App Server and Claude Code CLI integrations with persistent sessions.
- Symmetric MCP tools, authenticated local transport, SQLite recovery and observable event history.
- Shared reports with optimistic version checks, provenance, disagreement tracking and exact-version dual approval.
- Separate code worktrees, integration/conflict handling and sandboxed tests before joint review.
- Bounded retries, timeouts, cancellation, duplicate/no-progress protection and honest degraded results.
- Installer and doctor for both clients; English and Traditional Chinese usage guides.

Real provider acceptance includes memory architecture and hardware research reports, an isolated bug fix, a deliberately seeded review/revision regression, and joint development on Agent Bridge itself. Public evidence includes sanitized traces, session fingerprints, verdict histories and final reports. Complete internal messages remain local.

Start with the [README](README.md), [繁體中文操作指南](docs/USAGE.zh-TW.md), and [acceptance evidence](docs/ACCEPTANCE.md).

Requirements: Node.js 22.13+, Git, authenticated Codex and Claude Code CLIs. Sandboxed coding tests currently require macOS. Codex dynamic tools remain experimental. This is a GitHub source release; it is not an npm registry publication.
