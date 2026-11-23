# O34-2 交接單（重要角色 AI 批次決策、世界紀錄只列已知事件）

> 分支：`module/O34-2`（從 main 開出，尚未合併、未 push）。規格：`docs/specs/O34-2.md`；自行決定的細節見規格書「製作紀錄 › 實作細節」。

## 完成項目（對照規格書「範圍內」）

| 範圍內項目 | 實作位置 |
| --- | --- |
| 角色決策 AI 批次呼叫（只在最後一天、每批最多 5 位、候選制、失敗退回規則） | `src/utils/agents.ts`（`settleAgents` 的 `deferToAI`、`listAgentCandidates`、`selectAgentsForAI`、`applyAgentBatch`）；`src/utils/worldEvents.ts` `finalizeWorldWithAgentBatch`；`src/services/agentDecisionContext.ts`（請求、字數上限、解析）；`src/services/agentDecisionService.ts`（呼叫、逾時、報告） |
| 「各方正在盤算…」、逾時、過期結果丟棄 | `src/App.tsx`（`updatePlayer`、`startAgentBatch`、`startNewSession`、`commitWorldUpdate`）；`OptionBar.tsx` `busyNote`；`StoryLog.tsx` `busyText` |
| 設定頁：角色 AI 開關、呼叫次數與 tokens、上次角色決策結果 | `src/components/ApiKeyModal.tsx`；`src/services/aiModels.ts` `agentDecisionsEnabled`／`isAgentAIEnabled` |
| 除錯面板顯示上一次角色決策請求 | `src/components/AIContextDebugPanel.tsx` |
| 玩家已知事件清單（存檔版本 15）、HUD 只列已知、抵達時得知消息、「世界變化」改用同一套規則 | `worldEvents.ts`（`updatePlayerKnownEvents`、`compressEvents`、`getPlayerKnownEvents`）；`PlayerHUD.tsx`；`App.tsx` `commitWorldUpdate`；`playerStorage.ts`；`saveStorage.ts` |
| test:ai「角色決策」分組（3 個情境） | `scripts/ai-smoke-test.mjs` |
| 資料 | `agent_rules.json` 的 `ai`；`ai_context.json` 的 `maxCallsPerTurn: 3`、`news.maxNoticeEvents: 3`；`scenario.json` 的 `news.noticePrefix`；`staticData.ts` `validateAgentData` 同步驗證 |

範圍外未做：第 3 階段的行動與新決策時機、角色記憶壓縮、模擬呼叫 AI。主持人回應格式（`formatVersion` 5）沒有改。`content/` 沒有改。

## 驗收證據

暫時腳本放在製作電腦的 session scratchpad（規則腳本 `rule/o34-2-check.mjs`＋`o34-2-entry.ts`，已從 `scripts/` 刪除；Playwright `pw/o34-2-browser.mjs`）。Playwright 以 `context.route` 攔截所有 AI 請求並回傳模擬 JSON，**0 次真實呼叫**。

| 驗收 | 結果 | 證據摘要 |
| --- | --- | --- |
| 1 最多 5 位、優先順序、只剩維持現狀不送、批次為空不呼叫 | 通過 | 規則腳本：玩家在村莊時村長優先、在巢穴時酋長優先、在古道依資料順序；勢力被牽涉的事件使酋長優先；酋長自己的決策事件不算（選項 B）；前一天以前的事件不算；暫設上限 1 時只選 1 位；冷卻使只剩維持現狀時不選、`finalizeWorldWithAgentBatch` 不回傳 batch |
| 2 跨多日只有最後一天呼叫 AI | 通過（規則腳本）／部分（瀏覽器） | 規則腳本：跨 3 日時 batch 為最後一天，第一天的村長已由規則發布委託；不延後時沒有 batch。瀏覽器：單次跨日等待只送 1 次角色決策（敘事 0 次）。單一行動最多 8 小時，瀏覽器裡無法跨多日，多日由規則腳本涵蓋 |
| 3 驗證後套用、`source: 'ai'`、無效只影響該角色、40 字截斷 | 通過 | 規則腳本：村長發布委託的事件 `cause` 含「AI」、`detail` 含 AI 動機；動機 49 字截為 40 字；未知 unitId 不影響其他角色；C99 與空白動機各自改用規則（原因「候選編號不在清單中」「缺少動機」）；沒回應到的角色用規則；冷卻中的 AI 選擇在套用時再驗證失敗改用規則；不是 JSON、版本錯、缺 decisions 整批規則 |
| 4 上下文只含已知事件；≤ 8,000 字元 | 通過 | 規則腳本：斥候目擊的事只出現在酋長區段，凱斯目擊的事只出現在村長區段，灰燼部族的勢力事件不出現在村長區段；灌入 60 件長事件時請求不超過 8,000 字元、每人事件數自動減到 8 件以下、兩位角色都保留；一般請求每人 8 件；Gemini schema 的 enum 正確 |
| 5 連線失敗、429、逾時、格式錯誤改用規則 | 通過 | Playwright：四種情況都只送 1 次、村長當天由規則決策、故事沒有「❌」、設定頁顯示「規則後備（AI 額度用完或請求太頻繁（HTTP 429））」「（無法連線至 AI 服務）」「（回應不是 JSON）」「（逾時（20 秒））」；逾時 20 秒後恢復操作 |
| 6 等待狀態；結果回來前讀檔則丟棄 | 通過 | Playwright：等待中選項列顯示「⚖️ 各方正在盤算…」、分組與輸入停用、故事區顯示說明，回來後恢復；延遲 4 秒時讀手動存檔，讀檔後立即恢復操作，5 秒後存檔沒有任何 AI 事件、時間仍是 23:00，設定頁顯示「結果已丟棄」 |
| 7 敘事、移動修正、角色決策共 3 次 | 通過 | Playwright：古道 23:00 移動回村，第一次敘事宣稱抵達巢穴 → 修正 → 角色決策，敘事 2 次＋角色 1 次＝3；規則腳本：`maxCallsPerTurn` 為 3，已用 2 次可再呼叫、已用 3 次不可 |
| 8 關閉角色 AI | 通過 | Playwright：取消勾選並儲存後跨日 0 次角色請求，村長仍由規則發布委託；設定頁「規則後備（設定已關閉角色 AI）」；重新載入後仍為關閉 |
| 9 設定頁說明 | 通過 | Playwright：「每回合最多呼叫 AI 3 次：敘事 1 次、移動修正 0～1 次、角色決策 0～1 次（只在跨日時）。上一次敘事請求約 7,697 tokens（14,239 字元）；上一次角色決策請求約 917 tokens（1,655 字元）」；「上次角色決策：AI」 |
| 10 HUD 世界紀錄只列已知事件、得知消息 | 通過 | Playwright：在古道跨日後，村長的委託與酋長的關係變化都不在 HUD、沒有「🌍 世界變化」；回村後 HUD 列出村長的委託，出現「🗞️ 告示板上的新消息與往來旅人的傳言：」並列出（1 件，≤ 3），巢穴的關係變化仍未列出；在村裡跨日時村長的決策立即列在 HUD 與「🌍 世界變化」 |
| 11 與玩家有關一律列出；witnesses 抵達也不列 | 通過 | 規則腳本：在場（即使 witnesses）、全世界周知、遠處聲望變化、玩家委託失敗立即得知；別人的遠處委託轉手不得知；抵達巢穴後得知當地地區／勢力事件（含例行重生，只進 HUD），witnesses 事件仍不得知；沒有移動時不重複得知 |
| 12 壓縮同步移除 | 通過 | 規則腳本：205 件事件壓縮後剩 150 件，已知清單 150 件且都在紀錄中 |
| 13 存讀檔保留；版本 14 捨棄 | 通過 | 規則腳本：寫入後讀回清單相同、版本 15；版本 14 與缺清單的存檔讀不出。Playwright：重新載入後清單相同（3 件）；把自動存檔改成版本 14 後重新載入回到建立角色 |
| 14 test:sim 與 main 相同 | 通過 | 分支與 main（暫時 worktree）各跑 1000 次，輸出只有換行格式不同：結局 END-1 500／350／128、END-2 3、未達成 19，保底 36.8%，疑似漏報 0，上下文最大 16,778 字元，重要角色行動次數相同 |
| 15 test:ai「角色決策」Flash-Lite 3/3 | 通過 | `npm run test:ai -- --models gemini-3.5-flash-lite --only 角色決策`：3/3，實際請求 3 次（每個情境 1 次，1,655～1,755 字元）。一般跨日與只知道部分事件：兩位角色都選維持現狀（有效）；村民遇襲：村長發布「討伐哥布林斥候」，動機「村民昨夜遭受哥布林斥候襲擊，我必須發布討伐委託來保護大家。」 |
| 16 通用檢查 | 通過 | `npm run build`（含 `validate:data`）、`npm run lint` 通過；`src/`（不含 `src/data/`）搜尋 `NPC-`、`MON-`、`MAP-`、`FAC-`、`EVT-`、`QTPL-`、`ITEM-`、橡木、哥布林、埃爾德、格羅姆、灰燼都沒有結果；Playwright 375px：盤算提示可見、頁面沒有橫向溢出，設定頁新增內容在畫面內 |

規則腳本 45/45、Playwright 38/38。Playwright 的 console 錯誤：除了情境 B 攔截回應時瀏覽器自動記錄的「Failed to load resource」（429、連線失敗），沒有其他錯誤。截圖在 session scratchpad `pw/`：`o34-2-thinking.png`（盤算中）、`o34-2-settings.png`（設定頁）、`o34-2-mobile-thinking.png`、`o34-2-mobile-settings.png`。

本次真實 AI 請求合計 3 次（只有 test:ai）。

## 製作 pre-mortem

假設「review 抓到嚴重問題」或「玩家第一次玩就壞了」：

| 可能失敗理由 | 證據／處理 |
| --- | --- |
| 套用 AI 結果時丟出例外，選項列永遠停在「盤算中」 | 已修：套用包在 try／finally，一定恢復操作，錯誤記為「套用失敗，本日未套用」（`App.tsx` `startAgentBatch`） |
| 結果回來前讀檔，舊結果套到別的存檔 | 已處理：讀檔世代＋世界 ID＋遊戲時間比對；Playwright 驗收 6 |
| 請求卡住 | 已處理：20 秒逾時；Playwright 實測 20 秒恢復 |
| 每回合超過 3 次 | 已處理：呼叫計數＋上限判斷；Playwright 計次 3 |
| 模擬被改壞 | `finalizeWorld` 不延後；test:sim 與 main 完全相同 |
| 「世界變化」少了原本看得到的訊息 | 刻意改變（規格風險 9）；在場事件、全世界周知、與玩家有關的仍立即顯示（驗收 10、11） |
| 等待中重新整理頁面，被選中的角色當天沒有決策 | **未修，交給 review 判斷**：等待中自動存檔照常寫入（敘事要保存），存檔裡被選中的角色還沒決策；重新整理後這些角色少決策一天（不會出錯，只是少一天）。要修需要在存檔記下待決批次，會改存檔格式，超出規格 |
| Flash-Lite 幾乎都選維持現狀 | 接受（規格風險 5）：test:ai 一般情境兩位都選維持現狀，有明確事件時會選委託；實際遊玩再觀察 |
| AI 讓領袖與遠方無關勢力的關係變化，世界變動比規則後備劇烈 | **觀察項目**：第 1 階段規則允許領袖對任何勢力改變一階，候選照此列出（已把非中立勢力排前面）。範例村長的候選可能包含「與艾德蘭王國的關係惡化」。若實玩覺得突兀，可在資料中限制領袖可改變關係的對象（需新決策） |
| OpenAI 路徑沒有實測 | **未測**：沒有 OpenAI 金鑰；請求格式與主持人相同（`json_object`），解析由前端驗證 |
| 同一世界接續新角色時，新角色沿用前一角色的已知事件 | 接受：清單屬於世界層（規格決策 16）；接續目前沒有入口（死亡改讀檔制） |
| 多段移動途經地區的事件不會得知 | 接受（實作細節，記在製作紀錄）：只看最後抵達的地區 |

## 第一輪 review 修正（2026-11-23）

逐條處理見規格書「Review 紀錄 › 第一輪 › 處理結果」。摘要：
- 應修 1 已修：重要角色的決策記在決策日的午夜；有移動的行動依出發／抵達時間判定在場，旅途中目的地的事件改為抵達時得知（`witnesses` 不得知），AI 批次套用沿用行動前位置。
- 建議 1～4 已修（執行函式擋住盤算中的新行動、「回應不是 JSON」、動機以字元截斷、`scenario.json` 的 `worldDescription`）。
- 建議 5 與上方 pre-mortem「等待中重新整理少決策一天」：接受，已寫進 CLAUDE.md「已知問題與待辦觀察」。
- 遠方勢力關係、OpenAI 未實測：待 Andrew 決定，程式未動。
- 重跑：build、lint、validate:data、內容 ID 搜尋通過；規則腳本 54/54；test:sim 與修正前相同；Playwright 38/38；test:ai 未跑（回應格式與提示內容未變）。本輪真實 AI 呼叫 0 次。

## 待 review 注意

- 「與近期事件相關」排除角色自己的決策（選項 B，2026-11-20 Andrew 確認），已寫進規格書決策 4。
- PROJECT_GOALS 中 O33、O39 延後的「設定頁費用預估」已在本階段做了（呼叫次數與 tokens，不換算金額），review 通過後一併標為完成。
- CLAUDE.md 的「目前進度」尚未改，review 通過、合併時再更新。
