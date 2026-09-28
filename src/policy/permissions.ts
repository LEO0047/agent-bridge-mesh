import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, sep, join } from 'node:path';
export function workspacePath(root: string, path: string) {
  if (!path || path.includes('\0')) throw Error('Invalid path');
  const p = resolve(root, path);
  const rel = relative(root, p);
  if (rel.startsWith('..' + sep) || rel === '..' || rel === '' || resolve(path) === path)
    throw Error('Path outside authorized workspace');
  if (
    rel
      .split(sep)
      .some(
        (x) =>
          x === '.git' ||
          [
            '.gitattributes',
            '.gitmodules',
            '.lfsconfig',
            '.npmrc',
            '.pypirc',
            'id_rsa',
            'id_ed25519',
          ].includes(x) ||
          x === '.env' ||
          x.startsWith('.env.') ||
          /^(credentials|secrets?)(\..*)?$/i.test(x) ||
          /\.(pem|key)$/i.test(x),
      )
  )
    throw Error('Protected path');
  let at = root;
  for (const part of rel.split(sep)) {
    at = join(at, part);
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw Error('Symlink forbidden');
  }
  return p;
}
export function safeEnvironment() {
  const keys = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TERM',
    'CODEX_HOME',
  ];
  return Object.fromEntries(keys.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
}
