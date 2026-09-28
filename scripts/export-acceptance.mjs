// Export only allowlisted acceptance scenarios; never dump runtime logs or auth state.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../dist/database/sqlite.js';
import { git } from '../dist/tasks/worktrees.js';
import { loadConfig } from '../dist/config.js';
import { Service } from '../dist/service.js';
import { qualityGate } from '../dist/consensus/quality-gate.js';
const config = loadConfig(),
  db = new Store(config.db),
  service = new Service(db, config);
const runs = JSON.parse(readFileSync(process.argv[2] || 'logs/acceptance-runs.json', 'utf8'));
const digest = (v) => createHash('sha256').update(v).digest('hex');
const clean = (v) =>
  JSON.parse(
    JSON.stringify(v)
      .replaceAll(config.root, '<PROJECT>')
      .replaceAll(config.state, '<LOCAL_STATE>')
      .replace(/\/Users\/[^/\s"\\]+/g, '<HOME>'),
  );
mkdirSync('docs/acceptance', { recursive: true });
const summary = [];
for (const [label, id] of runs) {
  const c = db.get('collaborations', id);
  if (c.status !== 'completed')
    throw Error(`${label} is ${c.status}; do not publish incomplete acceptance as success`);
  const a = db.get('artifacts', `${id}/draft.md`),
    sessions = db.all('sessions', id),
    messages = db.all('messages', id),
    versions = db.all('artifact_versions', id).filter((v) => v.name === 'draft.md'),
    reviews = db.all('reviews', id);
  const gate = qualityGate(db, service.artifacts, service.bus, id);
  if (
    !gate.ready ||
    c.final_sha256 !== a.sha256 ||
    digest(readFileSync(join(config.artifactsRoot, id, 'final.md'), 'utf8')) !== a.sha256
  )
    throw Error(`${label}: final artifact or current quality gate failed validation`);
  const eventTrace = db
    .events(id)
    .filter((e) =>
      [
        'peer.message',
        'artifact.updated',
        'review.submitted',
        'agent.started',
        'agent.completed',
        'agent.failed',
        'collaboration.completed',
        'disagreement.created',
        'disagreement.updated',
        'code.integration_test',
      ].includes(e.type),
    )
    .map((e) => {
      let data = e.data;
      if (e.type === 'peer.message')
        data = {
          message_id: data.message_id,
          from: data.from,
          to: data.to,
          type: data.type,
          reply_to: data.reply_to,
          requires_reply: data.requires_reply,
          content_sha256: digest(data.content),
          content_preview: data.content
            .replace(/[“「"][^”」"]*[”」"]/g, '[quoted passage omitted]')
            .slice(0, 120),
          evidence_refs: data.evidence_refs,
        };
      if (e.type === 'agent.started')
        data = { ...data, session_id: data.session_id ? digest(data.session_id) : null };
      if (e.type === 'agent.completed')
        data = {
          agent: data.agent,
          run_id: data.run_id,
          summary: data.result?.summary?.slice(0, 200),
        };
      if (e.type === 'code.integration_test')
        data = {
          passed: data.passed,
          exit_code: data.exit_code,
          command: data.command,
          stdout: data.stdout,
        };
      return clean({ sequence: e.seq, type: e.type, at: e.created_at, data });
    });
  const result = clean({
    label,
    collaboration_id: id,
    status: c.status,
    initiator: c.initiator,
    final_version: c.final_version,
    final_sha256: c.final_sha256,
    public_copy_sha256: digest(clean(a.content)),
    session_fingerprints: sessions.map((s) => ({ agent: s.agent, sha256: digest(s.session_id) })),
    session_reuse: sessions.map((s) => ({
      agent: s.agent,
      distinct_resumed_ids: new Set(
        db
          .events(id)
          .filter(
            (e) => e.type === 'agent.started' && e.data.agent === s.agent && e.data.session_id,
          )
          .map((e) => e.data.session_id),
      ).size,
    })),
    models: [
      ...new Set(
        db
          .events(id)
          .flatMap((e) =>
            e.type === 'runtime.codex.session.config'
              ? [e.data.model]
              : e.type === 'runtime.claude.system' && e.data.subtype === 'init'
                ? [e.data.model]
                : [],
          ),
      ),
    ],
    total_agent_runs: db.all('runs', id).length,
    messages: messages.length,
    directions: {
      codex_to_claude: messages.filter((m) => m.from === 'codex').length,
      claude_to_codex: messages.filter((m) => m.from === 'claude').length,
    },
    draft_authors: [...new Set(versions.map((v) => v.author))],
    draft_versions: versions.length,
    review_verdicts: reviews.map((r) => ({
      agent: r.agent,
      version: r.artifact_version,
      verdict: r.verdict,
      artifact_sha256: r.artifact_sha256,
      code_sha256: r.code_sha256 || null,
    })),
    evidence: db.all('evidence', id).map((e) => ({
      id: e.id,
      source: e.source,
      retrieved_by: e.retrieved_by,
      verified_by: e.verified_by,
    })),
    disagreements: db
      .all('disagreements', id)
      .map((d) => ({ id: d.id, status: d.status, topic: d.topic })),
    code_test: c.code_test
      ? { passed: c.code_test.passed, exit_code: c.code_test.exit_code }
      : null,
    integrated_sha: c.integrated_sha || null,
  });
  writeFileSync(
    join('docs/acceptance', label + '-summary.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  writeFileSync(
    join('docs/acceptance', label + '-trace.json'),
    JSON.stringify(eventTrace, null, 2) + '\n',
  );
  writeFileSync(join('docs/acceptance', label + '-final.md'), clean(a.content));
  if (c.mode === 'collaborative_coding')
    writeFileSync(
      join('docs/acceptance', label + '.diff'),
      git(c.work.paths.integration, ['diff', c.work.base, c.integrated_sha]) + '\n',
    );
  summary.push(result);
}
writeFileSync('docs/acceptance/summary.json', JSON.stringify(summary, null, 2) + '\n');
db.close();
console.log(
  summary.map((x) => ({ label: x.label, version: x.final_version, messages: x.messages })),
);
