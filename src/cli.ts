#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  openSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './config.js';
import { serve, request } from './server.js';
import { mcp } from './mcp.js';
import { doctor } from './doctor.js';
const config = loadConfig(),
  args = process.argv.slice(2),
  command = args[0] || 'help';
async function start() {
  try {
    return await request(config, '/health');
  } catch {}
  // A graceful stop closes the socket before the old process finishes cleanup.
  // Wait for that owner instead of racing a second daemon against its PID lock.
  const lock = join(config.state, 'daemon.pid');
  for (let i = 0; i < 40 && existsSync(lock); i++) {
    const pid = Number(readFileSync(lock, 'utf8'));
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      return await request(config, '/health');
    } catch {}
  }
  const log = openSync(join(config.state, 'logs', 'daemon.log'), 'a');
  const child = spawn(process.execPath, [join(config.root, 'dist', 'cli.js'), 'serve'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, AGENT_BRIDGE_ROOT: config.root, AGENT_BRIDGE_STATE: config.state },
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      return await request(config, '/health');
    } catch {}
  }
  throw Error('Daemon did not start; inspect logs/daemon.log in state directory');
}
async function install() {
  await start();
  const cli = join(config.root, 'dist', 'cli.js');
  for (const a of ['codex', 'claude'] as const) {
    const check = spawnSync(config.agents[a].command, ['mcp', 'get', 'agent-bridge'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    if (check.status === 0) {
      if (!check.stdout.includes(cli))
        throw Error(`${a} already has a different agent-bridge registration; preserving it`);
      continue;
    }
    const argv =
      a === 'codex'
        ? [
            'mcp',
            'add',
            'agent-bridge',
            '--env',
            `AGENT_BRIDGE_ROOT=${config.root}`,
            '--env',
            `AGENT_BRIDGE_STATE=${config.state}`,
            '--',
            process.execPath,
            cli,
            'mcp',
          ]
        : [
            'mcp',
            'add',
            'agent-bridge',
            '--scope',
            'user',
            '-e',
            `AGENT_BRIDGE_ROOT=${config.root}`,
            '-e',
            `AGENT_BRIDGE_STATE=${config.state}`,
            '--',
            process.execPath,
            cli,
            'mcp',
          ];
    const r = spawnSync(config.agents[a].command, argv, { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) throw Error(r.stderr || r.stdout);
  }
  const bin = join(homedir(), '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  const q = (v: string) => "'" + v.replaceAll("'", "'\\''") + "'";
  const launcher = join(bin, 'agent-bridge');
  const body = `#!/bin/sh\nexport AGENT_BRIDGE_ROOT=${q(config.root)}\nexport AGENT_BRIDGE_STATE=${q(config.state)}\nexec ${q(process.execPath)} ${q(cli)} "$@"\n`;
  if (existsSync(launcher) && !readFileSync(launcher, 'utf8').includes(cli))
    throw Error('Existing unrelated agent-bridge launcher preserved');
  writeFileSync(launcher, body, { mode: 0o755 });
  for (const base of [join(homedir(), '.codex', 'skills'), join(homedir(), '.claude', 'skills')]) {
    const initiator = base.includes('.claude') ? 'claude' : 'codex';
    const folder = join(base, 'agent-bridge');
    mkdirSync(folder, { recursive: true });
    const dest = join(folder, 'SKILL.md');
    if (existsSync(dest)) copyFileSync(dest, dest + '.backup');
    writeFileSync(
      dest,
      `---\nname: agent-bridge\ndescription: Use when the user asks Codex and Claude to collaborate, 雙 Agent 協作, 跟 Claude 一起, or 跟 Codex 一起.\n---\nStart the local bridge with \`${launcher} start\`. Use the agent-bridge MCP collaboration_start with the user goal and your agent name as initiator. Do not start nested collaboration from a Bridge-managed session. Poll collaboration_status until completed, degraded, or cancelled. Both agents retain sessions and share draft.md. Deliver only final.md when status completed; report degraded honestly and provide best-effort.md otherwise. Never claim dual approval without the quality gate. CLI fallback: \`${launcher} new --initiator ${initiator} --goal '...'\`, status: \`${launcher} collaboration <id>\`.\n`,
    );
  }
  return await doctor(config);
}
async function main() {
  if (command === 'serve') {
    await serve(config);
    return;
  }
  if (command === 'mcp') {
    if (!args.includes('--agent')) await start();
    await mcp(config, args.includes('--agent') ? args[args.indexOf('--agent') + 1] : undefined);
    return;
  }
  if (command === 'start') return start();
  if (command === 'stop') return request(config, '/stop', {});
  if (command === 'install') return install();
  if (command === 'doctor') return doctor(config);
  if (command === 'status') return request(config, '/health');
  if (command === 'collaborations') return request(config, '/collaborations');
  if (command === 'collaboration') return request(config, `/collaborations/${args[1]}`);
  if (['messages', 'disagreements', 'artifact', 'logs'].includes(command))
    return request(
      config,
      `/${command === 'logs' ? 'events' : command}${args[1] ? '?id=' + args[1] : ''}`,
    );
  if (['continue', 'cancel'].includes(command))
    return request(config, '/rpc', { name: `collaboration_${command}`, collaboration_id: args[1] });
  if (command === 'new') {
    await start();
    const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
    return request(config, '/rpc', {
      name: 'collaboration_start',
      args: {
        goal: flag('--goal') || args.slice(1).join(' '),
        initiator: flag('--initiator') || 'codex',
        mode: flag('--mode') || 'collaborative_report',
        repository: flag('--repository'),
        require_evidence: !args.includes('--no-evidence'),
      },
    });
  }
  if (command === 'watch') {
    let after = 0;
    while (true) {
      const events = await request(config, `/events?id=${args[1]}&after=${after}`);
      for (const e of events) {
        after = e.seq;
        if (!e.type.startsWith('runtime.')) console.log(JSON.stringify(e));
      }
      const c = await request(config, `/collaborations/${args[1]}`);
      if (['completed', 'degraded', 'cancelled'].includes(c.status))
        return { status: c.status, final_path: c.final_path };
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (command === 'acceptance') {
    await start();
    return request(config, '/rpc', {
      name: 'collaboration_start',
      args: {
        goal: '請你和另一個 Agent 一起完成一份完整報告。主題：AI Agent 長期記憶系統的工程架構選擇。自行分工、查閱一手官方資料、交換觀點、討論不同意的地方、互相挑錯，共同修改同一份報告，直到雙方認為沒有 blocking issue。比較檔案與 Git、SQLite/全文索引、向量資料庫、知識圖譜、事件紀錄及混合設計。涵蓋記憶寫入、檢索、更新與刪除、權限、來源、評估與成本。對小型個人系統與團隊系統提出可行建議，勿把複雜度當品質。繁體中文，完整但避免空話。',
        initiator: 'codex',
        required_sections: ['架構', '取捨', '建議', '來源'],
        require_evidence: true,
      },
    });
  }
  return {
    usage:
      'agent-bridge start | stop | doctor | install | new --goal TEXT [--initiator codex|claude] | collaborations | collaboration ID | messages ID | disagreements ID | artifact ID | logs [ID] | watch ID | continue ID | cancel ID | acceptance',
  };
}
main()
  .then((v) => {
    if (v !== undefined) console.log(JSON.stringify(v, null, 2));
    if (
      ['doctor', 'install'].includes(command) &&
      Array.isArray(v) &&
      v.some((row) => row.status === 'FAIL')
    )
      process.exitCode = 1;
  })
  .catch((e) => {
    console.error(String(e));
    process.exitCode = 1;
  });
