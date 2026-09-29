# The 45-second collaboration replay

[Animated replay](collaboration-demo.gif) · [Static poster](demo-poster.png) · [Actual final report](../acceptance/review-regression-final.md)

This is an **editorial terminal-style replay of a real provider run**, not a screen recording, live execution, or the literal output of `agent-bridge watch`. It uses English summaries of the public Chinese messages. Pauses are condensed into nine five-second scenes; the original run lasted about 4 minutes 38 seconds. The original event order is preserved.

The input was a **deliberately incorrect draft seeded at review**, not a naturally discovered research error. Codex and Claude Code performed the review, revisions and approvals. There is no simulated provider output in the source evidence. The animation itself is rendered from the summaries below.

## Transcript and event provenance

All event numbers refer to the `sequence` field in the [public trace](../acceptance/review-regression-trace.json). [Verdicts and final hash](../acceptance/review-regression-summary.json) are independently inspectable.

| Replay time | What the scene summarizes | Source events |
|---|---|---|
| 0–5s | A seeded faulty `draft.md` v1 enters review. | 1452 |
| 5–10s | Codex asks Claude to revise: stale writes must fail, and edits invalidate approvals. Codex submits REVISE on v1. | 1481, 1483 |
| 10–15s | Claude independently confirms the blocking issues and missing limitations section; submits REVISE on v1. | 1523, 1548 |
| 15–20s | Codex corrects the rules, adds limitations, writes v2 and messages Claude. | 1578, 1591 |
| 20–25s | Claude verifies the fixes, clarifies whole-artifact version granularity, writes v3 and messages Codex. | 1673, 1703 |
| 25–30s | Codex reviews v3, messages Claude and submits APPROVE. | 1757, 1759 |
| 30–35s | Claude reviews and approves that same v3 and hash. | 1828, 1859 |
| 35–40s | The collaboration completes on v3; the exported final report matches the approved hash. | 1884 + final report |
| 40–45s | Editorial recap of this completed exchange. | Same completed run |

The full final SHA-256 is `207ce4a33e62fb30f7c1d982e8ac2ef8400d28c0c0d67176bd885e0f4f3561a1`. The display abbreviates it to 16 characters. No private provider streams, credentials or raw session IDs are used.

## Rebuild the media

The checked-in GIF is ready for GitHub; viewers need no dependencies. To regenerate it, use Python with Pillow installed, then run:

```sh
python3 docs/media/render-demo.py
```

The renderer reads only checked-in public evidence and checks the final file hash and both exact-version approvals. It does not invoke either provider. macOS system fonts and Linux DejaVu fonts are supported; `DEMO_FONT` and `DEMO_MONO_FONT` can select other TrueType fonts. Fonts affect pixels, not the source events. Pillow is a media-authoring dependency, not a runtime dependency.

[architecture.svg](architecture.svg) is a hand-authored, editable vector diagram with a text description and no external fonts, scripts or images. It shows the logical data flow; peer exchanges go through Bridge's scoped tools. In coding mode, source edits occur in separate worktrees before integration, while the report remains shared.
