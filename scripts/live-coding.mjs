import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../dist/config.js';
import { request } from '../dist/server.js';
import { git } from '../dist/tasks/worktrees.js';

const config = loadConfig();
const started = spawnSync(process.execPath, ['dist/cli.js', 'start'], { encoding: 'utf8' });
if (started.status !== 0) throw Error(started.stderr);
const repo = join(config.state, 'fixtures', randomUUID());
mkdirSync(repo, { recursive: true });
git(repo, ['init']);
git(repo, ['config', 'user.name', 'Agent Bridge Test']);
git(repo, ['config', 'user.email', 'test@example.invalid']);
writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
writeFileSync(
  join(repo, 'range.js'),
  'export function clamp(value,min,max) { return Math.max(max,Math.min(min,value)); }\n',
);
writeFileSync(
  join(repo, 'range.test.js'),
  "import {test} from 'node:test';import assert from 'node:assert/strict';import {clamp} from './range.js';test('in range',()=>assert.equal(clamp(5,0,10),5));\n",
);
git(repo, ['add', '.']);
git(repo, ['commit', '-m', 'Seed regression fixture']);
const collaboration = await request(config, '/rpc', {
  name: 'collaboration_start',
  args: {
    mode: 'collaborative_coding',
    initiator: 'claude',
    repository: repo,
    require_evidence: false,
    required_sections: ['根因', '修正', '驗證'],
    goal: '一起修復 clamp 的上下界計算錯誤。Codex 負責 range.js 實作，Claude 負責 range.test.js 補充低於下界、高於上界、邊界與負數範圍的回歸測試。各自在自己的工作樹修改，交換根因與證據；原始前置條件 min <= max 不變，不擴大功能。共同編輯繁體中文結果報告，整合後實跑測試，雙方審同一版本。',
    test_command: ['node', '--test'],
  },
});
const check = spawn(
  process.execPath,
  ['scripts/live-acceptance.mjs', '--resume', collaboration.id],
  { stdio: 'inherit' },
);
check.on('exit', (code) => {
  process.exitCode = code || 0;
});
