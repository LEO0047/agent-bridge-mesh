import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig, projectRoot, sessionTimeouts } from '../src/config.js';
import { skillMarkdown } from '../src/skill.js';
import { Store, id } from '../src/database/sqlite.js';
import { Service } from '../src/service.js';
import { Engine } from '../src/collaboration-engine.js';
import { peer } from '../src/messaging/protocol.js';
import type { Adapter, TurnInput } from '../src/adapters/types.js';
import { Worktrees, git } from '../src/tasks/worktrees.js';
import { runTests } from '../src/tasks/test-runner.js';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-engine-'));
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
  const config = loadConfig(root);
  return { root, config, db: new Store(config.db) };
}
async function until(fn: () => boolean) {
  for (let n = 0; n < 500; n++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error('Test wait expired');
}
class Fake implements Adapter {
  sessions = new Map<string, string>();
  revisions = 1;
  notReadyRounds: Record<string, number> = {};
  constructor(
    public s: Service,
    public failOnce = false,
  ) {}
  async turn(i: TurnInput) {
    if (this.failOnce) {
      this.failOnce = false;
      throw Error('simulated crash');
    }
    const key = i.collaboration_id + '/' + i.agent;
    const existing = this.sessions.get(key);
    if (existing) assert.equal(i.session_id, existing);
    else this.sessions.set(key, 'session-' + key);
    i.onSession(this.sessions.get(key)!);
    const c = this.s.collab(i.collaboration_id),
      ctx = { actor: i.agent, collaboration_id: c.id, run_id: i.run_id };
    const call = (n: string, a: any) => this.s.call(n, a, ctx);
    for (const m of this.s.bus.pending(c.id, i.agent))
      await call('peer_reply', { reply_to: m.id, content: 'Evidence and answer ' + m.id });
    if (c.phase === 'scope' || c.phase === 'analysis')
      await call('peer_ask', { content: i.agent + ' ' + c.phase + ' question' });
    if (c.phase === 'discussion' && c.discussion_round < (this.notReadyRounds[i.agent] ?? 0)) {
      if (i.agent === c.initiator)
        await call('peer_ask', { content: 'Open point ' + randomBytes(24).toString('hex') });
      return { summary: 'still discussing', ready_for_next_phase: false };
    }
    if (c.phase === 'draft') {
      const a = this.s.artifacts.read(c.id);
      if (!a)
        await call('artifact_create', {
          content: '## Report\n' + 'Sufficient shared content. '.repeat(12),
        });
      else
        await call('artifact_patch', {
          base_version: a.version,
          old_text: '## Report',
          new_text: '## Report improved',
          reason: 'peer improvement',
        });
    }
    if (c.phase === 'review' || c.phase === 'integrity') {
      const a = this.s.artifacts.read(c.id);
      const revise = this.revisions > 0 && i.agent === 'claude';
      if (revise) this.revisions--;
      await call('review_submit', {
        artifact_version: a.version,
        verdict: revise ? 'REVISE' : 'APPROVE',
        blocking_issues: revise ? ['Missing caveat'] : [],
        required_changes: revise ? ['Add caveat'] : [],
      });
    }
    if (c.phase === 'revision' && i.agent === 'codex') {
      const a = this.s.artifacts.read(c.id);
      await call('artifact_patch', {
        base_version: a.version,
        old_text: 'Sufficient shared content.',
        new_text: 'Sufficient shared content.' + ' Updated caveat.',
        reason: 'review correction',
      }).catch(async () => {
        await call('artifact_replace_section', {
          base_version: a.version,
          heading: '## Report improved',
          content: `Corrected content with caveat ${c.revision_round}. `.repeat(12),
          reason: 'review correction',
        });
      });
    }
    return { summary: 'complete ' + c.phase, ready_for_next_phase: true };
  }
}
test('full automatic report, retry crash, resume, revise, dual approval and convergence', async () => {
  const { config, db } = fixture();
  const s = new Service(db, config);
  const fake = new Fake(s, true),
    e = new Engine(s, { codex: fake, claude: fake });
  const c = s.create({
    goal: 'test',
    initiator: 'claude',
    mode: 'collaborative_report',
    required_sections: [],
    require_evidence: false,
  }).id;
  await until(() => !e.running.size);
  assert.equal(s.collab(c).status, 'completed');
  assert.ok(db.all('reviews', c).some((r) => r.verdict === 'REVISE'));
  assert.ok(s.artifacts.read(c).version >= 3);
  assert.ok(db.all('runs', c).some((r) => r.status === 'failed'));
  assert.equal(readFileSync(s.artifacts.path(c, 'final.md'), 'utf8'), s.artifacts.read(c).content);
});
function report(s: Service, goal: string) {
  return s.create({
    goal,
    initiator: 'claude',
    mode: 'collaborative_report',
    required_sections: [],
    require_evidence: false,
  }).id;
}
test('discussion ends only when both peers report ready', async () => {
  const { config, db } = fixture();
  const s = new Service(db, config);
  const fake = new Fake(s);
  fake.notReadyRounds = { claude: 3 };
  const e = new Engine(s, { codex: fake, claude: fake });
  const c = report(s, 'dual ready');
  await until(() => !e.running.size);
  assert.equal(s.collab(c).status, 'completed');
  // The responder was ready from round 1; the initiator only from round 4.
  assert.equal(s.collab(c).discussion_round, 4);
});
test('maximal discussion still leaves budget for three revision rounds', async () => {
  const { config, db } = fixture();
  const s = new Service(db, config);
  const fake = new Fake(s);
  fake.notReadyRounds = { claude: Infinity, codex: Infinity };
  fake.revisions = 3;
  const e = new Engine(s, { codex: fake, claude: fake });
  const c = report(s, 'budget');
  await until(() => !e.running.size);
  const v = s.collab(c);
  assert.equal(v.status, 'completed', v.last_error);
  assert.ok(v.discussion_round >= 2);
  assert.equal(v.revision_round, 3);
  assert.ok(v.turns <= config.collaboration.max_total_agent_turns);
});
test('exhausted revisions end through best effort and integrity, not a budget crash', async () => {
  const { config, db } = fixture();
  const s = new Service(db, config);
  const fake = new Fake(s);
  fake.notReadyRounds = { claude: Infinity, codex: Infinity };
  fake.revisions = Infinity;
  const e = new Engine(s, { codex: fake, claude: fake });
  const c = report(s, 'never approved');
  await until(() => !e.running.size);
  const v = s.collab(c);
  assert.equal(v.status, 'degraded');
  assert.match(v.last_error, /Final integrity review/);
  assert.ok(db.all('runs', c).some((r) => r.phase === 'best_effort'));
  assert.ok(v.turns <= config.collaboration.max_total_agent_turns);
  assert.equal(s.status(c).final_path, null);
});
test('cancel interrupts both runtimes and prevents late tool mutations', async () => {
  const { config, db } = fixture();
  const s = new Service(db, config);
  const hang: Adapter = {
    turn: async (i) =>
      new Promise((_, reject) =>
        i.signal.addEventListener('abort', () => reject(Error('aborted'))),
      ),
  };
  const e = new Engine(s, { codex: hang, claude: hang });
  const c = s.create({
    goal: 'cancel',
    initiator: 'codex',
    mode: 'collaborative_report',
    required_sections: [],
    require_evidence: false,
  }).id;
  await s.call('collaboration_cancel', {}, { actor: 'user', collaboration_id: c });
  await until(() => !e.running.size);
  assert.equal(s.collab(c).status, 'cancelled');
  assert.equal(e.capabilities.size, 0);
});
test('timeout retries are bounded and do not fake final approval', async () => {
  const { config, db } = fixture();
  config.sessions.agent_timeout_ms = 20;
  config.sessions.max_retries = 1;
  const s = new Service(db, config);
  const hang: Adapter = {
    turn: async (i) =>
      new Promise((_, reject) =>
        i.signal.addEventListener('abort', () => reject(Error('timeout'))),
      ),
  };
  const e = new Engine(s, { codex: hang, claude: hang });
  const c = s.create({
    goal: 'timeout',
    initiator: 'codex',
    mode: 'collaborative_report',
    required_sections: [],
    require_evidence: false,
  }).id;
  await until(() => !e.running.size);
  assert.equal(s.collab(c).status, 'degraded');
  assert.equal(db.all('runs', c).length, 4);
  assert.equal(s.status(c).final_path, null);
  // The retry prompt carries last_error, so the timeout must be named there.
  assert.ok(db.all('runs', c).every((r) => /^Turn timed out after 0s/.test(r.error)));
});
test('coding mode uses its own turn and collaboration time limits', () => {
  const { config } = fixture();
  const {
    coding_agent_timeout_ms: _a,
    coding_collaboration_timeout_ms: _c,
    ...reportOnly
  } = config.sessions;
  const sessions = { ...reportOnly, agent_timeout_ms: 1000, collaboration_timeout_ms: 2000 };
  const coding = {
    ...sessions,
    coding_agent_timeout_ms: 3000,
    coding_collaboration_timeout_ms: 4000,
  };
  assert.deepEqual(sessionTimeouts(coding, 'collaborative_report'), {
    agent_ms: 1000,
    collaboration_ms: 2000,
  });
  assert.deepEqual(sessionTimeouts(coding, 'collaborative_coding'), {
    agent_ms: 3000,
    collaboration_ms: 4000,
  });
  assert.deepEqual(sessionTimeouts(sessions, 'collaborative_coding'), {
    agent_ms: 1000,
    collaboration_ms: 2000,
  });
  assert.ok(config.sessions.coding_agent_timeout_ms! > config.sessions.agent_timeout_ms);
});
test('a coding turn longer than the report limit is not cut off', async () => {
  const { root, config, db } = fixture();
  config.sessions.agent_timeout_ms = 20;
  config.sessions.coding_agent_timeout_ms = 5000;
  config.sessions.max_retries = 0;
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Bridge Test']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(repo, 'index.js'), 'export const value=1;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  const s = new Service(db, config);
  // Outlives the 20 ms report limit, then ends the run with a recognisable error.
  const slow: Adapter = {
    turn: async (i) => {
      await new Promise((r) => setTimeout(r, 80));
      throw Error(i.signal.aborted ? 'aborted early' : 'slow turn finished');
    },
  };
  const e = new Engine(s, { codex: slow, claude: slow });
  const c = s.create({
    goal: 'long coding turn',
    initiator: 'claude',
    mode: 'collaborative_coding',
    repository: repo,
    required_sections: [],
    require_evidence: false,
  }).id;
  await until(() => !e.running.size);
  const first = db.all('runs', c)[0];
  assert.match(first.error, /slow turn finished/);
  assert.equal(s.collab(c).status, 'degraded');
});
test('installed skill states worker limits before the goal is split', () => {
  const md = skillMarkdown('/bin/agent-bridge', 'claude');
  const front = md.split('---')[1].trim().split('\n');
  assert.deepEqual(
    front.map((l) => l.split(':')[0]),
    ['name', 'description'],
  );
  for (const phrase of [
    'cannot read local files or images',
    'read-only sandbox',
    'image generation',
    'binary exports (PNG, GLB)',
    'Queued means the daemon restarted',
    '`/bin/agent-bridge start`',
    '--initiator claude',
  ])
    assert.ok(md.includes(phrase), phrase);
});
test('separate worktrees, merge conflict detection and sandboxed coding test', async () => {
  const { root } = fixture();
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Bridge Test']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(repo, 'index.js'), 'export const value=1;\n');
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(repo, 'value.test.js'),
    "import {test} from 'node:test';import assert from 'node:assert/strict';import {value} from './index.js';test('value',()=>assert.equal(value,1));",
  );
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  const w = new Worktrees(),
    work = w.setup(repo, join(root, 'trees'), 'collab_test');
  assert.notEqual(work.paths.codex, work.paths.claude);
  const result = await runTests(work.paths.codex);
  assert.equal(result.passed, true, JSON.stringify(result));
  writeFileSync(join(work.paths.codex, '.bridge-tmp', 'test-output.txt'), 'temporary output');
  w.write(work, 'codex', 'index.js', 'export const value=2;\n');
  w.write(work, 'claude', 'index.js', 'export const value=3;\n');
  const merged = w.integrate(work);
  assert.equal(merged.ok, false);
  assert.deepEqual(merged.conflicts, ['index.js']);
  assert.equal(git(work.paths.codex, ['ls-files', '.bridge-tmp']), '');
  assert.equal(readFileSync(join(repo, 'index.js'), 'utf8'), 'export const value=1;\n');
});
