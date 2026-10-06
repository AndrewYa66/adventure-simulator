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

/** 有效戰鬥與資源數值；玩家、NPC、魔物共用同一公式計算（見 utils/unitGrowth.ts）。 */
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
  /** 世界規則：此種族的非唯一個體死亡後經過幾天由新個體補上；未設定代表不重生。具名 NPC 與頭目不重生。 */
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

/** 單位組成：種族 × 職階 × 等級，加上個體相對修正。玩家、NPC、魔物共用。 */
export interface UnitBuild {
  speciesId: string;
  classId?: string;
  level: number;
  /** 相對於公式結果的個體修正（加減值），避免手填絕對數值。 */
  statAdjustments?: Partial<UnitStatBlock>;
}

/** NPC 與魔物共用的靜態單位樣板（UnitTemplate）；世界中實際個體的成長保存於存檔。 */
export interface UnitStaticBase extends UnitBuild {
  id: string;
  name: string;
  title?: string;
  alignment?: CharacterAlignment;
  defaultDisposition: UnitDisposition;
  /** 所屬勢力（factions.json）；未設定代表不屬於任何勢力（例如野獸）。 */
  factionId?: string;
  /** 世界規則「他方佔領」：此單位死亡滿 afterDays 天後不再重生，改由 byUnitId（須為潛伏單位）佔據原地。 */
  occupation?: { byUnitId: string; afterDays: number };
  /** 潛伏單位：開局不出現在世界中，只會經由「他方佔領」出現。 */
  dormantUntilOccupation?: boolean;
}

/** 怪物靜態資料 (來自 monsters.json) */
export interface MonsterStatic extends UnitStaticBase {
  enName: string;
  tier: string;           // 例如: "普通 (Common)"
  rewards: {
    gold: number;
    dropItems: {
      itemId: string;
      chance: number;     // 例如: 0.5 (50%)
    }[];
  };
  specialAbilities: {
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
  requiredQuestId?: string;
  isBoss?: boolean;
  tacticsAndBehavior: string; // 供 AI DM 參考的行為提示
}

/** NPC 靜態資料：身份、職稱、所屬地區與種族/職階。 */
export interface NpcStatic extends UnitStaticBase {
  title: string;
  mapId: string;
  shopId?: string;
  startingGold?: number;
  startingInventory?: { itemId: string; quantity: number }[];
  description: string;
}

/** 共用查詢層回傳的正規化單位視圖；stats/expReward 依種族、職階、等級計算，source 保留原有種類專屬資料。 */
export type WorldUnitStatic =
  | (UnitStaticBase & {
    kind: 'npc';
    title: string;
    stats: UnitStatBlock;
    expReward: number;
    mapIds: string[];
    source: NpcStatic;
  })
  | (UnitStaticBase & {
    kind: 'monster';
    stats: UnitStatBlock;
    expReward: number;
    mapIds: string[];
    source: MonsterStatic;
  });

/** 玩家在共用單位查詢中的視圖；數值與 NPC/魔物同一公式計算並加上裝備，source 保留完整玩家存檔。 */
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

/** 可辨識玩家、NPC 與魔物的共用單位視圖。 */
export type WorldUnitView = WorldUnitStatic | PlayerWorldUnit;

export interface ShopStatic {
  id: string;
  name: string;
  npcId: string;
  items: { itemId: string; buyPrice?: number }[];
  services?: { id: string; name: string; price: number; kind: 'restore_resources'; description: string }[];
}

/**
 * 單位實例（UnitInstance）：世界中實際存在、可成長的個體，保存於存檔；靜態樣板只提供初始值。
 * NPC 與魔物皆有實例；魔物樣板代表在該地區出沒的同一群個體，HP 以戰鬥狀態追蹤。
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
  type: 'purchase' | 'sale' | 'service' | 'quest_reward' | 'npc_transfer' | 'game_change';
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
    /** 擊倒 NPC 是否依單位公式給予經驗值（後果另由勢力聲望承擔）。 */
    npcKillGrantsExp: boolean;
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
  /** auto：條件成立時由遊戲自動觸發；aiProposal：只能由 AI 提議，前端驗證條件後套用。 */
  trigger: 'auto' | 'aiProposal';
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
  monstersPresent: string[]; // 怪物 ID 陣列
  pointsOfInterest: string[];
  npcsPresent: string[];
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
    defeatMonsters?: { monsterId: string; quantity: number }[];
    collectItems?: { itemId: string; quantity: number }[];
  };
  rewards: {
    exp: number;
    gold: number;
    items?: { itemId: string; quantity: number }[];
  };
  rewardLimits?: { exp: { min: number; max: number }; gold: { min: number; max: number }; maxItemQuantity: number };
}

/** 任務範本類型：討伐（擊敗附近魔物）、收集（收集附近魔物的掉落物）。 */
export type QuestTemplateType = 'defeat' | 'collect';

/** 任務範本 (來自 quest_templates.json)：AI 只能依範本提議支線委託，數值由公式與上限決定。 */
export interface QuestTemplateStatic {
  id: string;
  type: QuestTemplateType;
  name: string;
  /** 可用 {target}（目標魔物或物品名稱）、{quantity}。 */
  titlePattern: string;
  objectivePattern: string;
  /** AI 提議此範本的使用時機。 */
  aiHint: string;
  /** 發布者限制；未設定代表任何有所屬勢力的 NPC 都可發布。 */
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
  type: 'unit_death' | 'unit_respawn' | 'unit_occupation' | 'quest_failed' | 'quest_transferred' | 'reputation_change' | 'scenario_event';
  gameTimeMinutes: number;
  mapId: string;
  summary: string;
  detail?: string;
  knownBy: EventKnownBy;
  /** 事件發生時在場且存活的 NPC/魔物（目擊者）。 */
  witnessUnitIds: string[];
  /** 得知此事件（至少公開結果）的勢力，依傳播範圍於寫入時決定。 */
  awareFactionIds: string[];
  /** 觸發原因，例如「戰鬥」「條件成立自動觸發」「AI 提議」。 */
  cause: string;
  death?: { victimUnitId: string; victimName: string; cause: DeathCause; killerUnitId?: string; killerName?: string };
  /** 靜態事件 ID（scenario_event）。 */
  eventId?: string;
  /** 造成的改變。 */
  changes?: { setFlags?: string[]; clearFlags?: string[]; modifierIds?: string[]; questIds?: string[]; unitIds?: string[]; factionIds?: string[] };
  /** 玩家聲望變化（勢力 ID 與變化量）。 */
  reputationChanges?: { factionId: string; change: number }[];
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
}

/** 玩家動態存檔狀態 (寫入 LocalStorage) */
export interface PlayerState {
  /** 玩家穩定單位 ID，固定為 PLAYER_UNIT_ID。 */
  unitId: string;
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
  /** NPC 與魔物的實例狀態。O37/O29 會移至世界存檔。 */
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
  defeatedMonsters: Record<string, number>;
  encounteredUnitId?: string;
  unitDispositionOverrides: Record<string, UnitDisposition>;
  /** 各勢力對目前角色的聲望（角色層；新角色依劇本初始值重置）。 */
  factionReputation: Record<string, number>;

  // 當前進行中的任務
  activeQuests: {
    questId: string;
    status: 'in_progress' | 'completed' | 'failed';
    progress?: { defeatedMonsters: Record<string, number> };
    /** 原委託人死亡後，由同勢力、同職階單位接手時的新委託人 ID。 */
    giverUnitId?: string;
  }[];
  /** 進行中的戰鬥；怪物仍以專屬資料決定掉落與特殊招式。 */
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

/** 已結束的歷代角色紀錄；供 AI 傳聞與 NPC 對話素材，死亡遺物（O26）之後由此擴充。 */
export interface CharacterHistoryEntry {
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
  storyText: string;
  suggestedActions: string[];
  encounterRequest?: { monsterId: string } | null;
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
    npcItemTransfers?: { npcId: string; itemId: string; quantity: number }[];
    defeatedMonsters?: { monsterId: string; quantity: number }[];
    unitDispositionChanges?: { unitId: string; disposition: UnitDisposition }[];
  };
  failureStateChanges?: AIResponsePayload['stateChanges'];
  /** 提議觸發的靜態事件 ID；只可選遊戲提供的候選，前端驗證條件後套用。劇情旗標只能經由事件設定。 */
  eventProposals?: string[];
  /** 依任務範本提議的支線委託（最多一件）；只可選遊戲提供的候選，前端驗證後發布。 */
  questProposals?: QuestProposal[];
}
