import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { workspacePath, safeEnvironment } from '../policy/permissions.js';
import type { Agent } from '../messaging/protocol.js';
export function git(cwd: string, args: string[]) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: safeEnvironment(),
    maxBuffer: 5_000_000,
  });
  if (r.status !== 0) throw Error(r.stderr || r.error?.message || 'git failed');
  return r.stdout.trim();
}
export function assertIntegratedSnapshot(work: any, expected: string) {
  const cwd = work.paths.integration;
  if (git(cwd, ['rev-parse', 'HEAD']) !== expected || git(cwd, ['diff', 'HEAD', '--name-only']))
    throw Error('Integrated code changed since validation');
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter((p) => p && !p.startsWith('.bridge-tmp/'));
  if (untracked.length)
    throw Error('Untracked code exists in integrated candidate: ' + untracked.join(', '));
}
export class Worktrees {
  setup(repo: string, root: string, c: string) {
    const top = git(repo, ['rev-parse', '--show-toplevel']);
    if (realpathSync(repo) !== realpathSync(top))
      throw Error('Pass the exact repository root, not a directory within a larger repository');
    if (git(repo, ['status', '--porcelain']))
      throw Error('Coding requires a clean repository; preserve current edits first');
    const base = git(repo, ['rev-parse', 'HEAD']);
    const paths: Record<string, string> = {};
    for (const who of ['codex', 'claude', 'integration']) {
      const path = join(root, c, who);
      mkdirSync(dirname(path), { recursive: true });
      git(repo, ['worktree', 'add', '-b', `codex/bridge-${c.slice(7, 15)}-${who}`, path, base]);
      paths[who] = path;
    }
    return { repo, base, paths };
  }
  read(work: any, agent: Agent, path: string) {
    return readFileSync(workspacePath(work.paths[agent], path), 'utf8');
  }
  write(work: any, agent: Agent, path: string, content: string) {
    if (content.length > 2_000_000) throw Error('File exceeds 2 MB');
    const p = workspacePath(work.paths[agent], path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    return { path, agent };
  }
  commit(work: any, agent: Agent) {
    const cwd = work.paths[agent];
    git(cwd, ['add', '--all']);
    if (git(cwd, ['diff', '--cached', '--name-only']))
      git(cwd, ['commit', '-m', `Agent Bridge: ${agent} contribution`]);
    return git(cwd, ['rev-parse', 'HEAD']);
  }
  integrate(work: any) {
    const cwd = work.paths.integration;
    for (const a of ['codex', 'claude'] as Agent[]) {
      const sha = this.commit(work, a);
      try {
        git(cwd, ['merge', '--no-edit', sha]);
      } catch (error) {
        const conflicts = git(cwd, ['diff', '--name-only', '--diff-filter=U']);
        return { ok: false, conflicts: conflicts.split('\n'), error: String(error), path: cwd };
      }
    }
    return { ok: true, sha: git(cwd, ['rev-parse', 'HEAD']), path: cwd };
  }
}
