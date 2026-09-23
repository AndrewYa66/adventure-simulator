import type {
  ItemStatic,
  MapStatic,
  MonsterStatic,
  PlayerGrowthStatic,
  QuestStatic
} from '../types/game';

import rawItems from './items.json';
import rawMaps from './maps.json';
import rawMonsters from './monsters.json';
import rawPlayerGrowth from './player_growth.json';
import rawQuests from './quests.json';

// 進行靜態型別轉型，確保導出的資料陣列完全符合 DTO 規範
export const itemsDatabase: ItemStatic[] = rawItems as ItemStatic[];
export const mapsDatabase: MapStatic[] = rawMaps as MapStatic[];
export const monstersDatabase: MonsterStatic[] = rawMonsters as MonsterStatic[];
export const playerGrowthDatabase: PlayerGrowthStatic[] = rawPlayerGrowth as PlayerGrowthStatic[];
export const questsDatabase: QuestStatic[] = rawQuests as QuestStatic[];

// ==========================================
// 靜態資料查詢 Helper Functions
// ==========================================

export const getItemById = (id: string): ItemStatic | undefined => {
  return itemsDatabase.find((item) => item.id === id);
};

export const getMapById = (id: string): MapStatic | undefined => {
  return mapsDatabase.find((map) => map.id === id);
};

export const getMonsterById = (id: string): MonsterStatic | undefined => {
  return monstersDatabase.find((monster) => monster.id === id);
};

export const getPlayerGrowthByLevel = (level: number): PlayerGrowthStatic | undefined => {
  return playerGrowthDatabase.find((growth) => growth.level === level);
};

export const getQuestById = (id: string): QuestStatic | undefined => {
  return questsDatabase.find((quest) => quest.id === id);
};