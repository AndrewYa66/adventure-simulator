請一律使用繁體中文回覆。每完成一項任務後，請自動執行 git add 與 git commit，commit 訊息用繁體中文簡述這次的變更。

## 開發依據

- 開始任何實作前，先閱讀 `docs/PROJECT_GOALS.md` 的「已確認的設計決策」與「世界永久改變與分支主線（O28–O40 設計總覽）」，依總覽中的建議順序進行：O15 最小版本 → O28 → O37 → O29 → O38 → O30 → O39 → O31–O35 → O40；O36 工具可並行；O40 第 1、2 階段只依賴 O38，可提前並行；O41 建議與 O40 第 1 階段一起做。
- 目前進度（2026-10-06）：O15 最小版本、O28、O37、O29 第一版、O38 第一版、O30 第一版、O39 第一版、O27 第六階段（NPC／魔物合併為單一單位模型）、死亡改為讀檔制、O39 第二版第 1 項（對話記憶，數值待確認）已完成。下一步是 O31。O36 建置腳本可並行；O39 的設定條目與角色卡區段等 O36 完成；O41 奪取與靈魂值建議在 O31 之後與 O40 第 1 階段一起做。
- 若被指示的項目其前置項目尚未完成，先提醒使用者再動工。
- 遵守「引擎與劇本分離」原則：`src/` 程式碼（不含 `src/data/`）不得出現具體內容 ID 或名稱（含註解）。
- 敘事內容格式見 `docs/CONTENT_GUIDE.md`；`content/` 是寫手的筆記庫，除非被要求，不要修改其中的檔案。
- 完成一個項目或階段後，更新 `docs/PROJECT_GOALS.md` 中該項目的「狀態」；若變更 API 或資料格式，同步更新 `docs/API.md` 與型別。

## 工作方式

- 開工前先說明打算怎麼切這個項目的範圍、哪些要延後，再開始寫；延後的項目要寫進 `docs/PROJECT_GOALS.md` 的實作計畫。
- 需要使用者決定的設計問題（例如數值平衡、規則取捨）先給建議並做成資料設定，再請使用者確認；確認後寫入「已確認的設計決策」。
- 驗證規則邏輯用暫時的 Node 腳本（`scripts/` 底下，用 Vite 的 `runnerImport` 載入；要共用模組時建一個 re-export 的 `.ts` 入口檔），跑完就刪掉。
- 完成後執行 `npm run build` 和 `npm run lint`，並搜尋確認 `src/`（不含 `src/data/`）沒有具體內容 ID 或名稱。
- 最後更新文件並提交，再用 Playwright 自行跑瀏覽器測試（見下方），回報結果；只把手感與視覺樣式留給使用者，樣式修正時再一起調整。
- 使用者確認當前模組完成（設計問題都已決定、文件已更新並提交）後，在回覆最後附上一段開新對話用的 prompt，放在程式碼區塊中方便複製，避免過長的上下文干擾下一個模組。prompt 需自成一體，包含：
  - 要先閱讀的文件（`CLAUDE.md`、`docs/PROJECT_GOALS.md` 的相關段落、`docs/API.md`），以及與下一項相關、值得先看的程式檔案；
  - 目前進度（已完成並提交的項目），以及依建議順序的下一項；
  - 上一個模組留下、和下一項有關的延後項目或待觀察問題；
  - 照 `CLAUDE.md` 工作方式進行的提醒：開工前先說明範圍與延後項目、設計問題先給建議、完成後驗證並提交、再用 Playwright（無頭模式）測試並回報。
- 這台電腦沒有 Python，檔案批次處理用 Node 腳本；Bash 的 heredoc 遇到複雜引號容易失敗，長腳本請先用 Write 寫成檔案再執行。

## 存檔政策（開發階段）

- 沒有舊存檔需要相容，不寫存檔遷移程式。改了存檔格式就把 `src/utils/saveStorage.ts` 的 `SAVE_SCHEMA_VERSION` 加一，舊存檔直接捨棄。

## AI 模型與測試

- 預設 AI 模型是 Gemini 3.5 Flash-Lite（免費、回應快，給一般玩家用）；開發測試也用它。
- 真實 AI 測試：`npm run test:ai -- --models gemini-3.5-flash-lite`，可加 `--only <分組>`。
- 金鑰在專案根目錄的 `ai-test.local.json`（已 gitignore，欄位 provider/model/apiKey）；絕對不要印出或貼出金鑰。
- Gemini 免費額度大約每分鐘 5 次、每天 20 次，呼叫前先說要打幾次。

## 瀏覽器測試（Playwright）

- VS Code 內建瀏覽器無法操作；改用 Playwright 控制本機 Edge，預設無頭模式（不開視窗、不搶前景），使用者要求觀看時才用有畫面模式。
- `playwright-core` 裝在 session 的 scratchpad，不加入 `package.json`；`chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })`，結果靠頁面文字與截圖確認。
- 先背景執行 `npx vite --port 5199 --strictPort`，網址含 base path：`http://localhost:5199/adventure-simulator/`；跑完停掉伺服器。
- 需要特定狀態時直接改 localStorage 的自動存檔（`TRPG_SAVE_INDEX` 的 `activeWorldId` → `TRPG_WORLD_<id>_auto` 的 `character`／`world` 層）再重新載入，例如升到 Lv.10 方便戰鬥。
- 戰鬥中聊天輸入會停用，要點 HUD 的「攻擊」按鈕；自傷指令的數值上限為 1000。
- AI 金鑰以 `context.addInitScript` 寫入 `TRPG_GEMINI_KEY`（模型設定寫入 `TRPG_AI_MODEL_SETTINGS`），不輸出到任何地方。

## 待實作（規格已確認）

- **O39 第二版**（已確認，見 O39「尚待後續」）：第 1 項對話記憶已完成（近期 8 輪視窗＋人物記憶 `memoryNotes`，回應格式第 4 版）；第 2～5 項（依情境送規則、依重要度挑選事件、固定規則前置與快取、長流程回歸測試）待排。
- **O41 奪取與靈魂值**、**O42 非同步多人**：規格見 `docs/PROJECT_GOALS.md`；O41 需先由寫手決定種族分類。

## 已知問題與待辦觀察

- 人物記憶品質：AI 偶爾會記下價值不高的內容（例如「玩家再次向我確認妹妹的特徵」），每人上限 8 則會擠掉較早的重要記憶；長時間遊玩後再觀察是否需要重要度排序或合併（已列入 O39 延後項目）。
- 談到其他地名被誤判成移動：O39 已排除引號內對話、過去或假設語氣的敘事，以及玩家文字中的詢問與過去經歷（例如「你上次去那裡是什麼時候？」）；仍需持續觀察其他說法。
- `src/data/events.json` 的 3 個事件是範例，用到的旗標尚未登記到 `content/02 旗標清單`；`src/data/factions.json` 是依 `content/lore/FAC-*` 審閱中草稿整理，待寫手確認。
- 世界觀已改為寫手新大綱（人造勇者、魔王、人造神），但 `src/data/` 的劇本資料（橡木村、哥布林、九個勢力等）與 `content/lore/FAC-*`、`RACE-*` 仍是舊《星鐵亂世》設定，等寫手設計種族、勢力與地理後再替換；LORE-001、LORE-003、LORE-004、LORE-005、ACT-1～3 已依新大綱改寫。
- 「他方佔領」規則已實作，但目前沒有資料使用，瀏覽器測不到。
- AI 傳聞品質：O39 後目擊者能明確說出前任冒險者殺害村長（2026-10-06 實測通過）。未在場的同勢力 NPC 依認知層級以傳聞口吻提到兇手（2026-10-06 決議並實測通過）。
- O27 第六階段（單位合併、AI 回應格式第 3 版）後的真實 AI 測試已通過（2026-10-06，Flash-Lite 21/21，21 次請求）。沒有遭遇候選時，AI 會回傳占位值 `__NO_ENCOUNTER_UNIT__` 的 `encounterRequest`，目前查無單位而自然忽略，無實際影響。
