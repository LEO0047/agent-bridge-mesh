import { spawnSync, type ChildProcess } from 'node:child_process';

export function processIdentity(pid: number) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], {
    encoding: 'utf8',
    timeout: 2000,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    if (child.exitCode === null) child.kill(signal);
  }
}

export function recoverOrphan(pid: number, identity: string) {
  // Do not kill a recycled PID or an unrelated process.
  if (!Number.isInteger(pid) || pid <= 1 || !identity || processIdentity(pid) !== identity) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The child may already have exited with its parent.
  }
}
