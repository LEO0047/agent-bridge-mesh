import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import type { Config } from './config.js';
import { Store } from './database/sqlite.js';
import { request } from './server.js';
export async function doctor(config: Config) {
  const checks: { check: string; status: string; detail: string }[] = [];
  const add = (check: string, ok: boolean, detail: string) =>
    checks.push({ check, status: ok ? 'PASS' : 'FAIL', detail });
  add('Node', Number(process.versions.node.split('.')[0]) >= 22, process.version);
  for (const [label, command, args] of [
    ['Git', 'git', ['--version']],
    ['Codex', config.agents.codex.command, ['--version']],
    ['Claude', config.agents.claude.command, ['--version']],
  ] as const) {
    const r = spawnSync(command, args, { encoding: 'utf8', timeout: 15000 });
    add(label, r.status === 0, (r.stdout || r.stderr || String(r.error)).trim());
  }
  const codex = spawnSync(config.agents.codex.command, ['login', 'status'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  add('Codex authentication', codex.status === 0, (codex.stdout || codex.stderr).trim());
  const claude = spawnSync(config.agents.claude.command, ['auth', 'status'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  let auth = false;
  try {
    auth = JSON.parse(claude.stdout).loggedIn === true;
  } catch {}
  add('Claude authentication', auth, auth ? 'Logged in (identity omitted)' : 'Not authenticated');
  try {
    const db = new Store(config.db);
    const result = db.db.prepare('PRAGMA integrity_check').get();
    db.close();
    add('SQLite/database', result?.integrity_check === 'ok', String(result?.integrity_check));
  } catch (e) {
    add('SQLite/database', false, String(e));
  }
  try {
    accessSync(config.state, constants.W_OK);
    accessSync(config.artifactsRoot, constants.W_OK);
    add('workspace permissions', true, 'Writable');
  } catch (e) {
    add('workspace permissions', false, String(e));
  }
  add('config', true, 'Validated strict configuration');
  for (const agent of ['codex', 'claude'] as const) {
    const r = spawnSync(config.agents[agent].command, ['mcp', 'get', 'agent-bridge'], {
      encoding: 'utf8',
      timeout: 20000,
    });
    add(
      `${agent} MCP registration`,
      r.status === 0,
      r.status === 0 ? 'agent-bridge registered' : (r.stderr || r.stdout).trim(),
    );
  }
  try {
    await request(config, '/health');
    add('runtime', true, 'Bridge daemon ready');
  } catch (e) {
    add('runtime', false, String(e));
  }
  return checks;
}
