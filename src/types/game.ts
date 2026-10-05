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

/** 玩家動態存檔狀態 (寫入 LocalStorage) */
export interface PlayerState {
  /** 玩家穩定單位 ID；舊存檔載入時補上 PLAYER_UNIT_ID。 */
  unitId: string;
  name: string;
  /** 玩家種族；舊存檔載入時補為劇本預設種族。 */
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
  /** NPC 與魔物的實例狀態；舊存檔的 npcStates 載入時遷移至此。O37/O29 會移至世界存檔。 */
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
  
  // 當前進行中的任務
  activeQuests: {
    questId: string;
    status: 'in_progress' | 'completed';
    progress?: { defeatedMonsters: Record<string, number> };
  }[];
  /** 進行中的戰鬥；怪物仍以專屬資料決定掉落與特殊招式。 */
  combat?: CombatState;
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
  /** 種族/職階檢定加值（已計入 modifier）；舊紀錄沒有此欄位。 */
  checkBonus?: number;
  modifier: number;
  total: number;
  dc: number;
  success: boolean;
  label?: string;
}

export interface GameSession {
  schemaVersion: 1;
  savedAt: number;
  player: PlayerState;
  messages: StoryMessage[];
}

/** AI 結構化回應 (Gemini 回傳格式) */
export interface AIResponsePayload {
  storyText: string;
  suggestedActions: string[];
  encounterRequest?: { monsterId: string } | null;
  travelRequest?: { destinationMapId: string } | null;
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
    setFlags?: Record<string, boolean>;
    questUpdates?: { questId: string; status: 'completed' }[];
    questAcceptances?: string[];
    npcItemTransfers?: { npcId: string; itemId: string; quantity: number }[];
    defeatedMonsters?: { monsterId: string; quantity: number }[];
    unitDispositionChanges?: { unitId: string; disposition: UnitDisposition }[];
  };
  failureStateChanges?: AIResponsePayload['stateChanges'];
}
