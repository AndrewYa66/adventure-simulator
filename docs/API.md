# API 文件

## 範圍與架構

本專案沒有自建後端 API。瀏覽器前端可選擇 Google Gemini 或 OpenAI，直接呼叫玩家選定的模型；兩種服務的回應都會轉成共用的 `AIResponsePayload`，並由前端驗證後套用遊戲狀態。

## 可選服務與模型

| 服務 | 模型 ID | API |
| --- | --- | --- |
| Google Gemini | `gemini-3.5-flash-lite`（預設）、`gemini-3.8-flash`、`gemini-3.6-flash` | Gemini `generateContent` |
| OpenAI | `gpt-6-luna`、`gpt-6.1-sol`、`gpt-6-astra` | OpenAI `Responses` |

模型清單由 `src/services/aiModels.ts` 管理。預設模型為 `gemini-3.5-flash-lite`：有免費額度且回應快，一般玩家不需付費即可遊玩（實測 14 個意圖情境的結構化欄位判斷正確，見 `npm run test:ai`）；尚未儲存設定的玩家以及設定失效時都會使用此模型。選定模型失敗時，系統會顯示錯誤，不會靜默切換到其他模型。

連線錯誤處理：503 與網路錯誤以退避重試 2 次。429 依額度種類處理：每日免費額度（Gemini `PerDay` 配額）或帳戶額度不足（OpenAI `insufficient_quota`）不重試，直接顯示可理解的訊息與預估恢復時間；每分鐘額度只在伺服器建議等待時間不超過 10 秒時重試一次，否則提示玩家等待秒數。Gemini 免費額度約為每個模型每分鐘 5 次、每天 20 次（依 Google 公告為準）。

## 共用前端介面

```ts
sendPlayerAction(
  settings: AIModelSettings,
  apiKey: string,
  playerState: PlayerState,
  actionText: string,
  storyHistory: string[]
): Promise<AIResponsePayload>
```

`settings.provider` 為 `gemini` 或 `openai`；`settings.model` 為該服務的模型 ID。近期劇情只傳入最後四筆。

## 提供者 API 呼叫

### Google Gemini

- `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- 使用 `x-goog-api-key` 標頭傳送 Key。
- JSON 模式使用 `generationConfig.responseMimeType = "application/json"`。
- 從 `candidates[0].content.parts[0].text` 讀取生成文字。

### OpenAI

- `POST https://api.openai.com/v1/responses`
- 使用 `Authorization: Bearer {apiKey}` 標頭。
- 將 GM 指令放在 `instructions`、玩家行動及近期劇情放在 `input`，並以 `text.format = { type: "json_object" }` 要求 JSON 模式。
- 從回應 `output` 中 `type = "output_text"` 的內容組合生成文字。

兩個提供者最後都會執行同一份執行期格式檢查。JSON 無法解析或欄位不合法時，若仍有可讀的 `storyText` 就只顯示該敘事；若回應是 JSON 原始內容或無法辨識的結構，顯示固定格式錯誤提示，不把 JSON 本文放進聊天視窗，也不套用狀態變更。429、503 及網路錯誤會有限次重試。

## 共用回應資料格式

成功回應必須包含 `storyText` 和 `suggestedActions`。其他欄位可省略：

```json
{
  "storyText": "你察覺林間傳來一陣急促的腳步聲。",
  "suggestedActions": ["躲到樹後", "拔出武器戒備"],
  "encounterRequest": null,
  "travelRequest": null,
  "serviceRequest": null,
  "checkRequest": {
    "stat": "spd",
    "dc": 12,
    "reason": "避開突然襲擊"
  },
  "checkOutcomes": {
    "successText": "你及時閃開，避過敵人的突襲。",
    "failureText": "你閃避不及，受到擦傷。"
  },
  "stateChanges": { "hpChange": 0, "expChange": 5, "questAcceptances": [], "unitDispositionChanges": [] },
  "failureStateChanges": { "hpChange": -3 },
  "eventProposals": []
}
```

有檢定時，`stat` 可為 `atk`、`def`、`spd`、`str`、`dex`、`con`、`int`、`wis`、`cha`，DC 限整數 5–25，且必須提供成功與失敗敘述。能力值檢定採 d20 + `floor((能力值 - 10) / 2)` + 種族/職階的 `checkBonuses`；攻防速使用種族 × 職階 × 等級公式計算的數值加上裝備加值（見下方「單位成長」）。成功時套用 `stateChanges`，失敗時套用 `failureStateChanges`。失敗分支不能發放經驗、道具、任務完成或擊敗怪物紀錄。

`encounterRequest` 只能指向本地區、已解鎖且玩家確實看見/接觸的魔物；遊戲驗證後才將其顯示在 HUD。每個單位明確定義預設對玩家關係（友善、中立、敵對），實際關係依「個人關係覆寫 → 所屬勢力聲望等級 → 單位預設值」判定（見「勢力聲望與勢力間關係」）；`stateChanges.unitDispositionChanges` 只能變更目前地區存活單位的關係，遊戲會保存覆寫。九大陣營描述價值傾向，不直接決定敵友；敵對 NPC 不可提供任務或交易，敵對 NPC 與已遭遇的敵對魔物都可由 HUD 發起戰鬥。NPC 與魔物的實例狀態（等級、經驗、HP、死亡、持有物）保存在玩家快照的 `unitInstances`；擊倒 NPC 時玩家取得該 NPC 實例的全部持有物與金幣（記錄於交易紀錄，NPC 持有物清空），並依劇本 `rules.npcKillGrantsExp`（目前為 `true`）以與魔物相同的公式獲得經驗；殺害的後果由勢力聲望承擔。明確攻擊友善/中立單位會視為挑釁並轉為敵對。

`stateChanges` 支援 HP/MP/EXP/金幣增減、道具增加/移除、怪物擊敗紀錄、單位關係變更、任務接受及任務完成回報。劇情旗標不能由 AI 直接設定（舊格式的 `setFlags` 會被忽略），只能經由世界事件成立（見下方「世界事件、世界修正與世界規則」）。AI 只能對遊戲提供的「目前地區可接取任務」提出 `questAcceptances: ["QST-001"]`；玩家詢問任務不等於接受。HUD 按鈕及對話接受會共用同一驗證，確認玩家位於任務指定地圖、任務給予者 NPC 確實在場且存活、非敵對，且任務尚未接取或完成。靜態任務資料定義需求、獎勵值及上下限，完成時再次檢查需求；交付道具會從背包扣除，獎勵只發放一次。NPC 靜態資料以 ID、姓名、職稱、種族、職階、等級和所在地圖定義，數值由單位成長公式計算，可用 `statAdjustments` 做有上限的相對修正。地圖的 `npcsPresent` 使用 NPC ID。消耗品的 `usableInCombat` 布林欄位控制是否可在戰鬥中使用，描述文字只用於說明；consumable 的 `effect.hpRestore`/`effect.mpRestore` 定義固定回復量；玩家可從 HUD 使用背包中的消耗品，回復不會超過角色資源上限，無實際回復時不扣除道具。戰鬥中使用消耗品會觸發敵方反擊與 d20 閃避檢定。戰鬥狀態以 `{ "round": 1, "participants": [{ "unitId": "PLAYER-001", "side": "party" }, { "unitId": "NPC-001", "side": "enemy", "currentHp": 20 }], "targetUnitId": "NPC-001" }` 表示，預留 O35 多對多戰鬥；我方 HP 存於各自存檔/實例，敵方 HP 於戰鬥中追蹤。目前規則仍為玩家對單一敵人，不同種類仍套用專屬掉落/能力規則。玩家存檔包含穩定單位 ID `unitId: "PLAYER-001"`（存檔中必須為此保留 ID）；共用查詢 `resolveWorldUnit(player, unitId)` 可辨識玩家、NPC 與魔物，玩家視圖的 `stats` 以與 NPC/魔物相同的公式計算並加上裝備。玩家 ID 不可作為 `unitDispositionChanges`、`encounterRequest` 或戰鬥目標，NPC/魔物資料也不得使用此 ID。主動技能定義於 `skills.json`，由職階的 `skillUnlocks` 依等級解鎖，技能 effect 定義傷害倍率，程式以 `max(1, floor(玩家 ATK × multiplier) - 敵方 DEF)` 計算傷害；技能消耗 MP 並消耗玩家回合。地圖移動使用獨立欄位 `travelRequest`，格式為 `{ "destinationMapId": "MAP-002" }`。Gemini GenerateContent 請求會使用 JSON Schema 強制包含所有回應欄位，並將 `travelRequest.destinationMapId` 限制為本次可移動的相鄰地圖 ID、將 `encounterRequest.monsterId` 限制為可遭遇魔物 ID、將 `questAcceptances` 限制為本區可接取任務 ID、將 `unitDispositionChanges.unitId` 限制為當前地區單位 ID；這保證格式與欄位，不代表語意正確，因此遊戲端仍會驗證。只有玩家明確要求移動時才設定；模型收到的可移動地區清單包含相鄰地圖 ID、正式名稱、專屬別名及分類標籤。泛稱地點會根據可到達候選和上一個地區解析；若仍有多個候選，前端要求玩家選擇，不把泛稱綁定到單一地圖。若 AI 敘事聲稱玩家已移動，但缺少或填錯 `travelRequest`，系統會附上合法目的地清單要求模型重產一次完整 JSON；仍無有效請求時不會移動，並會在對話明確提示。前端再次驗證地圖 ID、連通性及戰鬥狀態後，才更新 `currentMapId`。詢問地點、觀察或含糊意圖不會移動。回應不可用 `stateChanges` 修改地圖。

## 角色建立、章節任務與特殊戰鬥

新角色從 `playerSelectable` 職階中選擇，種族取自劇本設定的 `defaultPlayer.speciesId`；能力值、HP/MP 與攻防速依下方單位成長公式計算，起始裝備和物品由職階資料提供。角色可選九大陣營之一。靜態數值調整後，存檔中超出新上限的 HP/MP 會夾回上限，而非讓存檔失效。姓名與職稱只描述身份，不決定數值。NPC 的 `startingInventory`/`startingGold` 初始化為可保存的世界持有物；交易、任務交付和 NPC 物品轉移會改變此存檔狀態。

## 單位成長：種族、職階與等級

玩家、NPC、魔物共用同一套單位模型與公式（`src/utils/unitGrowth.ts`）：

- `species.json`：種族的數值倍率 `statMultipliers`（hp/mp/atk/def/spd）、能力值修正、檢定加值、擊倒經驗倍率、天生特性，以及可搭配的職階類別 `allowedClassCategories` 與是否允許無職階 `allowsNoClass`（例如野獸）。
- `character_classes.json`：24 種職階，`category` 為 `combat`／`social`／`life`，含 `playerSelectable`、數值倍率、能力值修正、`checkBonuses`、`expRewardMultiplier`、`skillUnlocks`；玩家可選職階另需 `startingItems`/`startingEquipment`。
- `level_benchmarks.json`：同等級強度基準表（Lv.1–10），定義各等級的標準 hp/mp/atk/def/spd、升級所需累計經驗 `requiredExp` 與基準擊倒經驗 `expReward`。
- 有效數值 = `round(基準[等級] × 種族倍率 × 職階倍率) + statAdjustments`（玩家再加裝備）；能力值 = 10 + 種族修正 + 職階修正（1–30）；擊倒經驗 = `round(基準 expReward × 種族倍率 × 職階倍率)`，不由資料手填。
- NPC/魔物資料是單位樣板（`speciesId`、`classId?`、`level`、`statAdjustments?`）；存檔的 `unitInstances` 是世界中實際的個體（`level`、`exp`、`currentHp`、`isDead`、`diedAtMinutes`、`gold`、`inventory`），數值依實例等級計算並疊加世界修正。存檔只保存與樣板預設不同的實例；讀檔時缺少的實例（包含靜態資料新增的單位）由樣板補上。
- 升級規則共用：累計經驗達基準表 `requiredExp` 即升級，升級增加的 HP 上限同步補給。NPC 上限為基準表最高等級；魔物上限為出沒地區建議等級上限 +3。單位擊倒玩家時獲得玩家的擊倒經驗。
- `npm run build` 會先執行 `npm run validate:data`（`scripts/validate-data.mjs`），拒絕不存在或不可搭配的種族/職階組合、超出基準表的等級、超過公式結果 50% 的 `statAdjustments`、超出地區上限的魔物等級、等級基準表不連續或遞減，以及劇本設定的無效起始地圖/職階。

## 劇本設定

`src/data/scenario.json` 集中存放劇本專屬內容：規則開關 `rules`（`npcKillGrantsExp`：擊倒 NPC 是否給經驗）、新角色接續設定 `succession`（`relatedLabel` 選項文字、`reputationInheritRatio` 聲望繼承比例，可省略）、主持人定位 `gmRole`、起始地圖/金幣/遊戲時間 `start`、預設角色 `defaultPlayer`（名稱、種族、職階、陣營）、開場文字 `opening`（`introText`、`resetText`、可用 `{name}`/`{className}` 的 `newCharacterText`、`suggestedActions`）、輸入框提示 `inputPlaceholder`，以及不屬於世界觀、玩家不可憑空取出的物品詞彙 `anachronisticItemTerms`。`src/` 程式碼（不含 `src/data/`）不出現具體內容 ID 或名稱，替換劇本資料即可更換開場與起始地點。

新手章節任務為 `QST-001` 清理綠林古道，完成後解鎖 `QST-002` 討伐哥布林酋長；`MAP-003` 哥布林巢穴需先接取 QST-002 才能進入，UI 和對話移動共用地圖解鎖驗證。`MON-003` 格羅姆・裂牙每第三回合使用「裂地重擊」，玩家進行敏捷 DC 14 檢定；失敗時受到 `floor(敵方 ATK × 1.5) - floor(玩家 DEF / 4)` 傷害，存活時昏迷一回合並跳過下一個行動。一般敵方反擊依防禦 DC 擲骰。HP 降至 0 即死亡，昏迷只由獨立狀態效果表示。

## 玩家自主行動與交易

明確的自我傷害指令（例如「對自己造成 1 點傷害」或「自殘 10 點生命」）由前端解析數值並直接套用 `hpChange`，不依賴 AI 是否正確輸出狀態欄位；若辨識到自傷意圖但無法確定數值，會先請玩家補充，不送交模型敘事。實際扣血不超過目前 HP，HP 歸零仍觸發死亡。其他會改變遊戲狀態的 AI 行動須使用 `stateChanges`、`travelRequest` 或 `checkRequest` 對應欄位，遊戲端才會更新狀態和 HUD。劇本設定 `anachronisticItemTerms` 所列、不屬於世界觀的物品要求（比對時忽略大小寫、空白與連字號）會在送 AI 前拒絕；AI 亦不可透過敘事或 `addItems` 生成庫存之外的物品。

商店由 `shops.json` 定義 NPC、商品清單及服務，NPC 以 `shopId` 關聯商店。玩家只能在商店 NPC 所在且該 NPC 出現在當前地圖時交易，戰鬥、死亡或昏迷時禁止交易。買賣需同時檢查玩家金幣/物品與商人金幣/庫存，並同步轉移雙方資產；任務道具不可出售。購買的武器、防具及飾品可從背包裝備。旅店提供 5 金幣的休息服務，恢復 HP/MP、推進遊戲時間 8 小時，並將費用轉入旅店老闆持有金幣；服務可由 HUD 按鈕或 AI 對話使用，兩者共用 `purchaseService` 規則。AI 回應必須包含 `serviceRequest`，格式為 `{ "shopId": "SHOP-002", "serviceId": "SERVICE-REST-001" }` 或 `null`；只可選擇遊戲提供的「當前可使用服務」（商店 NPC 在場、存活、非敵對，Gemini JSON Schema 以 enum 限制），且只在玩家明確要求使用服務時設定。前端驗證後才扣款、轉帳、恢復並推進時間，失敗時在對話中說明原因；AI 不可用 `hpChange`/`goldChange` 描述同一服務。同一回合若同時移動，服務請求不處理。服務與物品交易均保留最近 100 筆交易紀錄。遊戲時鐘以玩家存檔的 `gameTimeMinutes`（自世界開始經過的分鐘數，新角色為第 1 天 08:00）保存。時間只在有效行動完成後依行動類型固定推進：對話/任務接取與交付/一般 AI 回合 10 分鐘、買賣 10 分鐘、地區移動 2 小時、旅店休息 8 小時、每個戰鬥回合（含逃跑與昏迷失去的回合）1 分鐘、裝備/非戰鬥使用道具或治療技能/自傷 1 分鐘；被拒絕或要求釐清的行動不耗時。AI 回合若同時移動，只計移動耗時；若透過 `serviceRequest` 成功使用服務，只計服務耗時。原地等待是唯一可變時長的行動：玩家明確輸入時長（例如「等待 2 小時」「等一個半小時」「等 30 分鐘」「在這裡待三天」）時由前端解析並推進時間，不呼叫 AI；單次上限 8 小時，超過則不推進，並提示玩家原本要求的時長、上限與目前時間。以天、週、月、年為單位的時長（「等兩天」「等一整天」「等半天」「等幾天」）也會解析並拒絕；「睡／休息／度過」加上一天以上的時長同樣攔截，較短的休息照常交給 AI（例如使用旅店服務）。「三天後」「一天內」是時間點而非時長，不視為等待。等待只推進時間、不回復 HP/MP；戰鬥中、昏迷或死亡時不可等待。未指定時長的「原地等待」會要求玩家補充時長；「等到天亮」「等天亮」等依時段等待尚未支援（需日夜時段），會提示改用時長；「等一下」「等待村長回覆」等不含時長的句子照常交給 AI，但仍只計一般回合 10 分鐘。目前時間顯示於 HUD 與快照恢復訊息，並以「第 N 天 HH:MM」提供給 AI 上下文，AI 不能自行推進時間。任務交付必須在任務給予者所在區域進行，玩家可由 HUD 交付；需求道具轉入 NPC 持有物，獎勵物品/金幣只能從 NPC 現有存量發放，不足時標記短缺，不會憑空生成。AI 的 `npcItemTransfers` 只能轉移當前在場 NPC 實際持有且存在於靜態資料庫的物品。

戰鬥外可施放已解鎖的資源技能。範例「急救術」消耗 5 MP 恢復最多 20 HP；若 MP 不足或 HP 已滿，不消耗資源。戰鬥中的傷害技能與戰鬥外治療技能依效果類型分別提供，MP 消耗和效果由程式結算。

## 生死狀態

角色 HP 歸零即死亡，死亡狀態會隨快照保存並阻止後續遊戲行動；載入時 HP 為 0 的存檔一律視為死亡。昏迷由獨立 `statusEffects` 條目表示，不能以 HP 為 0 表示昏迷。

## 世界事件、世界修正與世界規則

世界的永久變動只經由事件入口套用並寫入事件紀錄（`src/utils/worldEvents.ts`）。每次行動造成的狀態變更都會經過 `finalizeWorld(之前, 之後, 死因提示)`，依序：記錄新的死亡、處理委託人死亡、結算玩家所在地區、觸發自動事件、移除過期的世界修正、壓縮事件紀錄。讀檔與換角色不是行動，不經過此流程。

- **事件紀錄** `world.events`（只增不改）：`{ id, type, gameTimeMinutes, mapId, summary, detail?, knownBy, witnessUnitIds, awareFactionIds, cause, death?, eventId?, changes?, reputationChanges? }`。`type` 為 `unit_death`、`unit_respawn`、`unit_occupation`（他方佔領）、`quest_failed`、`quest_transferred`（委託接手）、`reputation_change`（玩家聲望變化）、`scenario_event`。`summary` 是公開結果，`detail` 是經過與兇手等細節；`witnessUnitIds` 是事件發生時在場且存活的 NPC 與交戰中/已遭遇的魔物。`knownBy` 為 `witnesses`（目擊者）、`faction`（同勢力）、`region`（本地區）或 `world`（全世界）；`awareFactionIds` 在寫入時依傳播範圍決定：目擊者 → 目擊者所屬勢力；同勢力 → 指定勢力加目擊者勢力；本地區 → 另加在該地區有存活成員的勢力；全世界 → 所有勢力。超過 200 件時，最舊的事件壓縮成 `world.chronicle` 的一行摘要（最多 100 行）。
- **死亡事件**：NPC、頭目與玩家角色死亡時寫入，`death` 記錄死者、死因（`combat` 戰鬥、`self_inflicted` 自我了斷、`misadventure` 意外或風險行動、`unknown`）與兇手。呼叫端提供死因提示；未提供時依事件前的戰鬥狀態推斷。玩家角色的歷代紀錄以 `deathEventId`/`deathSummary` 引用死亡事件。一般魔物樣板代表一群個體，擊敗不寫死亡事件；頭目（`isBoss`）是唯一個體，擊敗即永久死亡。
- **知識範圍（暫定，正式規則見 O34）**：AI 收到目前地區、全世界周知、與在場 NPC 相關（目擊或死者原屬此地），或在場 NPC 所屬勢力得知的同勢力事件，取最近 12 件，加上編年史摘要。目擊者知道 `detail`；其他人只知道 `summary`，可轉述傳聞但不可斷定兇手或經過。
- **靜態事件** `src/data/events.json`：`{ id, title, trigger: "auto" | "aiProposal", requires?: { flags, unitsAlive, unitsDead, mapIds, reputation, factionRelations }, excludes?: { flags }, effects: { setFlags?, clearFlags?, worldModifiers?, reputation?, factionRelations? }, knownBy, knownByFactions?, summary, aiHint? }`。勢力條件與效果見「勢力聲望與勢力間關係」；`knownBy: "faction"` 時必須列出 `knownByFactions`。每個事件只觸發一次（`world.firedEventIds`）。`auto` 事件在條件成立時自動觸發；`aiProposal` 事件只能由 AI 在回應的 `eventProposals`（事件 ID 陣列，必填，沒有時為空陣列）提議，遊戲驗證條件成立後才套用，有檢定時只在成功時考慮。Gemini JSON Schema 將 `eventProposals` 限制為目前可提議的事件 ID，沒有候選時只允許空陣列。
- **世界修正** `world.modifiers`：`{ id, scope, stat, op, value, sourceEventId, expiresAtMinutes? }`，`scope` 為 `unit:<ID>`、`species:<ID>`、`map:<ID>`，`op` 為 `add`（整數加減）或 `multiply`（倍率）。一律為相對值：有效數值 = 公式數值先加總加減值、再乘以倍率後取整，因此調整靜態基礎數值後舊存檔的修正仍正確疊加。修正同樣作用於玩家（種族與所在地區）。事件的 `durationMinutes` 決定到期時間，到期後移除。
- **世界規則**（寫死於前端）：單位死亡處理如上；委託人死亡時，由同勢力、同職階且存活的 NPC 接手（優先同一地區），進行中的委託記錄新委託人 `activeQuests[].giverUnitId`，交付改在接手者所在地進行並寫入 `quest_transferred` 事件；沒有人選時委託變為 `failed`。種族的 `respawnDays` 決定非唯一個體死亡後幾天由新個體補上（具名 NPC 與頭目不重生）。**他方佔領**：單位樣板可設 `occupation: { byUnitId, afterDays }`，此單位死亡滿 `afterDays` 天後不重生，改由 `byUnitId` 出現在原地並寫入 `unit_occupation` 事件；被佔領單位必須設 `dormantUntilOccupation: true`，在此之前為潛伏狀態（實例 `isDormant: true`、視為不在場，不會出現在 HUD、AI 上下文與遭遇候選，也不算「已死亡」）。目前只有會真正死亡的單位（NPC 與頭目）能觸發佔領。商店 NPC 存活時，其商品庫存每個遊戲日最多補回一次至起始數量。
- **地區延後結算**：只結算玩家所在地區（`world.regions[mapId].lastRestockDay`），第一次進入只建立紀錄，之後依經過的遊戲日補貨與重生。
- **防止以等待刷資源**：補貨每日最多一次，重生依天數；非安全地區每等待滿一小時有 15% 機率被對玩家敵對、符合條件的魔物打斷（`src/utils/waitRules.ts`），只經過到打斷為止的時間並遭遇該魔物；安全地區不會被打斷。
- `npm run validate:data` 驗證事件 ID 格式與唯一性、觸發方式與傳播範圍、引用的單位/地圖/種族/勢力、聲望等級與勢力關係條件、世界修正格式，以及自動事件至少有一個旗標或單位條件。

## 勢力聲望與勢力間關係

勢力資料由劇本提供（`src/data/factions.json`，內容取自 `content/lore/FAC-xxx`），程式不寫死任何勢力（`src/utils/factions.ts`）。

- **資料格式**：`{ reputation: { min, max, tiers, rules }, relationTags, factions, relations }`。
  - `tiers`：聲望等級 `{ id, name, min, disposition? }`，`min` 為該等級最低值；目前為敵視（−100）、冷淡（−40）、中立（−10）、友好（25）、崇敬（60）。`disposition` 只能設在最低的連續等級（`hostile`）或最高的連續等級（`friendly`），保證聲望提高時態度不會變差；目前敵視 → 敵對、崇敬 → 友善，其他等級沿用單位預設關係。
  - `rules`：玩家行動的聲望變化量 `memberKilled`（−40）、`memberAttacked`（−15）、`questCompleted`（+10）、`enemyMemberKilled`（+5）。
  - `factions`：`{ id: "FAC-xxx", name, summary, initialReputation }`；`summary` 會提供給 AI，只能寫公開資訊。
  - `relations`：初始勢力關係 `{ factionIds: [A, B], status, tags? }`，`status` 為 `war` 交戰、`hostile` 敵對、`tense` 緊張、`neutral` 中立、`friendly` 友好、`alliance` 同盟；`tags` 為 `relationTags` 的 ID（債務、禁運、盟約、貿易往來）。未列出的組合視為中立。
- **單位所屬**：NPC 與魔物樣板的 `factionId` 指向勢力；沒有勢力的單位（例如野獸）只看個人覆寫與預設關係。
- **玩家聲望** `factionReputation`（角色存檔）：各勢力對目前角色的聲望值，夾在 `min`～`max`。新角色重置為各勢力 `initialReputation`；在同一世界接續且劇本設有 `succession` 時，角色建立畫面提供「與前任冒險者有關聯」選項，勾選後新聲望 = 初始值 + `reputationInheritRatio` ×（前角色聲望 − 初始值）。
- **勢力間關係** `world.factionRelations`（世界存檔）：只保存與 `factions.json` 初始值不同的組合，鍵為排序後的 `"FAC-A|FAC-B"`；改回初始值時移除。
- **聲望只經由事件改變，且只影響得知事件的勢力**（`finalizeWorld` 結算，寫入 `reputation_change` 事件，傳播範圍為同勢力）：
  - 主動攻擊原本非敵對的成員（本次行動開戰）：被攻擊者存活時其勢力必定得知，扣 `memberAttacked`；持續戰鬥不重複扣分。
  - 殺害成員：只有目擊者所屬勢力知道兇手。被害者勢力得知時扣 `memberKilled`（一擊斃命且原本非敵對時另扣 `memberAttacked`）；與被害者勢力敵對或交戰、且得知此事的其他勢力加 `enemyMemberKilled`。沒有目擊者時聲望不變，但死亡事件照常寫入。
  - 完成委託：目前委託人（含接手者）所屬勢力加 `questCompleted`。
  - 交易屬於例行行為，不改變聲望；背叛等劇情行為以靜態事件的聲望效果表達。
- **事件條件與效果**：`requires.reputation: [{ factionId, minTier?, maxTier? }]`（聲望等級區間，含兩端）、`requires.factionRelations: [{ factionIds, status: [...] }]`；`effects.reputation: [{ factionId, change }]`（由寫手指定，直接套用並記錄於 `reputationChanges`）、`effects.factionRelations: [{ factionIds, status?, addTags?, removeTags? }]`。同一套條件判定（`matchesFactionConditions`）預留給 O31 劇情片段與 O30 任務範本。
- **AI 上下文**：各勢力對玩家的聲望與等級、非中立或有附加關係的勢力組合、在場人物所屬勢力的公開簡介，以及在場 NPC 的所屬勢力。AI 不能直接改變聲望或勢力關係，只能經由可提議的事件。
- **HUD**：「勢力聲望」區塊列出各勢力的聲望值與等級（與初始值不同時一併顯示初始值）及勢力間關係；當前地區人物顯示所屬勢力；委託由他人接手時任務欄顯示新委託人。

## 設定保存

| Key | 保存方式 | 用途 |
| --- | --- | --- |
| `TRPG_AI_MODEL_SETTINGS` | `localStorage` | 選定的服務與模型 ID。 |
| `TRPG_GEMINI_KEY` | `localStorage` | Gemini API Key，沿用舊版設定。 |
| OpenAI API Key | 僅目前分頁的 React 記憶體 | 不寫入 `localStorage`；重新載入後須重新輸入。 |
| `TRPG_SAVE_INDEX` | `localStorage` | 存檔索引 `{ schemaVersion, activeWorldId, worlds: [{ id, name, scenarioId, createdAt, updatedAt }] }`。 |
| `TRPG_WORLD_<世界ID>_<欄位>` | `localStorage` | 存檔欄位 `{ schemaVersion, savedAt, world, character, messages }`；欄位為 `auto`、`manual-1`～`manual-3`。 |

## 存檔架構（世界與角色兩層）

- **兩層存檔**：每個存檔欄位分為 `world`（世界存檔：`gameTimeMinutes`、`unitInstances`、`storyFlags`、世界狀態 `world`（事件紀錄、編年史、世界修正、已觸發事件、地區結算、勢力間關係）與歷代角色紀錄 `characterHistory`）與 `character`（角色存檔：其餘玩家欄位，包含能力、背包、金幣、任務、戰鬥、單位對此角色的關係覆寫、各勢力聲望等）。哪些欄位屬於世界層由 `types/game.ts` 的 `WORLD_STATE_KEYS` 定義。執行期仍合併為 `PlayerState`，只在存讀檔時拆分與合併（`utils/saveStorage.ts`）。
- **存檔欄位**：每個世界一個自動存檔（狀態變更且非 AI 回合進行中時覆寫）與 3 個手動存檔。每個世界只有一條時間線：讀取手動存檔即取代目前進度，之後的自動存檔從該時間點繼續。可有多個世界，存檔索引記錄目前世界；切換世界即讀取該世界的自動存檔。
- **新角色接續**：角色死亡後可在同一世界建立新角色。世界層欄位保留，前一位角色以 `characterHistory`（名稱、種族、職階、等級、結束時間與地區、死亡事件 ID 與公開描述、攜帶物快照）記錄並提供給 AI 作為傳聞素材（最多 5 位）；新角色不繼承等級、背包、任務與單位關係；勢力聲望重置為初始值，或依劇本設定部分繼承（見「勢力聲望與勢力間關係」）。死亡遺物（O26）尚未實作，攜帶物快照留待之後使用。
- **匯出／匯入**：存檔管理可將一個世界的所有欄位匯出為 JSON（`format: "adventure-simulator-world"`）。匯入時驗證格式、版本、劇本與每個欄位內容，任何欄位無效即整份拒絕；一律以新世界 ID 匯入，不覆蓋任何現有存檔，寫入中途失敗會移除已寫入的欄位。
- **容量管理**：存檔管理顯示本遊戲在 localStorage 的估計用量（以約 5 MB 上限計），達 80% 時警示；寫入失敗（例如容量不足）時 HUD 提示匯出備份，其他欄位不受影響。事件紀錄超過 200 件即壓縮成編年史，且存檔只保存有差異的單位實例；目前容量足夠，暫不改用 IndexedDB。

存檔帶有 `schemaVersion`（`saveStorage.ts` 的 `SAVE_SCHEMA_VERSION`，目前為 5）。開發階段每次變更存檔格式就將版本加一；版本不符、缺少欄位或格式無效的存檔直接捨棄，不提供舊格式遷移；舊版單一快照（`TRPG_GAME_SESSION`、`TRPG_PLAYER_STATE`）在啟動時移除。正式上線後才開始為舊版本撰寫遷移。

## 金鑰安全限制

本專案目前是靜態前端，瀏覽器會直接送出 API 請求。Gemini Key 會保存於瀏覽器本機；OpenAI Key 雖不保存，但仍在瀏覽器執行並用於直接請求。OpenAI 官方建議不要在瀏覽器或其他用戶端程式碼暴露 API Key；正式公開部署應加入伺服器端代理，讓金鑰只保存在伺服器環境變數或金鑰管理服務。
