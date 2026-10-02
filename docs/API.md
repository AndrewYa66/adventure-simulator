# API 文件

## 範圍與架構

本專案沒有自建後端 API。瀏覽器前端可選擇 Google Gemini 或 OpenAI，直接呼叫玩家選定的模型；兩種服務的回應都會轉成共用的 `AIResponsePayload`，並由前端驗證後套用遊戲狀態。

## 可選服務與模型

| 服務 | 模型 ID | API |
| --- | --- | --- |
| Google Gemini | `gemini-3.8-flash`、`gemini-3.6-flash`、`gemini-3.5-flash-lite` | Gemini `generateContent` |
| OpenAI | `gpt-6-luna`、`gpt-6.1-sol`、`gpt-6-astra` | OpenAI `Responses` |

模型清單由 `src/services/aiModels.ts` 管理。選定模型失敗時，系統會顯示錯誤，不會靜默切換到其他模型。

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
  "failureStateChanges": { "hpChange": -3 }
}
```

有檢定時，`stat` 可為 `atk`、`def`、`spd`、`str`、`dex`、`con`、`int`、`wis`、`cha`，DC 限整數 5–25，且必須提供成功與失敗敘述。能力值檢定採 d20 + `floor((能力值 - 10) / 2)`；攻防速使用等級成長值、職業加值及裝備加值。成功時套用 `stateChanges`，失敗時套用 `failureStateChanges`。失敗分支不能發放經驗、道具、任務完成或擊敗怪物紀錄。

`encounterRequest` 只能指向本地區、已解鎖且玩家確實看見/接觸的魔物；遊戲驗證後才將其顯示在 HUD。每個單位明確定義預設對玩家關係（友善、中立、敵對）；`stateChanges.unitDispositionChanges` 只能變更目前地區存活單位的關係，遊戲會保存覆寫。九大陣營描述價值傾向，不直接決定敵友；敵對 NPC 不可提供任務或交易，敵對 NPC 與已遭遇的敵對魔物都可由 HUD 發起戰鬥。NPC HP 與死亡狀態保存在玩家快照；擊倒 NPC 不發放魔物經驗、金幣或掉落。明確攻擊友善/中立單位會視為挑釁並轉為敵對。

`stateChanges` 支援 HP/MP/EXP/金幣增減、道具增加/移除、劇情旗標、怪物擊敗紀錄、單位關係變更、任務接受及任務完成回報。AI 只能對遊戲提供的「目前地區可接取任務」提出 `questAcceptances: ["QST-001"]`；玩家詢問任務不等於接受。HUD 按鈕及對話接受會共用同一驗證，確認玩家位於任務指定地圖、任務給予者 NPC 確實在場且存活、非敵對，且任務尚未接取或完成。靜態任務資料定義需求、獎勵值及上下限，完成時再次檢查需求；交付道具會從背包扣除，獎勵只發放一次。NPC 靜態資料以 ID、姓名、職稱、類別和所在地圖定義，類別提供預設數值，NPC 可設定個別數值覆寫。地圖的 `npcsPresent` 使用 NPC ID。消耗品的 `usableInCombat` 布林欄位控制是否可在戰鬥中使用，描述文字只用於說明；consumable 的 `effect.hpRestore`/`effect.mpRestore` 定義固定回復量；玩家可從 HUD 使用背包中的消耗品，回復不會超過角色資源上限，無實際回復時不扣除道具。戰鬥中使用消耗品會觸發敵方反擊與 d20 閃避檢定。戰鬥狀態以 `{ "unitId": "NPC-001", "currentHp": 20, "round": 1 }` 表示目標，不同種類仍套用專屬掉落/能力規則；舊快照的 `combat.monsterId` 和 `encounteredMonsterId` 會轉換為共用單位 ID。主動技能由等級成長資料解鎖，技能 effect 定義傷害倍率，程式以 `max(1, floor(玩家 ATK × multiplier) - 敵方 DEF)` 計算傷害；技能消耗 MP 並消耗玩家回合。地圖移動使用獨立欄位 `travelRequest`，格式為 `{ "destinationMapId": "MAP-002" }`。Gemini GenerateContent 請求會使用 JSON Schema 強制包含所有回應欄位，並將 `travelRequest.destinationMapId` 限制為本次可移動的相鄰地圖 ID、將 `encounterRequest.monsterId` 限制為可遭遇魔物 ID、將 `questAcceptances` 限制為本區可接取任務 ID、將 `unitDispositionChanges.unitId` 限制為當前地區單位 ID；這保證格式與欄位，不代表語意正確，因此遊戲端仍會驗證。只有玩家明確要求移動時才設定；模型收到的可移動地區清單包含相鄰地圖 ID、正式名稱、專屬別名及分類標籤。泛稱地點會根據可到達候選和上一個地區解析；若仍有多個候選，前端要求玩家選擇，不把泛稱綁定到單一地圖。若 AI 敘事聲稱玩家已移動，但缺少或填錯 `travelRequest`，系統會附上合法目的地清單要求模型重產一次完整 JSON；仍無有效請求時不會移動，並會在對話明確提示。前端再次驗證地圖 ID、連通性及戰鬥狀態後，才更新 `currentMapId`。詢問地點、觀察或含糊意圖不會移動。舊格式 `stateChanges.newLocationId` 會轉換為同一移動請求並執行相同驗證；新回應不可用 `stateChanges` 修改地圖。

## 角色建立、章節任務與特殊戰鬥

新角色由職業資料建立；`character_classes.json` 定義六項能力值、攻防速及 HP/MP 加值、起始裝備和物品。角色可選九大陣營之一。舊存檔遷移至冒險者職業、絕對中立陣營，並保留原有角色資源與物品。NPC 由類別提供預設 HP/ATK/DEF/SPD，可用個別 `stats` 覆寫；姓名與職稱只描述身份，不決定數值。NPC 的 `startingInventory`/`startingGold` 初始化為可保存的世界持有物；交易、任務交付和 NPC 物品轉移會改變此存檔狀態。

新手章節任務為 `QST-001` 清理綠林古道，完成後解鎖 `QST-002` 討伐哥布林酋長；`MAP-003` 哥布林巢穴需先接取 QST-002 才能進入，UI 和對話移動共用地圖解鎖驗證。`MON-003` 格羅姆・裂牙每第三回合使用「裂地重擊」，玩家進行敏捷 DC 14 檢定；失敗時受到 `floor(敵方 ATK × 1.5) - floor(玩家 DEF / 4)` 傷害，存活時昏迷一回合並跳過下一個行動。一般敵方反擊依防禦 DC 擲骰。HP 降至 0 即死亡，昏迷只由獨立狀態效果表示。

## 玩家自主行動與交易

明確的自我傷害指令（例如「對自己造成 1 點傷害」或「自殘 10 點生命」）由前端解析數值並直接套用 `hpChange`，不依賴 AI 是否正確輸出狀態欄位；若辨識到自傷意圖但無法確定數值，會先請玩家補充，不送交模型敘事。實際扣血不超過目前 HP，HP 歸零仍觸發死亡。其他會改變遊戲狀態的 AI 行動須使用 `stateChanges`、`travelRequest` 或 `checkRequest` 對應欄位，遊戲端才會更新狀態和 HUD。未存在於世界物品資料的手榴彈、巴雷特、AK-47 等裝備要求會在送 AI 前拒絕；AI 亦不可透過敘事或 `addItems` 生成庫存之外的物品。

商店由 `shops.json` 定義 NPC、商品清單及服務，NPC 以 `shopId` 關聯商店。玩家只能在商店 NPC 所在且該 NPC 出現在當前地圖時交易，戰鬥、死亡或昏迷時禁止交易。買賣需同時檢查玩家金幣/物品與商人金幣/庫存，並同步轉移雙方資產；任務道具不可出售。購買的武器、防具及飾品可從背包裝備。旅店提供 5 金幣的休息服務，立即恢復 HP/MP，並將費用轉入旅店老闆持有金幣；服務與物品交易均保留最近 100 筆交易紀錄。休息耗時和服務持續時間待時間系統完成後處理。任務交付必須在任務給予者所在區域進行，玩家可由 HUD 交付；需求道具轉入 NPC 持有物，獎勵物品/金幣只能從 NPC 現有存量發放，不足時標記短缺，不會憑空生成。AI 的 `npcItemTransfers` 只能轉移當前在場 NPC 實際持有且存在於靜態資料庫的物品。

戰鬥外可施放已解鎖的資源技能。範例「急救術」消耗 5 MP 恢復最多 20 HP；若 MP 不足或 HP 已滿，不消耗資源。戰鬥中的傷害技能與戰鬥外治療技能依效果類型分別提供，MP 消耗和效果由程式結算。

## 生死狀態\n\n角色 HP 歸零即死亡，死亡狀態會隨快照保存並阻止後續遊戲行動；舊存檔若 HP 為 0 會自動遷移為死亡。昏迷由獨立 `statusEffects` 條目表示，不能以 HP 為 0 表示昏迷。\n\n## 設定保存

| Key | 保存方式 | 用途 |
| --- | --- | --- |
| `TRPG_AI_MODEL_SETTINGS` | `localStorage` | 選定的服務與模型 ID。 |
| `TRPG_GEMINI_KEY` | `localStorage` | Gemini API Key，沿用舊版設定。 |
| OpenAI API Key | 僅目前分頁的 React 記憶體 | 不寫入 `localStorage`；重新載入後須重新輸入。 |
| `TRPG_PLAYER_STATE` | `localStorage` | 玩家存檔。 |

## 金鑰安全限制

本專案目前是靜態前端，瀏覽器會直接送出 API 請求。Gemini Key 會保存於瀏覽器本機；OpenAI Key 雖不保存，但仍在瀏覽器執行並用於直接請求。OpenAI 官方建議不要在瀏覽器或其他用戶端程式碼暴露 API Key；正式公開部署應加入伺服器端代理，讓金鑰只保存在伺服器環境變數或金鑰管理服務。
