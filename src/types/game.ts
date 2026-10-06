// ==========================================
// 1. 靜態資料庫 DTO (Static Data - Read Only)
// ==========================================

/** 道具靜態資料 (來自 items.json) */
export interface ItemStatic {
  id: string;             // 格式: "ITEM-xxx"
  name: string;           // 顯示名稱
  type: 'consumable' | 'weapon' | 'armor' | 'accessory' | 'quest';
  usableInCombat: boolean;
  effect: {
    hpRestore?: number;
    mpRestore?: number;
    atkBonus?: number;
    defBonus?: number;
    spdBonus?: number;
    specialEffect?: string;
  };
  buyPrice: number;
  sellPrice: number;
  description: string;
}

/** 能力值六維。 */
export interface AbilityScores { str: number; dex: number; con: number; int: number; wis: number; cha: number }
export type AbilityKey = keyof AbilityScores;

/** 有效戰鬥與資源數值；玩家與所有單位共用同一公式計算（見 utils/unitGrowth.ts）。 */
export interface UnitStatBlock {
  hp: number;
  mp: number;
  atk: number;
  def: number;
  spd: number;
}
export type UnitStatKey = keyof UnitStatBlock;

/** 同等級強度基準表 (來自 level_benchmarks.json)：「人類冒險者」在該等級的標準數值，種族與職階以倍率相對校準。 */
export interface LevelBenchmarkStatic extends UnitStatBlock {
  level: number;
  /** 累計經驗值達此數值即升至下一級；最高等級的值不使用。 */
  requiredExp: number;
  /** 被擊倒時給予的基準經驗值，再乘以種族與職階倍率。 */
  expReward: number;
}

/** 技能靜態資料 (來自 skills.json)；由職階的 skillUnlocks 依等級解鎖。 */
export interface SkillStatic {
  id: string;
  name: string;
  type: 'active' | 'passive';
  costMp: number;
  description: string;
  effect: { kind: 'damage_multiplier'; multiplier: number } | { kind: 'healing'; hpRestore: number };
}

export type ClassCategory = 'combat' | 'social' | 'life';
export type CheckBonuses = Partial<Record<ActionCheckResult['stat'], number>>;

/** 種族靜態資料 (來自 species.json)：提供基礎數值倍率、能力值修正與天生特性。 */
export interface SpeciesStatic {
  id: string;
  name: string;
  description: string;
  /** 可搭配的職階類別；不在其中的職階組合會被資料驗證拒絕。 */
  allowedClassCategories: ClassCategory[];
  /** 是否允許沒有職階（例如野獸）。 */
  allowsNoClass: boolean;
  statMultipliers: UnitStatBlock;
  abilityModifiers: Partial<AbilityScores>;
  checkBonuses?: CheckBonuses;
  expRewardMultiplier: number;
  traits: string[];
  /** 世界規則：此種族的非唯一個體死亡後經過幾天由新個體補上；未設定代表不重生。具名的唯一個體不重生。 */
  respawnDays?: number;
}

/** 職階靜態資料 (來自 character_classes.json)：提供成長倍率、能力值修正、檢定加值與技能。 */
export interface CharacterClassStatic {
  id: string;
  name: string;
  category: ClassCategory;
  playerSelectable: boolean;
  description: string;
  abilityModifiers: Partial<AbilityScores>;
  statMultipliers: UnitStatBlock;
  checkBonuses?: CheckBonuses;
  expRewardMultiplier: number;
  skillUnlocks?: { level: number; skillId: string }[];
  /** 玩家可選職階必填。 */
  startingItems?: { itemId: string; quantity: number }[];
  startingEquipment?: { weaponItemId?: string; armorItemId?: string; accessoryItemId?: string };
}

export type CharacterAlignment = '守序善良' | '中立善良' | '混亂善良' | '守序中立' | '絕對中立' | '混亂中立' | '守序邪惡' | '中立邪惡' | '混亂邪惡';
export type UnitDisposition = 'friendly' | 'neutral' | 'hostile';

/** 單位組成：種族 × 職階 × 等級，加上個體相對修正。玩家與所有單位共用。 */
export interface UnitBuild {
  speciesId: string;
  classId?: string;
  level: number;
  /** 相對於公式結果的個體修正（加減值），避免手填絕對數值。 */
  statAdjustments?: Partial<UnitStatBlock>;
}

/**
 * 單位靜態樣板（units.json）：玩家以外的所有單位共用同一結構，差異只由下列功能欄位表達，
 * 不區分人物與魔物。世界中實際個體的成長保存於存檔。
 */
export interface UnitStatic extends UnitBuild {
  id: string;
  name: string;
  /** 稱號或職稱，顯示時置於名稱前（例如「村長」）。 */
  title?: string;
  enName?: string;
  alignment?: CharacterAlignment;
  defaultDisposition: UnitDisposition;
  /** 所屬勢力（factions.json）；未設定代表不屬於任何勢力（例如野獸）。 */
  factionId?: string;
  /** 世界規則「他方佔領」：此單位死亡滿 afterDays 天後不再重生，改由 byUnitId（須為潛伏單位）佔據原地。 */
  occupation?: { byUnitId: string; afterDays: number };
  /** 潛伏單位：開局不出現在世界中，只會經由「他方佔領」出現。 */
  dormantUntilOccupation?: boolean;
  /**
   * 族群樣板：代表一群可重複遭遇的個體，擊倒不寫死亡事件、依種族重生。
   * 未設定即為具名的唯一個體（死亡永久，寫入死亡事件）。
   */
  population?: boolean;
  /**
   * 需要遭遇才會出現：進入地區時不在場，須探索遭遇後才能交戰；每次戰鬥以完整 HP 開始，
   * 成長上限為出沒地區建議等級 +3，可打斷非安全區的等待，也可作為支線委託的討伐目標。
   * 未設定即為地區居民：進入地區即在場，可交談、交易、發布委託，戰鬥 HP 會保留。
   */
  requiresEncounter?: boolean;
  /** 頭目：擊倒時觸發勝利訊息。 */
  isBoss?: boolean;
  /** 只有此任務進行中時才能遭遇。 */
  requiredQuestId?: string;
  /** 強度分級的顯示文字，例如「普通 (Common)」。 */
  tier?: string;
  /** 給 AI 的人物介紹。 */
  description?: string;
  /** 給 AI 的戰鬥行為提示。 */
  tactics?: string;
  /** 經營的商店（shops.json）。 */
  shopId?: string;
  /** 初始持有物；擊倒時由擊倒者取得（世界實際庫存）。 */
  startingGold?: number;
  startingInventory?: { itemId: string; quantity: number }[];
  /** 掉落表：擊倒時額外依機率產生的金幣與物品。 */
  loot?: {
    gold: number;
    dropItems: {
      itemId: string;
      chance: number;     // 例如: 0.5 (50%)
    }[];
  };
  specialAbilities?: {
    name: string;
    effect: string;
    combatAction?: {
      triggerEveryRounds: number;
      checkStat: ActionCheckResult['stat'];
      dc: number;
      damageMultiplier: number;
      applyUnconsciousTurnsOnFailure?: number;
    };
  }[];
}

/** 共用查詢層回傳的正規化單位視圖；stats/expReward 依種族、職階、等級計算，source 保留完整樣板。 */
export interface WorldUnitStatic extends UnitStatic {
  stats: UnitStatBlock;
  expReward: number;
  /** 出現的地圖（地圖 unitsPresent 列出此單位者）。 */
  mapIds: string[];
  /** 居所：第一個列出此單位的地圖；交付委託、委託接手等以此為準。 */
  homeMapId: string;
  source: UnitStatic;
}

/** 玩家在共用單位查詢中的視圖；數值與其他單位同一公式計算並加上裝備，source 保留完整玩家存檔。 */
export interface PlayerWorldUnit extends UnitBuild {
  kind: 'player';
  id: string;
  name: string;
  title?: string;
  alignment: CharacterAlignment;
  stats: UnitStatBlock;
  expReward: number;
  mapIds: string[];
  source: PlayerState;
}

/** 可辨識玩家與其他單位的共用單位視圖。 */
export type WorldUnitView = WorldUnitStatic | PlayerWorldUnit;

export interface ShopStatic {
  id: string;
  name: string;
  /** 經營者單位 ID。 */
  ownerUnitId: string;
  items: { itemId: string; buyPrice?: number }[];
  services?: { id: string; name: string; price: number; kind: 'restore_resources'; description: string }[];
}

/**
 * 單位實例（UnitInstance）：世界中實際存在、可成長的個體，保存於存檔；靜態樣板只提供初始值。
 * 每個單位樣板都有實例；族群樣板代表在該地區出沒的同一群個體，戰鬥 HP 以戰鬥狀態追蹤。
 */
export interface UnitInstance {
  level: number;
  /** 累計經驗值；以等級基準表的門檻判定升級。 */
  exp: number;
  gold: number;
  inventory: { itemId: string; quantity: number }[];
  currentHp?: number;
  isDead?: boolean;
  /** 死亡時的遊戲時間（分鐘）；供重生規則使用。 */
  diedAtMinutes?: number;
  /** 潛伏中（尚未經由「他方佔領」出現）：視為不在場，isDead 為 true 但沒有死亡事件。 */
  isDormant?: boolean;
}

export interface TransactionRecord {
  id: string;
  type: 'purchase' | 'sale' | 'service' | 'quest_reward' | 'unit_transfer' | 'game_change';
  description: string;
  goldChange: number;
  timestamp: number;
}

/** 劇本設定 (來自 scenario.json)：開場、起始狀態等劇本專屬內容，替換此檔即可更換劇本開場。 */
export interface ScenarioStatic {
  id: string;
  title: string;
  /** 主持人 AI 的角色與世界觀定位，置於系統指令開頭。 */
  gmRole: string;
  start: { mapId: string; gold: number; gameTimeMinutes: number };
  defaultPlayer: { name: string; speciesId: string; classId: string; alignment: CharacterAlignment };
  opening: {
    introText: string;
    resetText: string;
    /** 可使用 {name}、{className} 佔位字。 */
    newCharacterText: string;
    suggestedActions: string[];
  };
  inputPlaceholder: string;
  /** 不屬於此世界觀、玩家不可憑空取出的物品詞彙。 */
  anachronisticItemTerms: string[];
  /** 劇本層級的規則開關。 */
  rules: {
    /** 擊倒地區居民（非 requiresEncounter 單位）是否依單位公式給予經驗值（後果另由勢力聲望承擔）；需遭遇的單位一律給予。 */
    residentKillGrantsExp: boolean;
  };
  /** 新角色接續：劇本允許新角色與前一位角色有關聯時，可部分繼承勢力聲望的變化量。 */
  succession?: {
    /** 角色建立畫面的選項文字，例如「以前任冒險者的同鄉身分出發」。 */
    relatedLabel: string;
    /** 繼承比例 0–1：新聲望 = 初始值 + 比例 ×（前角色聲望 − 初始值）。 */
    reputationInheritRatio: number;
  };
}

// ---------- 勢力（factions.json）----------

/** 勢力之間的關係狀態，由敵到友：交戰、敵對、緊張、中立、友好、同盟。 */
export type FactionRelationStatus = 'war' | 'hostile' | 'tense' | 'neutral' | 'friendly' | 'alliance';

/** 聲望等級；disposition 只允許出現在最低（hostile）或最高（friendly）的連續等級，其餘等級沿用單位預設關係。 */
export interface ReputationTierStatic {
  id: string;
  name: string;
  /** 此等級的最低聲望值（含）。 */
  min: number;
  disposition?: 'hostile' | 'friendly';
}

/** 玩家行動造成的聲望變化量（只影響得知該事件的勢力）。 */
export interface ReputationRules {
  /** 殺害該勢力成員。 */
  memberKilled: number;
  /** 主動攻擊原本非敵對的成員。 */
  memberAttacked: number;
  /** 完成該勢力成員發布的委託。 */
  questCompleted: number;
  /** 殺害與自己敵對或交戰勢力的成員。 */
  enemyMemberKilled: number;
}

export interface FactionStatic {
  id: string;
  name: string;
  /** 公開的勢力簡介（不可包含未揭露的真相），提供給 AI。 */
  summary: string;
  /** 新角色對此勢力的初始聲望。 */
  initialReputation: number;
}

export interface FactionRelationStatic {
  factionIds: [string, string];
  status: FactionRelationStatus;
  /** 附加關係，例如債務、禁運、盟約（relationTags 的 ID）。 */
  tags?: string[];
}

export interface FactionDataStatic {
  reputation: { min: number; max: number; tiers: ReputationTierStatic[]; rules: ReputationRules };
  relationTags: { id: string; name: string }[];
  factions: FactionStatic[];
  /** 未列出的勢力組合視為中立、沒有附加關係。 */
  relations: FactionRelationStatic[];
}

/** 勢力條件：事件使用，日後的劇情片段與任務範本共用同一判定。 */
export interface FactionConditions {
  /** 玩家對勢力的聲望等級須介於 minTier 與 maxTier 之間（含）。 */
  reputation?: { factionId: string; minTier?: string; maxTier?: string }[];
  /** 兩勢力目前的關係須為其中之一。 */
  factionRelations?: { factionIds: [string, string]; status: FactionRelationStatus[] }[];
}

/** 事件效果中的勢力變化。 */
export interface FactionEffects {
  reputation?: { factionId: string; change: number }[];
  factionRelations?: { factionIds: [string, string]; status?: FactionRelationStatus; addTags?: string[]; removeTags?: string[] }[];
}

/** 世界修正的作用對象：`unit:<ID>`、`species:<ID>`、`map:<ID>`（位於該地區的單位）。 */
export type WorldModifierScope = `unit:${string}` | `species:${string}` | `map:${string}`;

/** 事件的傳播範圍：目擊者、同勢力、本地區、全世界。 */
export type EventKnownBy = 'witnesses' | 'faction' | 'region' | 'world';

/** 靜態事件 (來自 events.json)：條件與效果由資料定義，前端驗證條件後套用並寫入事件紀錄。 */
export interface EventStatic {
  id: string;
  title: string;
  /** auto：條件成立時由遊戲自動觸發；aiProposal：只能由 AI 提議，前端驗證條件後套用；storylet：劇情片段完成時觸發（O31）。 */
  trigger: 'auto' | 'aiProposal' | 'storylet';
  requires?: { flags?: string[]; unitsAlive?: string[]; unitsDead?: string[]; mapIds?: string[] } & FactionConditions;
  excludes?: { flags?: string[] };
  effects: {
    setFlags?: string[];
    clearFlags?: string[];
    worldModifiers?: { scope: WorldModifierScope; stat: UnitStatKey; op: 'add' | 'multiply'; value: number; durationMinutes?: number }[];
  } & FactionEffects;
  knownBy: EventKnownBy;
  /** knownBy 為 faction 時得知此事件的勢力。 */
  knownByFactions?: string[];
  /** 公開的事件描述（發生了什麼）。 */
  summary: string;
  /** AI 提議事件的使用時機。 */
  aiHint?: string;
}

/** 地圖靜態資料 (來自 maps.json) */
export interface MapStatic {
  id: string;             // 格式: "MAP-xxx"
  name: string;
  enName: string;
  recommendedLevel: string;
  zoneType: string;
  aliases?: string[];
  locationTags?: string[];
  isSafeZone: boolean;
  description: string;
  connectedMapIds: string[];
  pointsOfInterest: string[];
  /** 出現在此地區的單位 ID（居民與需遭遇的單位）。 */
  unitsPresent: string[];
  requiredQuestId?: string;
}

/** 任務靜態資料 (來自 quests.json) */
export interface QuestStatic {
  id: string;             // 格式: "QST-xxx"
  title: string;
  questGiverId: string;
  questGiver: string;
  mapId: string;
  prerequisiteQuestIds?: string[];
  objective: string;
  requirements: {
    defeatUnits?: { unitId: string; quantity: number }[];
    collectItems?: { itemId: string; quantity: number }[];
  };
  rewards: {
    exp: number;
    gold: number;
    items?: { itemId: string; quantity: number }[];
  };
  rewardLimits?: { exp: { min: number; max: number }; gold: { min: number; max: number }; maxItemQuantity: number };
}

/** 任務範本類型：討伐（擊敗附近需遭遇的單位）、收集（收集其掉落物）。 */
export type QuestTemplateType = 'defeat' | 'collect';

/** 任務範本 (來自 quest_templates.json)：AI 只能依範本提議支線委託，數值由公式與上限決定。 */
export interface QuestTemplateStatic {
  id: string;
  type: QuestTemplateType;
  name: string;
  /** 可用 {target}（目標單位或物品名稱）、{quantity}。 */
  titlePattern: string;
  objectivePattern: string;
  /** AI 提議此範本的使用時機。 */
  aiHint: string;
  /** 發布者限制；未設定代表任何有所屬勢力的地區居民都可發布。 */
  giver?: { factionIds?: string[]; classIds?: string[] };
  quantity: { min: number; max: number };
  /** 委託期限（遊戲日）；逾期後失效並退還報酬。 */
  durationDays: number;
  reward: {
    /** 經驗值 = 目標擊倒經驗 × 數量 × expRatio，不超過 maxExp。 */
    expRatio: number;
    maxExp: number;
    /** 報酬價值上限 = 目標等級 × valuePerLevel × 數量，不超過 maxValue。 */
    valuePerLevel: number;
    maxValue: number;
    maxItemQuantity: number;
  };
  requires?: { flags?: string[] } & FactionConditions;
  excludes?: { flags?: string[] };
}

// ---------- 主線：幕與劇情片段（O31，story.json）----------

/** 保底管道（非單位的給予者）：告示板、書信、遺物（遺物需 O26，尚未支援）、無。 */
export type StoryletGiverChannel = 'notice_board' | 'letter' | 'relic' | 'none';

/**
 * 劇情片段目標：以結果定義，由他人或事件達成時同樣推進。
 * threatRemoved：列出的唯一單位都已死亡；locationReached：玩家抵達地圖；flagSet：旗標成立（說服、得知真相等由事件設定旗標）。
 * orFlag：另一種解法（例如說服對方離開）由事件設定此旗標時，同樣算完成。
 */
export type StoryletGoal =
  | { type: 'threatRemoved'; unitIds: string[]; orFlag?: string; summary: string }
  | { type: 'locationReached'; mapId: string; orFlag?: string; summary: string }
  | { type: 'flagSet'; flag: string; summary: string };

/** 幕：主線的大階段與收斂點。 */
export interface StoryActStatic {
  id: string;
  title: string;
  /** 幕的順序；推進下一幕時取 order 次大的幕。 */
  order: number;
  /** 預設片段（保底）：本幕沒有其他片段可走時才成為候選。 */
  defaultStoryletId: string;
  /** 幕目標（結果），提供給 AI 作為敘事方向。 */
  goal: string;
  theme?: string;
}

/** 劇情片段的演出要求（給 AI）。 */
export interface StoryletScene {
  purpose: string;
  mustConvey: string[];
  tone?: string;
  keyLines?: string[];
  playerChoices?: string[];
  forbidden: string[];
  /** 首選給予者不在時（由接手者或保底管道帶出）的演出方式。 */
  giverAbsent?: string;
}

/** 劇情片段（Storylet）：進入條件、給予者條件、以結果定義的目標、完成效果與演出要求。 */
export interface StoryletStatic {
  id: string;
  actId: string;
  title: string;
  /** 0–100；候選依此排序，越大越優先。 */
  priority: number;
  /** 本幕的預設片段（保底）。 */
  isDefault?: boolean;
  /** 進入條件；mapIds 是片段發生地點（玩家須在其中）。開始後不再檢查。 */
  requires?: { flags?: string[]; unitsAlive?: string[]; unitsDead?: string[]; mapIds?: string[] } & FactionConditions;
  excludes?: { flags?: string[] };
  /** 給予者綁定角色條件：首選者不可用（死亡、潛伏、敵對）時，由符合 role 的存活、非敵對居民接手；都沒有時使用保底管道。 */
  giver: {
    preferredUnitId?: string;
    role?: { classIds?: string[]; factionIds?: string[]; minLevel?: number };
    /** 接手人選範圍：map 為片段發生地點（未設定時為首選者居所）的居民；world 為全世界。預設 map。 */
    scope?: 'map' | 'world';
    fallback: StoryletGiverChannel;
  };
  goal: StoryletGoal;
  onComplete: {
    /** 完成時觸發的事件（trigger 須為 storylet），條件不成立的事件略過。 */
    eventIds?: string[];
    setFlags?: string[];
    advanceAct?: boolean;
    endingTraits?: Record<string, string>;
    /** 完成時寫入事件紀錄的公開結果。 */
    summary: string;
    knownBy?: EventKnownBy;
  };
  scene: StoryletScene;
}

export interface StoryDataStatic {
  rules: {
    /** 同時進行中的片段上限。 */
    maxActiveStorylets: number;
    /** 每回合最多開始幾個片段。 */
    maxStartsPerTurn: number;
    /** 提供給 AI 的候選片段上限（依優先度）。 */
    maxCandidatesForAI: number;
  };
  acts: StoryActStatic[];
  storylets: StoryletStatic[];
}

/** 主線進度（世界存檔）。 */
export interface StoryState {
  currentActId: string;
  activeStorylets: { id: string; startedAtMinutes: number; giverUnitId?: string; giverChannel?: StoryletGiverChannel }[];
  /** wasActive：完成時是否已開始（false 代表目標先被他人或事件達成）。 */
  completedStorylets: { id: string; completedAtMinutes: number; wasActive: boolean }[];
  /** 過程中累積的結局特徵（項目 → 值），提供給 AI 作為敘事背景，結局判定見 O33。 */
  endingTraits: Record<string, string>;
}

/** 可截斷的 AI 上下文區段；其餘區段（規則、候選清單）不截斷，避免 AI 看不到合法選項。 */
export type AIContextTrimmableSectionId = 'legacy' | 'worldEvents' | 'modifiers' | 'chronicle';

/** AI 上下文組裝設定（O39）：每回合呼叫上限與 token 預算（以字元計）。 */
export interface AIContextConfigStatic {
  /** 每回合 AI 呼叫上限（主持人敘事 1 次 + 修正請求）。 */
  maxCallsPerTurn: number;
  /** 系統提示的整體字元上限；超出時依優先順序截斷可截斷區段。 */
  totalBudgetChars: number;
  legacy: { maxCharacters: number; maxDeedsPerCharacter: number };
  worldEvents: { maxEvents: number };
  chronicle: { maxLines: number };
  /** 傳聞或公開消息經過多少遊戲日後變成「傳說」（親眼目擊者不受影響）。 */
  knowledge: { legendAfterDays: number };
  /** priority 數字越小越重要；超出整體預算時先截斷數字大的區段。 */
  trimmableSections: Record<AIContextTrimmableSectionId, { priority: number; maxChars: number }>;
  /** 近期對話視窗（O39 第二版）：一輪從玩家訊息開始；超出 maxChars 時從最舊的訊息捨棄。 */
  dialogue: { maxTurns: number; maxChars: number; maxCharsPerMessage: number; includeSystemMessages: boolean };
  /** 人物記憶（memoryNotes）：每次回應最多幾則、每則字數上限、每個人物保留幾則（超出捨棄最舊）。 */
  memory: { maxNotesPerResponse: number; maxNoteChars: number; maxNotesPerUnit: number };
}

export interface QuestTemplateDataStatic {
  limits: {
    /** 全世界同時開放（含已接取未完成）的動態委託上限。 */
    maxOpenQuests: number;
    maxOpenPerGiver: number;
    /** 同一發布者兩次發布之間至少相隔的遊戲日。 */
    giverCooldownDays: number;
  };
  templates: QuestTemplateStatic[];
}

/**
 * 依範本生成的支線委託（世界存檔）。rewards 為發布時自發布者持有物預扣保留的報酬；
 * 是否已被接取取決於目前角色的 activeQuests，不另外記錄。
 */
export interface GeneratedQuest extends QuestStatic {
  generated: true;
  templateId: string;
  targetUnitId: string;
  status: 'open' | 'completed' | 'failed' | 'expired';
  postedAtMinutes: number;
  expiresAtMinutes: number;
}

/**
 * 委託提議；前端以 validateQuestProposal 驗證後才發布。
 * 主持人 AI 只選範本、發布者、目標與數量，報酬由規則自發布者持有物組成；明確指定報酬時（例如日後的重要角色決策）須在上限內，否則拒絕。
 */
export interface QuestProposal {
  templateId: string;
  giverId: string;
  targetUnitId: string;
  /** 收集範本的目標物品；討伐範本為 null。 */
  itemId?: string | null;
  quantity: number;
  rewardGold?: number;
  rewardItems?: { itemId: string; quantity: number }[];
}


// ==========================================
// 2. 動態資料 DTO (Dynamic State - LocalStorage / API)
// ==========================================

/**
 * 戰鬥參與者：party（玩家、日後的同伴）的 HP 存於各自存檔/實例；enemy 的 HP 在戰鬥中追蹤。
 * 結構預留多對多戰鬥（O35）；目前遊戲規則仍為玩家對單一敵人。
 */
export type CombatParticipant =
  | { unitId: string; side: 'party' }
  | { unitId: string; side: 'enemy'; currentHp: number };

export interface CombatState {
  round: number;
  participants: CombatParticipant[];
  /** 玩家目前攻擊的敵方單位 ID。 */
  targetUnitId: string;
}

export type DeathCause = 'combat' | 'self_inflicted' | 'misadventure' | 'unknown';

/**
 * 世界事件紀錄（只增不改）：世界的永久變動經由事件入口套用並寫入此紀錄。
 * summary 是公開結果（未在場者也會聽說）；detail 是經過與兇手等細節，只有目擊者知道。
 */
export interface WorldEvent {
  id: string;
  type: 'unit_death' | 'unit_respawn' | 'unit_occupation' | 'quest_failed' | 'quest_transferred' | 'reputation_change' | 'scenario_event' | 'story_progress';
  gameTimeMinutes: number;
  mapId: string;
  summary: string;
  detail?: string;
  knownBy: EventKnownBy;
  /** 事件發生時在場且存活的單位（目擊者）。 */
  witnessUnitIds: string[];
  /** 得知此事件（至少公開結果）的勢力，依傳播範圍於寫入時決定。 */
  awareFactionIds: string[];
  /** 觸發原因，例如「戰鬥」「條件成立自動觸發」「AI 提議」。 */
  cause: string;
  death?: { victimUnitId: string; victimName: string; cause: DeathCause; killerUnitId?: string; killerName?: string };
  /** 靜態事件 ID（scenario_event）。 */
  eventId?: string;
  /** 造成的改變。 */
  changes?: { setFlags?: string[]; clearFlags?: string[]; modifierIds?: string[]; questIds?: string[]; unitIds?: string[]; factionIds?: string[]; storyletIds?: string[]; actIds?: string[] };
  /** 玩家聲望變化（勢力 ID 與變化量）。 */
  reputationChanges?: { factionId: string; change: number }[];
  /** 事件發生時在世的玩家角色代數（PlayerState.characterSeq）。 */
  characterSeq?: number;
  /** 由另一事件衍生時的來源事件 ID，例如殺害造成的聲望變化引用死亡事件。 */
  sourceEventId?: string;
}

/** 世界修正：一律為相對值（加減或倍率），疊加在公式數值之上，靜態數值調整後仍自動生效。 */
export interface WorldModifier {
  id: string;
  scope: WorldModifierScope;
  stat: UnitStatKey;
  op: 'add' | 'multiply';
  value: number;
  sourceEventId: string;
  expiresAtMinutes?: number;
}

/** 執行期世界狀態（屬於世界存檔）；單位實例、時間與旗標見 PlayerState 的其他世界層欄位。 */
export interface WorldRuntimeState {
  /** 事件紀錄；超過上限時最舊的事件壓縮進 chronicle。 */
  events: WorldEvent[];
  /** 世界編年史：壓縮後的舊事件摘要，每行一件。 */
  chronicle: string[];
  nextEventSeq: number;
  modifiers: WorldModifier[];
  /** 已觸發過的靜態事件 ID（每個事件只觸發一次）。 */
  firedEventIds: string[];
  /** 地區延後結算：玩家所在地區才結算，記錄上次補貨的遊戲日。 */
  regions: Record<string, { lastRestockDay: number }>;
  /** 勢力間關係：只保存與 factions.json 初始值不同的組合，鍵為排序後的「勢力A|勢力B」。 */
  factionRelations: Record<string, { status: FactionRelationStatus; tags: string[] }>;
  /** 依任務範本生成的支線委託（O30）。 */
  generatedQuests: GeneratedQuest[];
  nextGeneratedQuestSeq: number;
  /** 人物記憶（O39 第二版）：單位 ID → 該人物記得的與玩家往來，舊→新。 */
  unitMemories: Record<string, UnitMemoryNote[]>;
  /** 主線進度（O31）。 */
  story: StoryState;
}

/** 人物記得的一件事（由 AI 的 memoryNotes 經前端驗證後寫入）。 */
export interface UnitMemoryNote {
  note: string;
  gameTimeMinutes: number;
  /** 記下時的玩家角色代數；只有同一代角色的記憶會送給 AI。 */
  characterSeq: number;
}

/** 玩家動態存檔狀態 (寫入 LocalStorage) */
export interface PlayerState {
  /** 玩家穩定單位 ID，固定為 PLAYER_UNIT_ID。 */
  unitId: string;
  /** 此角色在世界中的代數（第一位角色為 1，接續的新角色依序加一）；事件以此連結到歷代角色。 */
  characterSeq: number;
  name: string;
  /** 玩家種族；新角色取自劇本預設種族。 */
  speciesId: string;
  classId: string;
  alignment: CharacterAlignment;
  setupComplete: boolean;
  abilities: AbilityScores;
  isDead: boolean;
  statusEffects: { id: 'unconscious'; remainingTurns: number }[];
  level: number;
  exp: number;
  hp: number;
  mp: number;
  gold: number;
  /** 單位的實例狀態（世界層）。 */
  unitInstances: Record<string, UnitInstance>;
  transactionHistory: TransactionRecord[];
  currentMapId: string;
  previousMapId?: string;
  /** 遊戲時鐘：自世界開始經過的分鐘數，只依行動類型固定耗時推進；O37 拆分世界存檔後移至世界層。 */
  gameTimeMinutes: number;
  
  // 背包建議儲存 itemId 與 quantity，其餘詳細說明向靜態資料庫查詢
  inventory: { 
    itemId: string; 
    quantity: number; 
  }[];
  
  equipped: {
    weaponItemId?: string;
    armorItemId?: string;
    accessoryItemId?: string;
  };

  // 劇情進度與旗標，防止 AI 遺忘劇情進度
  storyFlags: Record<string, boolean>; // 例如: { "FLAG_TUTORIAL_DONE": true }
  defeatedUnits: Record<string, number>;
  encounteredUnitId?: string;
  unitDispositionOverrides: Record<string, UnitDisposition>;
  /** 各勢力對目前角色的聲望（角色層；新角色依劇本初始值重置）。 */
  factionReputation: Record<string, number>;

  // 當前進行中的任務
  activeQuests: {
    questId: string;
    status: 'in_progress' | 'completed' | 'failed';
    progress?: { defeatedUnits: Record<string, number> };
    /** 原委託人死亡後，由同勢力、同職階單位接手時的新委託人 ID。 */
    giverUnitId?: string;
  }[];
  /** 進行中的戰鬥；掉落與特殊招式取自單位樣板的功能欄位。 */
  combat?: CombatState;
  /** 世界狀態：事件紀錄、世界修正與地區結算（世界層）。 */
  world: WorldRuntimeState;
}

/** 對話視窗訊息 */
export interface StoryMessage {
  id: string;
  sender: 'ai' | 'user' | 'system';
  text: string;
  options?: string[];
  checkResult?: ActionCheckResult;
  checkResults?: ActionCheckResult[];
  travelOptions?: { mapId: string; name: string }[];
  timestamp: string;
}

export interface ActionCheckResult {
  reason: string;
  stat: 'atk' | 'def' | 'spd' | 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
  d20Rolls: number[];
  baseStat: number;
  equipmentBonus: number;
  statValue: number;
  /** 種族/職階檢定加值（已計入 modifier）。 */
  checkBonus: number;
  modifier: number;
  total: number;
  dc: number;
  success: boolean;
  label?: string;
}

// ==========================================
// 3. 存檔架構 (O37)：世界存檔 + 角色存檔
// ==========================================

/** 歸入世界存檔的欄位；其餘 PlayerState 欄位屬於角色存檔。執行期仍合併為 PlayerState，只在存檔時拆分。 */
export const WORLD_STATE_KEYS = ['gameTimeMinutes', 'unitInstances', 'storyFlags', 'world'] as const;
export type WorldStateKey = typeof WORLD_STATE_KEYS[number];

/** 已結束的歷代角色紀錄；供 AI 傳聞與人物對話素材，死亡遺物（O26）之後由此擴充。 */
export interface CharacterHistoryEntry {
  /** 角色代數，對應事件的 characterSeq。 */
  characterSeq: number;
  name: string;
  speciesId: string;
  classId: string;
  alignment: CharacterAlignment;
  level: number;
  /** 結束時的遊戲時間（分鐘）。 */
  endedAtMinutes: number;
  mapId: string;
  reason: 'death';
  /** 死亡事件 ID 與其公開描述；死因細節見事件紀錄。 */
  deathEventId?: string;
  deathSummary?: string;
  /** 結束時的攜帶物快照，留待 O26 死亡遺物使用。 */
  inventory: { itemId: string; quantity: number }[];
  gold: number;
}

/** 世界存檔：同一世界中跨角色保留的狀態。 */
export interface WorldSave extends Pick<PlayerState, WorldStateKey> {
  characterHistory: CharacterHistoryEntry[];
}

/** 角色存檔：目前在世角色的能力、背包、任務等。 */
export type CharacterSave = Omit<PlayerState, WorldStateKey>;

/** 一個存檔欄位（自動或手動）的完整內容。 */
export interface SaveSlotData {
  schemaVersion: number;
  savedAt: number;
  world: WorldSave;
  character: CharacterSave;
  messages: StoryMessage[];
}

export type SaveSlotId = 'auto' | 'manual-1' | 'manual-2' | 'manual-3';

/** 存檔索引中的世界摘要。 */
export interface WorldIndexEntry {
  id: string;
  name: string;
  scenarioId: string;
  createdAt: number;
  updatedAt: number;
}

export interface SaveIndex {
  schemaVersion: number;
  activeWorldId?: string;
  worlds: WorldIndexEntry[];
}

/** 匯出檔格式：一個世界的所有存檔欄位。 */
export interface WorldExportFile {
  format: 'adventure-simulator-world';
  schemaVersion: number;
  exportedAt: number;
  world: WorldIndexEntry;
  slots: Partial<Record<SaveSlotId, SaveSlotData>>;
}


/** AI 結構化回應 (Gemini 回傳格式) */
export interface AIResponsePayload {
  /** 回應格式版本（O39）；沒有版本號的回應解析為 1。 */
  formatVersion?: number;
  storyText: string;
  suggestedActions: string[];
  encounterRequest?: { unitId: string } | null;
  travelRequest?: { destinationMapId: string } | null;
  /** 使用目前地區商店的服務；只可選遊戲提供的候選，由前端以與 HUD 相同的規則結算。 */
  serviceRequest?: { shopId: string; serviceId: string } | null;
  checkRequest?: {
    stat: ActionCheckResult['stat'];
    dc: number;
    reason: string;
  };
  checkOutcomes?: {
    successText: string;
    failureText: string;
  };
  stateChanges?: {
    hpChange?: number;
    mpChange?: number;
    expChange?: number;
    goldChange?: number;
    addItems?: { itemId: string; quantity: number }[];
    removeItems?: { itemId: string; quantity: number }[];
    questUpdates?: { questId: string; status: 'completed' }[];
    questAcceptances?: string[];
    unitItemTransfers?: { unitId: string; itemId: string; quantity: number }[];
    defeatedUnits?: { unitId: string; quantity: number }[];
    unitDispositionChanges?: { unitId: string; disposition: UnitDisposition }[];
  };
  failureStateChanges?: AIResponsePayload['stateChanges'];
  /** 提議觸發的靜態事件 ID；只可選遊戲提供的候選，前端驗證條件後套用。劇情旗標只能經由事件設定。 */
  eventProposals?: string[];
  /** 依任務範本提議的支線委託（最多一件）；只可選遊戲提供的候選，前端驗證後發布。 */
  questProposals?: QuestProposal[];
  /** 在場人物值得記住的一句話（第 4 版）；前端驗證人物在場且存活後存入人物記憶。 */
  memoryNotes?: { unitId: string; note: string }[];
  /** 本回合開始的劇情片段 ID（第 5 版）；只可選遊戲提供的候選，前端驗證後開始。 */
  storyletProposals?: string[];
}
