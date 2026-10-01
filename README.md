# Adventure Simulator

[![GitHub Pages Status](https://img.shields.io/badge/site-Live-brightgreen)](https://andrewya66.github.io/adventure-simulator/)

一個以 **AI 作為遊戲主持人（DM）** 的純前端文字冒險遊戲。可選擇 Google Gemini 或 OpenAI 模型，結合固定遊戲資料庫與 AI 對話推進劇情與動態事件。

## 🔗 相關連結
- 🎮 **遊戲線上體驗：** [GitHub Pages](https://andrewya66.github.io/adventure-simulator/)
- 📦 **程式碼庫：** [GitHub Repository](https://github.com/AndrewYa66/adventure-simulator)

---

## 🛠️ 架構與設計概念

本專案採用 **全前端 / 無後端（Serverless）** 方式部署，所有數據與邏輯皆在瀏覽器端運行。

* **遊戲資料庫（靜態數據）：**
  * 以 JSON 格式預先建置於專案中。
  * 包含基本玩家數值、怪物數據、地圖資訊、NPC 檔案與對話設定等。
* **玩家資料持久化（動態數據）：**
  * 使用瀏覽器的 `LocalStorage` 儲存個人檔案（如角色背包、即時狀態等）。
  * 每次觸發 AI 對話時，會自動載入當前 `LocalStorage` 數據作為 Context。
* **AI 主持人邏輯與狀態控管：**
  * 將 AI 明確定位為「遊戲主持人」，避免被玩家任意引導。
  * **機制判定：** 包含擲骰子（Dice Roll）等判定機制，根據客觀標準回傳行動結果。
  * **結構化輸出：** 每次 AI 輸出的結果皆盡量格式化為 JSON 並寫回 `LocalStorage`，以解決上下文過長與 AI 幻覺（Hallucination）問題。

---

## 🤖 AI 設定與使用說明

本專案支援 **Google Gemini** 與 **OpenAI API**。使用前請準備所選服務的 API Key：

1. 從 [Google AI Studio](https://aistudio.google.com/api-keys) 或 [OpenAI API 平台](https://platform.openai.com/api-keys) 建立 API Key。
2. 開啟 [Adventure Simulator](https://andrewya66.github.io/adventure-simulator/) 網頁，點選右上角「模型設定」。
3. 選擇服務、模型並貼上對應的 API Key，再儲存即可開始遊玩。

Gemini Key 會保存於此瀏覽器；OpenAI Key 僅保留在目前分頁記憶體，重新載入頁面後須重新輸入。此專案目前由瀏覽器直連模型服務；OpenAI 官方建議不要在用戶端暴露 API Key，正式公開部署應先改用伺服器端代理。

---

## 📌 版本紀錄 (Changelog)

### `v0.1.0` (Alpha)
- [x] 建立基本專案雛型與純前端介面。
- [x] 支援 Gemini 與 OpenAI 多模型選擇。
- [x] 實現結構化回應、遊戲狀態結算與輕量 d20 判定。
- [ ] *[待開發]* 完整 JSON 資料庫建置（玩家/怪物/地圖/NPC）。
- [ ] *[待開發]* 結構化 LocalStorage 數據讀寫與擲骰判定機制。
