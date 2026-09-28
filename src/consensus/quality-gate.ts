import { Store } from '../database/sqlite.js';
import { Artifacts } from '../artifacts/manager.js';
import { Bus } from '../messaging/bus.js';
export function qualityGate(db: Store, artifacts: Artifacts, bus: Bus, c: string) {
  const collab = db.get('collaborations', c),
    a = artifacts.read(c);
  const issues: string[] = [];
  if (!a || a.content.trim().length < 100) issues.push('No substantive shared draft');
  if (a) {
    if (/【[^】]*(待補|待填)[^】]*】/.test(a.content))
      issues.push('Unfinished drafting placeholders remain');
    const headings = [...a.content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m: any) => m[1]);
    for (const section of collab.required_sections)
      if (!headings.some((h: string) => h.includes(section.replace(/^#+\s*/, ''))))
        issues.push(`Missing section heading: ${section}`);
    for (const agent of ['codex', 'claude']) {
      const r = db
        .all('reviews', c)
        .filter(
          (r) =>
            r.agent === agent &&
            r.artifact_version === a.version &&
            r.artifact_sha256 === a.sha256 &&
            (collab.mode !== 'collaborative_coding' || r.code_sha256 === collab.integrated_sha),
        )
        .at(-1);
      if (!r || r.verdict !== 'APPROVE' || r.blocking_issues.length)
        issues.push(`${agent} has not approved version ${a.version}`);
    }
    const evidence = db.all('evidence', c);
    if (
      collab.require_evidence &&
      new Set(
        evidence
          .filter(
            (e) =>
              e.verified_by && e.verified_by !== e.retrieved_by && a.content.includes(e.source),
          )
          .map((e) => e.source.split('#')[0]),
      ).size < 2
    )
      issues.push('Need at least two independently verified sources cited in draft');
    for (const d of db.all('disagreements', c)) {
      if (d.status === 'open') issues.push(`Open disagreement: ${d.id}`);
      if (d.status === 'uncertain' && (!d.final_note || !a.content.includes(d.final_note)))
        issues.push(`Uncertainty must appear verbatim in draft: ${d.id}`);
    }
  }
  if (bus.pending(c).length) issues.push('Pending peer question or revision');
  if (db.all('tasks', c).some((t) => t.status !== 'done' && t.status !== 'cancelled'))
    issues.push('Pending task');
  if (collab.mode === 'collaborative_coding' && !collab.code_integrated)
    issues.push('Code not integrated and validated');
  return {
    ready: issues.length === 0,
    issues,
    artifact_version: a?.version,
    artifact_sha256: a?.sha256,
  };
}
