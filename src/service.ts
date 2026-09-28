import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, id, now, hash } from './database/sqlite.js';
import type { Config } from './config.js';
import { Artifacts } from './artifacts/manager.js';
import { Bus } from './messaging/bus.js';
import { Agent, Verdict, type Context } from './messaging/protocol.js';
import { qualityGate } from './consensus/quality-gate.js';
import { schemas } from './tools.js';
import { z } from 'zod';
import { Worktrees, git, assertIntegratedSnapshot } from './tasks/worktrees.js';
import { runTests, type TestProcessRegistry, type TestRunOutcome } from './tasks/test-runner.js';
import { workspacePath } from './policy/permissions.js';
// Test children are detached, so their identity is kept in its own record kind: mixing them
// into agent runs would corrupt the retry and fallback decisions that read the last run.
export class TestRuns implements TestProcessRegistry {
  constructor(
    private db: Store,
    private collaboration_id: string,
  ) {}
  started(info: { pid: number; identity: string | null; command: string[]; cwd: string }) {
    const v = {
      id: id('testrun'),
      collaboration_id: this.collaboration_id,
      pid: info.pid,
      process_identity: info.identity,
      command: info.command,
      cwd: info.cwd,
      status: 'running',
      started_at: now(),
      ended_at: null,
      exit_code: null,
      signal: null,
      error: null,
    };
    this.db.put('test_runs', v);
    return v.id;
  }
  finished(
    handle: string,
    status: TestRunOutcome,
    detail: { exit_code: number | null; signal: string | null; error?: string },
  ) {
    const v = this.db.get('test_runs', handle);
    if (!v) return;
    this.db.put('test_runs', {
      ...v,
      status,
      exit_code: detail.exit_code,
      signal: detail.signal,
      error: detail.error ?? null,
      ended_at: now(),
    });
  }
}
export class Service {
  runSignals = new Map<string, AbortSignal>();
  artifacts: Artifacts;
  bus: Bus;
  worktrees = new Worktrees();
  wake: (id: string) => void = () => {};
  interrupt: (id: string) => void = () => {};
  constructor(
    public db: Store,
    public config: Config,
  ) {
    this.artifacts = new Artifacts(db, config);
    this.bus = new Bus(db, config.collaboration.max_duplicate_messages);
  }
  collab(c: string) {
    const r = this.db.get('collaborations', c);
    if (!r) throw Error('Unknown collaboration');
    return r;
  }
  create(x: any) {
    const taskHash = hash(
      JSON.stringify({
        goal: x.goal.trim().normalize('NFKC'),
        mode: x.mode,
        initiator: x.initiator,
        repository: x.repository || null,
        required_sections: x.required_sections,
        require_evidence: x.require_evidence,
        test_command: x.test_command || ['node', '--test'],
      }),
    );
    const existing = this.db
      .all('collaborations')
      .find((c) => c.task_hash === taskHash && ['queued', 'running'].includes(c.status));
    if (existing) return this.status(existing.id);
    const c = id('collab');
    const v = {
      id: c,
      collaboration_id: c,
      goal: x.goal,
      task_hash: taskHash,
      mode: x.mode,
      initiator: x.initiator,
      synthesizer: x.initiator,
      required_sections: x.required_sections,
      require_evidence: x.require_evidence,
      status: 'queued',
      phase: 'scope',
      phase_step: 0,
      turns: 0,
      discussion_round: 0,
      revision_round: 0,
      no_progress: 0,
      created_at: now(),
      updated_at: now(),
      last_error: null,
      test_command: x.test_command || ['node', '--test'],
    };
    let work = null;
    if (x.mode === 'collaborative_coding') {
      if (!x.repository) throw Error('repository is required');
      work = this.worktrees.setup(x.repository, join(this.config.state, 'worktrees'), c);
    }
    this.db.put('collaborations', { ...v, work });
    for (const a of ['codex', 'claude'])
      this.db.put('agents', {
        id: `${c}/${a}`,
        collaboration_id: c,
        agent: a,
        role: a === x.initiator ? 'SYNTHESIZER' : 'CHALLENGER',
      });
    for (const d of ['source', 'notes', 'evidence'])
      mkdirSync(join(this.config.artifactsRoot, c, d), { recursive: true });
    this.db.event(c, 'collaboration.created', v);
    this.snapshot(c);
    this.wake(c);
    return this.status(c);
  }
  snapshot(c: string) {
    for (const [kind, name] of [
      ['disagreements', 'disagreements.json'],
      ['decisions', 'decisions.json'],
      ['evidence', 'evidence/index.json'],
    ] as const)
      this.artifacts.export(c, name, JSON.stringify(this.db.all(kind, c), null, 2));
    this.artifacts.export(c, 'metadata.json', JSON.stringify(this.collab(c), null, 2));
  }
  status(c: string) {
    const v = this.collab(c);
    return {
      ...v,
      sessions: this.db.all('sessions', c),
      quality_gate: qualityGate(this.db, this.artifacts, this.bus, c),
      artifact: this.artifacts.read(c)
        ? { version: this.artifacts.read(c).version, path: this.artifacts.path(c, 'draft.md') }
        : null,
      pending_messages: this.bus.pending(c),
      final_path: v.status === 'completed' ? this.artifacts.path(c, 'final.md') : null,
    };
  }
  async call(name: string, input: any, ctx: Context): Promise<any> {
    if (!schemas[name]) throw Error('Unknown tool');
    const x = z.object(schemas[name]!).parse(input) as any;
    if (name === 'collaboration_start') {
      if (ctx.actor !== 'user') throw Error('Nested collaboration is forbidden');
      return this.create(x);
    }
    const c = ctx.collaboration_id;
    if (!c) throw Error('collaboration_id required');
    let collab = this.collab(c);
    if (name === 'collaboration_status') {
      if (ctx.actor !== 'user' && collab.phase === 'analysis')
        return {
          id: c,
          phase: collab.phase,
          status: collab.status,
          goal: collab.goal,
          required_sections: collab.required_sections,
        };
      return this.status(c);
    }
    if (
      ctx.actor !== 'user' &&
      collab.phase === 'analysis' &&
      ['artifact_read', 'artifact_history', 'artifact_diff'].includes(name) &&
      x.name.startsWith('notes/') &&
      x.name !== `notes/${ctx.actor}.md`
    )
      throw Error('Independent analysis: peer notes unlock in discussion');
    const readOnly = /(_read|_list|_history|_diff|_status)$/.test(name) || name === 'session_list';
    if (ctx.actor !== 'user' && !readOnly) {
      const run = ctx.run_id && this.db.get('runs', ctx.run_id);
      if (!run || run.status !== 'running' || run.agent !== ctx.actor || run.collaboration_id !== c)
        throw Error('Agent capability expired');
    }
    if (['completed', 'cancelled'].includes(collab.status) && !readOnly)
      throw Error('Collaboration is terminal');
    if (name === 'collaboration_cancel') {
      if (ctx.actor !== 'user') throw Error('User control only');
      this.db.put('collaborations', { ...collab, status: 'cancelled', updated_at: now() });
      this.interrupt(c);
      this.db.event(c, 'collaboration.cancelled', {});
      return this.status(c);
    }
    if (name === 'collaboration_continue') {
      if (ctx.actor !== 'user') throw Error('User control only');
      if (['running', 'queued'].includes(collab.status)) return this.status(c);
      this.db.put('collaborations', {
        ...collab,
        status: 'queued',
        turns: 0,
        created_at: now(),
        last_error: null,
      });
      this.wake(c);
      return this.status(c);
    }
    if (name === 'session_reset') {
      if (ctx.actor !== 'user' || collab.status === 'running')
        throw Error('Reset only when not running, by user');
      const sid = `${c}/${x.agent}`;
      this.db.put('sessions', { id: sid, collaboration_id: c, agent: x.agent, session_id: null });
      this.db.event(c, 'session.reset', { agent: x.agent });
      return { reset: true };
    }
    if (name === 'session_list') return this.db.all('sessions', c);
    if (name === 'messages_list') {
      if (ctx.actor !== 'user' && collab.phase === 'analysis')
        throw Error('Independent analysis: messages unlock in discussion');
      return this.db.all('messages', c);
    }
    if (name === 'review_status') return this.db.all('reviews', c);
    if (name === 'evidence_list')
      return this.db
        .all('evidence', c)
        .filter(
          (e) =>
            ctx.actor === 'user' || collab.phase !== 'analysis' || e.retrieved_by === ctx.actor,
        );
    if (name === 'disagreement_list') return this.db.all('disagreements', c);
    if (name === 'task_status')
      return x.id ? this.owned('tasks', x.id, c) : this.db.all('tasks', c);
    if (name === 'artifact_read') {
      if (
        ctx.actor !== 'user' &&
        collab.phase === 'analysis' &&
        x.name.startsWith('notes/') &&
        x.name !== `notes/${ctx.actor}.md`
      )
        throw Error('Independent analysis: peer notes unlock in discussion');
      return this.artifacts.read(c, x.name) || { exists: false, version: 0 };
    }
    if (name === 'artifact_history') return this.artifacts.history(c, x.name);
    if (name === 'artifact_diff') {
      const h = this.artifacts.history(c, x.name);
      return h
        .filter((v) => v.version > x.from && v.version <= x.to)
        .map((v) => ({ version: v.version, diff: v.diff }));
    }
    const actor = Agent.parse(ctx.actor);
    if (name === 'role_assign') {
      if (!['scope', 'analysis', 'discussion'].includes(collab.phase))
        throw Error('Assign roles before drafting');
      this.db.put('collaborations', { ...collab, synthesizer: x.synthesizer });
      for (const a of ['codex', 'claude'])
        this.db.put('agents', {
          id: `${c}/${a}`,
          collaboration_id: c,
          agent: a,
          role: a === x.synthesizer ? 'SYNTHESIZER' : 'CHALLENGER',
        });
      const d = {
        id: id('decision'),
        collaboration_id: c,
        author: actor,
        decision: `Synthesizer: ${x.synthesizer}`,
        reason: x.reason,
        created_at: now(),
      };
      this.db.put('decisions', d);
      this.snapshot(c);
      return d;
    }
    if (name === 'scope_set') {
      if (collab.phase !== 'scope') throw Error('Define scope only during scope phase');
      const sections = [...new Set([...collab.required_sections, ...x.required_sections])];
      this.db.put('collaborations', { ...collab, required_sections: sections });
      this.db.event(c, 'scope.updated', {
        agent: actor,
        required_sections: sections,
        reason: x.reason,
      });
      return { required_sections: sections };
    }
    if (['review_submit', 'peer_submit_review'].includes(name)) {
      const v = Verdict.parse(x),
        a = this.artifacts.read(c);
      if (!a || v.artifact_version !== a.version) throw Error('STALE_REVIEW');
      if (collab.mode === 'collaborative_coding' && v.verdict === 'APPROVE') {
        if (!collab.code_integrated) throw Error('Code candidate is not validated');
        assertIntegratedSnapshot(collab.work, collab.integrated_sha);
      }
      const r = {
        ...v,
        id: id('review'),
        collaboration_id: c,
        agent: actor,
        artifact_sha256: a.sha256,
        code_sha256: collab.integrated_sha || null,
        created_at: now(),
      };
      this.db.put('reviews', r);
      this.db.event(c, 'review.submitted', r);
      return r;
    }
    const pm: Record<string, [string, boolean]> = {
      peer_ask: ['question', true],
      peer_reply: ['answer', false],
      peer_challenge: ['challenge', true],
      peer_request_evidence: ['question', true],
      peer_propose_change: ['proposal', true],
      peer_accept_change: ['agreement', false],
      peer_reject_change: ['disagreement', false],
      peer_request_review: ['revision_request', true],
    };
    if (name === 'peer_send' || pm[name])
      return this.bus.send(
        c,
        actor,
        name === 'peer_send' ? x : { ...x, type: pm[name]![0], requires_reply: pm[name]![1] },
      );
    if (name === 'artifact_create')
      return this.artifacts.write(c, x.name, x.content, 0, actor, 'Initial shared artifact');
    if (name === 'artifact_patch')
      return this.artifacts.patch(
        c,
        x.name,
        x.base_version,
        x.old_text,
        x.new_text,
        actor,
        x.reason,
      );
    if (name === 'artifact_replace_section')
      return this.artifacts.section(
        c,
        x.name,
        x.base_version,
        x.heading,
        x.content,
        actor,
        x.reason,
      );
    if (name === 'artifact_comment') {
      const v = { ...x, id: id('comment'), collaboration_id: c, author: actor, created_at: now() };
      this.db.put('comments', v);
      this.db.event(c, 'artifact.comment', v);
      return v;
    }
    if (name === 'artifact_lock') return this.artifacts.lock(c, x.name, actor);
    if (name === 'artifact_unlock') return this.artifacts.unlock(c, x.name, actor);
    if (name === 'disagreement_create') {
      const v = {
        ...x,
        id: id('disagreement'),
        collaboration_id: c,
        status: 'open',
        created_by: actor,
        created_at: now(),
        history: [],
      };
      this.db.put('disagreements', v);
      this.db.event(c, 'disagreement.created', v);
      this.snapshot(c);
      return v;
    }
    if (['disagreement_update', 'peer_resolve_disagreement'].includes(name)) {
      const d = this.owned('disagreements', x.id, c);
      if (x.status === 'uncertain' && !x.final_note.trim())
        throw Error('Uncertainty needs final_note to include verbatim in draft');
      const v = {
        ...d,
        status: x.status,
        final_note: x.final_note,
        history: [...d.history, { author: actor, reason: x.reason, status: x.status, at: now() }],
      };
      this.db.put('disagreements', v);
      this.db.event(c, 'disagreement.updated', v);
      this.snapshot(c);
      return v;
    }
    if (name === 'evidence_add') {
      const u = new URL(x.source);
      if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password)
        throw Error('Public HTTP(S) source required');
      const v = {
        ...x,
        id: id('evidence'),
        collaboration_id: c,
        retrieved_by: actor,
        verified_by: null,
        retrieved_at: now(),
      };
      this.db.put('evidence', v);
      this.db.event(c, 'evidence.added', v);
      this.snapshot(c);
      return v;
    }
    if (name === 'evidence_verify') {
      const v = this.owned('evidence', x.id, c);
      if (v.retrieved_by === actor) throw Error('Peer must independently verify');
      const r = { ...v, verified_by: actor, assessment: x.assessment, verified_at: now() };
      this.db.put('evidence', r);
      this.db.event(c, 'evidence.verified', r);
      this.snapshot(c);
      return r;
    }
    if (name === 'decision_record') {
      const v = { ...x, id: id('decision'), collaboration_id: c, author: actor, created_at: now() };
      this.db.put('decisions', v);
      this.db.event(c, 'decision.recorded', v);
      this.snapshot(c);
      return v;
    }
    if (name === 'task_create') {
      for (const dep of x.depends_on) this.owned('tasks', dep, c);
      const v = { ...x, id: id('task'), collaboration_id: c, status: 'pending', created_at: now() };
      this.db.put('tasks', v);
      return v;
    }
    if (name === 'task_update') {
      const t = this.owned('tasks', x.id, c);
      if (t.assigned_to !== actor) throw Error('Task belongs to peer');
      if (
        x.status === 'done' &&
        t.depends_on.some((dep: string) => this.owned('tasks', dep, c).status !== 'done')
      )
        throw Error('Dependencies not completed');
      const v = { ...t, status: x.status, result: x.result };
      this.db.put('tasks', v);
      return v;
    }
    if (name.startsWith('workspace_')) {
      if (!collab.work) throw Error('Coding mode required');
      const w = collab.work;
      if (name === 'workspace_list')
        return {
          files: git(w.paths[actor], ['ls-files']).split('\n'),
          worktrees: w.paths,
          conflicts: collab.conflicts || [],
        };
      if (name === 'workspace_read')
        return ['review', 'integrity', 'conflict'].includes(collab.phase)
          ? readFileSync(workspacePath(w.paths.integration, x.path), 'utf8')
          : this.worktrees.read(w, x.agent || actor, x.path);
      if (name === 'workspace_write') {
        if (['review', 'integrity'].includes(collab.phase))
          throw Error('Review phase is read only; request revision');
        this.db.put('collaborations', { ...collab, code_integrated: false });
        return this.worktrees.write(w, actor, x.path, x.content);
      }
      if (name === 'workspace_diff')
        return git(
          ['review', 'integrity'].includes(collab.phase)
            ? w.paths.integration
            : w.paths[x.agent || actor],
          ['diff', w.base],
        );
      if (name === 'workspace_resolve_conflict') {
        if (!collab.conflicts?.includes(x.path)) throw Error('Not a current merge conflict');
        const p = workspacePath(w.paths.integration, x.path);
        writeFileSync(p, x.content);
        git(w.paths.integration, ['add', '--', x.path]);
        const remaining = git(w.paths.integration, ['diff', '--name-only', '--diff-filter=U'])
          .split('\n')
          .filter(Boolean);
        if (!remaining.length) git(w.paths.integration, ['commit', '--no-edit']);
        this.db.put('collaborations', { ...collab, conflicts: remaining });
        return { remaining };
      }
      if (name === 'workspace_test') {
        const r = await runTests(
          ['review', 'integrity'].includes(collab.phase) ? w.paths.integration : w.paths[actor],
          collab.test_command,
          ctx.run_id ? this.runSignals.get(ctx.run_id) : undefined,
          new TestRuns(this.db, c),
        );
        this.db.event(c, 'code.test', { agent: actor, ...r });
        return r;
      }
    }
    throw Error('Unsupported tool');
  }
  owned(kind: string, id: string, c: string) {
    const v = this.db.get(kind, id);
    if (!v || v.collaboration_id !== c) throw Error(`Unknown ${kind} in this collaboration`);
    return v;
  }
}
