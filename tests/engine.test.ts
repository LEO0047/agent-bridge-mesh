import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, projectRoot } from '../src/config.js';
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
  revised = false;
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
      const revise = !this.revised && i.agent === 'claude';
      if (revise) this.revised = true;
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
          content: 'Corrected content with caveat. '.repeat(12),
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
