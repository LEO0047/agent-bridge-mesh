"""Render an editorial replay of public acceptance events; never calls a provider.
Requires Pillow. Run from any directory: python3 docs/media/render-demo.py
"""
import hashlib
import json
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
EVIDENCE = HERE.parent / 'acceptance'
TRACE = json.loads((EVIDENCE / 'review-regression-trace.json').read_text())
SUMMARY = json.loads((EVIDENCE / 'review-regression-summary.json').read_text())
EVENTS = {event['sequence']: event for event in TRACE}
FINAL_HASH = SUMMARY['final_sha256']
assert hashlib.sha256((EVIDENCE / 'review-regression-final.md').read_bytes()).hexdigest() == FINAL_HASH
assert SUMMARY['status'] == 'completed'
assert {r['agent'] for r in SUMMARY['review_verdicts'] if r['verdict'] == 'APPROVE' and r['artifact_sha256'] == FINAL_HASH and r['version'] == 3} == {'codex', 'claude'}

# English editorial summaries, not verbatim messages or literal CLI output.
# Each scene is bound to the public event(s) supporting it, in event order.
SCENES = [
    ([1452], 'One shared draft. Two independent minds.', 'fixture', 'draft.md  /  v1',
     ['A deliberately flawed candidate enters review.', 'Can two real agents catch it, revise it, and agree?'], 'SEE THE FULL LOOP IN 45 SECONDS', 'v1', 0),
    ([1481, 1483], 'Codex challenges the candidate.', 'codex', 'Codex  ->  Claude',
     ['REVISE  /  v1', 'Stale writes must be rejected.', 'An edit must invalidate earlier approvals.'], 'REVIEW  /  A PROBLEM IS FLAGGED', 'v1', 0),
    ([1523, 1548], 'Claude checks it independently.', 'claude', 'Claude  ->  Codex',
     ['REVISE  /  v1', 'The blocking issues are confirmed.', 'The draft also needs a limitations section.'], 'RETURN MESSAGE  /  NO HUMAN RELAY', 'v1', 0),
    ([1578, 1591], 'Codex revises the shared artifact.', 'codex', 'draft.md  /  v1 -> v2',
     ['Correct the conflict-handling rules.', 'Explain version-bound approval.', 'Add limits, then send the revision to Claude.'], 'EDIT  /  THE SAME VERSIONED DRAFT', 'v2', 0),
    ([1673, 1703], 'Claude closes one more gap.', 'claude', 'draft.md  /  v2 -> v3',
     ['Verify the fixes, then clarify version granularity.', 'A stale base is rejected even at a different text anchor.', 'Send the updated candidate back to Codex.'], 'REFINE  /  BOTH AGENTS HAVE EDITED', 'v3', 0),
    ([1757, 1759], 'Codex approves the current version.', 'codex', 'Codex  ->  Claude',
     ['APPROVE  /  v3', 'sha256  ' + FINAL_HASH[:16] + '...', 'Waiting for Claude to review this same candidate.'], 'QUALITY GATE  /  1 OF 2 APPROVALS', 'v3', 1),
    ([1828, 1859], 'Claude approves the same candidate.', 'claude', 'Claude  ->  Codex',
     ['APPROVE  /  v3', 'sha256  ' + FINAL_HASH[:16] + '...', 'Same version. Same hash. Two independent verdicts.'], 'QUALITY GATE  /  2 OF 2 APPROVALS', 'v3', 2),
    ([1884], 'Both approve. Bridge exports final.md.', 'bridge', 'collaboration.completed',
     ['final.md  /  v3', 'The shared artifact passes the completion gate.', 'The final report is available in the public evidence.'], 'COMPLETE  /  READ THE REAL FINAL REPORT', 'v3', 2),
    ([1884], 'You set the goal. They handle the exchange.', 'bridge', 'Codex <-> Claude  /  AgentBridgeMesh',
     ['Challenge -> revise -> review -> dual approval.', 'Persistent sessions. One shared artifact.', 'No copy-pasting messages between agents.'], 'SOURCE + TRANSCRIPT  /  LINKED BELOW', 'v3', 2),
]
BG, PANEL, EDGE = '#0b1219', '#111d28', '#2b3d4e'
WHITE, MUTED, TEAL, AMBER = '#eff6fc', '#a6b8c8', '#66e0ca', '#ffbc8c'

def font(size, mono=False):
    configured = os.environ.get('DEMO_MONO_FONT' if mono else 'DEMO_FONT')
    candidates = ([configured] if configured else []) + ([
        '/System/Library/Fonts/SFNSMono.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
    ] if mono else [
        '/System/Library/Fonts/Supplemental/Arial.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ])
    for candidate in candidates:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    raise SystemExit('Set DEMO_FONT and DEMO_MONO_FONT to TrueType font paths.')

FONTS = {(s, m): font(s, m) for s, m in [(14, False), (16, False), (18, False), (22, False), (30, False), (17, True), (19, True)]}

def frame(scene_index, elapsed):
    refs, title, who, command, lines, label, version, approvals = SCENES[scene_index]
    for ref in refs:
        assert ref in EVENTS
    color = TEAL if who in ('codex', 'bridge') else AMBER if who == 'claude' else MUTED
    im = Image.new('RGB', (1080, 630), BG)
    d = ImageDraw.Draw(im)
    def text(x, y, value, size=18, fill=WHITE, mono=False):
        f = FONTS[(size, mono)]
        assert d.textbbox((x, y), value, font=f)[2] <= 1048, value
        d.text((x, y), value, font=f, fill=fill)
    text(36, 26, 'AgentBridgeMesh', 22)
    text(720, 30, 'REAL RUN / EDITORIAL REPLAY', 16, TEAL)
    text(36, 75, title, 30)
    text(36, 123, 'Codex  >  Claude  >  Codex  >  dual approval  >  final.md', 18, MUTED)
    d.rounded_rectangle((36, 171, 1044, 453), radius=14, fill=PANEL, outline=EDGE)
    for x, c in [(58, '#eb857d'), (79, '#e5bb70'), (100, '#78c5a2')]:
        d.ellipse((x, 192, x+9, 201), fill=c)
    text(135, 189, 'acceptance / review-regression', 17, MUTED, True)
    text(842, 190, f'SCENE {scene_index+1:02d} / 09', 16, MUTED)
    d.line((37, 220, 1043, 220), fill=EDGE)
    text(61, 243, command, 19, color, True)
    for i, line in enumerate(lines):
        text(61, 292+i*37, line, 19, WHITE, True)
    text(36, 474, label, 16, color)
    d.rounded_rectangle((36, 513, 1044, 552), radius=8, fill=PANEL)
    text(53, 523, 'SHARED DRAFT  ' + version, 16, MUTED)
    text(376, 523, 'CODEX  ' + ('APPROVE' if approvals else 'PENDING'), 16, TEAL if approvals else MUTED)
    text(714, 523, 'CLAUDE  ' + ('APPROVE' if approvals == 2 else 'PENDING'), 16, AMBER if approvals == 2 else MUTED)
    text(36, 568, 'Seeded faulty draft; real providers. English summaries; timing condensed.', 14, MUTED)
    text(927, 568, f'{elapsed:02d}s / 45s', 14, MUTED)
    d.rectangle((36, 601, 1044, 605), fill=EDGE)
    d.rectangle((36, 601, 36 + int(1008 * (elapsed+1)/45), 605), fill=TEAL)
    return im

frames = [frame(i//5, i) for i in range(45)]
# One shared palette prevents text and colors from changing between GIF frames.
palette = frames[0].quantize(colors=128)
frames = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in frames]
frames[0].save(HERE / 'collaboration-demo.gif', save_all=True, append_images=frames[1:], duration=1000, loop=0, optimize=True, disposal=1)
frame(0, 0).save(HERE / 'demo-poster.png')
print('Rendered 45-second replay from public acceptance evidence.')
