import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, projectRoot } from '../src/config.js';
import { Store, id } from '../src/database/sqlite.js';
import { Service } from '../src/service.js';
import { qualityGate } from '../src/consensus/quality-gate.js';
import { Verdict } from '../src/messaging/protocol.js';
import { similarity } from '../src/policy/loop-protection.js';
import { workspacePath } from '../src/policy/permissions.js';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  copyFileSync(
    join(projectRoot, 'agent-bridge.config.yaml'),
    join(root, 'agent-bridge.config.yaml'),
  );
  process.env.AGENT_BRIDGE_STATE = join(root, 'state');
  const config = loadConfig(root);
  const db = new Store(config.db),
    service = new Service(db, config);
  const c = service.create({
    goal: 'test',
    initiator: 'codex',
    mode: 'collaborative_report',
    required_sections: [],
    require_evidence: false,
  }).id;
  return { root, config, db, service, c };
}
test('symmetric message roundtrips and persistent reply closure', () => {
  const { db, service: s, c, config } = fixture();
  const a = s.bus.send(c, 'codex', { type: 'question', content: 'A?', requires_reply: true });
  const b = s.bus.send(c, 'claude', { type: 'answer', content: 'B.', reply_to: a.id });
  const q = s.bus.send(c, 'claude', { type: 'question', content: 'C?', requires_reply: true });
  s.bus.send(c, 'codex', { type: 'answer', content: 'D.', reply_to: q.id });
  assert.equal(s.bus.pending(c).length, 0);
  assert.equal(db.all('messages', c).length, 4);
  db.close();
  const recovered = new Store(config.db);
  assert.equal(recovered.all('messages', c).length, 4);
  recovered.close();
});
test('forged cross-task and wrong-agent replies rejected', () => {
  const { service: s, c } = fixture();
  const m = s.bus.send(c, 'codex', { type: 'question', content: 'A?' });
  assert.throws(() => s.bus.send(c, 'codex', { type: 'answer', content: 'fake', reply_to: m.id }));
  assert.throws(() =>
    s.bus.send(c, 'claude', { type: 'answer', content: 'fake', reply_to: 'missing' }),
  );
});
test('duplicate hashes and semantic lexical similarity', () => {
  const { service: s, c } = fixture();
  for (let i = 0; i < 2; i++) s.bus.send(c, 'codex', { type: 'status', content: 'Same proposal!' });
  assert.throws(
    () => s.bus.send(c, 'codex', { type: 'status', content: 'same proposal' }),
    /DUPLICATE/,
  );
  assert.ok(
    similarity(
      'the report needs exact source references',
      'the report needs exact source references.',
    ) > 0.9,
  );
});
test('artifact optimistic concurrency, history, diff, locking and stale versions', () => {
  const { service: s, c } = fixture();
  s.artifacts.write(c, 'draft.md', '## A\nfirst\n## B\nsecond', 0, 'codex', 'initial');
  s.artifacts.patch(c, 'draft.md', 1, 'first', 'changed', 'claude', 'correct');
  assert.throws(() => s.artifacts.write(c, 'draft.md', 'stale', 1, 'codex', 'oops'), /STALE/);
  assert.equal(s.artifacts.history(c).length, 2);
  assert.match(s.artifacts.history(c)[1].diff, /changed/);
  s.artifacts.lock(c, 'draft.md', 'codex');
  assert.throws(
    () => s.artifacts.patch(c, 'draft.md', 2, 'changed', 'oops', 'claude', 'edit'),
    /LOCKED/,
  );
  s.artifacts.unlock(c, 'draft.md', 'codex');
  s.artifacts.section(c, 'draft.md', 2, '## A', 'new body', 'claude', 'section');
  assert.match(s.artifacts.read(c).content, /## B\nsecond/);
});
test('path traversal and symlink writes rejected', () => {
  const { service: s, c, root } = fixture();
  assert.throws(() => s.artifacts.write(c, '../escape', 'x', 0, 'codex', 'x'));
  mkdirSync(join(root, 'artifacts', c, 'linked-parent'));
  symlinkSync(tmpdir(), join(root, 'artifacts', c, 'linked-parent', 'link'));
  assert.throws(
    () => s.artifacts.write(c, 'linked-parent/link/file.md', 'x', 0, 'codex', 'x'),
    /Symlink/,
  );
  assert.throws(() => workspacePath(root, '../secret'));
  assert.throws(() => workspacePath(root, '.env'));
});
test('dual approval of exact version required; edits invalidate both', async () => {
  const { service: s, db, c } = fixture();
  s.artifacts.write(c, 'draft.md', 'Report '.repeat(40), 0, 'codex', 'initial');
  for (const a of ['codex', 'claude'] as const) {
    const run = id('run');
    db.put('runs', { id: run, collaboration_id: c, agent: a, status: 'running' });
    await s.call(
      'review_submit',
      { artifact_version: 1, verdict: 'APPROVE', blocking_issues: [] },
      { actor: a, collaboration_id: c, run_id: run },
    );
  }
  assert.equal(qualityGate(db, s.artifacts, s.bus, c).ready, true);
  s.artifacts.write(c, 'draft.md', 'Changed '.repeat(40), 1, 'claude', 'correction');
  assert.equal(qualityGate(db, s.artifacts, s.bus, c).ready, false);
  assert.throws(() =>
    Verdict.parse({ artifact_version: 1, verdict: 'APPROVE', blocking_issues: ['bad'] }),
  );
});
test('uncertainty must remain in final draft; pending requests block convergence', () => {
  const { service: s, db, c } = fixture();
  s.artifacts.write(c, 'draft.md', 'Report '.repeat(40), 0, 'codex', 'initial');
  db.put('disagreements', {
    id: 'd1',
    collaboration_id: c,
    status: 'uncertain',
    final_note: 'Unknown answer',
  });
  assert.ok(qualityGate(db, s.artifacts, s.bus, c).issues.some((x) => x.includes('Uncertainty')));
  s.bus.send(c, 'codex', { type: 'question', content: 'still unanswered', requires_reply: true });
  assert.ok(
    qualityGate(db, s.artifacts, s.bus, c).issues.includes('Pending peer question or revision'),
  );
});
test('expired agent capability prevents mutation; user cannot forge peer approval', async () => {
  const { service: s, c } = fixture();
  await assert.rejects(
    s.call(
      'artifact_create',
      { content: 'x' },
      { actor: 'codex', collaboration_id: c, run_id: 'bad' },
    ),
    /expired/,
  );
  await assert.rejects(
    s.call(
      'review_submit',
      { artifact_version: 1, verdict: 'APPROVE', blocking_issues: [] },
      { actor: 'user', collaboration_id: c },
    ),
  );
});
test('disagreement creation, resolution, evidence verification and task dependencies', async () => {
  const { service: s, db, c } = fixture();
  function ctx(a: 'codex' | 'claude') {
    const r = id('run');
    db.put('runs', { id: r, collaboration_id: c, agent: a, status: 'running' });
    return { actor: a, collaboration_id: c, run_id: r };
  }
  const a = ctx('codex'),
    b = ctx('claude');
  const d = await s.call(
    'disagreement_create',
    { topic: 'scope', codex_position: 'x', claude_position: 'y' },
    a,
  );
  await s.call('disagreement_update', { id: d.id, status: 'merged', reason: 'new evidence' }, b);
  assert.equal(db.get('disagreements', d.id).status, 'merged');
  const e = await s.call(
    'evidence_add',
    { claim: 'claim', source: 'https://example.org/doc', excerpt: 'source text' },
    a,
  );
  await assert.rejects(s.call('evidence_verify', { id: e.id, assessment: 'yes' }, a), /Peer/);
  await s.call('evidence_verify', { id: e.id, assessment: 'independently checked' }, b);
  const t = await s.call('task_create', { title: 'first', assigned_to: 'codex' }, a);
  const u = await s.call(
    'task_create',
    { title: 'second', assigned_to: 'claude', depends_on: [t.id] },
    a,
  );
  await assert.rejects(s.call('task_update', { id: u.id, status: 'done' }, b), /Dependencies/);
  await s.call('task_update', { id: t.id, status: 'done', result: 'ok' }, a);
  await s.call('task_update', { id: u.id, status: 'done', result: 'ok' }, b);
});
