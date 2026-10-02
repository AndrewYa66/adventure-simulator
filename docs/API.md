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
  "stateChanges": { "hpChange": 0, "expChange": 5, "questAcceptances": [] },
  "failureStateChanges": { "hpChange": -3 }
}
```

有檢定時，`stat` 限 `atk`、`def`、`spd`，DC 限整數 5–25，且必須提供成功與失敗敘述。瀏覽器以 d20、角色成長數值及裝備加成計算結果；成功時套用 `stateChanges`，失敗時套用 `failureStateChanges`。失敗分支不能發放經驗、道具、任務完成或擊敗怪物紀錄。

`stateChanges` 支援 HP/MP/EXP/金幣增減、道具增加/移除、劇情旗標、怪物擊敗紀錄、任務接受及任務完成回報。AI 只能對遊戲提供的「目前地區可接取任務」提出 `questAcceptances: ["QST-001"]`；玩家詢問任務不等於接受。HUD 按鈕及對話接受會共用同一驗證，確認玩家位於任務指定地圖、任務給予者 NPC 確實在場，且任務尚未接取或完成。靜態任務資料定義需求、獎勵值及上下限，完成時再次檢查需求；交付道具會從背包扣除，獎勵只發放一次。NPC 靜態資料以 ID、姓名、職稱、類別和所在地圖定義，類別提供預設數值，NPC 可設定個別數值覆寫。地圖的 `npcsPresent` 使用 NPC ID。道具的 consumable `effect.hpRestore`/`effect.mpRestore` 定義固定回復量；玩家可從 HUD 使用背包中的消耗品，回復不會超過角色資源上限，無實際回復時不扣除道具。戰鬥中使用消耗品會觸發敵方反擊與 d20 閃避檢定。主動技能由等級成長資料解鎖，技能 effect 定義傷害倍率，程式以 `max(1, floor(玩家 ATK × multiplier) - 敵方 DEF)` 計算傷害；技能消耗 MP 並消耗玩家回合。地圖移動使用獨立欄位 `travelRequest`，格式為 `{ "destinationMapId": "MAP-002" }`。Gemini GenerateContent 請求會使用 JSON Schema 強制包含所有回應欄位，並將 `travelRequest.destinationMapId` 限制為本次可移動的相鄰地圖 ID，將 `questAcceptances` 限制為本區可接取任務 ID；這保證格式與欄位，不代表語意正確，因此遊戲端仍會驗證。只有玩家明確要求移動時才設定；模型收到的可移動地區清單包含相鄰地圖 ID、正式名稱、專屬別名及分類標籤。泛稱地點會根據可到達候選和上一個地區解析；若仍有多個候選，前端要求玩家選擇，不把泛稱綁定到單一地圖。若 AI 敘事聲稱玩家已移動，但缺少或填錯 `travelRequest`，系統會附上合法目的地清單要求模型重產一次完整 JSON；仍無有效請求時不會移動，並會在對話明確提示。前端再次驗證地圖 ID、連通性及戰鬥狀態後，才更新 `currentMapId`。詢問地點、觀察或含糊意圖不會移動。舊格式 `stateChanges.newLocationId` 會轉換為同一移動請求並執行相同驗證；新回應不可用 `stateChanges` 修改地圖。

## 設定保存

| Key | 保存方式 | 用途 |
| --- | --- | --- |
| `TRPG_AI_MODEL_SETTINGS` | `localStorage` | 選定的服務與模型 ID。 |
| `TRPG_GEMINI_KEY` | `localStorage` | Gemini API Key，沿用舊版設定。 |
| OpenAI API Key | 僅目前分頁的 React 記憶體 | 不寫入 `localStorage`；重新載入後須重新輸入。 |
| `TRPG_PLAYER_STATE` | `localStorage` | 玩家存檔。 |

## 金鑰安全限制

本專案目前是靜態前端，瀏覽器會直接送出 API 請求。Gemini Key 會保存於瀏覽器本機；OpenAI Key 雖不保存，但仍在瀏覽器執行並用於直接請求。OpenAI 官方建議不要在瀏覽器或其他用戶端程式碼暴露 API Key；正式公開部署應加入伺服器端代理，讓金鑰只保存在伺服器環境變數或金鑰管理服務。
