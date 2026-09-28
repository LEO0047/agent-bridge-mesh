# clamp 上下界修復

## 根因

`range.js` 原式 `Math.max(max, Math.min(min, value))` 用反了夾限運算。在一般數值且 `min <= max` 下，內層結果不大於 `min`，外層因而固定回傳 `max`。例如 `clamp(5, 0, 10)` 錯回 `10`，應為 `5`；負數區間同樣受影響，`clamp(-7, -10, -1)` 錯回 `-1`（該區間的上界），應為 `-7`。原有測試已能抓到此錯誤。

## 修正

`range.js` 僅修改一行運算式，先夾下界、再夾上界：

```js
export function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
```

維持 `min <= max` 前置條件與既有介面，沒有增加功能。`range.test.js` 擴充為六組測試，涵蓋區間內、低於下界、高於上界、兩端邊界、負數範圍及上下界相等；另以正負小數確認區間內值不被取整。

## 驗證

雙方已檢查對方的實際 diff。使用 Bridge 設定的 `node --test` 實跑結果：

- 原始程式與原始測試：雙方各自執行，均為 1 組失敗（`10 !== 5`），exit code 1。
- Codex 工作樹：修正程式搭配原始測試，1 組通過、0 組失敗，exit code 0。
- Claude 工作樹：原始程式搭配新增測試，2 組通過、4 組失敗，exit code 1；此時尚未包含程式修正。
- 整合樹（`integrated_sha 0c18037`）：修正程式搭配六組回歸測試，6 組全數通過、0 組失敗，exit code 0。原本失敗的區間內案例（`10 !== 5`）已通過。

雙方均已檢查合併後的實際 diff——僅 `range.js` 的一行公式修正與 `range.test.js` 的六組測試，無額外功能——並各自在整合樹實跑 `node --test` 確認上述結果。修復已完成驗證。

適用範圍：回歸測試涵蓋上述情境與正負小數，不宣稱有限案例能排除所有可能的錯誤實作。未涵蓋 `NaN`、`Infinity` 與 `-0`；`min > max` 由前置條件排除。
