import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { projectRoot, loadConfig } from '../src/config.js';
import { request } from '../src/server.js';
import { Store } from '../src/database/sqlite.js';
import { processIdentity, recoverOrphan } from '../src/adapters/process.js';
import { runTests } from '../src/tasks/test-runner.js';
import { Engine } from '../src/collaboration-engine.js';
import { Service } from '../src/service.js';
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

test(
  'sandbox allows child-group signals while denying signals outside its sandbox',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'bridge-signal-scope-'));
    const outside = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    assert.ok(outside.pid);
    const exited = new Promise((resolve) => outside.once('exit', resolve));
    try {
      const source = `
        const {spawn}=require('node:child_process');
        const assert=require('node:assert/strict');
        for(const pid of [${outside.pid},-${outside.pid}])
          assert.throws(()=>process.kill(pid,0),e=>e.code==='EPERM');
        const child=spawn(process.execPath,['-e','setTimeout(()=>{},1000)'],{detached:true,stdio:'ignore'});
        child.once('exit',(code,signal)=>{assert.equal(signal,'SIGKILL');console.log('signal scope verified');});
        setTimeout(()=>process.kill(-child.pid,'SIGKILL'),50);
      `;
      const result = await runTests(root, ['node', '-e', source]);
      assert.equal(result.passed, true, JSON.stringify(result));
      assert.match(result.stdout, /signal scope verified/);
      assert.doesNotThrow(() => process.kill(outside.pid!, 0));
    } finally {
      process.kill(-outside.pid!, 'SIGKILL');
      await exited;
    }
  },
);

test(
  'SIGKILLed runner leaves a silent test that persisted restart recovery terminates',
  { skip: process.platform !== 'darwin', timeout: 15000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'bridge-hard-crash-'));
    const work = join(root, 'work');
    mkdirSync(work);
    cpSync(join(projectRoot, 'agent-bridge.config.yaml'), join(root, 'agent-bridge.config.yaml'));
    const state = join(root, 'state');
    process.env.AGENT_BRIDGE_STATE = state;
    const config = loadConfig(root);
    let db = new Store(config.db);
    const moduleUrl = (file: string) =>
      JSON.stringify(pathToFileURL(join(projectRoot, 'dist', file)).href);
    const program = `
      import {loadConfig} from ${moduleUrl('config.js')};
      import {Store} from ${moduleUrl('database/sqlite.js')};
      import {TestRuns} from ${moduleUrl('service.js')};
      import {runTests} from ${moduleUrl('tasks/test-runner.js')};
      const db=new Store(loadConfig(${JSON.stringify(root)}).db);
      await runTests(${JSON.stringify(work)},['node','-e','setInterval(()=>{},1000)'],undefined,new TestRuns(db,'crash-fixture'));
    `;
    const parent = spawn(process.execPath, ['--input-type=module', '-e', program], {
      env: { ...process.env, AGENT_BRIDGE_STATE: state },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    parent.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise((resolve) => parent.once('exit', resolve));
    let childRecord: any;
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!condition()) {
        if (Date.now() >= deadline) throw Error('Timed out: ' + stderr);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await until(() => {
        childRecord = db.all('test_runs', 'crash-fixture')[0];
        return !!childRecord?.process_identity;
      });
      assert.equal(childRecord.status, 'running');
      parent.kill('SIGKILL');
      await exited;
      assert.doesNotThrow(() => process.kill(childRecord.pid, 0));
      db.close();
      db = new Store(config.db);
      const engine = new Engine(new Service(db, config));
      engine.recover();
      assert.equal(db.get('test_runs', childRecord.id).status, 'interrupted');
      await until(() => {
        try {
          process.kill(childRecord.pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      assert.equal(db.all('runs').length, 0);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      await exited;
      if (childRecord?.process_identity)
        recoverOrphan(childRecord.pid, childRecord.process_identity);
      db.close();
    }
  },
);
