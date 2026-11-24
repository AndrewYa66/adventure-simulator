# O45 交接單（給 review）

> 分支 `module/O45`，從 main `4ef0926`（含空 checkRequest 小修正）開出。規格書 `docs/specs/O45.md`。

## 變更範圍

| 檔案 | 內容 |
| --- | --- |
| `src/data/action_methods.json`（新） | 手段 → 結果表（伏擊、陷阱、攻擊）與 `combatRules`（失效時間、察覺、逃跑、居民再強制時間、預設陷阱時長、字詞清單），全部可調 |
| `src/data/staticData.ts` | 載入 `actionMethodData`、`combatRules`、`getActionMethod`；`validateActionMethodData` |
| `src/types/game.ts` | `CombatOpening`、`EncounterInfo`、手段表型別；`CombatState.opening`；`PlayerState.encounterInfo`、`residentAggro`；`AIResponsePayload.combatRequest`、`encounterEnded` |
| `src/utils/encounters.ts`（新） | 遭遇狀態、察覺、伏擊對象、失效、敵對居民、字詞判斷、建議過濾 |
| `src/utils/combatResolution.ts`（新） | 由 App 移出的攻擊／敵方回合／擊倒結算，加上逃跑、伏擊、設陷阱等待、敵方偷襲、被找上、`applyPostActionRules`、`resolveCombatRequest`、`startCombatByPlan` |
| `src/App.tsx` | 改用上述純函式；`preemptByEnemy`、`executeAmbush`、`executeSetTrap`、`commitCombatStep`；`runAiTurn` 處理 `combatRequest`、`encounterEnded`、宣稱偵測、建議過濾；`updatePlayer` 套用 `applyPostActionRules` |
| `src/utils/systemOptions.ts` | `ambush`、`trapWait` 選項 |
| `src/utils/travelRoute.ts` | 途中被找上改擲察覺（`foundByEnemy`） |
| `src/utils/playerStorage.ts`、`saveStorage.ts` | 新欄位正規化；`SAVE_SCHEMA_VERSION` 16 |
| `src/services/aiContext.ts`、`aiService.ts` | 回應格式第 6 版（schema、規則、可開戰對象、遭遇狀態與開場方式）；解析 |
| `src/components/PlayerHUD.tsx` | 開場方式、「你先發現對方」 |
| `scripts/ai-smoke-test.mjs` | 新分組「戰鬥前行動」8 個情境；輸出欄位加 `combatRequest`、`encounterEnded` |
| 文件 | `docs/API.md`（O45 段落、格式第 6 版、存檔第 16 版）、`docs/specs/O50.md`（O50-2 順延第 7 版）、`docs/PROJECT_GOALS.md`、`docs/製作流程.md`（補試玩步驟）、`CLAUDE.md` |

## 驗收證據

- build、lint、`validate:data`：通過。引擎與劇本分離：`src/`（不含 `src/data/`）搜尋具體 ID 與名稱為 0 筆。
- 暫時 Node 腳本（已刪除，固定 d20；在製作 pre-mortem 收斂字詞之前執行，用到的例句在收斂後仍符合）31/31：察覺成功／失敗（敵方偷襲後為第 1 回合、HP 100→95）、伏擊成功（傷害 19＝一般 13 × 1.5、敵人不反擊）、伏擊失敗、伏擊一擊擊殺（EXP +20＝單位經驗）、陷阱成功（剩 4＝30−7−19）、陷阱失敗（一般開場）、沒有敵人只是等待、安全地區不能設陷阱、遭遇 29 分鐘仍在／30 分鐘失效、逃跑成功／失敗（DC 15、回合 +1）、敵對居民進入時強制／30 分鐘內不再／30 分鐘後再強制／離開清除、Lv.1 偷襲一擊（斥候 5、打手 8、灰林狼 5，HP 100）、宣稱偵測正反例、建議過濾、打字說法、`combatRequest` 不合法 5 種、第 5 版回應可解析、第 6 版欄位解析、形狀不對視為 null、系統提示 10,165 字元。→ 驗收 2、3、4、5、6、7、10、11、12、13、14。
- Playwright（無頭 Edge，AI 以模擬回應攔截並計數，共 11 次模擬呼叫）24/24：
  - 1a 探索遭遇 → 選項列有伏擊與挑戰、提示玩家先發現；1b 改做等待 → 強制開戰、一般開場、不呼叫 AI、HUD 顯示「一般開戰（你先攻）」；1c 移動離開 → 不開戰、遭遇清除。（驗收 1、8）
  - 3 選項列伏擊：有伏擊檢定、不呼叫 AI、HUD 顯示伏擊開場。（驗收 3、8）
  - 9a 打字「我躲在樹後偷襲斥候」→ 伏擊、不呼叫 AI；9b「我衝上去一劍結果了牠的性命」→ 規則開戰。（驗收 9）
  - 10a `combatRequest` attack → 規則開戰、本回合只 1 次 AI 呼叫；10b 不合法的 ambush → 忽略並說明。（驗收 10）
  - 11 宣稱攻防 → 附「尚未交戰」說明、該回合人物記憶未寫入；12 建議行動過濾。（驗收 11、12）
  - 5a `encounterEnded` → 清除並提示；5b 超過 30 分鐘 → 失效並提示；5c 等待。（驗收 5）
  - 4a～4c 設陷阱等待：野外有、不呼叫 AI、安全地區沒有。（驗收 4）
  - 6 進入安全地區 → 敵對居民強制（本次為玩家先發現）。（驗收 6）
  - 7 逃跑有速度檢定。（驗收 7）
  - 8 讀檔後「玩家先發現」保留；手機寬度 375px 伏擊按鈕可見。（驗收 8、通用）
- `npm run test:sim`：通過（模擬程式未改）。（驗收 16）
- test:ai（Flash-Lite，`--models gemini-3.5-flash-lite`，22 次請求）：「戰鬥前行動」7/8，失敗的是「拉弓射擊」（沒有提出 `combatRequest`）；回歸「移動」4/5（「途中遭遇停在中途」在 main 就失敗）、「遭遇」1/1、「主線」3/3。（驗收 15）

## Review 第 1 輪後補充（修正後的分支）

- 暫時 Node 腳本（已刪除）17/17：收斂後的宣稱字詞正例 5（「刺中」「沒了氣息」「閃過了」「擊殺」「射中」）、反例 5（「眼中閃過一絲憂慮」「哥布林殺了我的羊」「年輕時受了傷」「一道閃光」「用性命保護村子」）；建議過濾（字詞改在資料檔，「刺探消息」「殺價買裝備」保留）；打字說法正反例；應修 1（抵達時已有遭遇不判定居民＋對照組）；建議 5（脫戰時 atMinutes 480 → 485）。→ 驗收 9、11、12，應修 1。
- Playwright 全套 36/36（AI 模擬呼叫 18 次；新增以頁面內固定骰點驅動的 12 條）：
  - R1-2a／2b：等待被打斷，察覺成功 → 玩家先發現、有伏擊選項；察覺失敗 → HUD「遭到偷襲（敵方先攻）」、「搶先出手」、HP 下降、仍在戰鬥。（驗收 2）
  - R1-7：逃跑失敗 → 「逃跑失敗」、敵人「反擊命中」、仍有戰鬥選項。（驗收 7）
  - R1-8：戰鬥中重新整理 → 讀回戰前存檔，沒有戰鬥、遭遇仍為「你先發現對方」。（驗收 8）
  - R1-9：「趁牠倒地補上一劍」→ 規則開戰。（驗收 9）
  - R1-6a～6f：進入村子 → 敵對居民（玩家先發現）；挑戰後逃跑成功；30 分鐘內等待照常進行、不再強制；再等待（超過 30 分鐘）→ 再次強制、原本的行動沒有進行；離開 → 紀錄清除；回來 → 再次強制。（驗收 6）
  - R1-應修2：非敵對遭遇的提示與選項列一致、伏擊按鈕 title 註明會使對方轉為敵對、沒有挑戰。
- build、lint、`validate:data` 通過；引擎與劇本分離搜尋 0 筆。

## 試玩後（P1 修正）

- 試玩紀錄見規格書「試玩紀錄」。P1（搜索檢定失敗卻顯示玩家先發現）已修。
- Playwright 全套 39/39（新增 PT-1a～1c；另把 5c 改為固定「不被打斷」的骰點，避免被打斷後進入戰鬥時讀不到自動存檔而誤判）；build、lint、`test:sim` 通過。

## 製作 pre-mortem

| 風險 | 處理 |
| --- | --- |
| 宣稱字詞太廣，NPC 說「眼中閃過一絲憂慮」「哥布林殺了我的羊」就被判成宣稱攻防並丟掉人物記憶 | 已修：字詞改為「閃過了」「擊殺」等攻防專用說法 |
| 打字補充攻擊字詞（「性命」「殺了」）讓一般對話誤觸開戰 | 已修：字詞收斂，且只在有敵人可交戰時生效 |
| 讀檔正規化丟掉新欄位，存讀檔後「玩家先發現」消失 | 已修：`playerStorage` 保留 `encounterInfo`、`residentAggro`、`combat.opening`；Playwright 8 驗證 |
| 敵方偷襲以第 0 回合表示，特殊能力在第 0 回合誤觸發 | 已修：先攻一擊不觸發特殊能力，結算後進入第 1 回合 |
| AI 用 `checkRequest` 而非 `combatRequest` 描寫射擊（test:ai「拉弓射擊」） | 未修，交給 review 判斷：前端的宣稱偵測會在敘事寫出命中時附說明；AI 的檢定不會給擊倒或經驗。可考慮在主持規則加「遠程攻擊也用 combatRequest」 |
| 強制開戰不接 AI 開戰敘事，戰鬥開場只有系統訊息 | 接受（規格 D13 精神、控制呼叫數）；手感交給 Andrew 測試 |
| 在敵對居民的地區，30 分鐘後每個行動都可能再被攻擊 | 依規格 D10；數值可調，試玩時觀察 |

## 未在範圍、留給之後

- 實測第 7、8 點（延後，已寫入 PROJECT_GOALS）。
- 說服、偷竊等手段（O50-2，回應格式第 7 版）。
