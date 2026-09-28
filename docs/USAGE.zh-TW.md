# AgentBridgeMesh 操作指南

AgentBridgeMesh（指令與 MCP 名稱為 `agent-bridge`）讓 Codex 與 Claude Code 自己交換問題、查證、改同一份稿件，再對同一版本共同驗收。協調器是程式，不是第三個模型。

## 安裝與啟動

先準備 Node.js 22.13 以上、Git，並分別完成 Codex 與 Claude Code 的官方登入。報告使用既有 CLI 登入，不需要把 API key 交給 Bridge。程式測試目前使用 macOS 的 sandbox-exec。

```sh
git clone https://github.com/LEO0047/agent-bridge-mesh.git
cd agent-bridge-mesh
npm ci
npm run build
npm run install:mcp
agent-bridge doctor
```

安裝會啟動本機服務、向兩個 CLI 註冊 MCP，並安裝協作 skill。啟動器在 `~/.local/bin`；若該目錄不在 PATH，可先用 `node dist/cli.js` 取代 `agent-bridge`。已經開啟的聊天可能要新開聊天才會載入新工具。

在任一端說：

> 請你跟另一個 Agent 一起完成這份報告。你們自行查資料、交換觀點、共同修改，直到雙方都沒有 blocking issue，最後給我完成版。

入口聊天會呼叫 Bridge；Bridge 持有自己的兩個持續工作階段。它不接管既有桌面聊天，不要求你複製貼上中間訊息。

## 建立研究協作

```sh
agent-bridge new --initiator codex --goal 'AI Agent 長期記憶系統的工程架構選擇'
agent-bridge new --initiator claude --goal '本地 AI 工作站的硬體架構選擇'
agent-bridge watch <collaboration-id>
```

兩端權限對稱；initiator 只決定起始角色。一般過程不需要你批准下一輪。兩位 Agent 都能提出問題、要求證據、修正結論及修改共享稿件。草稿更新會讓舊審核失效。

研究完成後，路徑為 `artifacts/<collaboration-id>/final.md`。此檔案只有在同版本、同內容 hash 的雙方 APPROVE 與其他檢查全部成立後才會產生。若超時或不能收斂，狀態是 `degraded`，可讀 `best-effort.md`，不會冒充雙方完成。

## 程式協作

```sh
agent-bridge new --initiator claude --mode collaborative_coding \
  --repository /absolute/clean/repo --no-evidence \
  --goal '共同修復這個錯誤、補回歸測試並審查整合結果'
```

目標倉庫必須已有 commit 且工作目錄乾淨。Bridge 會建立兩個個別工作樹與一個整合工作樹，原始 checkout 不改動。雙方各寫自己的檔案，再整合、測試、審核同一整合 commit。完成後先查看報告與整合 diff，再自行採納分支；不會自動推送或部署。

預設測試為 `node --test`。MCP 的 `collaboration_start` 可指定預先授權的 `test_command`。若專案測試需要依賴，應先在工作樹準備好；沙箱測試不能聯網下載，也不繼承 API key。Bridge 本身的自我協作驗收由主協作者預先複製已安裝的依賴，並限定測試命令。

## 看進度、對話與恢復

```sh
agent-bridge status
agent-bridge collaborations
agent-bridge collaboration <id>
agent-bridge watch <id>
agent-bridge messages <id>
agent-bridge disagreements <id>
agent-bridge artifact <id>
agent-bridge logs <id>
agent-bridge stop
agent-bridge start
agent-bridge continue <id>
agent-bridge cancel <id>
```

`stop` 中斷服務並保留可恢復狀態，`start` 恢復尚未完成的工作與原 Session。`continue` 用於故障修復後重新給降級工作預算；已執行中的工作不會因重複 continue 重設預算。`cancel` 是明確終止該次工作。已完成的報告要做新任務時建立另一個 collaboration。

完整 Agent 訊息與事件留在本機 SQLite。公開驗收只保留經篩選的追蹤紀錄與訊息摘要，避免公開登入資訊、原始 provider 串流與私有路徑。資料庫預設在 `~/.local/state/agent-bridge`，請備份一致的 SQLite 狀態，勿同步正在使用的資料庫檔。

## 現階段邊界

- Codex App Server 的 dynamic tools 是實驗介面，CLI 更新後應重跑 doctor 與 live acceptance。
- 程式測試的 OS 隔離目前支援 macOS；其他系統沒有測試沙箱 adapter 時會明確拒絕執行測試。
- 雙方查證提供來源與交叉判斷，仍不保證每項研究結論永遠正確；價格與產品文件會改變。
- 近似重複訊息偵測使用字元 trigram，加上狀態進展與輪數上限，沒有宣稱理解所有語意同義句。
- 本機 OS 使用者是信任邊界。不要把 socket、token 或原始紀錄公開到網路。
- 付款、部署、對外發信、未授權秘密讀取與破壞性操作不在 worker 工具內，不能透過請另一位 Agent 代做來繞過。

實測紀錄與最終報告見 [驗收報告](ACCEPTANCE.md)。
