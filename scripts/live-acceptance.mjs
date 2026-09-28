import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../dist/config.js';
import { request } from '../dist/server.js';
import { Store } from '../dist/database/sqlite.js';
import assert from 'node:assert/strict';

const config = loadConfig();
const args = process.argv.slice(2);
const existing = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const start = spawnSync(process.execPath, ['dist/cli.js', 'start'], { encoding: 'utf8' });
if (start.status !== 0) throw Error(start.stderr);
const created = existing
  ? { id: existing }
  : await request(config, '/rpc', {
      name: 'collaboration_start',
      args: {
        initiator: args.includes('--claude') ? 'claude' : 'codex',
        goal: '請你和另一個 Agent 一起完成報告：AI Agent 長期記憶系統的工程架構選擇。自行分工、查閱官方一手資料、交換觀點、解決分歧、互相挑錯，共同修改 draft.md，雙方對相同版本完成 Review，最後給我繁體中文報告。比較檔案與 Git、SQLite/全文索引、向量資料庫、知識圖譜、事件紀錄與混合設計，涵蓋權限、來源、更新刪除、評估及成本。',
        required_sections: ['架構', '取捨', '建議', '來源'],
        require_evidence: true,
      },
    });
console.log(`Live collaboration ${created.id}; provider usage applies.`);
let previous = '';
for (;;) {
  const state = await request(config, `/collaborations/${created.id}`);
  const progress = `${state.status}/${state.phase}/${state.turns}`;
  if (progress !== previous) {
    console.log(progress);
    previous = progress;
  }
  if (['degraded', 'cancelled'].includes(state.status))
    throw Error(state.last_error || state.status);
  if (state.status === 'completed') {
    assert.equal(state.quality_gate.ready, true);
    const db = new Store(config.db);
    const messages = db.all('messages', created.id);
    const history = db.all('artifact_versions', created.id).filter((a) => a.name === 'draft.md');
    for (const agent of ['codex', 'claude']) {
      assert.ok(
        messages.filter((m) => m.from === agent).length >= 2,
        `${agent} must send real peer messages`,
      );
      assert.ok(
        history.some((a) => a.author === agent),
        `${agent} must edit shared draft`,
      );
      assert.ok(
        db
          .all('reviews', created.id)
          .some(
            (r) =>
              r.agent === agent &&
              r.verdict === 'APPROVE' &&
              r.artifact_version === state.final_version,
          ),
      );
      const sessions = new Set(
        db
          .events(created.id)
          .filter((e) => e.type === 'agent.started' && e.data.agent === agent && e.data.session_id)
          .map((e) => e.data.session_id),
      );
      assert.equal(sessions.size, 1, `${agent} must resume one persistent session`);
    }
    db.close();
    mkdirSync('logs', { recursive: true });
    writeFileSync(
      `logs/live-${created.id}.json`,
      JSON.stringify(
        {
          status: 'PASS',
          collaboration_id: created.id,
          final_path: state.final_path,
          final_version: state.final_version,
          final_sha256: state.final_sha256,
        },
        null,
        2,
      ),
    );
    console.log(`PASS ${state.final_path}`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
