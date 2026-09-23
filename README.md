# Adventure Simulator

[![GitHub Pages Status](https://img.shields.io/badge/site-Live-brightgreen)](https://andrewya66.github.io/adventure-simulator/)

一個以 **AI（Gemini）作為遊戲主持人（DM）** 的純前端文字冒險遊戲。透過結合固定的遊戲資料庫與 AI 對話，推動文字遊戲進度與動態事件判斷。

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

本專案目前採用 **Google Gemini API**。使用前請按照以下步驟設定：

1. 前往 [Google AI Studio](https://aistudio.google.com/api-keys) 申請一組免費的 **API Key**。
2. 開啟 [Adventure Simulator](https://andrewya66.github.io/adventure-simulator/) 網頁。
3. 將 API Key 貼入網頁右上角的設定欄位即可開始遊玩。

---

## 📌 版本紀錄 (Changelog)

### `v0.1.0` (Alpha)
- [x] 建立基本專案雛型與純前端介面。
- [x] 實現 basic Gemini API 對話對接。
- [ ] *[待開發]* 完整 JSON 資料庫建置（玩家/怪物/地圖/NPC）。
- [ ] *[待開發]* 結構化 LocalStorage 數據讀寫與擲骰判定機制。