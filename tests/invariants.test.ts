import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, projectRoot } from '../src/config.js';
import { Store, id } from '../src/database/sqlite.js';
import { Service } from '../src/service.js';
import { Engine } from '../src/collaboration-engine.js';
import { qualityGate } from '../src/consensus/quality-gate.js';
import { runTests } from '../src/tasks/test-runner.js';
import type { Agent } from '../src/messaging/protocol.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-invariant-'));
  copyFileSync(
    join(projectRoot, 'agent-bridge.config.yaml'),
    join(root, 'agent-bridge.config.yaml'),
  );
  mkdirSync(join(root, 'collaboration'));
  copyFileSync(
    join(projectRoot, 'collaboration/COLLABORATION_PROTOCOL.md'),
    join(root, 'collaboration/COLLABORATION_PROTOCOL.md'),
  );
  process.env.AGENT_BRIDGE_STATE = join(root, 'state');
  const config = loadConfig(root),
    db = new Store(config.db),
    s = new Service(db, config);
  const c = s.create({
    goal: 'test',
    initiator: 'codex',
    mode: 'collaborative_report',
    required_sections: [],
    require_evidence: false,
  }).id;
  const ctx = (agent: Agent) => {
    const r = id('run');
    db.put('runs', { id: r, collaboration_id: c, agent, status: 'running' });
    return { actor: agent, collaboration_id: c, run_id: r };
  };
  return { root, config, db, s, c, ctx };
}

test('session IDs survive database close and reopen', () => {
  const { db, c, config } = fixture();
  db.put('sessions', {
    id: c + '/codex',
    collaboration_id: c,
    agent: 'codex',
    session_id: 'persistent-thread',
  });
  db.close();
  const reopened = new Store(config.db);
  assert.equal(reopened.get('sessions', c + '/codex').session_id, 'persistent-thread');
  reopened.close();
});

test('cancelled collaboration rejects all late writes', async () => {
  const { s, c, ctx } = fixture();
  const actor = ctx('codex');
  await s.call('collaboration_cancel', {}, { actor: 'user', collaboration_id: c });
  await assert.rejects(s.call('artifact_create', { content: 'late' }, actor), /terminal/);
});

test('stale review cannot approve newer artifact', async () => {
  const { s, c, ctx } = fixture();
  s.artifacts.write(c, 'draft.md', 'initial '.repeat(20), 0, 'codex', 'initial');
  s.artifacts.write(c, 'draft.md', 'new '.repeat(40), 1, 'claude', 'change');
  await assert.rejects(
    s.call(
      'review_submit',
      { artifact_version: 1, verdict: 'APPROVE', blocking_issues: [] },
      ctx('codex'),
    ),
    /STALE_REVIEW/,
  );
});

test('REVISE remains blocking even if the other peer approves', async () => {
  const { s, c, ctx, db } = fixture();
  s.artifacts.write(c, 'draft.md', 'text '.repeat(40), 0, 'codex', 'initial');
  await s.call(
    'review_submit',
    { artifact_version: 1, verdict: 'APPROVE', blocking_issues: [] },
    ctx('codex'),
  );
  await s.call(
    'review_submit',
    { artifact_version: 1, verdict: 'REVISE', blocking_issues: ['Needs evidence'] },
    ctx('claude'),
  );
  assert.equal(qualityGate(db, s.artifacts, s.bus, c).ready, false);
});

test('source IDs from another collaboration are rejected', () => {
  const { s, c, db } = fixture();
  db.put('evidence', { id: 'foreign', collaboration_id: 'other', source: 'https://example.org' });
  assert.throws(
    () => s.bus.send(c, 'codex', { type: 'evidence', content: 'look', evidence_refs: ['foreign'] }),
    /Unknown evidence/,
  );
});

test('ambiguously repeated artifact patch anchor cannot replace text', () => {
  const { s, c } = fixture();
  s.artifacts.write(c, 'draft.md', 'repeat repeat', 0, 'codex', 'initial');
  assert.throws(
    () => s.artifacts.patch(c, 'draft.md', 1, 'repeat', 'changed', 'claude', 'fix'),
    /exactly once/,
  );
  assert.equal(s.artifacts.read(c).version, 1);
});

test('agent cannot fabricate final artifact or override metadata export', () => {
  const { s, c } = fixture();
  assert.throws(() => s.artifacts.write(c, 'final.md', 'fake', 0, 'codex', 'fake'), /convergence/);
  assert.throws(() => s.artifacts.write(c, 'metadata.json', '{}', 0, 'claude', 'fake'), /Reserved/);
});

test('role reassignment is symmetric and ends before drafting', async () => {
  const { s, c, ctx, db } = fixture();
  await s.call(
    'role_assign',
    { synthesizer: 'claude', reason: 'better synthesis context' },
    ctx('codex'),
  );
  assert.equal(s.collab(c).synthesizer, 'claude');
  db.put('collaborations', { ...s.collab(c), phase: 'review' });
  await assert.rejects(
    s.call('role_assign', { synthesizer: 'codex', reason: 'late change' }, ctx('claude')),
    /before drafting/,
  );
});

test('independent research cannot read peer notes or messages', async () => {
  const { s, c, ctx, db } = fixture();
  db.put('collaborations', { ...s.collab(c), phase: 'analysis' });
  await assert.rejects(
    s.call('artifact_read', { name: 'notes/claude.md' }, ctx('codex')),
    /Independent/,
  );
  await assert.rejects(s.call('messages_list', {}, ctx('claude')), /Independent/);
});

test('continuing an active run does not reset its usage budget', async () => {
  const { s, c, db } = fixture();
  db.put('collaborations', { ...s.collab(c), status: 'running', turns: 7 });
  await s.call('collaboration_continue', {}, { actor: 'user', collaboration_id: c });
  assert.equal(s.collab(c).turns, 7);
});

test('retrying the same active task reuses its collaboration', () => {
  const { s, c } = fixture();
  const repeated = s.create({
    goal: 'test',
    initiator: 'codex',
    mode: 'collaborative_report',
    required_sections: [],
    require_evidence: false,
  });
  assert.equal(repeated.id, c);
});

test('section names in ordinary prose do not satisfy required headings', () => {
  const { s, c, db } = fixture();
  db.put('collaborations', { ...s.collab(c), required_sections: ['Evidence'] });
  s.artifacts.write(
    c,
    'draft.md',
    'Evidence exists only as prose. '.repeat(10),
    0,
    'codex',
    'initial',
  );
  assert.ok(
    qualityGate(db, s.artifacts, s.bus, c).issues.some((x) =>
      x.includes('Missing section heading'),
    ),
  );
});

test('independent analysis starts both peers before waiting for either', async () => {
  const { s, c, db, config } = fixture();
  config.sessions.max_retries = 0;
  db.put('collaborations', { ...s.collab(c), phase: 'analysis' });
  const started: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r));
  const adapter = {
    turn: async (input: any) => {
      if (s.collab(c).phase !== 'analysis') throw Error('finished analysis');
      started.push(input.agent);
      if (started.length === 2) release();
      await barrier;
      input.onSession('session-' + input.agent);
      return { summary: 'independent', ready_for_next_phase: true };
    },
  };
  const engine = new Engine(s, { codex: adapter, claude: adapter });
  await assert.rejects(engine.run(c, new AbortController().signal), /finished analysis/);
  assert.deepEqual(new Set(started), new Set(['codex', 'claude']));
  assert.deepEqual(new Set(s.collab(c).analysis_done), new Set(['codex', 'claude']));
});

test('hard budget stops a discussion without counterfeit final', async () => {
  const { s, c, db, config } = fixture();
  config.collaboration.max_total_agent_turns = 0;
  const e = new Engine(s, {
    codex: {
      turn: async () => {
        throw Error('must not run');
      },
    },
    claude: {
      turn: async () => {
        throw Error('must not run');
      },
    },
  });
  await e.run(c, new AbortController().signal);
  assert.equal(s.collab(c).status, 'degraded');
  assert.equal(s.status(c).final_path, null);
});

test('restart rematerializes file export from authoritative SQLite', () => {
  const { s, c, db, config } = fixture();
  s.artifacts.write(c, 'draft.md', 'durable report', 0, 'codex', 'initial');
  writeFileSync(s.artifacts.path(c, 'draft.md'), 'corrupted export');
  db.put('collaborations', { ...s.collab(c), status: 'degraded' });
  const e = new Engine(s);
  e.recover();
  assert.equal(readFileSync(s.artifacts.path(c, 'draft.md'), 'utf8'), 'durable report');
});

test(
  'test sandbox denies reading a file outside authorized worktree',
  { skip: process.platform !== 'darwin' },
  async () => {
    const { root } = fixture();
    const work = join(root, 'work');
    mkdirSync(work);
    const secret = join(root, 'unauthorized.txt');
    writeFileSync(secret, 'not-for-tests');
    writeFileSync(
      join(work, 'security.test.cjs'),
      `const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');test('outside read denied',()=>assert.throws(()=>fs.readFileSync(${JSON.stringify(secret)})));`,
    );
    const result = await runTests(work);
    assert.equal(result.passed, true, JSON.stringify(result));
  },
);
