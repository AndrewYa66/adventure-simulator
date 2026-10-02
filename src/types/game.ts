// ==========================================
// 1. 靜態資料庫 DTO (Static Data - Read Only)
// ==========================================

/** 道具靜態資料 (來自 items.json) */
export interface ItemStatic {
  id: string;             // 例如: "ITEM-001"
  name: string;           // 例如: "小型生命藥水"
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

/** 玩家等級成長設定 (來自 player_growth.json) */
export interface PlayerGrowthStatic {
  level: number;
  requiredExp: number;
  maxHp: number;
  maxMp: number;
  baseAtk: number;
  baseDef: number;
  spd: number;
  unlockedSkill?: {
    id: string;
    name: string;
    type: 'active' | 'passive';
    costMp: number;
    description: string;
    effect: { kind: 'damage_multiplier'; multiplier: number } | { kind: 'healing'; hpRestore: number };
  };
  notes: string;
}

export type CharacterAlignment = '守序善良' | '中立善良' | '混亂善良' | '守序中立' | '絕對中立' | '混亂中立' | '守序邪惡' | '中立邪惡' | '混亂邪惡';
export type UnitDisposition = 'friendly' | 'neutral' | 'hostile';

/** NPC 與魔物共用的靜態單位欄位；玩家動態資料及單位專屬規則會在後續階段遷移。 */
export interface UnitStaticBase {
  id: string;
  name: string;
  title?: string;
  categoryId?: string;
  alignment?: CharacterAlignment;
  defaultDisposition: UnitDisposition;
  stats?: Partial<UnitStatBlock>;
}

/** 所有非玩家單位使用的基礎戰鬥數值欄位。 */
export interface UnitStatBlock {
  hp: number;
  atk: number;
  def: number;
  spd: number;
}

export interface CharacterClassStatic {
  id: string;
  name: string;
  description: string;
  baseAbilities: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
  bonuses: { atk: number; def: number; spd: number; maxHp: number; maxMp: number };
  startingItems: { itemId: string; quantity: number }[];
  startingEquipment: { weaponItemId?: string; armorItemId?: string; accessoryItemId?: string };
}

/** 怪物靜態資料 (來自 monsters.json) */
export interface MonsterStatic extends UnitStaticBase {
  enName: string;
  tier: string;           // 例如: "普通 (Common)"
  recommendedLevel: number;
  stats: UnitStatBlock;
  rewards: {
    exp: number;
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

/** NPC 數值類別：類別提供預設能力值，個別 NPC 可覆寫數值。 */
export interface NpcCategoryStatic {
  id: string;
  name: string;
  baseStats: UnitStatBlock;
}

/** NPC 靜態資料：身份、職稱、所屬地區與類別數值。 */
export interface NpcStatic extends UnitStaticBase {
  title: string;
  categoryId: string;
  mapId: string;
  shopId?: string;
  startingGold?: number;
  startingInventory?: { itemId: string; quantity: number }[];
  description: string;
}

/** 共用查詢層回傳的正規化單位視圖；source 保留原有種類專屬資料。 */
export type WorldUnitStatic =
  | (Omit<UnitStaticBase, 'stats'> & {
    kind: 'npc';
    title: string;
    categoryId: string;
    stats: UnitStatBlock;
    mapIds: string[];
    source: NpcStatic;
  })
  | (Omit<UnitStaticBase, 'stats'> & {
    kind: 'monster';
    stats: UnitStatBlock;
    mapIds: string[];
    source: MonsterStatic;
  });

export interface ShopStatic {
  id: string;
  name: string;
  npcId: string;
  items: { itemId: string; buyPrice?: number }[];
  services?: { id: string; name: string; price: number; kind: 'restore_resources'; description: string }[];
}

export interface NpcWorldState {
  gold: number;
  inventory: { itemId: string; quantity: number }[];
}

export interface TransactionRecord {
  id: string;
  type: 'purchase' | 'sale' | 'service' | 'quest_reward' | 'npc_transfer' | 'game_change';
  description: string;
  goldChange: number;
  timestamp: number;
}

/** 地圖靜態資料 (來自 maps.json) */
export interface MapStatic {
  id: string;             // 例如: "MAP-001"
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
  id: string;             // 例如: "QST-001"
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

/** 玩家動態存檔狀態 (寫入 LocalStorage) */
export interface PlayerState {
  name: string;
  classId: string;
  alignment: CharacterAlignment;
  setupComplete: boolean;
  abilities: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
  isDead: boolean;
  statusEffects: { id: 'unconscious'; remainingTurns: number }[];
  level: number;
  exp: number;
  hp: number;
  mp: number;
  gold: number;
  npcStates: Record<string, NpcWorldState>;
  transactionHistory: TransactionRecord[];
  currentMapId: string;
  previousMapId?: string;
  
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
  encounteredMonsterId?: string;
  unitDispositionOverrides: Record<string, UnitDisposition>;
  
  // 當前進行中的任務
  activeQuests: {
    questId: string;
    status: 'in_progress' | 'completed';
    progress?: { defeatedMonsters: Record<string, number> };
  }[];
  combat?: { monsterId: string; currentHp: number; round: number };
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
