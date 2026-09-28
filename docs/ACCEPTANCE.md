# Acceptance evidence — v1.0.0

The real provider runs below used authenticated Codex and Claude Code sessions on macOS on 2026-09-28 (UTC). They are not mocked conversations. Provider usage was incurred. The local daemon, persistent state, both MCP registrations and final artifact gates were exercised.

## Environment and integrations

- Local Node: `v26.8.0-alpha.0.0.0`; Git: `2.54.0 (Apple Git-157)`. CI separately checks supported Node 22 and 24.
- Codex: `0.158.0-alpha.2.1`, official App Server JSON-RPC, persistent thread/resume, experimental dynamic tools. Recorded model: `gpt-6-astra`.
- Claude Code: `2.1.275`, official non-interactive streamed CLI, persistent `--resume`, scoped Bridge MCP. Recorded model: `claude-opus-5[1m]` (message model `claude-opus-5`).
- Existing official logins were used. No API key, login identity, raw provider session ID or authentication file is published.
- Installer registered `agent-bridge` with both clients. Doctor: **12 PASS**. An independent MCP client listed **47 tools** and read completed collaboration state after the final daemon restart. [MCP check](acceptance/mcp.json) [Doctor results](acceptance/doctor.json)

The earliest versioning smoke included adapter configuration failures before they were corrected. Runs also include development-time daemon restarts. Traces intentionally retain failures; these are development acceptance histories, not a claim that every turn executed the final release build. Completed artifacts were checked again against the release's current quality gate.

## Real collaborations

Message counts are Codex → Claude / Claude → Codex. Every completed scenario has two approvals for the exact final version and SHA-256. Both providers edited the same draft; the separate worktrees in coding mode apply to source code, not reports.

| Scenario | Initiator | Messages | Final | Evidence |
|---|---|---:|---|---|
| versioning | codex | 9 / 7 | v2 | [report](acceptance/versioning-final.md) · [trace](acceptance/versioning-trace.json) |
| memory | codex | 11 / 7 | v8 | [report](acceptance/memory-final.md) · [trace](acceptance/memory-trace.json) |
| hardware | claude | 12 / 7 | v8 | [report](acceptance/hardware-final.md) · [trace](acceptance/hardware-trace.json) |
| coding | claude | 13 / 15 | v7 | [report](acceptance/coding-final.md) · [trace](acceptance/coding-trace.json) |
| review-regression | codex | 3 / 3 | v3 | [report](acceptance/review-regression-final.md) · [trace](acceptance/review-regression-trace.json) |
| self-hosting | claude | 14 / 8 | v7 | [report](acceptance/self-hosting-final.md) · [trace](acceptance/self-hosting-trace.json) |

Full hashes, session fingerprints, distinct resumed-session counts, evidence provenance, disagreements and verdict history are in [summary.json](acceptance/summary.json). In each scenario each agent reused one provider session across turns. The [restart comparison](acceptance/restart.json) records matching session fingerprints before and after a real daemon stop/start during the memory and hardware tasks.

### What actually happened

- **Memory architecture:** two independent analyses, reciprocal questions, primary-source research, disagreement over ANN filtering versus authorization and RDF provenance, shared revisions from v1 to v8, then dual approval. It compares files/Git, SQLite/FTS, vector databases, graph databases, event logs and minimal hybrid designs. The report explicitly separates product documentation from unmeasured performance/cost recommendations.
- **Hardware:** Claude initiated; both compared Apple shared memory, single/multiple NVIDIA GPUs and large-memory CPU systems. They corrected capacity, availability and specification attribution through shared revisions. No fabricated cross-platform benchmark ranking or current street price was supplied.
- **Coding fixture:** an intentionally seeded reversed-bound clamp bug initially failed. Codex changed the implementation; Claude contributed six boundary/negative-range tests in another worktree. Integrated tests passed 6/6. Review returned REVISE when the report still claimed integration was pending, causing another shared edit and review. Original checkout remained unchanged. [Integrated diff](acceptance/coding.diff)
- **Review regression:** a deliberately incorrect candidate and missing required section were seeded directly at review. Real agents both returned REVISE, revised the artifact, then approved v3. This is a **synthetic regression input with real providers**, not an organically discovered research error. The two research reports above converged through peer editing and received APPROVE at their final review; they are not mislabeled as REVISE scenarios.

### Joint development on AgentBridgeMesh itself

After the base runtime was usable, Claude implemented persistent test-child registration and restart cleanup in AgentBridgeMesh itself. Codex challenged the executable-name identity assumption, contributed 18 regression tests, reviewed the implementation, and edited the same report. Both approved report v7 and integrated commit `130f7527db1ba905bb8f287e283b400f846473f9`. [Integrated source diff](acceptance/self-hosting.diff)

The live worktree tests initially failed because the outer test sandbox denied OS operations (the probe specifically observed `spawnSync ps EPERM`; a Git fixture also could not load its Xcode runtime). The peers kept the production sandbox in place and replaced only OS process/Git boundaries in the regression tests. Actual Store reopening, registry, Service/Engine wiring, snapshot gate, cancellation/timeout and verdict behavior ran. That 18-test result is not described as a real kernel-process kill test.

The primary maintainer independently added a narrowly scoped same-sandbox signal permission and two real-process acceptance tests. One confirms test children can be terminated while positive-PID and process-group signals to an external owned process are denied. The other SIGKILLs a fixture parent running the production test runner, confirms its silent detached test survives, reopens SQLite, calls the real Engine recovery path, and observes that test process terminate. These tests pass in the final 52-test suite on all three local Node versions. The same-sandbox signal change does not claim to make `ps` available inside the outer sandbox. Provider peer review was on the integration commit above; subsequent maintainer changes and full release validation are attributed separately.

Test processes use separate `test_runs` records so they cannot corrupt agent retries or fallback selection. Recovery compares PID with process birth time and UID; executable changes do not invalidate that identity. Limits remain: `ps` birth time is second-resolution, identity lookup and signal delivery are not atomic, unknown/old-format identities fail closed, a child can escape its original process group, and a SIGKILL in the spawn-to-registration window cannot be recovered from an absent record. `interrupted` records an attempted recovery decision, not proof every descendant exited. This is local process recovery, not a hostile multi-user resource-containment service.

The exported trace includes message directions, reply IDs, version changes, review verdicts, failures and completion events. Peer-message text is a short excerpt with quoted passages removed; full content hashes preserve correspondence. Complete original Agent-to-Agent messages are retained privately and available with `agent-bridge messages <id>` or in SQLite. Raw provider streams and private paths are not public evidence artifacts.

## Automated coverage

The final local suite passed **52/52 tests**, with no skipped tests, on Node **22.23.3**, **24.21.0**, and the local Node **26.8.0-alpha.0.0.0**, all on macOS. Build and formatting checks passed. [Machine-readable checks](acceptance/checks.json) It contains real SQLite, daemon/socket and Git worktree tests alongside deterministic fake-agent lifecycle tests. It does not represent fake-agent calls as live model acceptance.

| Required behavior | Automated evidence | Real evidence |
|---|---|---|
| 1–4: both message directions and return trips | `core.test.ts`: symmetric roundtrips, reply ownership | all normal collaborations, direction counts above |
| 5–6: session resume and Bridge restart | `invariants.test.ts`, `transport.test.ts` | session fingerprints and restart comparison |
| 7–8: concurrent/stale artifact writes | `core.test.ts`: version/lock/history/diff | shared v1→final history; stale edits remain rejected |
| 9–11: disagreement create/resolve/uncertain | core ledger + uncertainty gate tests | memory/hardware ledger entries |
| 12–14: REVISE, APPROVE, exact dual approval | core + invariant + full engine tests | coding and review-regression verdicts |
| 15–16: loops and duplicate messages | hash/trigram tests, no-progress/hard budget | bounded run histories; no semantic-understanding claim |
| 17–19: timeout, crash, cancellation | engine interruption/retry tests; transport cancellation | recorded development interruptions/recovery |
| 20: collaborative report | full engine state-machine test | memory and hardware reports |
| 21–23: coding, separate worktrees, conflicts | real Git merge conflict + sandbox tests | clamp fix and integration results |
| 24–25: convergence and real roundtrip | exact gate and forged/stale review tests | final artifacts, both authors, both same-version approvals |

Additional checks cover independent-analysis isolation and parallel start, task dependencies and deduplication, cross-task provenance, expired capabilities, path traversal/symlinks, reserved final exports, repository-secret reads, and restoring file exports from authoritative SQLite.

## Reproduce

```sh
npm ci
npm run build
npm run lint
npm test
npm run install:mcp
agent-bridge doctor
npm run test:live
npm run test:live:coding
```

Live scripts incur provider usage and require both official logins. `node scripts/live-acceptance.mjs --resume <id>` checks an existing completed normal scenario without creating another task. The hardware scenario is a normal `collaborative_report` initiated by Claude with the hardware goal. The seeded review regression intentionally starts at review and is documented separately.

After completion, `node scripts/export-acceptance.mjs <manifest.json>` accepts an explicit array of `[label, collaboration-id]` pairs. It refuses incomplete or gate-failing scenarios and exports only selected fields. Private operational logs/database are gitignored. Review exported material before publication for each new use case.

## Boundaries of this evidence

No guarantee is made about future provider CLI changes, every model, every operating system, or arbitrary large codebases. Dynamic tool compatibility is experimental. Sandboxed coding tests currently require macOS; dependency preparation is explicit and test networking is denied. Research citations are agent cross-checks rather than formal proofs. Crash recovery is at-least-once model execution, protected by version and duplicate checks, not exactly-once reasoning. The local OS account remains trusted.

See [README](../README.md) for architecture and English operations, or [繁體中文操作指南](USAGE.zh-TW.md) for start/stop/new/watch/messages instructions.
