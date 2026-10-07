# API 文件

## 範圍與架構

本專案沒有自建後端 API。瀏覽器前端可選擇 Google Gemini 或 OpenAI，直接呼叫玩家選定的模型；兩種服務的回應都會轉成共用的 `AIResponsePayload`，並由前端驗證後套用遊戲狀態。

## 可選服務與模型

| 服務 | 模型 ID | API |
| --- | --- | --- |
| Google Gemini | `gemini-3.5-flash-lite`（預設）、`gemini-3.8-flash`、`gemini-3.6-flash` | Gemini `generateContent` |
| OpenAI | `gpt-6-luna`、`gpt-6.1-sol`、`gpt-6-astra` | OpenAI `Responses` |

模型清單由 `src/services/aiModels.ts` 管理。預設模型為 `gemini-3.5-flash-lite`：有免費額度且回應快，一般玩家不需付費即可遊玩（實測 14 個意圖情境的結構化欄位判斷正確，見 `npm run test:ai`）；尚未儲存設定的玩家以及設定失效時都會使用此模型。選定模型失敗時，系統會顯示錯誤，不會靜默切換到其他模型。

連線錯誤處理：503 與網路錯誤以退避重試 2 次。429 依額度種類處理：每日免費額度（Gemini `PerDay` 配額）或帳戶額度不足（OpenAI `insufficient_quota`）不重試，直接顯示可理解的訊息與預估恢復時間；每分鐘額度只在伺服器建議等待時間不超過 10 秒時重試一次，否則提示玩家等待秒數。Gemini 3.5 Flash-Lite 免費額度為每分鐘 15 次、每天 500 次（依 Google 公告為準）。

## 共用前端介面

```ts
sendPlayerAction(
  settings: AIModelSettings,
  apiKey: string,
  playerState: PlayerState,
  actionText: string,
  storyHistory: StoryMessage[],
  characterHistory?: CharacterHistoryEntry[]
): Promise<AIResponsePayload>
```

`settings.provider` 為 `gemini` 或 `openai`；`settings.model` 為該服務的模型 ID。`storyHistory` 是本回合行動之前的對話紀錄，由 `buildDialogueHistory` 取近期視窗放進使用者提示（見下方「近期對話與人物記憶」）；`characterHistory` 是同一世界的歷代角色紀錄。系統提示與 Gemini JSON Schema 由上下文組裝器 `buildAIContext`（`src/services/aiContext.ts`）產生，見下方「AI 上下文組裝與回應格式版本」。

## AI 上下文組裝與回應格式版本（O39）

- **區段**：系統提示由具名區段組成，依序為 `player`（玩家狀態、背包、裝備）、`legacy`（歷代角色）、`location`（所在與相鄰地區）、`npcs`、`factions`、`story`（主線，O31）、`quests`、`encounters`（戰鬥、遭遇候選、服務）、`items`（靜態物品清單）、`flags`、`worldEvents`、`chronicle`、`modifiers`、`proposableEvents`、`rules`（主持規則與 JSON 範例）。設定條目與角色卡區段待 O36 加入。
- **token 預算** `src/data/ai_context.json`：`totalBudgetChars`（整體字元上限，目前 20,000）、`maxCallsPerTurn`（每回合呼叫上限，目前 2：敘事 1 次 + 移動修正 1 次；設為 1 即不送修正請求）、`legacy.maxCharacters`／`maxDeedsPerCharacter`（5／5）、`worldEvents.maxEvents`（12）、`chronicle.maxLines`（送給 AI 的編年史行數，10；編年史壓縮設定見「世界事件、世界修正與世界規則」），以及可截斷區段的 `trimmableSections: { legacy, worldEvents, modifiers, chronicle }` 各自的 `priority`（數字越小越重要）與 `maxChars`。只有這四個歷史類區段可截斷；候選清單（地區、任務、遭遇、物品、可提議事件）與規則不截斷，避免 AI 看不到合法選項。截斷時先套用各區段上限，整體仍超出時從優先順序最低的區段繼續省略；列表從最舊的項目開始省略並在標籤註明省略筆數，歷代角色先省略各角色較舊的事蹟（每位保留最新一件，標示 `omittedDeeds`），最後才省略最早的角色。token 數以「中日韓文字 1 字 1 token、其他 4 字元 1 token」估算。2026-10-06 實測一般狀態約 13,200 字元（約 6,500 tokens）。
- **組裝報告**：每次呼叫記錄 `AIContextReport`（總字元、估計 tokens、預算、是否超出、各區段字元／上限／省略數、完整系統提示與使用者提示）。開發模式（`import.meta.env.DEV`）在 HUD 顯示「AI 上下文」面板；模型設定頁顯示每回合呼叫上限與上一次請求的估計大小。正式版不顯示面板。
- **歷代角色區段**：每位歷代角色（最多 5 位）提供 `generation`（代數）、名稱、種族職階等級、陣營、結束時間地點、`death`（死亡事件）與 `deeds`（事蹟）。事蹟為該角色任內（事件的 `characterSeq` 等於其代數）殺害 NPC 或頭目的死亡事件、未由殺害衍生的聲望事件（攻擊成員、完成委託）、以及 AI 提議並由玩家行動促成的劇本事件；一般魔物擊殺不列入。殺害造成的聲望事件以 `consequence` 附在死亡事件上，不重複列出。每件事蹟（與死亡事件）附上在場 NPC 的認知層級 `presentKnowledge`（見「世界事件、世界修正與世界規則」的認知層級），已列在此區段的事件不在世界事件區段重複；主持規則要求親眼目擊者被問到時明確說出前任冒險者做了什麼，傳聞者以聽說的口吻提到，公開消息者只知道結果。已壓縮進編年史的事件不再列為事蹟。
- **近期對話與人物記憶（O39 第二版）**：
  - 近期對話視窗（`buildDialogueHistory`）：設定在 `ai_context.json` 的 `dialogue`。取最近 `maxTurns` 輪（目前 8；一輪從玩家訊息開始，未取滿時連同開場敘事），`includeSystemMessages` 為 `false` 時排除系統訊息（戰鬥結算、道具使用等結果已反映在系統提示的狀態中）；每則超過 `maxCharsPerMessage`（400）時保留開頭並加上「…」，整段超過 `maxChars`（4,000）時從最舊的訊息捨棄。以「玩家:」「GM:」標示發言者放在使用者提示的【近期劇情回顧】；組裝報告另列 `dialogue` 區段（字元、上限、省略的較舊訊息數），不計入系統提示的 `totalBudgetChars`，但估計 tokens 包含使用者提示。
  - 人物記憶 `memoryNotes`（第 4 版必填陣列，沒有時為空陣列）：`[{ unitId, note }]`，AI 在本回合互動出現在場人物日後應記得的新資訊（玩家告知的名字或來歷、承諾、請託、透露的祕密、明顯改變印象的言行）時提出。前端以 `applyMemoryNotes`（`src/utils/unitMemory.ts`）驗證：人物須是行動前目前地區存活的居民（非遭遇型單位），每次最多 `memory.maxNotesPerResponse` 則（2），每則正規化空白後截到 `maxNoteChars`（40）字，與既有記憶相同則略過；不論檢定結果都寫入（對話已發生）。寫入世界層 `world.unitMemories[unitId]`（`{ note, gameTimeMinutes, characterSeq }`，舊→新），每人超過 `maxNotesPerUnit`（8）則時捨棄最舊的。系統提示的在場人物附上 `memories`（只含目前角色代數的記憶），主持規則要求自然延續、不可矛盾。不增加 AI 呼叫次數。
- **回應格式版本**：回應加入 `formatVersion`，目前為 `5`（`AI_RESPONSE_FORMAT_VERSION`），Gemini JSON Schema 要求填入此值。可解析的版本為 1、2、3、4、5；第 4 版加入 `memoryNotes`、第 5 版加入 `storyletProposals`，較舊版本沒有這些欄位時視為空陣列；沒有 `formatVersion` 的回應視為第 1 版。第 3 版（單位模型合併）將單位欄位改名：`encounterRequest.monsterId` → `unitId`、`stateChanges.npcItemTransfers[].npcId` → `unitItemTransfers[].unitId`、`defeatedMonsters[].monsterId` → `defeatedUnits[].unitId`；第 1、2 版回應的舊欄位名會在解析時轉成新名稱，第 3 版使用舊欄位名則視為格式錯誤。版本號不支援的回應會被拒絕：顯示「格式版本不受支援，本回合未套用任何變更」，不顯示其敘事、不套用狀態、不重試。日後新增請求類型（重要角色決策等）時提高版本號，並各自加上前端驗證。

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

成功回應必須包含 `storyText` 和 `suggestedActions`。其他欄位可省略（`formatVersion` 省略時視為第 1 版，見上方「回應格式版本」）：

```json
{
  "formatVersion": 5,
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
  "eventProposals": [],
  "questProposals": [],
  "memoryNotes": [{ "unitId": "<在場人物 ID>", "note": "玩家說自己在找失散的妹妹" }],
  "storyletProposals": []
}
```

有檢定時，`stat` 可為 `atk`、`def`、`spd`、`str`、`dex`、`con`、`int`、`wis`、`cha`，DC 限整數 5–25，且必須提供成功與失敗敘述。能力值檢定採 d20 + `floor((能力值 - 10) / 2)` + 種族/職階的 `checkBonuses`；攻防速使用種族 × 職階 × 等級公式計算的數值加上裝備加值（見下方「單位成長」）。成功時套用 `stateChanges`，失敗時套用 `failureStateChanges`。失敗分支不能發放經驗、道具、任務完成或擊敗怪物紀錄。

`encounterRequest`（`{ "unitId": "..." }`）只能指向本地區、已解鎖且玩家確實看見/接觸的需遭遇單位；遊戲驗證後才將其顯示在 HUD。每個單位明確定義預設對玩家關係（友善、中立、敵對），實際關係依「個人關係覆寫 → 所屬勢力聲望等級 → 單位預設值」判定（見「勢力聲望與勢力間關係」）；`stateChanges.unitDispositionChanges` 只能變更目前地區存活單位的關係，遊戲會保存覆寫。九大陣營描述價值傾向，不直接決定敵友；敵對的單位不可提供任務或交易；敵對的地區居民與已遭遇的敵對單位都可由 HUD 發起戰鬥。單位的實例狀態（等級、經驗、HP、死亡、持有物）保存在 `unitInstances`；擊倒的結算見「單位模型」。明確攻擊友善/中立單位會視為挑釁並轉為敵對。

`stateChanges` 支援 HP/MP/EXP/金幣增減、道具增加/移除、單位擊倒紀錄（`defeatedUnits`）、單位關係變更、任務接受及任務完成回報。劇情旗標不能由 AI 直接設定（舊格式的 `setFlags` 會被忽略），只能經由世界事件成立（見下方「世界事件、世界修正與世界規則」）。AI 只能對遊戲提供的「目前地區可接取任務」提出 `questAcceptances: ["QST-001"]`；玩家詢問任務不等於接受。HUD 按鈕及對話接受會共用同一驗證，確認玩家位於任務指定地圖、任務給予者（地區居民）確實在場且存活、非敵對，且任務尚未接取或完成。靜態任務資料定義需求、獎勵值及上下限，完成時再次檢查需求；交付道具會從背包扣除，獎勵只發放一次。單位樣板以 ID、名稱、稱號、種族、職階與等級定義，數值由單位成長公式計算，可用 `statAdjustments` 做有上限的相對修正；所在地由地圖的 `unitsPresent` 決定。消耗品的 `usableInCombat` 布林欄位控制是否可在戰鬥中使用，描述文字只用於說明；consumable 的 `effect.hpRestore`/`effect.mpRestore` 定義固定回復量；玩家可從 HUD 使用背包中的消耗品，回復不會超過角色資源上限，無實際回復時不扣除道具。戰鬥中使用消耗品會觸發敵方反擊與 d20 閃避檢定。戰鬥狀態以 `{ "round": 1, "participants": [{ "unitId": "PLAYER-001", "side": "party" }, { "unitId": "NPC-001", "side": "enemy", "currentHp": 20 }], "targetUnitId": "NPC-001" }` 表示，預留 O35 多對多戰鬥；我方 HP 存於各自存檔/實例，敵方 HP 於戰鬥中追蹤。目前規則仍為玩家對單一敵人。玩家存檔包含穩定單位 ID `unitId: "PLAYER-001"`（存檔中必須為此保留 ID）；共用查詢 `resolveWorldUnit(player, unitId)` 可辨識玩家與其他單位，玩家視圖的 `stats` 以相同公式計算並加上裝備。玩家 ID 不可作為 `unitDispositionChanges`、`encounterRequest` 或戰鬥目標，單位資料也不得使用此 ID。主動技能定義於 `skills.json`，由職階的 `skillUnlocks` 依等級解鎖，技能 effect 定義傷害倍率，程式以 `max(1, floor(玩家 ATK × multiplier) - 敵方 DEF)` 計算傷害；技能消耗 MP 並消耗玩家回合。地圖移動使用獨立欄位 `travelRequest`，格式為 `{ "destinationMapId": "MAP-002" }`。Gemini GenerateContent 請求會使用 JSON Schema 強制包含所有回應欄位，並將 `travelRequest.destinationMapId` 限制為本次可移動的相鄰地圖 ID、將 `encounterRequest.unitId` 限制為可遭遇單位 ID、將 `questAcceptances` 限制為本區可接取任務 ID、將 `unitDispositionChanges.unitId` 限制為當前地區單位 ID；這保證格式與欄位，不代表語意正確，因此遊戲端仍會驗證。只有玩家明確要求移動時才設定；模型收到的可移動地區清單包含相鄰地圖 ID、正式名稱、專屬別名及分類標籤。泛稱地點會根據可到達候選和上一個地區解析；若仍有多個候選，前端要求玩家選擇，不把泛稱綁定到單一地圖。若 AI 敘事聲稱玩家已移動，但缺少或填錯 `travelRequest`，系統會附上合法目的地清單要求模型重產一次完整 JSON（受 `ai_context.json` 的 `maxCallsPerTurn` 限制）；判斷敘事是否宣稱移動時，會略過引號內的對話（「」『』“”）以及移動動詞前帶有過去、假設或打算語氣（例如曾經、上次、打算、如果、等你）的句子，避免人物談到其他地名時誤送修正請求；前端從玩家文字判斷的明確移動意圖（會優先於 AI 的 `travelRequest`）排除否定、詢問（含「嗎」與問號）、過去經歷（上次、以前、曾）與安危打聽，例如「你上次去那裡是什麼時候？」不算移動；仍無有效請求時不會移動，並會在對話明確提示。前端再次驗證地圖 ID、連通性及戰鬥狀態後，才更新 `currentMapId`。詢問地點、觀察或含糊意圖不會移動。回應不可用 `stateChanges` 修改地圖。

**多段移動與先移動再敘事（O44）**：
- `src/utils/travelRoute.ts` 的 `getReachableRoutes(player)`／`findTravelRoute` 以相連地圖與 `canPlayerEnterMap` 求最短路徑；`travelAlongRoute(player, mapId, random?)` 逐段移動（每段 `ACTION_DURATIONS.travel`），途經的中間地區以 `rollWaitInterruption` 擲遭遇，被打斷就停下並設定 `encounteredUnitId`；最多走 `scenario.json` 的 `rules.routeTravel.maxSegmentsPerAction` 段。回傳 `{ player, origin, destination, arrived, passed, elapsedMinutes, interruptedByUnitId?, stoppedBySegmentLimit }`。
- 前端移動意圖的候選是所有可抵達地區；泛稱取最近的符合地區，同樣近的有多個時列出按鈕。HUD 與按鈕的移動同樣走 `travelAlongRoute`。
- 玩家文字的移動意圖明確時，送 AI 前先移動：`sendPlayerAction(..., resolvedTravel)` 以移動後的狀態組裝上下文，並在使用者提示附上「本回合移動結果（遊戲已結算）」；AI 依實際抵達地敘事，`travelRequest` 須為 null 且會被忽略，該回合不另計對話時間。意圖不明確時仍由 AI 提出相鄰的 `travelRequest`。
- 一致性：`getClaimedArrivalMapIds(text, currentMapId, ignoreMapIds)` 找出敘事宣稱抵達的其他地區（略過引號內對話與非實際語氣，`ignoreMapIds` 為本回合途經的地區）。已先移動時宣稱與實際所在地不符、或 `travelRequest` 合法但敘事宣稱抵達另一個地區時，會送修正請求（受 `maxCallsPerTurn` 限制）；修正後仍不符或額度不足時，訊息後附上「系統說明：你實際位於某地」。

## 角色建立、章節任務與特殊戰鬥

新角色從 `playerSelectable` 職階中選擇，種族取自劇本設定的 `defaultPlayer.speciesId`；能力值、HP/MP 與攻防速依下方單位成長公式計算，起始裝備和物品由職階資料提供。角色可選九大陣營之一。靜態數值調整後，存檔中超出新上限的 HP/MP 會夾回上限，而非讓存檔失效。姓名與職稱只描述身份，不決定數值。單位的 `startingInventory`/`startingGold` 初始化為可保存的世界持有物；交易、任務交付和單位物品轉移會改變此存檔狀態。

## 單位模型（units.json）

玩家以外的所有單位使用同一個樣板結構 `UnitStatic`（`src/data/units.json`），不再區分 NPC 與魔物；引擎只看下列欄位，「人物」「魔物」只是劇本內容的說法。ID 沿用寫手的編號習慣（`NPC-xxx`、`MON-xxx`），引擎不依前綴判斷。

| 欄位 | 意義 | 引擎行為 |
| --- | --- | --- |
| `population` | 族群樣板：代表一群可重複遭遇的個體 | 擊倒不寫死亡事件、依種族 `respawnDays` 重生；未設定即為具名的唯一個體（死亡永久、寫入死亡事件、不重生） |
| `requiresEncounter` | 需要遭遇才會出現 | 進入地區時不在場，須探索遭遇（AI `encounterRequest` 或等待打斷）後才能交戰；安全地區不會遭遇；每次戰鬥以完整 HP 開始；成長上限為出沒地區建議等級 +3；可作為支線委託的討伐目標。未設定即為**地區居民**：進入地區即在場，可交談、交易、發布委託與成為委託接手者，戰鬥 HP 保留在實例中，成長上限為基準表最高等級 |
| `isBoss` | 頭目 | 擊倒時顯示勝利訊息；不可同時是族群 |
| `requiredQuestId` | 前置任務 | 只有此任務進行中時才能遭遇 |
| `title`、`enName`、`tier`、`description`、`tactics` | 顯示與給 AI 的描述 | 顯示名稱為「稱號 + 名字」 |
| `shopId` | 經營的商店 | 經營者在場（居民，或已遭遇的需遭遇單位）、存活、非敵對時可交易 |
| `startingGold`、`startingInventory` | 初始持有物（世界實際庫存） | 交易、委託報酬、物品轉移與擊倒取得都以實例持有物為準 |
| `loot` | 掉落表（`gold` 與 `dropItems[].chance`） | 擊倒時另外擲骰產生 |
| `specialAbilities` | 特殊招式（可含 `combatAction`） | 敵方回合依 `triggerEveryRounds` 施放 |

- **出現地點**：地圖的 `unitsPresent` 列出出現在該地區的單位（取代原本的 `npcsPresent`／`monstersPresent`）。單位的 `mapIds` 由此推得，`homeMapId` 為第一張列出它的地圖；地區居民只能列在一張地圖，族群樣板必須是需遭遇單位。
- **擊倒**：任何單位都走同一流程：取得其持有物、依掉落表擲骰、記入 `defeatedUnits` 與任務進度、依公式給予經驗。地區居民的經驗可由 `scenario.json` 的 `rules.residentKillGrantsExp` 關閉（目前為 `true`），需遭遇單位一律給予；殺害的後果由勢力聲望承擔。唯一個體擊倒即永久死亡。
- **商店**：`shops.json` 以 `ownerUnitId` 指向經營者，經營者的 `shopId` 必須指回該商店。
- **任務需求**：`requirements.defeatUnits: [{ unitId, quantity }]`；玩家的擊倒計數為 `defeatedUnits`。
- 共用查詢：`getWorldUnitById`、`getWorldUnitsAtMap`、`getResidentUnitIds(map)`、`getEncounterUnitIds(map)`（`src/data/staticData.ts`）。`validateWorldUnitData` 檢查上述規則與參照。

## 單位成長：種族、職階與等級

玩家與所有單位共用同一套公式（`src/utils/unitGrowth.ts`）：

- `species.json`：種族的數值倍率 `statMultipliers`（hp/mp/atk/def/spd）、能力值修正、檢定加值、擊倒經驗倍率、天生特性，以及可搭配的職階類別 `allowedClassCategories` 與是否允許無職階 `allowsNoClass`（例如野獸）。
- `character_classes.json`：24 種職階，`category` 為 `combat`／`social`／`life`，含 `playerSelectable`、數值倍率、能力值修正、`checkBonuses`、`expRewardMultiplier`、`skillUnlocks`；玩家可選職階另需 `startingItems`/`startingEquipment`。
- `level_benchmarks.json`：同等級強度基準表（Lv.1–10），定義各等級的標準 hp/mp/atk/def/spd、升級所需累計經驗 `requiredExp` 與基準擊倒經驗 `expReward`。
- 有效數值 = `round(基準[等級] × 種族倍率 × 職階倍率) + statAdjustments`（玩家再加裝備）；能力值 = 10 + 種族修正 + 職階修正（1–30）；擊倒經驗 = `round(基準 expReward × 種族倍率 × 職階倍率)`，不由資料手填。
- `units.json` 是單位樣板（`speciesId`、`classId?`、`level`、`statAdjustments?`）；存檔的 `unitInstances` 是世界中實際的個體（`level`、`exp`、`currentHp`、`isDead`、`diedAtMinutes`、`gold`、`inventory`），數值依實例等級計算並疊加世界修正。存檔只保存與樣板預設不同的實例；讀檔時缺少的實例（包含靜態資料新增的單位）由樣板補上。
- 升級規則共用：累計經驗達基準表 `requiredExp` 即升級，升級增加的 HP 上限同步補給。地區居民上限為基準表最高等級；需遭遇單位上限為出沒地區建議等級上限 +3。單位擊倒玩家時獲得玩家的擊倒經驗。
- `npm run build` 會先執行 `npm run validate:data`（`scripts/validate-data.mjs`），拒絕不存在或不可搭配的種族/職階組合、超出基準表的等級、超過公式結果 50% 的 `statAdjustments`、超出地區上限的需遭遇單位等級、地圖與商店的單位參照、等級基準表不連續或遞減，以及劇本設定的無效起始地圖/職階。

## 劇本設定

`src/data/scenario.json` 集中存放劇本專屬內容：規則開關 `rules`（`residentKillGrantsExp`：擊倒地區居民是否給經驗）、新角色接續設定 `succession`（`relatedLabel` 選項文字、`reputationInheritRatio` 聲望繼承比例，可省略）、主持人定位 `gmRole`、起始地圖/金幣/遊戲時間 `start`、預設角色 `defaultPlayer`（名稱、種族、職階、陣營）、開場文字 `opening`（`introText`、`resetText`、可用 `{name}`/`{className}` 的 `newCharacterText`、`suggestedActions`）、輸入框提示 `inputPlaceholder`，以及不屬於世界觀、玩家不可憑空取出的物品詞彙 `anachronisticItemTerms`。`src/` 程式碼（不含 `src/data/`）不出現具體內容 ID 或名稱，替換劇本資料即可更換開場與起始地點。

新手章節任務為 `QST-001` 清理綠林古道，完成後解鎖 `QST-002` 討伐哥布林酋長；`MAP-003` 哥布林巢穴需先接取 QST-002 才能進入，UI 和對話移動共用地圖解鎖驗證。`MON-003` 格羅姆・裂牙每第三回合使用「裂地重擊」，玩家進行敏捷 DC 14 檢定；失敗時受到 `floor(敵方 ATK × 1.5) - floor(玩家 DEF / 4)` 傷害，存活時昏迷一回合並跳過下一個行動。一般敵方反擊依防禦 DC 擲骰。HP 降至 0 即死亡，昏迷只由獨立狀態效果表示。

## 玩家自主行動與交易

明確的自我傷害指令（例如「對自己造成 1 點傷害」或「自殘 10 點生命」）由前端解析數值並直接套用 `hpChange`，不依賴 AI 是否正確輸出狀態欄位；若辨識到自傷意圖但無法確定數值，會先請玩家補充，不送交模型敘事。實際扣血不超過目前 HP，HP 歸零仍觸發死亡。其他會改變遊戲狀態的 AI 行動須使用 `stateChanges`、`travelRequest` 或 `checkRequest` 對應欄位，遊戲端才會更新狀態和 HUD。劇本設定 `anachronisticItemTerms` 所列、不屬於世界觀的物品要求（比對時忽略大小寫、空白與連字號）會在送 AI 前拒絕；AI 亦不可透過敘事或 `addItems` 生成庫存之外的物品。

商店由 `shops.json` 定義經營者 `ownerUnitId`、商品清單及服務，經營者以 `shopId` 指回商店。玩家只能在經營者出現在當前地圖時交易，戰鬥、死亡或昏迷時禁止交易。買賣需同時檢查玩家金幣/物品與商人金幣/庫存，並同步轉移雙方資產；任務道具不可出售。購買的武器、防具及飾品可從背包裝備。旅店提供 5 金幣的休息服務，恢復 HP/MP、推進遊戲時間 8 小時，並將費用轉入旅店老闆持有金幣；服務可由 HUD 按鈕或 AI 對話使用，兩者共用 `purchaseService` 規則。AI 回應必須包含 `serviceRequest`，格式為 `{ "shopId": "SHOP-002", "serviceId": "SERVICE-REST-001" }` 或 `null`；只可選擇遊戲提供的「當前可使用服務」（經營者在場、存活、非敵對，Gemini JSON Schema 以 enum 限制），且只在玩家明確要求使用服務時設定。前端驗證後才扣款、轉帳、恢復並推進時間，失敗時在對話中說明原因；AI 不可用 `hpChange`/`goldChange` 描述同一服務。同一回合若同時移動，服務請求不處理。服務與物品交易均保留最近 100 筆交易紀錄。遊戲時鐘以玩家存檔的 `gameTimeMinutes`（自世界開始經過的分鐘數，新角色為第 1 天 08:00）保存。時間只在有效行動完成後依行動類型固定推進：對話/任務接取與交付/一般 AI 回合 10 分鐘、買賣 10 分鐘、地區移動 2 小時、旅店休息 8 小時、每個戰鬥回合（含逃跑與昏迷失去的回合）1 分鐘、裝備/非戰鬥使用道具或治療技能/自傷 1 分鐘；被拒絕或要求釐清的行動不耗時。AI 回合若同時移動，只計移動耗時；若透過 `serviceRequest` 成功使用服務，只計服務耗時。原地等待是唯一可變時長的行動：玩家明確輸入時長（例如「等待 2 小時」「等一個半小時」「等 30 分鐘」「在這裡待三天」）時由前端解析並推進時間，不呼叫 AI；單次上限 8 小時，超過則不推進，並提示玩家原本要求的時長、上限與目前時間。以天、週、月、年為單位的時長（「等兩天」「等一整天」「等半天」「等幾天」）也會解析並拒絕；「睡／休息／度過」加上一天以上的時長同樣攔截，較短的休息照常交給 AI（例如使用旅店服務）。「三天後」「一天內」是時間點而非時長，不視為等待。等待只推進時間、不回復 HP/MP；戰鬥中、昏迷或死亡時不可等待。未指定時長的「原地等待」會要求玩家補充時長；「等到天亮」「等天亮」等依時段等待尚未支援（需日夜時段），會提示改用時長；「等一下」「等待村長回覆」等不含時長的句子照常交給 AI，但仍只計一般回合 10 分鐘。目前時間顯示於 HUD 與快照恢復訊息，並以「第 N 天 HH:MM」提供給 AI 上下文，AI 不能自行推進時間。任務交付必須在任務給予者所在區域進行，玩家可由 HUD 交付；需求道具轉入委託人持有物，獎勵物品/金幣只能從委託人現有存量發放，不足時標記短缺，不會憑空生成。AI 的 `unitItemTransfers` 只能轉移當前在場居民（或已遭遇的單位）實際持有且存在於靜態資料庫的物品。

戰鬥外可施放已解鎖的資源技能。範例「急救術」消耗 5 MP 恢復最多 20 HP；若 MP 不足或 HP 已滿，不消耗資源。戰鬥中的傷害技能與戰鬥外治療技能依效果類型分別提供，MP 消耗和效果由程式結算。

## 生死狀態

角色 HP 歸零即死亡，死亡狀態阻止後續遊戲行動；載入時 HP 為 0 的存檔一律視為死亡。死亡採一般讀檔制：自動存檔不保存死亡狀態與戰鬥中狀態、死亡狀態與戰鬥中禁止手動存檔（戰鬥中死亡會回到該場戰鬥開始前），故事區顯示讀檔訊息與「讀取自動存檔（死亡前）」「開啟存檔管理」兩個按鈕（見「存檔架構」）。昏迷由獨立 `statusEffects` 條目表示，不能以 HP 為 0 表示昏迷。

## 世界事件、世界修正與世界規則

世界的永久變動只經由事件入口套用並寫入事件紀錄（`src/utils/worldEvents.ts`）。每次行動造成的狀態變更都會經過 `finalizeWorld(之前, 之後, 死因提示)`，依序：記錄新的死亡、處理委託人死亡、結算玩家所在地區、觸發自動事件、移除過期的世界修正、壓縮事件紀錄。讀檔與換角色不是行動，不經過此流程。

- **事件紀錄** `world.events`（只增不改）：`{ id, type, gameTimeMinutes, mapId, summary, detail?, knownBy, witnessUnitIds, awareFactionIds, cause, death?, eventId?, changes?, reputationChanges?, characterSeq?, sourceEventId? }`。`characterSeq` 是事件發生時在世的玩家角色代數（每個事件寫入時都會標記），用來把事件連結到歷代角色；`sourceEventId` 是衍生事件的來源，例如殺害造成的聲望事件引用該死亡事件。`type` 為 `unit_death`、`unit_respawn`、`unit_occupation`（他方佔領）、`quest_failed`、`quest_transferred`（委託接手）、`reputation_change`（玩家聲望變化）、`scenario_event`、`story_progress`（劇情片段完成與進入結局，見「主線：幕與劇情片段」）。`summary` 是公開結果，`detail` 是經過與兇手等細節；`witnessUnitIds` 是事件發生時在場且存活的 NPC 與交戰中/已遭遇的魔物。`knownBy` 為 `witnesses`（目擊者）、`faction`（同勢力）、`region`（本地區）或 `world`（全世界）；`awareFactionIds` 在寫入時依傳播範圍決定：目擊者 → 目擊者所屬勢力；同勢力 → 指定勢力加目擊者勢力；本地區 → 另加在該地區有存活成員的勢力；全世界 → 所有勢力。事件紀錄超過 `ai_context.json` 的 `chronicle.maxEvents`（200）件時，最舊的 `compressBatch`（50）件加上超出的部分以規則壓縮進 `world.chronicle`（O33，`summarizeEventsForChronicle`）：重要事件一件一行（`第 N 天 HH:MM｜地點｜摘要`）；`routineEventTypes`（目前只有 `unit_respawn`）類型的例行事件依類型與地點合併成一行（`第 A～B 天｜地點｜最後一件的摘要（共 N 次）`），各行依該組第一件事件的時間排序；編年史最多保存 `maxStoredLines`（100）行。壓縮不呼叫 AI。
- **死亡事件**：NPC、頭目與玩家角色死亡時寫入，`death` 記錄死者、死因（`combat` 戰鬥、`self_inflicted` 自我了斷、`misadventure` 意外或風險行動、`unknown`）與兇手。呼叫端提供死因提示；未提供時依事件前的戰鬥狀態推斷。玩家角色的歷代紀錄以 `deathEventId`/`deathSummary` 引用死亡事件。一般魔物樣板代表一群個體，擊敗不寫死亡事件；頭目（`isBoss`）是唯一個體，擊敗即永久死亡。
- **知識範圍與認知層級（O39；重要角色決策的知識範圍見 O34）**：AI 收到目前地區、全世界周知、與在場 NPC 相關（目擊或死者原屬此地），或在場 NPC 所屬勢力得知的同勢力事件，取最近 12 件（`ai_context.json` 的 `worldEvents.maxEvents`），加上編年史摘要（最近 10 行，視為傳說）。每件事以 `presentKnowledge` 列出在場 NPC 的認知層級（`getEventKnowledgeLevel`）：**親眼目擊**（`witnessUnitIds` 中的單位，知道 `detail`，不會淡化）、**傳聞**（與目擊者同勢力但未在場，事件有 `detail` 時聽說了兇手或死因，不知道經過；附 `heardFrom` 目擊者名單）、**公開消息**（`awareFactionIds` 中勢力的成員、全世界周知事件，或住在事件地區的無勢力 NPC，只知道 `summary`）、**傳說**（傳聞或公開消息經過 `knowledge.legendAfterDays` 天，目前 30 天，只剩模糊往事），其餘為不知道。`detail` 只出現在親眼目擊者的 `knows` 中，沒有在場目擊者時不送給 AI。傳聞不會說錯兇手（會出錯的傳聞留待 O40）。
- **靜態事件** `src/data/events.json`：`{ id, title, trigger: "auto" | "aiProposal" | "storylet" | "stuck", requires?: { flags, unitsAlive, unitsDead, mapIds, reputation, factionRelations }, excludes?: { flags }, effects: { setFlags?, clearFlags?, worldModifiers?, reputation?, factionRelations? }, knownBy, knownByFactions?, summary, aiHint? }`。勢力條件與效果見「勢力聲望與勢力間關係」；`knownBy: "faction"` 時必須列出 `knownByFactions`。每個事件只觸發一次（`world.firedEventIds`）。`auto` 事件在條件成立時自動觸發；`storylet` 事件只在引用它的劇情片段完成時觸發（見「主線：幕與劇情片段」）；`stuck` 事件只在幕卡死超過寬限期時觸發（O32）；`aiProposal` 事件只能由 AI 在回應的 `eventProposals`（事件 ID 陣列，必填，沒有時為空陣列）提議，遊戲驗證條件成立後才套用，有檢定時只在成功時考慮。Gemini JSON Schema 將 `eventProposals` 限制為目前可提議的事件 ID，沒有候選時只允許空陣列。
- **世界修正** `world.modifiers`：`{ id, scope, stat, op, value, sourceEventId, expiresAtMinutes? }`，`scope` 為 `unit:<ID>`、`species:<ID>`、`map:<ID>`，`op` 為 `add`（整數加減）或 `multiply`（倍率）。一律為相對值：有效數值 = 公式數值先加總加減值、再乘以倍率後取整，因此調整靜態基礎數值後舊存檔的修正仍正確疊加。修正同樣作用於玩家（種族與所在地區）。事件的 `durationMinutes` 決定到期時間，到期後移除。
- **世界規則**（寫死於前端）：單位死亡處理如上；委託人死亡時，由同勢力、同職階且存活的 NPC 接手（優先同一地區），進行中的委託記錄新委託人 `activeQuests[].giverUnitId`，交付改在接手者所在地進行並寫入 `quest_transferred` 事件；沒有人選時委託變為 `failed`。種族的 `respawnDays` 決定非唯一個體死亡後幾天由新個體補上（具名 NPC 與頭目不重生）。**他方佔領**：單位樣板可設 `occupation: { byUnitId, afterDays }`，此單位死亡滿 `afterDays` 天後不重生，改由 `byUnitId` 出現在原地並寫入 `unit_occupation` 事件；被佔領單位必須設 `dormantUntilOccupation: true`，在此之前為潛伏狀態（實例 `isDormant: true`、視為不在場，不會出現在 HUD、AI 上下文與遭遇候選，也不算「已死亡」）。目前只有會真正死亡的單位（NPC 與頭目）能觸發佔領。商店 NPC 存活時，其商品庫存每個遊戲日最多補回一次至起始數量。
- **地區延後結算**：只結算玩家所在地區（`world.regions[mapId].lastRestockDay`），第一次進入只建立紀錄，之後依經過的遊戲日補貨與重生。
- **防止以等待刷資源**：補貨每日最多一次，重生依天數；非安全地區每等待滿一小時有 15% 機率被對玩家敵對、符合條件的魔物打斷（`src/utils/waitRules.ts`），只經過到打斷為止的時間並遭遇該魔物；安全地區不會被打斷。
- `npm run validate:data` 驗證事件 ID 格式與唯一性、觸發方式與傳播範圍、引用的單位/地圖/種族/勢力、聲望等級與勢力關係條件、世界修正格式，以及自動事件至少有一個旗標或單位條件。

## 支線委託：任務範本與生成委託（O30）

主持人 AI 可依任務範本為在場 NPC 發布支線委託（`src/utils/generatedQuests.ts`）；範本與上限由劇本資料定義，程式不寫死任何內容。

- **範本資料** `src/data/quest_templates.json`：`{ limits: { maxOpenQuests, maxOpenPerGiver, giverCooldownDays, maxOpenPerTarget, targetCooldownDays }, templates }`。
  - `maxOpenQuests`：全世界同時開放的委託上限（已接取未完成的也算在內）；`maxOpenPerGiver`：每位發布者的上限；`giverCooldownDays`：同一發布者兩次發布至少相隔的遊戲日。
  - `maxOpenPerTarget`（O43）：同範本、同目標全世界同時開放的上限（討伐以目標單位、收集以要收集的物品為準）；`targetCooldownDays`：同範本、同目標的委託結束（完成、逾期、失敗）後，需經過 `targetCooldownDays × 24` 遊戲小時才能再發布。
  - 範本欄位：`{ id: "QTPL-xxx", type: "defeat" | "collect", name, titlePattern, objectivePattern, aiHint, giver?: { factionIds?, classIds? }, quantity: { min, max }, durationDays, reward: { expRatio, maxExp, valuePerLevel, maxValue, maxItemQuantity }, requires?: { flags?, reputation?, factionRelations? }, excludes?: { flags? } }`。
  - `titlePattern` 與 `objectivePattern` 可用 `{target}`、`{quantity}`；`requires` 的勢力條件與事件共用 `matchesFactionConditions`。
  - 目前範本：討伐（擊敗附近魔物）、收集（收集附近魔物的掉落物），數值見 `docs/PROJECT_GOALS.md`「已確認的設計決策」。
- **AI 提議** `questProposals`（必填陣列，最多一件，沒有時為空陣列）：`{ templateId, giverId, targetUnitId, itemId, quantity }`；收集範本以 `itemId` 為準，討伐範本的 `itemId` 為 `null`。
  - 只有玩家明確向在場人物詢問工作或委託時才提議。只在沒有檢定或檢定成功時考慮。
  - AI 回應中的報酬欄位一律忽略。
  - AI 上下文提供「可發布的支線委託」：各範本可發布的委託人、目標、每單位經驗與報酬價值；同目標開放中或冷卻中的目標不列入，範本沒有候選時不送。Gemini JSON Schema 以 enum 限制範本、委託人、目標與物品；沒有候選時只允許空陣列。
- **驗證** `validateQuestProposal(state, proposal)`：
  - 範本存在且條件成立；
  - 全世界與該委託人的開放委託未達上限，且委託人不在發布冷卻中；
  - 同範本、同目標沒有開放中的委託，也不在結束後的冷卻中；
  - 委託人是目前地區存活、非敵對、有所屬勢力的 NPC，且符合範本限制；委託人有可接取的劇本任務時不發布；
  - 數量在範圍內；
  - 目標是委託人所在地區或相鄰地區、存活的魔物，不含頭目、需前置任務者、同勢力或友好／同盟勢力；收集範本以掉落該物品、等級最低的魔物為目標；
  - 報酬不可為空、不可為要收集的物品，且價值不超過上限。
- **公式**：
  - 經驗 = `min(maxExp, round(目標擊倒經驗 × 數量 × expRatio))`；
  - 報酬價值上限 = `min(maxValue, 目標等級 × valuePerLevel × 數量)`，物品價值取 `max(buyPrice, sellPrice)`；
  - 未指定報酬時由規則組成：先付金幣（不超過上限與委託人存量），剩餘額度以委託人持有物中價值最高且放得下的物品補足（不超過 `maxItemQuantity` 件）；
  - 明確指定 `rewardGold`／`rewardItems` 的提議（供日後重要角色決策使用）須為委託人持有物的子集且在上限內，否則拒絕。
- **預扣與發放**：
  - 發布時報酬自委託人持有物扣除，保存在委託的 `rewards`。
  - 交付時全額發放，且只發放一次；需求物品轉入委託人持有物。
  - 逾期或失敗時退回目前負責的委託人（已死亡者留在其持有物中）。
- **存檔**：世界存檔的 `world.generatedQuests` 與 `world.nextGeneratedQuestSeq`。
  - 委託格式：`{ id: "QST-GEN-0001", generated: true, templateId, targetUnitId, title, questGiverId, questGiver, mapId, objective, requirements, rewards, status: "open" | "completed" | "failed" | "expired", postedAtMinutes, expiresAtMinutes, closedAtMinutes? }`；`closedAtMinutes` 是結束的遊戲時間（存檔版本 13 起）。
  - 是否已接取取決於目前角色的 `activeQuests`，因此新角色接續時，前任未完成的委託會重新開放。
  - 已結束且與目前角色無關的委託最多保留 30 筆。
  - 引用的範本、單位或物品已從靜態資料移除時，讀檔略過該委託；格式錯誤時整份存檔無效。
- **世界規則**（`finalizeWorld`）：
  - 委託人死亡時沿用委託接手規則；尚未被接取的委託改由接手者負責，沒有人選即失敗並退回報酬。
  - 逾期的委託失效並退回報酬，已接取者改為失敗。
  - 發布與逾期屬例行變化，不寫入事件紀錄。
- **任務查詢**：`questRules.findQuest(state, id)` 依序查靜態任務與生成委託；HUD、AI 上下文、交付、委託接手與聲望結算都使用此查詢。
- `npm run validate:data` 驗證範本 ID 格式與唯一性、類型、數量範圍、期限、報酬參數、發布者勢力／職階參照與條件。

## 主線：幕與劇情片段（O31、O32、O33）

主線採「幕＋劇情片段」結構（`src/utils/storylets.ts`，完成結算在 `src/utils/worldEvents.ts`）；幕與片段由劇本資料定義，程式不寫死任何內容。

- **資料** `src/data/story.json`：`{ rules: { maxActiveStorylets, maxStartsPerTurn, maxCandidatesForAI, stuckGraceMinutes }, acts, storylets, endings }`。
  - 幕：`{ id: "ACT-n", title, order, defaultStoryletId, stuckEventId?, deadline?: { days, endingId }, goal, theme? }`，依 `order` 排序，第一幕為開局的幕。`stuckEventId` 是卡死保底事件（`trigger: "stuck"`），最後一幕以外必填。`deadline` 是幕期限（O33）：進入本幕後經過 `days` 個遊戲日仍未達成結局，即進入 `endingId` 結局。
  - 片段：`{ id: "STORY-幕-編號", actId, title, priority (0–100), isDefault?, requires?, excludes?, giver, goal, onComplete, scene }`。
    - `requires`：`{ flags, unitsAlive, unitsDead, mapIds, reputation, factionRelations }`，勢力條件與事件共用 `matchesFactionConditions`；`mapIds` 是發生地點。
    - `giver`：`{ preferredUnitId?, role?: { classIds?, factionIds?, minLevel? }, scope?: "map" | "world", fallback: "notice_board" | "letter" | "relic" | "none" }`；`relic` 需 O26，第一版驗證會拒絕。
    - `goal`：`{ type: "threatRemoved", unitIds, orFlag? }`（唯一單位都已死亡）、`{ type: "locationReached", mapId, orFlag? }`（玩家抵達）或 `{ type: "flagSet", flag }`（旗標成立），都另有給玩家看的 `summary`；`orFlag` 旗標成立時同樣算完成（另一種解法，旗標由 AI 提議事件等設定）。
    - `onComplete`：`{ eventIds?, setFlags?, advanceAct?, endingId?, endingTraits?, summary, knownBy? }`；`eventIds` 須為 `trigger: "storylet"` 的事件；`endingId`（O33）完成時進入結局，與 `advanceAct` 擇一。
  - 結局（O33）：`{ id: "END-n", title, summary, afterEnding: "continue" | "end", epilogues: [{ when?: { traits?, flags?, excludesFlags?, unitsAlive?, unitsDead? }, text }] }`，見下方「結局」。
    - `scene`：`{ purpose, mustConvey, tone?, keyLines?, playerChoices?, forbidden, giverAbsent? }`，提供給 AI。
- **候選** `getStoryletCandidates(state)`：
  - 進行中的片段未達 `maxActiveStorylets`；
  - 片段屬於目前幕、尚未開始也未完成、符合進入條件，玩家在發生地點；
  - 給予者在玩家所在地圖（或使用保底管道）；
  - 依 `priority` 由高到低排序；
  - 預設片段只在本幕沒有其他進行中、也沒有其他在任何地點可開始的片段時才是候選；目標已無法達成的進行中片段、給予者或發生地點到不了的片段不算（判定見「卡死偵測」）。
- **給予者** `resolveStoryletGiver(state, storylet, atMapId?)`：
  1. 首選者可用（存活、非潛伏的居民，對玩家非敵對）時只由首選者給予；不在 `atMapId` 時不是候選。
  2. 首選者不可用或未指定時，由符合 `role` 的可用居民接手。`scope: "map"` 限發生地點（未設定時為首選者居所）的居民，`"world"` 不限；與首選者同居所者優先。
  3. 沒有人選時使用保底管道：書信到處可用；告示板只在有告示板的地點可用（地圖 `facilities` 含 `notice_board`，未指定 `atMapId` 時為任一發生地點有告示板）。保底管道不受敵友關係限制。
- **AI 選擇** `storyletProposals`（第 5 版必填陣列，最多 `maxStartsPerTurn` 個）：
  - AI 在敘事中由給予者帶出片段開場時，填入「可開始的劇情片段」的 ID。
  - 前端 `startStorylets(行動前狀態, 行動後狀態, ids)` 只接受行動前的候選，沒有檢定或檢定成功時才套用。
  - 開始時記錄 `startedAtMinutes` 與 `giverUnitId` 或 `giverChannel`；開始片段不寫入事件紀錄。
  - Gemini JSON Schema 以 enum 限制候選，沒有候選時只允許空陣列。
- **完成** `finalizeWorld`：每次狀態變更後與自動事件交替結算，直到沒有變化。
  - 進行中的片段（開始後不再檢查進入條件）與符合條件但尚未開始的片段，只要目標的結果成立就完成，尚未開始的完成時 `wasActive: false`。
  - 完成時設定 `setFlags`、合併 `endingTraits`，並寫入 `story_progress` 事件：`summary` 為 `onComplete.summary`，`knownBy` 預設 `region`，`changes.storyletIds`／`setFlags`／`actIds`。之後依序套用 `eventIds`，條件不成立的略過。
  - `advanceAct` 切換到下一幕：進行中的片段清空，上一幕剩下的片段不再完成，`actStartedAtMinutes` 記為推進的時間（幕期限由此起算）；最後一幕不可推進，改用 `endingId`。
  - `endingId`：套用完成旗標、結局特徵與完成事件之後進入結局（見「結局」）。
- **卡死偵測與保底（O32）** `isActStuck(state)`：判斷「日後仍可能達成」而非「現在就能達成」，寧可漏報也不誤判；無法由規則判定的條件（有來源但尚未成立的旗標、聲望與勢力關係）視為可能。
  - 可抵達的地圖：從目前地點沿 `connectedMapIds` 走，地圖的前置任務已接取、已完成或仍可接取（委託人可擔任給予者，前置任務也都可接取）。
  - 目標仍可達成：已達成；或 `orFlag` 仍可設定；威脅消除的單位都已死亡或仍可擊倒（未潛伏、所在地可抵達、`requiredQuestId` 進行中或仍可接取）；抵達的地圖可抵達；旗標仍可設定（未觸發、未被排除、需要存活的單位未死、需要死亡的單位可擊倒、發生地點可抵達的事件，不含 `stuck` 事件；或本幕尚未完成的片段的 `setFlags`）。
  - 卡死：尚未達成結局（O33 起最後一幕也判定），沒有目標仍可達成的進行中片段，且進行中已滿或沒有「進入條件可能成立、給予者在可抵達的發生地點、目標可能達成」的未開始片段。
  - `finalizeWorld` 在自動事件與片段完成之後檢查：卡死時記錄 `stuckSinceMinutes`，脫離卡死或完成任一片段時清除；持續 `stuckGraceMinutes`（範例 1440 分鐘）後先觸發該幕的 `stuckEventId` 事件（原因「主線保底」，每個事件只觸發一次，可設旗標開出救援片段）；觸發後仍卡死（或沒有事件、事件條件不成立）時強制完成該幕的預設片段，`completedStorylets` 記錄 `forced: true`、`story_progress` 事件原因以「主線保底」開頭，主線訊息標示「（主線保底）」。
- **結局（O33）**：由劇情片段完成（`onComplete.endingId`）或幕期限（`deadline`，`finalizeWorld` 交替結算的最後一步，片段完成優先）進入，每個世界只進入一次。
  - 結局判定 `resolveEpilogueIndexes(state, ending)`：依進入結局當下的結局特徵、旗標、單位生死，挑出所有條件成立的尾聲段落（依資料順序，沒有 `when` 的段落每次都顯示），段落索引存在 `world.story.ending`，之後顯示與 AI 上下文都讀這份紀錄，相同狀態一定得到相同結果。不呼叫 AI。
  - 進入時清空進行中的片段與卡死計時，寫入 `story_progress` 事件（`summary` 為結局的 `summary`、`knownBy: "world"`、`changes.endingIds`、原因以「結局：」開頭）。之後沒有片段候選、不再完成片段、不判定卡死。
  - `afterEnding: "continue"`：世界繼續運作，玩家以現在的身分繼續活動，主線已結束。
  - `afterEnding: "end"`：時間線結束（`isTimelineEnded`，`src/utils/playerStatus.ts`）：比照死亡，`canPlayerAct` 為 false，不寫入自動存檔（自動存檔停在進入結局的行動之前）、禁止手動存檔，故事區顯示「讀取自動存檔（結局前）」與「開啟存檔管理」。
  - 主線訊息附上結局標題、結果、尾聲段落與結局後的說明；HUD「📖 主線」顯示已達成的結局，或目前幕的期限（到期時間）。
- **存檔** `world.story`（世界層）：`{ currentActId, activeStorylets: [{ id, startedAtMinutes, giverUnitId?, giverChannel? }], completedStorylets: [{ id, completedAtMinutes, wasActive, forced? }], endingTraits, actStartedAtMinutes, stuckSinceMinutes?, ending?: { id, reachedAtMinutes, epilogueIndexes } }`（存檔版本 12）。
  - 目前幕或已達成的結局不存在、缺少 `actStartedAtMinutes` 或格式錯誤時整份存檔無效；超出資料範圍的尾聲段落索引略過；
  - 靜態資料已移除的片段讀檔時略過。
- **AI 上下文** `story` 區段（不截斷）：
  - 目前幕（`title`、`goal`、`theme`，只作敘事方向）與 `endingTraits`；
  - 幕期限的剩餘遊戲日 `deadline.remainingDays`（O33；AI 可營造時間壓力，不可捏造不同期限或預告結局）；
  - 達成結局後改附 `ending`（標題、結果、尾聲、結局後走向），不再附幕、期限與候選；
  - 進行中片段與最多 `maxCandidatesForAI` 個候選，各附 `giver`（目前給予者名稱或保底管道）、`goal` 與演出要求；
  - 首選給予者不在時改附 `giverAbsent`，不附 `keyLines`。
  - 主持規則：遵守 `forbidden`；不可由非給予者帶出片段；不可宣稱片段、目標、幕或故事已完成，不可自行描寫結局。
- **HUD**：「📖 主線」顯示目前幕、進行中片段、目標與目前給予者（原給予者不在時提示接手者）；片段開始、完成與進入新的一幕時顯示「📖 主線」訊息（`story_progress` 事件不重複列在「🌍 世界變化」）。
- `npm run validate:data` 驗證：
  - 幕與片段的 ID 格式與唯一性、參照、條件、給予者、目標類型；族群樣板不可作為威脅消除目標。
  - 完成事件須為 `storylet` 觸發，`storylet` 事件須被片段引用。
  - 每幕有且只有一個預設片段；預設片段只由保底管道給予、不依賴單位存活；最後一幕不可推進，最後一幕的預設片段必須進入結局（O33）。
  - O33：結局 ID 格式 `END-n` 與唯一性、標題與結果、`afterEnding`、至少一段尾聲、尾聲條件的單位與旗標（旗標須有設定來源）；`endingId` 與 `advanceAct` 不可同時設定；幕期限天數為正整數、期限結局存在；每個結局都要有片段或幕期限會進入。
  - O32：`stuckGraceMinutes` 為 0 以上的整數；最後一幕以外，預設片段必須 `advanceAct`，且必須有 `stuckEventId`（`trigger: "stuck"`，不可限制發生地點，須被幕引用）；片段的進入條件旗標、目標旗標與 `orFlag` 必須有事件或片段會設定；主線節點（`advanceAct`，或設定其他片段的進入條件／目標所需的旗標）的保底管道不可為 `none`；保底管道為告示板時，發生地點（未設定時為全世界）至少一處有告示板。地圖 `facilities` 只能是 `notice_board`。

## 主線自動模擬測試（O33）

`npm run test:sim`（`scripts/simulate-story.mjs` 載入 `src/dev/storySimulation.ts`）不呼叫 AI，以規則代替玩家與主持人 AI，大量重複遊玩目前的劇本資料；所有狀態變更都經過 `finalizeWorld`，與實際遊戲走同一套世界規則。

- **設定** `scripts/simulation.config.json`：`runs`（1000）、`seed`（亂數種子，第 i 次為 seed + i）、`maxGameDays`（60）、`maxSteps`、`contextSampleEvery`（每幾步量測一次 AI 上下文）、`continueAfterEndingDays`（結局為 continue 時，結局後再模擬幾天）、`stressEvents`（壓力測試灌入的事件數）、`profiles`（玩家類型）。命令列可覆寫 `--runs`、`--seed`、`--days`。
- **玩家類型** `profiles: [{ name, share, stallDays, requireEnding, policy }]`：依 `share` 分配次數；目前為專注主線（50%）、閒晃搗亂（35%）、拖延放置（15%，不要求達成結局，用來觸發幕期限）。`policy` 為每一步的機率：搗亂（`killResident` 殺害在場居民、`worldDeath` 具名居民在別處死亡、`wander` 隨意移動、`wait` 等待 8 小時），其餘時間朝目標前進（交付與接取任務 `acceptQuest`、開始候選片段 `startStorylet`、提議能設定目標旗標的事件 `proposeGoalEvent`、提議其他可提議事件 `proposeOtherEvent`、擊倒目標或收集物品需要的單位、沿最短路徑前往目標地點）。戰鬥一律視為玩家獲勝；重要角色的規則行為待 O34 `ruleFallback`。
- **報告**：各玩家類型的結局分布與一次都沒達成的結局、各幕停留天數、保底事件與強制完成的比例、主要卡死情況（第一次判定卡死時的狀態摘要分組）、AI 上下文最大字元數與是否超出預算、事件紀錄與編年史的大小、壓力測試結果、結局判定可重現性（達成結局的狀態存讀檔後結局與尾聲段落一致）、同一種子重跑是否一致，以及疑似漏報的卡死（同一幕超過該玩家類型的 `stallDays` 沒有進展，卡死偵測卻未判定，附狀態摘要與種子）。
- **失敗條件**（非零結束碼）：模擬中出現例外或存檔驗證失敗、結局達成後被改變或主線仍在前進、結局判定不可重現、AI 上下文或壓力測試超出預算、要求達成結局的玩家類型在期限內沒有達成結局、同一種子重跑不一致。疑似漏報與未達成的結局只列出供人工檢查。

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

- **兩層存檔**：每個存檔欄位分為 `world`（世界存檔：`gameTimeMinutes`、`unitInstances`、`storyFlags`、世界狀態 `world`（事件紀錄、編年史、世界修正、已觸發事件、地區結算、勢力間關係、生成委託、人物記憶 `unitMemories`、主線進度 `story`）與歷代角色紀錄 `characterHistory`）與 `character`（角色存檔：其餘玩家欄位，包含能力、背包、金幣、任務、戰鬥、單位對此角色的關係覆寫、各勢力聲望等）。哪些欄位屬於世界層由 `types/game.ts` 的 `WORLD_STATE_KEYS` 定義。執行期仍合併為 `PlayerState`，只在存讀檔時拆分與合併（`utils/saveStorage.ts`）。
- **存檔欄位**：每個世界一個自動存檔（狀態變更且非 AI 回合進行中時覆寫；戰鬥中與玩家死亡後不覆寫，因此停在致命行動或該場戰鬥開始之前）與 3 個手動存檔（死亡狀態與戰鬥中不能存檔）。每個世界只有一條時間線：讀取手動存檔即取代目前進度，之後的自動存檔從該時間點繼續。可有多個世界，存檔索引記錄目前世界；切換世界即讀取該世界的自動存檔。
- **新角色接續（停用，保留給 O42）**：死亡改為讀檔制後，「以新角色接續這個世界」入口與角色建立的「與前任冒險者有關聯」選項不再提供，以下程式保留供 O42 非同步多人使用。原設計為角色死亡後可在同一世界建立新角色。世界層欄位保留，玩家狀態的 `characterSeq` 記錄角色代數（第一位為 1，接續的新角色加一）；前一位角色以 `characterHistory`（代數、名稱、種族、職階、等級、結束時間與地區、死亡事件 ID 與公開描述、攜帶物快照）記錄並提供給 AI 作為傳聞素材（最多 5 位，附上其事蹟，見「AI 上下文組裝與回應格式版本」）；新角色不繼承等級、背包、任務與單位關係；勢力聲望重置為初始值，或依劇本設定部分繼承（見「勢力聲望與勢力間關係」）。死亡遺物（O26）尚未實作，攜帶物快照留待之後使用。
- **匯出／匯入**：存檔管理可將一個世界的所有欄位匯出為 JSON（`format: "adventure-simulator-world"`）。匯入時驗證格式、版本、劇本與每個欄位內容，任何欄位無效即整份拒絕；一律以新世界 ID 匯入，不覆蓋任何現有存檔，寫入中途失敗會移除已寫入的欄位。
- **容量管理**：存檔管理顯示本遊戲在 localStorage 的估計用量（以約 5 MB 上限計），達 80% 時警示；寫入失敗（例如容量不足）時 HUD 提示匯出備份，其他欄位不受影響。事件紀錄超過 200 件即壓縮成編年史，且存檔只保存有差異的單位實例；目前容量足夠，暫不改用 IndexedDB。

存檔帶有 `schemaVersion`（`saveStorage.ts` 的 `SAVE_SCHEMA_VERSION`，目前為 13）。開發階段每次變更存檔格式就將版本加一；版本不符、缺少欄位或格式無效的存檔直接捨棄，不提供舊格式遷移；舊版單一快照（`TRPG_GAME_SESSION`、`TRPG_PLAYER_STATE`）在啟動時移除。正式上線後才開始為舊版本撰寫遷移。

## 金鑰安全限制

本專案目前是靜態前端，瀏覽器會直接送出 API 請求。Gemini Key 會保存於瀏覽器本機；OpenAI Key 雖不保存，但仍在瀏覽器執行並用於直接請求。OpenAI 官方建議不要在瀏覽器或其他用戶端程式碼暴露 API Key；正式公開部署應加入伺服器端代理，讓金鑰只保存在伺服器環境變數或金鑰管理服務。
