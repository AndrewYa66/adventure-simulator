import type {
  ItemStatic,
  CharacterClassStatic,
  MapStatic,
  MonsterStatic,
  NpcCategoryStatic,
  NpcStatic,
  PlayerGrowthStatic,
  QuestStatic,
  ShopStatic
} from '../types/game';

import rawItems from './items.json';
import rawCharacterClasses from './character_classes.json';
import rawMaps from './maps.json';
import rawMonsters from './monsters.json';
import rawNpcCategories from './npc_categories.json';
import rawNpcs from './npcs.json';
import rawPlayerGrowth from './player_growth.json';
import rawQuests from './quests.json';
import rawShops from './shops.json';

// 進行靜態型別轉型，確保導出的資料陣列完全符合 DTO 規範
export const itemsDatabase: ItemStatic[] = rawItems as ItemStatic[];
export const characterClassesDatabase: CharacterClassStatic[] = rawCharacterClasses as CharacterClassStatic[];
export const mapsDatabase: MapStatic[] = rawMaps as MapStatic[];
export const monstersDatabase: MonsterStatic[] = rawMonsters as MonsterStatic[];
export const npcCategoriesDatabase: NpcCategoryStatic[] = rawNpcCategories as NpcCategoryStatic[];
export const npcsDatabase: NpcStatic[] = rawNpcs as NpcStatic[];
export const playerGrowthDatabase: PlayerGrowthStatic[] = rawPlayerGrowth as PlayerGrowthStatic[];
export const questsDatabase: QuestStatic[] = rawQuests as QuestStatic[];
export const shopsDatabase: ShopStatic[] = rawShops as ShopStatic[];

// ==========================================
// 靜態資料查詢 Helper Functions
// ==========================================

export const getItemById = (id: string): ItemStatic | undefined => {
  return itemsDatabase.find((item) => item.id === id);
};

export const getCharacterClassById = (id: string): CharacterClassStatic | undefined =>
  characterClassesDatabase.find((characterClass) => characterClass.id === id);

export const getPlayerResourceCaps = (level: number, classId: string) => {
  const growth = getPlayerGrowthByLevel(level);
  const characterClass = getCharacterClassById(classId);
  return {
    maxHp: Math.max(1, (growth?.maxHp ?? 100) + (characterClass?.bonuses.maxHp ?? 0)),
    maxMp: Math.max(0, (growth?.maxMp ?? 30) + (characterClass?.bonuses.maxMp ?? 0))
  };
};

export const getMapById = (id: string): MapStatic | undefined => {
  return mapsDatabase.find((map) => map.id === id);
};

export const getMonsterById = (id: string): MonsterStatic | undefined => {
  return monstersDatabase.find((monster) => monster.id === id);
};

export const getNpcCategoryById = (id: string): NpcCategoryStatic | undefined =>
  npcCategoriesDatabase.find((category) => category.id === id);

export const getNpcById = (id: string): NpcStatic | undefined =>
  npcsDatabase.find((npc) => npc.id === id);

export const getShopById = (id: string): ShopStatic | undefined =>
  shopsDatabase.find((shop) => shop.id === id);

export const getShopForNpc = (npc: NpcStatic): ShopStatic | undefined =>
  npc.shopId ? getShopById(npc.shopId) : undefined;

export const getNpcStats = (npc: NpcStatic) => {
  const baseStats = getNpcCategoryById(npc.categoryId)?.baseStats;
  if (!baseStats) return undefined;
  return { ...baseStats, ...npc.stats };
};

export const getPlayerGrowthByLevel = (level: number): PlayerGrowthStatic | undefined => {
  return playerGrowthDatabase.find((growth) => growth.level === level);
};

export const getUnlockedSkillsByLevel = (level: number) => playerGrowthDatabase
  .filter((growth) => growth.level <= level && growth.unlockedSkill?.type === 'active')
  .flatMap((growth) => growth.unlockedSkill ? [growth.unlockedSkill] : []);

export const getQuestById = (id: string): QuestStatic | undefined => {
  return questsDatabase.find((quest) => quest.id === id);
};

export const canPlayerEnterMap = (player: import('../types/game').PlayerState, map: MapStatic): boolean => {
  if (!map.requiredQuestId) return true;
  return player.activeQuests.some((quest) => quest.questId === map.requiredQuestId &&
    (quest.status === 'in_progress' || quest.status === 'completed'));
};
