// ==========================================
// 1. 靜態資料庫 DTO (Static Data - Read Only)
// ==========================================

/** 道具靜態資料 (來自 items.json) */
export interface ItemStatic {
  id: string;             // 例如: "ITEM-001"
  name: string;           // 例如: "小型生命藥水"
  type: 'consumable' | 'weapon' | 'armor' | 'accessory' | 'quest';
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
  };
  notes: string;
}

/** 怪物靜態資料 (來自 monsters.json) */
export interface MonsterStatic {
  id: string;             // 例如: "MON-001"
  name: string;
  enName: string;
  tier: string;           // 例如: "普通 (Common)"
  recommendedLevel: number;
  stats: {
    hp: number;
    atk: number;
    def: number;
    spd: number;
  };
  rewards: {
    exp: number;
    gold: number;
    dropItems: {
      itemName: string;
      chance: number;     // 例如: 0.5 (50%)
    }[];
  };
  specialAbilities: {
    name: string;
    effect: string;
  }[];
  tacticsAndBehavior: string; // 供 AI DM 參考的行為提示
}

/** 地圖靜態資料 (來自 maps.json) */
export interface MapStatic {
  id: string;             // 例如: "MAP-001"
  name: string;
  enName: string;
  recommendedLevel: string;
  zoneType: string;
  isSafeZone: boolean;
  description: string;
  connectedMapIds: string[];
  monstersPresent: string[]; // 怪物 ID 陣列
  pointsOfInterest: string[];
  npcsPresent: string[];
}

/** 任務靜態資料 (來自 quests.json) */
export interface QuestStatic {
  id: string;             // 例如: "QST-001"
  title: string;
  questGiver: string;
  objective: string;
  rewards: {
    exp: number;
    gold: number;
    items?: { itemId: string; quantity: number }[];
  };
}


// ==========================================
// 2. 動態資料 DTO (Dynamic State - LocalStorage / API)
// ==========================================

/** 玩家動態存檔狀態 (寫入 LocalStorage) */
export interface PlayerState {
  name: string;
  level: number;
  exp: number;
  hp: number;
  mp: number;
  gold: number;
  currentMapId: string;
  
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
  
  // 當前進行中的任務
  activeQuests: {
    questId: string;
    status: 'in_progress' | 'completed';
  }[];
}

/** 對話視窗訊息 */
export interface StoryMessage {
  id: string;
  sender: 'ai' | 'user' | 'system';
  text: string;
  options?: string[];
  timestamp: string;
}

/** AI 結構化回應 (Gemini 回傳格式) */
export interface AIResponsePayload {
  storyText: string;
  suggestedActions: string[];
  stateChanges?: {
    hpChange?: number;
    mpChange?: number;
    expChange?: number;
    goldChange?: number;
    addItems?: { itemId: string; quantity: number }[];
    removeItems?: { itemId: string; quantity: number }[];
    newLocationId?: string;
    setFlags?: Record<string, boolean>;
  };
}