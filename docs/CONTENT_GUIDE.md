# 敘事內容維護說明（O36）

寫手用的指南在 `content/00 寫手指南.md`（寫手只會看到 `content/` 筆記庫，因此寫手指南放在筆記庫內）。本文件給專案維護者與開發者，說明內容格式、欄位對應與尚待實作的工具。

## 目前狀態

- 已完成：`content/` 資料夾結構、五種範本（角色卡、幕、劇情片段、事件、設定條目）、寫手指南、ID 登記表、旗標清單、`LORE-000 敘事風格` 骨架、兩份範例。
- 尚未實作：Markdown → JSON 建置腳本、內容驗證器（CLI 與網頁版）、雲端筆記庫同步腳本，以及遊戲端讀取這些內容（依賴 O28–O35）。

## 資料夾結構

```
content/
├─ 00 寫手指南.md        寫手指南（不建置）
├─ 01 ID 登記表.md        ID 登記（不建置；驗證器可用來比對）
├─ 02 旗標清單.md         旗標登記（驗證器以此為合法旗標來源）
├─ _templates/           Obsidian 範本（不建置）
├─ _examples/            範例（不建置）
├─ characters/           角色卡
├─ story/actN/           幕與劇情片段
├─ events/               事件
└─ lore/                 設定條目（LORE / FAC / RACE）
```

建置規則：忽略 `_` 開頭的資料夾、以數字開頭的根目錄檔案，以及 `.obsidian/`。只納入 `狀態: 定稿` 的檔案。

## 設計決策

- **frontmatter 一律扁平**：Obsidian 的屬性介面只能以表單編輯文字、清單、數字、勾選與日期，無法編輯巢狀物件，因此巢狀結構（如 `giver.role.class`）在 frontmatter 中攤平為獨立欄位，由建置腳本組回巢狀 JSON。
- **欄位名稱與可選值使用中文**：降低非技術寫手的填寫錯誤；建置腳本負責對應到程式內部的英文欄位與列舉值。
- **引用可為 ID 或 Obsidian 連結**：`MAP-001` 或 `"[[NPC-001 埃爾德]]"`。解析規則：去除 `[[ ]]` 與 `|別名`，取第一個空白前的字串為 ID。
- **填寫說明使用 `%% … %%`**：Obsidian 閱讀模式不顯示；建置時移除，不送給 AI。
- **數值不在敘事內容中**：HP/ATK 等仍維護於 `src/data/*.json`；角色卡以 ID 對應。
- **內文以固定 `##` 標題分段**：建置時依標題切成欄位，供 AI 上下文依情境挑選段落。

## 欄位對應

### 共通

| 中文欄位 | 內部欄位 | 值對應 |
| --- | --- | --- |
| 狀態 | status | 草稿→draft、審閱中→review、定稿→final |
| 作者 | author | |
| 更新日期 | updatedAt | |

### 角色卡

| 中文欄位 | 內部欄位 | 值對應／備註 |
| --- | --- | --- |
| 名稱／稱號 | name／title | |
| 單位類型 | unitType | NPC→npc、魔物→monster |
| 種族／職階 | species／class | O28 建立種族與職階清單後改為 ID 驗證 |
| 勢力 | faction | FAC-xxx |
| 陣營傾向 | alignment | 沿用現有 `CharacterAlignment` 中文值 |
| 所在地 | mapId | |
| 預設關係 | defaultDisposition | 友善→friendly、中立→neutral、敵對→hostile |
| 重要角色 | agent（存在與否） | true 時建立 `agent` |
| 同伴 | companion | |
| 目標／個性 | agent.goals／agent.traits | |
| 預設行為 | agent.ruleFallback | 守護→guardian、經商→merchant、巡邏→patrol、流浪→wanderer、掠奪→raider、隱居→hermit |
| 繼承者 | successors | |

內文段落：一句話介紹→summary、外貌與第一印象→appearance、說話口吻→voice、個性與價值觀→personality、動機與目標→motivation、祕密→secrets（AI 不得主動揭露）、與其他角色的關係→relationships、同伴設定→companionNotes。

### 幕

`id`、標題→title、順序→order、預設片段→defaultStorylet。內文：幕目標→goal、開場時的世界→openingState、主題與情緒→theme、可能的走向→branches、保底走向→fallback、結束條件→exitCondition。

### 劇情片段

| 中文欄位 | 內部欄位 |
| --- | --- |
| 所屬幕／優先度／預設片段 | act／priority／isDefault |
| 需要旗標／排除旗標 | requires.flags／excludes.flags |
| 需要存活／需要死亡 | requires.unitsAlive／requires.unitsDead |
| 發生地點 | requires.mapIds |
| 首選給予者 | giver.preferred |
| 給予者職階／給予者勢力 | giver.role.class／giver.role.faction |
| 保底管道 | giver.fallback：告示板→notice_board、書信→letter、遺物→relic、無→none |
| 目標類型 | goal.type：威脅消除→threatRemoved、物品送達→itemDelivered、抵達地點→locationReached、說服角色→unitPersuaded、保護角色→unitProtected、得知真相→truthRevealed、其他→custom |
| 目標對象 | goal.target：`MON-003`、`哥布林@MAP-003`→`species:goblin@MAP-003`、`ITEM-002→NPC-001`、`MAP-003`、旗標名稱 |
| 完成事件／完成旗標 | onComplete.events／onComplete.flags |
| 推進下一幕 | onComplete.advanceAct |
| 結局特徵 | onComplete.endingTraits（`項目:值` 拆為鍵值） |

內文：場面目的→purpose、必須傳達的資訊→mustConvey、情緒基調→tone、關鍵台詞→keyLines、可能的玩家選擇與後果→playerChoices、禁止事項→forbidden、給予者不在時→giverAbsent。

### 事件

觸發方式→trigger（自動→auto、劇情片段完成→storylet、角色決策→agent、AI提議→aiProposal）；條件欄位同劇情片段；設定旗標／移除旗標→effects.setFlags／effects.clearFlags；影響單位／影響地區→effects.units／effects.mapIds；傳播範圍→knownBy（目擊者→witnesses、同勢力→faction、本地區→region、全世界→world）。內文「世界影響」由維護者轉為 `worldModifiers` 等結構化效果（O29）。

### 設定條目

分類→category（敘事風格→style、歷史→history、地理→geography、勢力→faction、種族→race、文化→culture、宗教→religion、其他→other）；相關→related；AI使用→aiUsage（總是→always、相關時→contextual、僅作者→authorOnly）。內文：摘要→summary、詳細內容→details、一般人知道多少→commonKnowledge、未揭露的真相→hiddenTruth。

## 驗證規則（待實作）

- `id` 格式符合類別前綴，且全域唯一（含 `src/data` 既有 ID 與玩家保留 ID `PLAYER-001`）。
- 列舉欄位只接受上表中文值；必填欄位不得為空。
- 所有引用（角色、地圖、物品、事件、幕、片段、勢力、種族）可解析。
- 旗標必須登記於 `02 旗標清單`。
- 每一幕有且只有一個預設片段，其 `保底管道` 不為「無」，且不依賴任何角色存活。
- 內文必要段落存在且標題未被改動。
- 錯誤訊息使用中文並指出檔案、欄位與原因。

## 同步流程（待實作）

1. 寫手在共用雲端資料夾（Obsidian 筆記庫）撰寫。
2. 維護者執行同步腳本：將雲端資料夾複製至 repo `content/`（排除 `.obsidian/` 與衝突副本並提示）。
3. 執行驗證與建置，產生遊戲用 JSON，通過後提交。

## 世界設定與職階清單

- 世界觀採用**受托爾金啟發的原創設定**，不直接使用《魔戒》的國家、地名與專有種族名稱（例如以「半身人」代替該作品專有名稱），以避免公開部署時的版權與商標問題。
- 種族：`content/lore/RACE-001`～`RACE-007`（人類、精靈、矮人、半身人、哥布林、獸人、野獸）。
- 勢力：`content/lore/FAC-001`～`FAC-009`（橡木村、艾德蘭王國、北原騎族聯盟、銀灣共和國、鐵脊山王國、霧林、綠丘郡、灰燼部族、斷劍傭兵團）。
- 世界局勢與核心設定：`LORE-001 世界局勢`（AI 每回合讀取）、`LORE-002 星鐵`、`LORE-003 主線大綱`（僅作者）。
- 職階清單：`content/03 職階清單.md`。角色卡以中文名稱填寫，建置時對應下表 ID；`adventurer`、`warrior`、`scout`、`mage` 沿用現有 `character_classes.json`，其餘為 O28 新增。

| 中文 | ID | 類別 | 玩家可選 |
| --- | --- | --- | --- |
| 冒險者 | adventurer | 戰鬥 | ✓ |
| 戰士 | warrior | 戰鬥 | ✓ |
| 斥候 | scout | 戰鬥 | ✓ |
| 法師 | mage | 戰鬥 | ✓ |
| 祭司 | priest | 戰鬥 | ✓ |
| 盜賊 | rogue | 戰鬥 | ✓ |
| 說客 | envoy | 戰鬥 | ✓ |
| 騎士 | knight | 戰鬥 | |
| 狂戰士 | berserker | 戰鬥 | |
| 薩滿 | shaman | 戰鬥 | |
| 首領 | chieftain | 戰鬥 | |
| 貴族 | noble | 社會 | |
| 使節 | diplomat | 社會 | |
| 商人 | merchant | 社會 | |
| 間諜 | spy | 社會 | |
| 將領 | commander | 社會 | |
| 長老 | elder | 生活 | |
| 工匠 | smith | 生活 | |
| 農民 | farmer | 生活 | |
| 店主 | innkeeper | 生活 | |
| 衛兵 | guard | 生活 | |
| 獵人 | hunter | 生活 | |
| 礦工 | miner | 生活 | |
| 學者 | scholar | 生活 | |

現有 NPC 類別（`npc_categories.json`）與魔物對應：一般村民→依個人職階（長老、工匠、農民、店主）、村莊守衛→衛兵、林地獵人→獵人；哥布林斥候→斥候、哥布林打手→戰士、格羅姆・裂牙→首領、灰林狼→無職階（野獸）。
