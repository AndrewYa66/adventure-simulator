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
| 種族／職階 | species／class | 種族對應 `species.json` ID、職階對應 `character_classes.json` ID（見下方對照表）；組合由 `npm run validate:data` 驗證 |
| 勢力 | factionId | FAC-xxx；對應 NPC／魔物資料的 `factionId`，決定聲望對該角色態度的影響 |
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

`id`、標題→title、順序→order、預設片段→defaultStoryletId、卡死保底事件→stuckEventId（O32；最後一幕以外必填，事件的觸發方式須為「卡死保底」）、期限天數／期限結局→deadline.days／deadline.endingId（O33，選填：進入本幕後經過指定遊戲日仍未達成結局，即進入期限結局）。內文：幕目標→goal、開場時的世界→openingState、主題與情緒→theme、可能的走向→branches、保底走向→fallback、結束條件→exitCondition。

### 劇情片段

| 中文欄位 | 內部欄位 |
| --- | --- |
| 所屬幕／優先度／預設片段 | act／priority／isDefault |
| 需要旗標／排除旗標 | requires.flags／excludes.flags |
| 需要存活／需要死亡 | requires.unitsAlive／requires.unitsDead |
| 發生地點 | requires.mapIds |
| 首選給予者 | giver.preferredUnitId |
| 給予者職階／給予者勢力／給予者最低等級 | giver.role.classIds／giver.role.factionIds／giver.role.minLevel |
| 接手範圍 | giver.scope：本地→map、全世界→world（預設本地） |
| 保底管道 | giver.fallback：告示板→notice_board、書信→letter、遺物→relic、無→none |
| 目標類型 | goal.type：威脅消除→threatRemoved、抵達地點→locationReached；說服角色、保護角色、得知真相、其他→flagSet（目標對象填旗標，由 AI 提議事件設定）；物品送達尚未支援（見下方說明） |
| 目標對象 | 威脅消除→goal.unitIds（唯一單位 ID，可多個；族群魔物如 `哥布林@MAP-003` 尚未支援）、抵達地點→goal.mapId、旗標→goal.flag |
| 或旗標成立 | goal.orFlag（只用於威脅消除、抵達地點） |
| 目標說明 | goal.summary |
| 完成事件／完成旗標 | onComplete.eventIds（事件的觸發方式須為「劇情片段完成」）／onComplete.setFlags |
| 推進下一幕 | onComplete.advanceAct |
| 進入結局 | onComplete.endingId（O33；與推進下一幕擇一，最後一幕的預設片段必填） |
| 結局特徵 | onComplete.endingTraits（`項目:值` 拆為鍵值） |
| 完成描述／完成傳播範圍 | onComplete.summary／onComplete.knownBy：目擊者→witnesses、本地區→region、全世界→world（預設本地區） |

內文：場面目的→purpose、必須傳達的資訊→mustConvey、情緒基調→tone、關鍵台詞→keyLines、可能的玩家選擇與後果→playerChoices、禁止事項→forbidden、給予者不在時→giverAbsent（以上合為 `scene`）。

遊戲資料格式見 `src/data/story.json` 與 `docs/API.md`「主線：幕與劇情片段」（O31 第一版，目前是手寫的範例資料，O36 建置腳本完成後由 `content/story/` 產生）。範本與寫手指南已於 2026-10-06 補上目標說明、完成描述、完成傳播範圍、接手範圍與給予者最低等級，以及 O32 的卡死保底事件、告示板地點與旗標來源規則。

- 「保底管道」第一版只支援告示板與書信；遺物需死亡遺物（O26）。預設片段不可指定首選給予者或給予者職階／勢力。
- 告示板只在有告示板的地點可用（地圖的地點設施 `facilities: ["notice_board"]`；地圖目前由維護者在 `src/data/maps.json` 設定）；書信到處可用。
- 卡死保底（O32）：本幕沒有任何片段能前進、持續一個遊戲日後，先觸發幕的「卡死保底事件」（可設旗標開出救援片段）；仍無法前進時，遊戲強制完成本幕的預設片段。因此最後一幕以外的預設片段必須「推進下一幕」，完成描述也要能在「沒有人真的完成目標」時讀得通。
- 推進下一幕、或設定其他片段需要的旗標的片段（主線節點），保底管道不可為「無」；片段用到的旗標（需要旗標、目標旗標、或旗標成立）必須有事件或片段會設定。
- 「物品送達」需要「交給非發布者」的交付規則，暫不支援；需要時改用旗標目標。
- 結局（O33）：最後一幕也有卡死保底，因此最後一幕的預設片段必須「進入結局」。

### 結局（O33，範本待設計確認後補上）

遊戲資料見 `src/data/story.json` 的 `endings` 與 `docs/API.md`「結局（O33）」。建議的寫手格式：

- frontmatter：`id`（END-n）、標題→title、結局後→afterEnding（世界繼續→continue、時間線結束→end）。
- 內文：結果→summary（寫入事件紀錄、提供給 AI 的公開結果）；「尾聲」下每個小節是一段尾聲，小節第一行寫顯示條件（例如「條件：結局特徵 魔王的下場=被奪取；旗標 X；角色 Y 存活」，沒有條件則每次都顯示），其餘為段落文字→epilogues[].when／text。
- 結局由劇情片段的「進入結局」或幕的「期限結局」進入；尾聲依進入結局當下的結局特徵、旗標與角色生死，由規則挑出所有符合的段落依序顯示，不呼叫 AI。變化軸（例如魔王的下場 × 靈魂值）用多段有條件的尾聲表達。

### 事件

觸發方式→trigger（自動→auto、劇情片段完成→storylet、卡死保底→stuck、角色決策→agent、AI提議→aiProposal）；卡死保底事件須被某一幕引用、不可限制發生地點；條件欄位同劇情片段；設定旗標／移除旗標→effects.setFlags／effects.clearFlags；影響單位／影響地區→effects.units／effects.mapIds；傳播範圍→knownBy（目擊者→witnesses、同勢力→faction、本地區→region、全世界→world）。內文「世界影響」由維護者轉為 `worldModifiers` 等結構化效果，「發生了什麼」轉為 `summary`，AI 提議事件的使用時機寫入 `aiHint`。遊戲資料格式見 `src/data/events.json` 與 `docs/API.md`「世界事件、世界修正與世界規則」；目前遊戲端支援自動、AI 提議、劇情片段完成與卡死保底四種觸發方式（角色決策待 O34）；四種傳播範圍都已支援，「同勢力」需另列得知事件的勢力（`knownByFactions`）。事件也可用聲望等級與勢力關係作為條件、以聲望與勢力關係變化作為效果（見 `docs/API.md`「勢力聲望與勢力間關係」）。

### 設定條目

分類→category（敘事風格→style、歷史→history、地理→geography、勢力→faction、種族→race、文化→culture、宗教→religion、其他→other）；相關→related；AI使用→aiUsage（總是→always、相關時→contextual、僅作者→authorOnly）。內文：摘要→summary、詳細內容→details、一般人知道多少→commonKnowledge、未揭露的真相→hiddenTruth。

## 驗證規則（待實作）

- `id` 格式符合類別前綴，且全域唯一（含 `src/data` 既有 ID 與玩家保留 ID `PLAYER-001`）。
- 列舉欄位只接受上表中文值；必填欄位不得為空。
- 所有引用（角色、地圖、物品、事件、幕、片段、勢力、種族）可解析。
- 旗標必須登記於 `02 旗標清單`。
- 每一幕有且只有一個預設片段，其 `保底管道` 不為「無」，且不依賴任何角色存活；最後一幕以外，預設片段推進下一幕，且幕有卡死保底事件；最後一幕的預設片段進入結局。
- 結局都有進入方式（劇情片段或幕期限），尾聲條件引用的旗標有設定來源。
- 主線節點的保底管道不為「無」；劇情片段用到的旗標都有事件或片段會設定。
- 內文必要段落存在且標題未被改動。
- 錯誤訊息使用中文並指出檔案、欄位與原因。

## 同步流程（待實作）

1. 寫手在共用雲端資料夾（Obsidian 筆記庫）撰寫。
2. 維護者執行同步腳本：將雲端資料夾複製至 repo `content/`（排除 `.obsidian/` 與衝突副本並提示）。
3. 執行驗證與建置，產生遊戲用 JSON，通過後提交。

## 世界設定與職階清單

- 世界觀採用**受托爾金啟發的原創設定**，不直接使用《魔戒》的國家、地名與專有種族名稱（例如以「半身人」代替該作品專有名稱），以避免公開部署時的版權與商標問題。
- 種族：`content/lore/RACE-001`～`RACE-007`，遊戲 ID 為 human（人類）、elf（精靈）、dwarf（矮人）、halfling（半身人）、goblin（哥布林）、orc（獸人）、beast（野獸，不可有職階）。哥布林只能搭配戰鬥類職階，獸人可搭配戰鬥與生活類。
- 勢力：`content/lore/FAC-001`～`FAC-009`（橡木村、艾德蘭王國、北原騎族聯盟、銀灣共和國、鐵脊山王國、霧林、綠丘郡、灰燼部族、斷劍傭兵團）。遊戲資料在 `src/data/factions.json`：勢力的「摘要」轉為 `summary`（只寫公開資訊，AI 會讀取），初始聲望 `initialReputation` 與勢力間初始關係（同盟／友好／中立／緊張／敵對／交戰，加上債務、禁運、盟約、貿易往來等附加關係）由維護者依「詳細內容」的對外關係填寫，目前為依審閱中草稿整理的版本。「未揭露的真相」不可寫入勢力關係（例如祕密資助不列為公開關係）。
- 世界局勢與核心設定：`LORE-001 世界局勢`（AI 每回合讀取）、`LORE-002 星鐵`、`LORE-003 主線大綱`（僅作者）。
- 職階清單：`content/03 職階清單.md`。角色卡以中文名稱填寫，建置時對應下表 ID；24 種職階皆已定義於 `character_classes.json`。

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

O28 已將既有 NPC 類別（原 `npc_categories.json`，已移除）與魔物遷移為：一般村民→依個人職階（長老、工匠、農民、店主）、村莊守衛→衛兵、林地獵人→獵人；哥布林斥候→斥候、哥布林打手→戰士、格羅姆・裂牙→首領、灰林狼→無職階（野獸）。
