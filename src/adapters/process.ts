import { spawnSync, type ChildProcess } from 'node:child_process';

// Identity must rely only on birth attributes the process cannot change about itself.
// comm is unusable: a launcher such as sandbox-exec replaces its image with the target
// executable, so the value read just after spawn may not be the value read at recovery.
export function processIdentity(pid: number) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'uid='], {
    encoding: 'utf8',
    timeout: 2000,
  });
  const identity = result.stdout?.trim().replace(/\s+/g, ' ');
  return result.status === 0 && identity ? identity : null;
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
    // The process group may already be gone.
  }
}
