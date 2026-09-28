import { assertIntegratedSnapshot } from './tasks/worktrees.js';
import { recoverOrphan } from './adapters/process.js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Service, TestRuns } from './service.js';
import { id, now, hash } from './database/sqlite.js';
import { peer, type Agent } from './messaging/protocol.js';
import { runTests } from './tasks/test-runner.js';
import { qualityGate } from './consensus/quality-gate.js';
import { CodexAdapter } from './adapters/codex.js';
import { ClaudeAdapter } from './adapters/claude.js';
import type { Adapter } from './adapters/types.js';
export class Engine {
  stopping = false;
  running = new Map<string, AbortController>();
  capabilities = new Map<string, { actor: Agent; collaboration_id: string; run_id: string }>();
  adapters: Record<Agent, Adapter>;
  constructor(
    public service: Service,
    adapters?: Record<Agent, Adapter>,
  ) {
    this.adapters = adapters || {
      codex: new CodexAdapter(service),
      claude: new ClaudeAdapter(service.config),
    };
    service.wake = (c) => this.start(c);
    service.interrupt = (c) => this.running.get(c)?.abort();
  }
  recover() {
    for (const r of this.service.db.all('runs'))
      if (r.status === 'running') {
        if (r.pid && r.process_identity) recoverOrphan(r.pid, r.process_identity);
        this.service.db.put('runs', { ...r, status: 'interrupted', ended_at: now() });
      }
    // Detached test children survive a killed Bridge; recoverOrphan only signals a process
    // group whose birth identity still matches, so a recycled PID is left alone.
    for (const t of this.service.db.all('test_runs'))
      if (t.status === 'running') {
        if (t.pid && t.process_identity) recoverOrphan(t.pid, t.process_identity);
        this.service.db.put('test_runs', { ...t, status: 'interrupted', ended_at: now() });
      }
    for (const a of this.service.db.all('artifacts'))
      this.service.artifacts.export(a.collaboration_id, a.name, a.content);
    for (const c of this.service.db.all('collaborations'))
      if (['running', 'queued'].includes(c.status)) this.start(c.id);
  }
  start(c: string) {
    if (this.running.has(c)) return;
    const abort = new AbortController();
    this.running.set(c, abort);
    this.run(c, abort.signal)
      .catch(async (e) => {
        let v = this.service.collab(c);
        if (v.status === 'cancelled') return;
        if (this.stopping) {
          this.update(c, { status: 'queued' });
          return;
        }
        const failed = this.service.db.all('runs', c).at(-1);
        if (
          failed?.status === 'failed' &&
          v.turns < this.service.config.collaboration.max_total_agent_turns
        ) {
          this.update(c, { peer_unavailable: failed.agent });
          try {
            await this.turn(
              c,
              peer(failed.agent),
              'Peer is unavailable after retries. Preserve what is defensible in shared draft.md, include explicit missing review/evidence limitations, and finish any safe independent work. Do not invent peer approval or claim collaboration completed.',
              abort.signal,
            );
          } catch (fallback) {
            this.service.db.event(c, 'fallback.failed', { error: String(fallback) });
          }
        }
        this.degraded(c, String(e));
        this.service.db.event(c, 'collaboration.error', { error: String(e) });
      })
      .finally(() => this.running.delete(c));
  }
  update(c: string, patch: any) {
    const v = { ...this.service.collab(c), ...patch, updated_at: now() };
    this.service.db.put('collaborations', v);
    this.service.snapshot(c);
    return v;
  }
  prompt(c: string, agent: Agent, instruction: string) {
    const s = this.service,
      v = s.collab(c);
    const protocol = readFileSync(
      join(s.config.root, 'collaboration', 'COLLABORATION_PROTOCOL.md'),
      'utf8',
    );
    const analysisHidden = v.phase === 'analysis';
    return `${protocol}\nYou are ${agent}. Peer is ${peer(agent)}. Collaboration ${c}. Goal: ${v.goal}\nMode ${v.mode}. Current role ${agent === v.synthesizer ? 'SYNTHESIZER' : 'CHALLENGER'}.\nCURRENT TURN: ${instruction}\nRequired sections: ${JSON.stringify(v.required_sections)}. External evidence required: ${v.require_evidence}.\n${analysisHidden ? 'Independent analysis: do not read peer messages or peer notes until exchange phase.' : `Peer history: ${JSON.stringify(s.db.all('messages', c).slice(-30))}\nPending replies addressed to you: ${JSON.stringify(s.bus.pending(c, agent))}\nDisagreements: ${JSON.stringify(s.db.all('disagreements', c))}\nReviews: ${JSON.stringify(s.db.all('reviews', c).slice(-4))}\nEvidence: ${JSON.stringify(s.db.all('evidence', c))}\nTasks: ${JSON.stringify(s.db.all('tasks', c))}\nQuality gate: ${JSON.stringify(qualityGate(s.db, s.artifacts, s.bus, c))}`}\nRecent runtime recovery note: ${v.last_error || 'none'}.\nUse Bridge tools for all messages, edits and reviews. Tool caller identity is enforced. Do not call collaboration_start or spawn other agents. Finish this turn with the required JSON summary and ready_for_next_phase. This field never replaces review_submit. Communicate substantive findings using peer tools; no need to narrate to the user. Tools have implicit collaboration id; do not invent additional arguments.`;
  }
  progress(c: string) {
    const s = this.service;
    return hash(
      JSON.stringify({
        a: s.artifacts.read(c)?.sha256,
        e: s.db.all('evidence', c),
        d: s.db.all('decisions', c),
        dis: s.db.all('disagreements', c),
        questions: s.bus.pending(c).map((m) => m.message_id),
      }),
    );
  }
  async turn(c: string, agent: Agent, instruction: string, signal: AbortSignal) {
    const s = this.service;
    for (let retry = 0; retry <= s.config.sessions.max_retries; retry++) {
      const v = s.collab(c);
      if (signal.aborted || v.status === 'cancelled') throw Error('Cancelled');
      if (v.turns >= s.config.collaboration.max_total_agent_turns)
        throw Error('Agent turn budget exhausted');
      const runId = id('run'),
        token = randomBytes(32).toString('hex'),
        controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, s.config.sessions.agent_timeout_ms);
      s.db.put('runs', {
        id: runId,
        collaboration_id: c,
        agent,
        phase: v.phase,
        status: 'running',
        retry,
        started_at: now(),
      });
      s.runSignals.set(runId, controller.signal);
      this.capabilities.set(token, { actor: agent, collaboration_id: c, run_id: runId });
      this.update(c, { turns: v.turns + 1 });
      const before = this.progress(c);
      const session = s.db.get('sessions', `${c}/${agent}`);
      s.db.event(c, 'agent.started', {
        agent,
        run_id: runId,
        phase: v.phase,
        session_id: session?.session_id || null,
        retry,
      });
      try {
        const result = await this.adapters[agent].turn({
          collaboration_id: c,
          run_id: runId,
          agent,
          session_id: session?.session_id,
          cwd: s.config.root,
          prompt: this.prompt(c, agent, instruction),
          signal: controller.signal,
          token,
          onSession: (sid) => {
            s.db.put('sessions', {
              id: `${c}/${agent}`,
              collaboration_id: c,
              agent,
              session_id: sid,
              updated_at: now(),
            });
          },
          onEvent: (type, data) => {
            if (type === 'process.started')
              s.db.put('runs', {
                ...s.db.get('runs', runId),
                id: runId,
                pid: data.pid,
                process_identity: data.identity,
              });
            if (agent === 'claude' && data.message?.content)
              data = {
                ...data,
                message: {
                  ...data.message,
                  content: data.message.content.filter((b: any) =>
                    ['text', 'tool_use'].includes(b.type),
                  ),
                },
              };
            s.db.event(c, `runtime.${agent}.${type}`, { run_id: runId, ...data });
          },
        });
        if (controller.signal.aborted) throw Error('Turn timed out or cancelled');
        s.db.put('runs', {
          ...s.db.get('runs', runId),
          id: runId,
          status: 'completed',
          result,
          ended_at: now(),
        });
        s.db.event(c, 'agent.completed', { agent, run_id: runId, result });
        this.update(c, {
          last_error: null,
          no_progress: before === this.progress(c) ? s.collab(c).no_progress + 1 : 0,
        });
        return result;
      } catch (e) {
        s.db.put('runs', {
          ...s.db.get('runs', runId),
          id: runId,
          status: signal.aborted ? 'cancelled' : 'failed',
          error: String(e),
          ended_at: now(),
        });
        s.db.event(c, 'agent.failed', { agent, retry, error: String(e) });
        this.update(c, { last_error: String(e) });
        if (signal.aborted || retry === s.config.sessions.max_retries) throw e;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.capabilities.delete(token);
        s.runSignals.delete(runId);
      }
    }
    throw Error('Unreachable');
  }
  async run(c: string, signal: AbortSignal) {
    const s = this.service;
    this.update(c, { status: 'running' });
    while (!signal.aborted) {
      let v = s.collab(c);
      if (Date.now() - Date.parse(v.created_at) > s.config.sessions.collaboration_timeout_ms)
        throw Error('Collaboration timeout');
      const synth = v.synthesizer as Agent,
        challenger = peer(synth);
      const pairLead = ['scope', 'analysis', 'discussion'].includes(v.phase) ? v.initiator : synth;
      const actor = (v.phase_step === 0 ? pairLead : peer(pairLead)) as Agent;
      if (v.turns >= s.config.collaboration.max_total_agent_turns) {
        this.degraded(c, 'Turn budget reached');
        return;
      }
      if (v.phase === 'scope') {
        await this.turn(
          c,
          actor,
          'Understand scope and quality criteria. Propose a compact plan to peer using peer_send; use scope_set to register meaningful required headings and role_assign only if changing the synthesizer improves the task; counterparty may amend. Do not write the report yet. Do not create administrative tasks unless necessary.',
          signal,
        );
        this.advancePair(c, 'analysis');
      } else if (v.phase === 'analysis') {
        const completed: Agent[] = v.analysis_done || (v.phase_step === 1 ? [v.initiator] : []);
        const results = await Promise.allSettled(
          ([v.initiator, peer(v.initiator)] as Agent[])
            .filter((agent) => !completed.includes(agent))
            .map(async (agent) => {
              await this.turn(
                c,
                agent,
                `Independently research the goal. Browse official/primary external sources where evidence is required, record evidence_add with genuine excerpts. Create or update your own notes artifact notes/${agent}.md. Send concise findings, uncertainties and a substantive question/challenge to peer. Do not inspect peer analysis in this phase.`,
                signal,
              );
              this.update(c, {
                analysis_done: [...new Set([...(s.collab(c).analysis_done || completed), agent])],
              });
            }),
        );
        const failed = results.find((r) => r.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        this.update(c, { phase: 'discussion', phase_step: 0 });
      } else if (v.phase === 'discussion') {
        const result = await this.turn(
          c,
          actor,
          'Exchange findings, answer EVERY pending peer question addressed to you using peer_reply. Inspect peer sources independently and evidence_verify. Register substantive disagreements in ledger; exchange reasons then evidence then reassess. Resolve with reasons or mark uncertain with exact final_note. Do not invent disagreement for theatre. Stop sending questions once no new information is needed. You may directly improve shared draft if it exists.',
          signal,
        );
        v = s.collab(c);
        if (v.phase_step === 0) this.update(c, { phase_step: 1 });
        else {
          const rounds = v.discussion_round + 1;
          const open = s.db.all('disagreements', c).filter((d) => d.status === 'open');
          const done =
            rounds >= 2 && result.ready_for_next_phase && !s.bus.pending(c).length && !open.length;
          const limit =
            rounds >= s.config.collaboration.max_discussion_rounds || v.no_progress >= 4;
          this.update(c, {
            phase: done || limit ? 'draft' : 'discussion',
            phase_step: 0,
            discussion_round: rounds,
          });
        }
      } else if (v.phase === 'draft') {
        await this.turn(
          c,
          actor,
          v.phase_step === 0
            ? 'Read all findings and write the single shared draft.md (artifact_create if missing, patch otherwise). Include reasoned recommendations, alternatives, limits, primary source links and uncertainty notes. Resolve open disagreements truthfully; answer pending peer requests. For coding mode implement changes in your own worktree and explain them in draft.md.'
            : 'Read latest shared draft and peer analysis. Directly improve that SAME draft with artifact_patch or artifact_replace_section. Verify peer citations. Address omissions, questionable claims and unresolved uncertainty. For coding mode inspect and modify your separate worktree. Reply to pending peer requests.',
          signal,
        );
        this.advancePair(c, 'synthesis');
      } else if (v.phase === 'synthesis') {
        await this.turn(
          c,
          synth,
          "Synthesize current shared draft into final candidate. Incorporate both agents' contributions, uncertainties and real source links. Resolve all pending questions addressed to you. Do not create final.md. Announce final_candidate using peer_send. Close completed tasks. In coding mode finish implementation and prepare for integration.",
          signal,
        );
        if (v.mode === 'collaborative_coding') {
          const integration = s.worktrees.integrate(v.work);
          if (!integration.ok) {
            this.update(c, { conflicts: integration.conflicts, phase: 'conflict', phase_step: 0 });
            continue;
          }
          const test =
            v.integrated_sha === integration.sha && v.code_test?.passed
              ? { ...v.code_test, reused: true }
              : await runTests(integration.path, v.test_command, signal, new TestRuns(s.db, c));
          try {
            assertIntegratedSnapshot(v.work, integration.sha!);
          } catch (e) {
            test.passed = false;
            test.error = String(e);
          }
          s.db.event(c, 'code.integration_test', test);
          this.update(c, {
            code_integrated: test.passed,
            integrated_sha: integration.sha,
            code_test: test,
          });
        }
        this.update(c, { phase: 'review', phase_step: 0 });
      } else if (v.phase === 'conflict') {
        await this.turn(
          c,
          synth,
          'Resolve listed merge conflicts in the integration worktree via workspace_resolve_conflict. Inspect peer changes first; preserve both intended behaviors.',
          signal,
        );
        if (!s.collab(c).conflicts?.length) this.update(c, { phase: 'synthesis' });
      } else if (v.phase === 'review' || v.phase === 'integrity') {
        await this.turn(
          c,
          actor,
          'Read CURRENT draft.md and review that exact artifact version. Answer all pending peer requests addressed to you. Verify required sections, sources, uncertainty and task completion. Do NOT edit during review. Call review_submit with APPROVE only if no blocking issues; otherwise REVISE with specific changes. Honest approval only, never approve to satisfy orchestration.',
          signal,
        );
        if (v.phase_step === 0) this.update(c, { phase_step: 1 });
        else {
          const gate = qualityGate(s.db, s.artifacts, s.bus, c);
          if (gate.ready) {
            this.finalize(c);
            return;
          }
          v = s.collab(c);
          if (v.phase === 'integrity') {
            this.degraded(
              c,
              'Final integrity review did not meet dual gate: ' + gate.issues.join('; '),
            );
            return;
          }
          this.update(c, {
            phase:
              v.revision_round >= s.config.collaboration.max_revision_rounds
                ? 'best_effort'
                : 'revision',
            phase_step: 0,
            revision_round: v.revision_round + 1,
          });
        }
      } else if (v.phase === 'revision') {
        await this.turn(
          c,
          actor,
          'Read latest reviews and quality gate. Fix every blocking issue in SAME draft with versioned patches. Respond to pending requests; verify missing evidence; include uncertain final_notes verbatim. Close finished tasks. If peer review is mistaken, give evidence and improve clarity. Do not submit review until next review phase.',
          signal,
        );
        this.advancePair(c, v.mode === 'collaborative_coding' ? 'synthesis' : 'review');
      } else if (v.phase === 'best_effort') {
        await this.turn(
          c,
          synth,
          'Discussion/revision limit reached. Produce best defensible shared draft: retain confirmed findings and explicitly preserve unresolved uncertainty. Resolve ledger items to uncertain where appropriate with exact final_note in draft. Answer pending requests without pretending certainty. No forced consensus.',
          signal,
        );
        this.update(c, { phase: 'integrity', phase_step: 0 });
      } else throw Error('Unknown phase ' + v.phase);
    }
  }
  advancePair(c: string, next: string) {
    const v = this.service.collab(c);
    this.update(c, v.phase_step === 0 ? { phase_step: 1 } : { phase: next, phase_step: 0 });
  }
  finalize(c: string) {
    const s = this.service;
    const gate = qualityGate(s.db, s.artifacts, s.bus, c);
    if (!gate.ready) throw Error('Convergence gate failed');
    const collab = s.collab(c);
    if (collab.mode === 'collaborative_coding')
      assertIntegratedSnapshot(collab.work, collab.integrated_sha);
    const a = s.artifacts.read(c);
    s.artifacts.export(c, 'final.md', a.content);
    this.update(c, {
      status: 'completed',
      phase: 'complete',
      final_version: a.version,
      final_sha256: a.sha256,
      completed_at: now(),
    });
    s.db.event(c, 'collaboration.completed', { version: a.version, sha256: a.sha256 });
  }
  degraded(c: string, reason: string) {
    const s = this.service,
      a = s.artifacts.read(c);
    if (a) s.artifacts.export(c, 'best-effort.md', a.content);
    this.update(c, { status: 'degraded', last_error: reason });
    s.db.event(c, 'collaboration.degraded', { reason });
  }
}
