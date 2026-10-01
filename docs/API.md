# API 文件

## 範圍與架構

本專案目前沒有自建後端或對外提供的 REST API。瀏覽器前端直接呼叫 Google Gemini `generateContent` API，並在本機 `localStorage` 保存玩家資料與 API Key。本文件記錄現有的 Gemini 整合介面、資料格式與瀏覽器端儲存契約。

## Gemini 文字生成

| 項目 | 說明 |
| --- | --- |
| 方法 | `POST` |
| URL | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}` |
| Content-Type | `application/json` |
| 呼叫位置 | `src/services/geminiService.ts` 的 `sendPlayerAction` |
| 模型順序 | `gemini-3.6-flash`、`gemini-3.5-flash`、`gemini-3.1-flash` |

API Key 由玩家在設定視窗輸入，現階段儲存在 `TRPG_GEMINI_KEY`。請勿把真實 Key 寫入原始碼或提交至版本控制。

### 前端函式介面

```ts
sendPlayerAction(
  apiKey: string,
  playerState: PlayerState,
  actionText: string,
  storyHistory: string[]
): Promise<AIResponsePayload>
```

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `apiKey` | `string` | Gemini API Key；會先移除前後空白，空值會直接報錯。 |
| `playerState` | `PlayerState` | 玩家目前狀態，組成 GM prompt 的遊戲脈絡。 |
| `actionText` | `string` | 玩家本次輸入的行動。 |
| `storyHistory` | `string[]` | 對話摘要文字；目前只傳入最後四筆。 |

### 請求本文

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "系統提示、玩家狀態、近期劇情與本次行動" }]
    }
  ],
  "generationConfig": {
    "responseMimeType": "application/json"
  }
}
```

系統提示包含玩家姓名、等級、HP/MP、金幣、地圖、背包、裝備與劇情旗標，並要求 GM 以繁體中文回覆結構化 JSON。

### 成功回應

Gemini 回應本文中的 `candidates[0].content.parts[0].text` 應為 `AIResponsePayload` JSON：

```json
{
  "storyText": "你沿著綠林古道前進，遠處傳來窸窣聲。",
  "suggestedActions": ["查看聲音來源", "提高警戒繼續前進"],
  "checkRequest": {
    "stat": "spd",
    "dc": 12,
    "reason": "避開哥布林的伏擊"
  },
  "checkOutcomes": {
    "successText": "你迅速側身閃過襲擊。",
    "failureText": "你沒能及時避開，受到擦傷。"
  },
  "stateChanges": {
    "hpChange": 0,
    "mpChange": 0,
    "expChange": 5,
    "goldChange": 0,
    "addItems": [{ "itemId": "ITEM-001", "quantity": 1 }],
    "removeItems": [],
    "newLocationId": "MAP-002",
    "setFlags": { "MET_SCOUT": true },
    "defeatedMonsters": [],
    "questUpdates": [{ "questId": "QST-001", "status": "completed" }]
  },
  "failureStateChanges": { "hpChange": -3 }
}
```

`storyText` 和 `suggestedActions` 為必要欄位；`stateChanges` 可省略，其欄位亦皆可省略。需要擲骰時，Gemini 回傳 `checkRequest`（`stat` 限 `atk`、`def`、`spd`，DC 為 5–25）及成功/失敗敘述。瀏覽器擲 d20，依角色成長數值與裝備修正計算結果。`stateChanges` 只在成功時套用；`failureStateChanges` 只在失敗時套用。未要求檢定的行動不擲骰。
這是本專案的輕量行動檢定，不是完整 D&D 戰鬥模擬；目前尚未實作先攻、回合行動點或持續中的敵人 HP。

| 欄位 | 型別 | 用途 |
| --- | --- | --- |
| `storyText` | `string` | 顯示 GM 的劇情描述。 |
| `suggestedActions` | `string[]` | 顯示可供玩家選擇的行動建議。 |
| `stateChanges.hpChange` / `mpChange` | `number` | HP/MP 增減量。 |
| `stateChanges.expChange` / `goldChange` | `number` | 經驗值/金幣增減量。 |
| `stateChanges.addItems` / `removeItems` | `{ itemId: string; quantity: number }[]` | 增加/扣除背包道具。道具 ID 應存在 `items.json`。 |
| `stateChanges.newLocationId` | `string` | 更新當前地圖 ID。 |
| `stateChanges.setFlags` | `Record<string, boolean>` | 合併更新劇情旗標。 |
| `stateChanges.questUpdates` | `{ questId: string; status: "completed" }[]` | 回報已接取且目標達成的任務。前端只會完成進行中的有效任務，並按靜態任務資料發放獎勵。 |
| `stateChanges.defeatedMonsters` | `{ monsterId: string; quantity: number }[]` | 回報成功擊敗的怪物數量；未知怪物 ID 和非正整數數量會忽略。 |
| `failureStateChanges` | 同 `stateChanges` | 檢定失敗時套用的有限狀態變更。 |

玩家狀態由 `src/App.tsx` 套用：HP、MP、金幣最低為 0；經驗值直接加減；道具依 ID 合併數量，數量耗盡時從背包移除；新地圖及旗標有提供時才更新。
AI 任務完成回報僅對應目前進行中的任務生效；接取任務由玩家在介面操作，跨地圖移動限制在靜態地圖資料定義的連通地點。
任務 JSON 的 `requirements` 以怪物 ID 和道具 ID 表示擊敗/收集條件；程式檢查玩家接取任務後的擊敗進度及背包數量，條件滿足後才完成任務，並消耗任務要求的收集物品。怪物掉落使用 `itemId` 參照道具資料。

### 重試與錯誤

- HTTP 429、503，以及網路例外會在同一模型最多重試兩次，延遲由 1 秒起並逐次增加。
- 模型失敗後依序嘗試清單中的下一個模型。
- 全部模型失敗時，函式會丟出錯誤，UI 以系統訊息顯示。
- 回應文字無法解析為 JSON 時，函式會退回純文字劇情和預設建議行動；此情況不會帶有狀態變更。
- 其他非成功 HTTP 狀態目前不會在同一模型重試，但會繼續嘗試下一個模型。

## 瀏覽器端資料契約

| LocalStorage Key | 資料型別 | 用途 |
| --- | --- | --- |
| `TRPG_GEMINI_KEY` | `string` | 玩家輸入的 Gemini API Key。 |
| `TRPG_PLAYER_STATE` | `PlayerState` JSON | 玩家存檔，由 React 狀態變更後寫回。 |

`PlayerState` 的欄位定義位於 `src/types/game.ts`，涵蓋角色數值、所在地圖、背包、裝備、劇情旗標與進行中任務。靜態物品、地圖、怪物、等級成長和任務資料分別由 `src/data/*.json` 載入，不透過 API 取得。

## 範例錯誤

```text
API Key 為空，請檢查右上角設定。
```

若所有模型都失敗，錯誤訊息會包含最後一個模型的 HTTP 狀態或連線錯誤細節。
