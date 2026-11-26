# O35-1 交接單（給 review）

> 分支 `module/O35-1`，從 main `fbdeff0`（O45 合併）開出。規格書 `docs/specs/O35-1.md`（含製作紀錄與驗收證據）。

## 變更範圍

| 檔案 | 內容 |
| --- | --- |
| `src/data/party_rules.json`（新） | 同伴上限 3、仇恨權重（玩家 2、同伴 1）、同伴治療門檻 0.4、起身 HP 1，皆可調 |
| `src/data/units.json` | 伊凡（NPC-006）加 `companion`（不敵對＋FAC-001 聲望 ≥ neutral、traits、voice）；`groupSize`：斥候 1～2、打手 1、狼 1～3 |
| `src/data/staticData.ts` | 載入 `partyRules`；隊伍感知的在場查詢 `isInParty`、`isUnitAtMap`、`getResidentIdsAt`、`getWorldUnitsAtMap(mapId, source)`；`validate:data` 檢查 companion、groupSize、party_rules、`partyJoin`／`partyLeave` |
| `src/types/game.ts` | `PlayerState.party`；單位實例 `currentMp`、`statusEffects`、`downed`；`CombatStatusEffect`（昏迷、嘲諷）；`CombatState` 改為 `participants`／`turnOrder`／`turnIndex`／`targetKey`／`opening`；死亡事件 `actorUnitId`／`actorName`；事件與劇情片段的 `partyJoin`／`partyLeave` |
| `src/utils/party.ts`（新） | 邀請條件、入隊、離隊、事件／劇情效果、自動離隊、休息全隊恢復 |
| `src/utils/combatState.ts`、`combatResolution.ts` | 多對多戰鬥：SPD 行動順序、自動結算到玩家回合、同伴規則行為、仇恨與嘲諷、倒地與起身、全隊逃跑、每個敵人各自結算、只結算吻合任務、開場方式；玩家行動統一走 `resolvePlayerCombatAction` |
| `src/utils/random.ts`（新） | 規則亂數集中、可注入固定亂數（只供驗證腳本） |
| `src/utils/gameChecks.ts` | 單位檢定 `resolveUnitCheck`（同伴與敵人用同一套 d20） |
| `src/utils/agents.ts` | 隊伍中暫停每日決策 |
| `src/utils/worldEvents.ts` | 事件／劇情片段入隊離隊效果；目擊者與發生地改為隊伍感知；`finalizeWorld` 結尾自動離隊；死亡事件記實際出手者 |
| `src/utils/applyStateChanges.ts`、`generatedQuests.ts` | AI 不能替同伴改關係、轉移物品、發委託 |
| `src/utils/tradeRules.ts` | 休息服務隊伍一起恢復；只有同伴受傷時也能休息 |
| `src/utils/systemOptions.ts`、`components/OptionBar.tsx` | 邀請／請離隊；戰鬥中「目標」「治療」「物品」分組；戰鬥外技能與物品可選同伴 |
| `src/components/PlayerHUD.tsx` | 「隊伍」區；戰鬥區（雙方 HP、行動順序、▶ 目前行動者、🎯 鎖定） |
| `src/utils/playerStorage.ts`、`saveStorage.ts` | 新欄位正規化；`SAVE_SCHEMA_VERSION` 17；戰鬥欄位讀檔時略過 |
| `src/services/aiContext.ts` | 「隊伍成員」區段、居民排除同伴、戰鬥中可讀的行動順序與雙方 HP；主持規則補同伴插話限制（D25、D26），含「口頭請同伴先走時同伴仍留在身邊」 |
| `src/App.tsx` | 戰鬥動作統一呼叫 `resolvePlayerCombatAction`；`handleInvite`、`handleDismiss`、`handleSwitchTarget`、對同伴的技能與道具；隊伍變化訊息統一在 `commitWorldUpdate` |
| `scripts/ai-smoke-test.mjs` | 戰鬥測資改新結構；新分組「同伴」6 情境 |
| 文件 | `docs/API.md`（隊伍與多對多戰鬥段落、單位欄位、存檔第 17 版、死亡事件出手者）、`docs/PROJECT_GOALS.md`（O35 狀態） |

## 驗收證據（詳見規格書製作紀錄）

- build、lint、`validate:data`：通過。引擎與劇本分離：`src/`（不含 `src/data/`）搜尋內容 ID 與名稱 0 筆。
- 暫時 Node 腳本（固定亂數，已刪除）68/68：驗收 2～14、16、17、20。
- Playwright（無頭 Edge，AI 以模擬回應攔截）38/38：驗收 1（14 項）；驗收 5、8、11、15、16、18、19（24 項）＋截圖。
- test:ai（Flash-Lite，共 28 次請求）：「同伴」第一輪 6/6（腳本判定）、收緊規則與判定後第二輪 5/6；回歸「戰鬥前行動」7/8、「遭遇」1/1。
- `npm run test:sim`：1000 次通過（結局可重現、上下文最大 18,025 字元、疑似漏報 0）。

## 製作 pre-mortem

假設「review 抓到嚴重問題」或「玩家第一次玩就壞了」：

| # | 可能原因 | 處理 |
| --- | --- | --- |
| 1 | 有戰鬥動作沒走 `resolvePlayerCombatAction`，行為分岔 | 已查：App 只在一處呼叫，選項列與打字都經由它（`src/App.tsx:882`）。請 review 再確認 |
| 2 | 引擎出現劇本內容 ID 或名稱 | 已搜尋，0 筆 |
| 3 | 同伴在場判定漏改某條路徑（例如某處仍直接讀 `map.unitsPresent`），同伴被當成原居所居民 | Playwright 驗收 1 與 Node 驗收 17 通過；**請 review 特別檢查**其他直接讀 `unitsPresent` 的地方（`applyStateChanges` 的擊倒計數、`getCombatStartBlock` 仍以地圖資料判定，這兩處對同伴無影響，因為同伴不能被攻擊、也不是被擊倒的對象） |
| 4 | Flash-Lite 把「玩家口頭請同伴先走」寫成同伴轉身離去（狀態上仍在隊伍） | 兩輪都出現；已在主持規則加一句，未改善。達到驗收門檻（≥ 5/6），**列為觀察**：之後可考慮前端偵測（類似 O45 的宣稱偵測）或在敘事後附說明，需 Andrew 決定 |
| 5 | 同伴在敘事中拒絕出手，但戰鬥中由規則照常攻擊，前後不一致 | 接受：O35-1 不開放指揮，敘事只是口吻；觀察手感 |
| 6 | 一回合的檢定卡片（每個行動者一張）在 3 隻敵人時很長 | 未改；截圖交給 Andrew 看手感（見下方） |
| 7 | 鎖定的敵人不是經由傷害倒下時 `targetKey` 不會換 | 只有測試會發生；`getCombatTarget` 會退回第一個站著的敵人，行為正確 |
| 8 | 商店經營者成為同伴後，商店仍以原居所判定 | 目前沒有這種資料，未處理（記在製作紀錄） |
| 9 | 灰林狼為中立，選項列沒有「挑戰」只有「伏擊」（O45 既有行為），玩家可能不知道怎麼和狼打 | 不是本模組造成，列給 Andrew |
| 10 | 戰鬥外「小型魔力藥水 → 伊凡」的選項文字顯示 HP 而不是 MP | 小問題，建議類；未改 |

## 請 review 特別看

- `src/utils/combatResolution.ts` 的 `runUntilPlayerTurn`、`runPartyFirstRound`、`runEnemyOpeningRound`（回合推進與安全上限）。
- `src/data/staticData.ts` 的 `getWorldUnitsAtMap`／`getResidentIdsAt` 與所有呼叫端是否都傳入了隊伍來源。
- `src/utils/playerStorage.ts`：倒地只存在於戰鬥中，讀檔時 `currentHp` 為 0 的實例視為死亡（戰鬥不存檔，正常流程不會存到倒地狀態）。

## Review 第 1 輪修正（2026-11-26，給第 2 輪 review）

逐條處理見規格書「Review 紀錄」第 1 輪表格，製作細節見「製作紀錄」的「review 第 1 輪修正」。重點：
- 新增 `src/utils/partyClaims.ts`（D34）、`party_rules.json` 的 `reviveRatio` 與 `narrativeChecks`、`items.json` 的復甦藥 `ITEM-005`（店與庫存）、`StoryMessage.partyDismissOptions`、OptionBar 的請離隊按鈕。
- `combatResolution.ts`：一般治療不救起倒地者、`revivePartyMember`、`getCombatActionBlock` 補倒地／復甦／技能解鎖與類型檢查、昏迷自動跳過推進時間、玩家戰死時整理同伴。
- `factions.ts`：地區勢力在場判定改為隊伍感知（與 review 建議的 `getResidentIdsAt` 不同，理由見製作紀錄）。
- 新的回歸測試 `npm run test:combat`（72 項）。
- 驗證：build、lint、分離檢查通過；test:combat 72/72；Playwright 59/59；test:ai「同伴」6/6（共 12 次請求）；test:sim 通過。

請第 2 輪特別看：`partyClaims.ts` 的字詞與誤判風險（目前偏保守：要提到名字、去掉引號、否定句不算）；復甦後不重排行動順序是否符合「下一次輪到他時才行動」。

## Review 第 2 輪（2026-11-26，通過）

阻擋 0、應修 0。建議 S7（給東西須提到具體道具或金幣）、S8（離隊意圖的否定）已在試玩前修正，見規格書 Review 紀錄第 2 輪表格；test:combat 79/79。下一步：試玩。

## 試玩與試玩後修正（2026-11-26）

試玩（Flash-Lite 10 次呼叫）發現 P1～P5，處理見規格書「試玩後處理」表格：P1 對同伴說離隊的話不再變成玩家移動；已在隊伍中的同伴被再邀請時不寫拒絕（上下文加隊伍身分、主持規則、`refuse` 偵測）；P2 戰鬥明細預設收起；P3 戰鬥結束後倒地同伴以 25% 起身；P4、P5 記入待辦。驗證：test:combat 85/85、Playwright 68/68、test:ai「同伴」7/7、test:sim 通過。下一步：Andrew 看手感、測試後合併。

## 給 Andrew 看手感的截圖

Playwright 截圖在製作電腦的 scratchpad（未加入版本控制），review 後試玩時再實際看：開戰時的戰鬥區、攻擊後一回合的訊息、伊凡倒地、手機寬度戰鬥。
