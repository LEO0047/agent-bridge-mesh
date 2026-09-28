import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { projectRoot, loadConfig } from '../src/config.js';
import { request } from '../src/server.js';
import { Store } from '../src/database/sqlite.js';
import { processIdentity, recoverOrphan } from '../src/adapters/process.js';
import { runTests } from '../src/tasks/test-runner.js';
const exec = promisify(execFile);

test('real daemon stop/start race, authenticated transport and persistent database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-transport-'));
  cpSync(join(projectRoot, 'dist'), join(root, 'dist'), { recursive: true });
  cpSync(join(projectRoot, 'collaboration'), join(root, 'collaboration'), { recursive: true });
  cpSync(join(projectRoot, 'agent-bridge.config.yaml'), join(root, 'agent-bridge.config.yaml'));
  // Resolve runtime dependencies without installing another copy.
  const { symlinkSync } = await import('node:fs');
  symlinkSync(join(projectRoot, 'node_modules'), join(root, 'node_modules'));
  const env = { ...process.env, AGENT_BRIDGE_ROOT: root, AGENT_BRIDGE_STATE: join(root, 'state') };
  process.env.AGENT_BRIDGE_STATE = env.AGENT_BRIDGE_STATE;
  const config = loadConfig(root);
  const cli = async (command: string) =>
    exec(process.execPath, [join(root, 'dist', 'cli.js'), command], { env, timeout: 20000 });
  try {
    await cli('start');
    await assert.rejects(request(config, '/health', undefined, 'invalid-capability'), /Invalid/);
    const db = new Store(config.db);
    db.put('sessions', { id: 'persist', collaboration_id: 'fixture', session_id: 'same-session' });
    db.close();
    await cli('stop');
    await cli('start');
    assert.equal((await request(config, '/health')).status, 'ok');
    const reopened = new Store(config.db);
    assert.equal(reopened.get('sessions', 'persist').session_id, 'same-session');
    reopened.close();
  } finally {
    await cli('stop').catch(() => {});
  }
});

test('orphan cleanup requires exact process identity', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  assert.ok(child.pid);
  const identity = processIdentity(child.pid!)!;
  assert.ok(identity);
  recoverOrphan(child.pid!, 'unrelated process');
  assert.doesNotThrow(() => process.kill(child.pid!, 0));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  recoverOrphan(child.pid!, identity);
  await exited;
  assert.throws(() => process.kill(child.pid!, 0));
});

test(
  'sandboxed tests are cancellable and cannot read repository env files',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'bridge-test-cancel-'));
    writeFileSync(join(root, '.env'), 'not-authorized');
    writeFileSync(
      join(root, 'guard.test.cjs'),
      "const{test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');test('env protected',()=>assert.throws(()=>fs.readFileSync('.env')));",
    );
    assert.equal((await runTests(root)).passed, true);
    const controller = new AbortController();
    const pending = runTests(root, ['node', '-e', 'setInterval(()=>{},1000)'], controller.signal);
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    assert.equal(result.passed, false);
    assert.equal(result.error, 'Test cancelled');
  },
);
