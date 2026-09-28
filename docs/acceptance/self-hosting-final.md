# Agent Bridge 測試子程序恢復缺口：修正報告

已補上測試程序的 PID、出生身分與執行狀態記錄，讓 `Engine.recover()` 能辨識並嘗試清理 Bridge 中斷後仍存活的測試程序群組。修改限於五個生產檔與新增的 `tests/orphan-recovery.test.ts`；本輪工作樹未修改正式 sandbox profile。

## 根因

`runTests` 以 `detached: true` 啟動測試，但 child、abort 監聽器與 120 秒 timer 都只存在於 Bridge 記憶體中。`workspace_test` 與 synthesis 整合測試兩條入口皆未持久化測試 PID；原本的 `Engine.recover()` 只掃描 agent 的 `runs`，因此沒有測試程序的身分可供比對。

Bridge 被 SIGKILL 後，測試程序**可能**殘留，尤其是安靜或卡住的程序：Bridge 內的 timer 已消失，而未繼續寫入輸出管線的程序可能仍在執行。這是依程式結構作出的情境推論，沒有發生率量測，也不表示所有 detached 程序必定續存。Node 文件說明非 Windows 的 detached 子程序會成為新 process group 與 session 的 leader，並提醒父程序退出後的存活也受 stdio 連接方式影響。[Node.js child_process 文件](https://nodejs.org/api/child_process.html)

另有身分穩定性問題：舊 `processIdentity` 使用 `lstart + comm`，但 `runTests` 啟動的是 `sandbox-exec`，實際要跑的執行檔放在它的參數中。Apple 的說明是 sandbox 套用在當前程序上，而 man page 並未載明 `sandbox-exec` 究竟是以新映像取代自身還是另開子程序（[sandbox_init(3)](https://keith.github.io/xcode-man-pages/sandbox_init.3.html)）。因此 spawn 後查到的 `comm` 是不確定的：可能是啟動器，也可能已是目標執行檔。若寫入的值與恢復時查到的不同，全字串比對就會略過清理，而且失敗方式是沉默的。本次改用 `lstart + uid`，保留出生時間精度的限制。

## 修正

- **獨立 `test_runs` 記錄。** `src/service.ts` 新增 `TestRuns`，同步儲存 PID、process identity、command、cwd、collaboration、狀態與時間。兩條啟動入口皆接上登記。這些記錄不混入 `runs`，避免影響 agent retry/fallback 對最後一筆 run 的判斷。`sqlite.ts` 僅新增查詢 view，底層 records 表不需 migration。
- **先監聽，再登記。** `test-runner.ts` 在 spawn 後先掛上 child 的 error/close 監聽器，再同步呼叫 `started()`。登記拋錯時嘗試對群組送 SIGKILL，清理 timer 與 abort 監聽器，等待 completion 結束或最多 5 秒，再拋回原始錯誤。這是有上限的清理等待，不能當成所有 OS 情況下都已成功收屍的保證。
- **正常終態持久化。** 成功為 `completed`；非零離開碼、逾時、輸出超限及已登記執行的錯誤為 `failed`；abort 為 `interrupted`。`finished()` 拋錯不覆蓋原測試結果。spawn 失敗而沒有 PID 時不建立 running 記錄。
- **恢復加入測試記錄。** `collaboration-engine.ts` 對 running 的 test_runs 比對出生身分；只有 PID 合法、身分非空且與即時查詢相符，才嘗試向 `-pid` 送 SIGKILL。之後將記錄標為 interrupted。負 PID 的訊號目標是對應 process group。[kill(2)](https://man7.org/linux/man-pages/man2/kill.2.html)
- **身分跨 exec 保持穩定。** `process.ts` 改查 `lstart + uid` 並正規化空白；查詢失敗或空輸出回傳 null，恢復時保守地不送訊號。

原本的 abort、120 秒逾時、每個輸出串流的 2,000,000 字元截斷門檻及 sandbox 安全規則均保留。synthesis 若重用已通過的相同整合快照，不會啟動程序，也不新增 test_runs。

**評估後未採用的替代方案。** 以下是討論過但刻意不做的選項，記錄理由以供日後重新評估：

- *把測試記錄寫進既有 `runs`*：`Engine.start()` 以最後一筆 run 判斷是哪個 agent 失敗，混入測試列會影響該判斷；既有測試也對 `runs` 筆數有斷言。
- *由子程序自行寫 PID 檔，或先寫佔位記錄再補上 PID*：可縮小 spawn 到登記之間的窗口，但需要新的協定與檔案清理責任，超出本次範圍。
- *常駐 supervisor 監看測試程序*：需要新增長期執行元件及其自身恢復策略，維護範圍超過本次的最小持久化修補。
- *在身分中加入 `pgid` 或保留 `comm` 以提高鑑別力*：測試指令是不受信任的程式碼，可透過 exec 或 setpgid 改變這些屬性，反而可能讓應被清理的程序逃過比對。
- *為舊格式身分加相容層*：舊值的不穩定性正是問題來源，相容層會把不可靠的比對重新帶回。
- *恢復時列舉整個 process group 而非只認 leader*：可涵蓋 leader 先退出的情況，但需要列舉系統程序（在受限 profile 下未必可行），且會提高誤殺風險。

## 介面契約

`runTests(cwd, command?, signal?, registry?)` 保留既有三個參數，第四個選用參數為 `TestProcessRegistry`：

| 方法 | 契約 |
| --- | --- |
| `started({ pid, identity, command, cwd }): string` | 有 child PID 時，在第一個 await 之前同步呼叫並回傳 handle；identity 為查詢到的字串或 null。快速退出的 child 也可能查不到身分。 |
| `finished(handle, status, { exit_code, signal, error? }): void` | 正常取得 handle 後，在結果結束時回寫一次；status 為 completed、failed 或 interrupted。回呼錯誤不改變原回傳結果。 |

`TestRuns(db, collaboration_id)` 是 Store-backed 實作。記錄包含 `id`、`collaboration_id`、`pid`、`process_identity`、`command`、`cwd`、`status`、`started_at`、`ended_at`、`exit_code`、`signal` 與 `error`。重啟恢復也使用 interrupted，該狀態不代表已確認成功終止程序。

## 驗證

**本輪工作樹驗證：18 項通過、0 失敗、0 skip。** Codex 在自己的工作樹，以預授權指令 `node --import tsx --test tests/orphan-recovery.test.ts` 執行，最近一次約 677 ms。Codex 先把 Claude 的五個生產檔同步到該工作樹才執行測試，並再次透過 workspace_read 逐檔比較，確認五檔內容完全相同。Claude 已審閱測試檔，Codex 已審閱生產 diff。雙方的正式核可以 Bridge 整合後的同一份草稿版本為準。

**主維護者獨立檢查。** 主維護者回報已在 Codex 工作樹執行 TypeScript build 與涵蓋 src/tests/scripts 的 Prettier check，兩者皆 exit 0；核對的六個修改檔案聯合 SHA-256 為 `7955dfd02a9621afedea9eea4698ad8836f54327715811ec4169802a49bcb19e`。這是主維護者提供的驗證結果，不是兩位代理的 workspace_test。本段不代表主分支合併後的完整 suite 或真實 crash recovery 已通過。

回歸涵蓋：

- 第一個 await 前即有記錄；Store 關閉重開後仍可用於 Engine.recover。
- 身分相符才送群組 SIGKILL；錯配、null、已完成記錄及 PID 出生時間改變不送訊號；重複恢復不再處理終態。
- executable 名稱改變不影響出生識別；ps 成功但空輸出記為 null。
- 兩條入口均登記且不改動 agent runs；整合結果重用不啟動第二個 child。
- 成功、非零退出、abort、timeout、輸出超限、兩個 callback 拋錯、無 PID spawn 失敗與 pre-abort。
- spawn 仍選用 sandbox-exec，profile 仍包含 deny default 與憑證檔名限制。

**驗證邊界。** 目前服務本次協作的 daemon 使用舊 sandbox profile。探針實際回報 `spawnSync ps EPERM`；真實 Git fixture 另因 sandbox 阻擋讀取 Xcode 的 libxcrun 而失敗。最終測試替換 OS 的 spawn、ps、Git 與 process.kill 邊界，保留真正的 runTests、TestRuns、SQLite Store、Service、Engine 及恢復流程。因此上述通過證明持久化、狀態與訊號決策的連接正確，**不等於已驗證真實 kernel kill、原生 ps 身分或完整的 Bridge SIGKILL／重啟情境**。

**主維護者另行驗收。** 依主維護者協調補充，他已查核 Apple application.sb，並另行驗證 `(allow signal (target same-sandbox))` 可允許同沙箱群組 SIGKILL、仍拒絕對沙箱外程序送 signal 0。本輪兩位代理未自行重做該驗證。主維護者將在主分支加入該條款與 transport 安全回歸，再以非巢狀完整 build、lint、tests 驗收真實 kill、identity 與沙箱外訊號限制；本報告不把這些後續關卡算作本輪已通過。

## 限制與殘餘風險

1. **本次未消除 spawn 到登記的窗口。** 查身分與寫入 DB 之前若 Bridge 被 SIGKILL，仍可能沒有可恢復記錄；本次未增加 supervisor 或子程序登記協定。
2. **出生時間為秒級精度。** 同一 PID 若在同一秒被同一 uid 的新程序取代，身分可能碰撞。查詢與送訊號也非原子操作；不能宣稱絕不誤殺。
3. **舊格式記錄的相容性。** 舊 agent runs 的身分含 comm，新格式不再使用它。舊值不能與新值匹配時會保守跳過清理，本次不加相容層。
4. **leader 或身分不可查。** group leader 先退出、查詢受限或 identity 為 null 時，恢復會放棄送訊號，其他群組成員仍可能殘留。
5. **interrupted 不證明清理成功。** 包含不匹配、無法查詢及送訊號失敗等情況；現有記錄未保存獨立的清理結果，不能僅憑狀態或 PID 欄位確認程序已退出。
6. **終態寫入失敗仍可能留下 running 記錄。** finished 拋錯目前被吞掉，測試結果仍回傳，但 DB 可能保留舊狀態，之後恢復仍需做身分比對。
7. **平台與驗收範圍不變。** runTests 仍要求 macOS sandbox；未承諾跨平台，也未增加 test_runs 保留期限管理。完整 build/lint/tests 與真實 OS 行為仍由主維護者最後驗收。
