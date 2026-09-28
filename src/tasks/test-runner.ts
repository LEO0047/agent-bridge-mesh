import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safeEnvironment } from '../policy/permissions.js';
import { killGroup } from '../adapters/process.js';
export async function runTests(
  cwd: string,
  command: string[] = ['node', '--test'],
  signal?: AbortSignal,
) {
  if (!command.length) throw Error('Empty test command');
  const executable = command[0] === 'node' ? process.execPath : command[0]!;
  const env = { ...safeEnvironment(), HOME: cwd, TMPDIR: join(cwd, '.bridge-tmp') };
  mkdirSync(env.TMPDIR, { recursive: true });
  let runner = executable,
    args = command.slice(1);
  // Test code is untrusted code. It cannot inherit credentials or reach the network.
  if (process.platform === 'darwin') {
    const quote = (p: string) => JSON.stringify(realpathSync(p));
    const profile = `(version 1)(deny default)(allow process*)(allow signal (target same-sandbox))(allow sysctl-read)(allow mach-lookup)(allow file-read-metadata)(allow file-read* (literal "/") (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library/Apple") (subpath "/Library/Frameworks") (subpath "/dev") (subpath ${quote(dirname(process.execPath))}) (subpath ${quote(cwd)}))(allow file-write* (subpath ${quote(cwd)}) (literal "/dev/null"))`;
    runner = '/usr/bin/sandbox-exec';
    const protectedFiles = String.raw`(deny file-read* (regex #"/([.]env([.].*)?|credentials([.].*)?|secrets?([.].*)?|[.]npmrc|[.]pypirc|id_rsa|id_ed25519)$"))`;
    args = ['-p', profile + protectedFiles, executable, ...args];
  } else
    throw Error(
      'Secure test execution currently requires macOS sandbox-exec; configure an OS sandbox adapter before tests on this platform',
    );
  if (signal?.aborted) throw Error('Test cancelled');
  const child = spawn(runner, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '',
    error: string | undefined;
  const abort = () => {
    error = 'Test cancelled';
    killGroup(child, 'SIGKILL');
  };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    error = 'Test timeout';
    killGroup(child, 'SIGKILL');
  }, 120000);
  try {
    return await new Promise<{
      command: string[];
      exit_code: number | null;
      signal: string | null;
      passed: boolean;
      stdout: string;
      stderr: string;
      error?: string;
    }>((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.length > 2_000_000) {
          error = 'Test output limit';
          killGroup(child, 'SIGKILL');
          stdout = stdout.slice(0, 2_000_000);
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.length > 2_000_000) {
          error = 'Test output limit';
          killGroup(child, 'SIGKILL');
          stderr = stderr.slice(0, 2_000_000);
        }
      });
      child.on('error', reject);
      child.on('close', (code, exitSignal) =>
        resolve({
          command,
          exit_code: code,
          signal: exitSignal,
          passed: code === 0 && !error,
          stdout,
          stderr,
          error,
        }),
      );
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
