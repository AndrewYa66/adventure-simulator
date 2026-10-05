import type {
  ItemStatic,
  CharacterClassStatic,
  MapStatic,
  MonsterStatic,
  NpcCategoryStatic,
  NpcStatic,
  NpcWorldState,
  PlayerGrowthStatic,
  QuestStatic,
  ScenarioStatic,
  ShopStatic,
  UnitDisposition,
  WorldUnitStatic
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
import rawScenario from './scenario.json';

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
export const scenario: ScenarioStatic = rawScenario as ScenarioStatic;

/** 玩家的穩定單位 ID；NPC/魔物資料不得使用此 ID。 */
export const PLAYER_UNIT_ID = 'PLAYER-001';

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

/** 舊查詢介面：已無外部呼叫端，僅供共同查詢層內部使用。 */
const getMonsterById = (id: string): MonsterStatic | undefined => {
  return monstersDatabase.find((monster) => monster.id === id);
};

export const getNpcCategoryById = (id: string): NpcCategoryStatic | undefined =>
  npcCategoriesDatabase.find((category) => category.id === id);

/** 舊查詢介面：已無外部呼叫端，僅供共同查詢層內部使用。 */
const getNpcById = (id: string): NpcStatic | undefined =>
  npcsDatabase.find((npc) => npc.id === id);

export const getShopById = (id: string): ShopStatic | undefined =>
  shopsDatabase.find((shop) => shop.id === id);

export const getShopForNpc = (npc: NpcStatic): ShopStatic | undefined =>
  npc.shopId ? getShopById(npc.shopId) : undefined;

const getNpcStats = (npc: NpcStatic) => {
  const baseStats = getNpcCategoryById(npc.categoryId)?.baseStats;
  if (!baseStats) return undefined;
  return { ...baseStats, ...npc.stats };
};

/** Shared lookup adapter. Legacy NPC/monster records and their IDs remain unchanged. */
export const getWorldUnitById = (id: string): WorldUnitStatic | undefined => {
  const npc = getNpcById(id);
  const monster = getMonsterById(id);
  if (Boolean(npc) === Boolean(monster)) return undefined;

  if (npc) {
    const stats = getNpcStats(npc);
    if (!stats) return undefined;
    return {
      kind: 'npc', id: npc.id, name: npc.name, title: npc.title, categoryId: npc.categoryId,
      alignment: npc.alignment, defaultDisposition: npc.defaultDisposition, stats, mapIds: [npc.mapId], source: npc
    };
  }

  if (!monster) return undefined;
  const mapIds = mapsDatabase.filter((map) => map.monstersPresent.includes(monster.id)).map((map) => map.id);
  return {
    kind: 'monster', id: monster.id, name: monster.name, alignment: monster.alignment, defaultDisposition: monster.defaultDisposition,
    stats: monster.stats, mapIds, source: monster
  };
};

/** NPC 動態狀態預設值；新存檔建立與舊存檔補欄位共用。 */
export const createDefaultNpcWorldState = (npc: NpcStatic): NpcWorldState => ({
  gold: npc.startingGold ?? 0,
  inventory: (npc.startingInventory ?? []).flatMap((entry) =>
    getItemById(entry.itemId) && Number.isInteger(entry.quantity) && entry.quantity > 0 ? [{ ...entry }] : []),
  currentHp: getWorldUnitById(npc.id)?.stats.hp ?? 1,
  isDead: false
});

/** Return the normalized units referenced by a map, preserving NPC and monster order. */
export const getWorldUnitsAtMap = (mapId: string): WorldUnitStatic[] => {
  const map = getMapById(mapId);
  if (!map) return [];
  return [...map.npcsPresent, ...map.monstersPresent]
    .flatMap((unitId) => {
      const unit = getWorldUnitById(unitId);
      return unit ? [unit] : [];
    });
};

/** Alignment expresses values; disposition is the unit's current relation to this player. */
export const getWorldUnitDisposition = (
  player: Pick<import('../types/game').PlayerState, 'unitDispositionOverrides'>,
  unitId: string
): UnitDisposition | undefined => {
  const unit = getWorldUnitById(unitId);
  return unit ? player.unitDispositionOverrides[unitId] ?? unit.defaultDisposition : undefined;
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

/** Validate the existing split NPC/monster files against the shared unit contract. */
export function validateWorldUnitData(): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  const validAlignments = new Set([
    '守序善良', '中立善良', '混亂善良', '守序中立', '絕對中立',
    '混亂中立', '守序邪惡', '中立邪惡', '混亂邪惡'
  ]);
  const validateStats = (unitId: string, stats: unknown) => {
    if (!stats || typeof stats !== 'object' || !('hp' in stats) || !('atk' in stats) || !('def' in stats) || !('spd' in stats)) {
      issues.push(`${unitId}: 缺少有效的 HP/ATK/DEF/SPD 數值`);
      return;
    }
    const values = stats as Record<'hp' | 'atk' | 'def' | 'spd', unknown>;
    if (!Number.isFinite(values.hp) || (values.hp as number) <= 0 ||
        ![values.atk, values.def, values.spd].every((value) => Number.isFinite(value) && (value as number) >= 0)) {
      issues.push(`${unitId}: 缺少有效的 HP/ATK/DEF/SPD 數值`);
    }
  };

  for (const unit of [...npcsDatabase, ...monstersDatabase]) {
    if (typeof unit.id !== 'string' || !unit.id.trim() || typeof unit.name !== 'string' || !unit.name.trim()) {
      issues.push('單位缺少有效的 ID 或名稱');
    }
    if (seenIds.has(unit.id)) issues.push(`單位 ID 重複：${unit.id}`);
    if (unit.id === PLAYER_UNIT_ID) issues.push(`單位 ID 與玩家保留 ID 衝突：${unit.id}`);
    seenIds.add(unit.id);
    if (unit.alignment !== undefined && !validAlignments.has(unit.alignment)) issues.push(`${unit.id}: 無效陣營 ${unit.alignment}`);
    if (!['friendly', 'neutral', 'hostile'].includes(unit.defaultDisposition)) issues.push(`${unit.id}: 無效預設關係 ${unit.defaultDisposition}`);
  }

  const seenCategoryIds = new Set<string>();
  for (const category of npcCategoriesDatabase) {
    if (seenCategoryIds.has(category.id)) issues.push(`NPC 類別 ID 重複：${category.id}`);
    seenCategoryIds.add(category.id);
    validateStats(category.id, category.baseStats);
  }

  for (const npc of npcsDatabase) {
    const category = getNpcCategoryById(npc.categoryId);
    const map = getMapById(npc.mapId);
    validateStats(npc.id, getNpcStats(npc));
    if (!category) issues.push(`${npc.id}: 找不到類別 ${npc.categoryId}`);
    if (!map || !map.npcsPresent.includes(npc.id)) issues.push(`${npc.id}: 所在地圖 ${npc.mapId} 未正確列出此 NPC`);
    if (npc.shopId) {
      const shop = getShopById(npc.shopId);
      if (!shop || shop.npcId !== npc.id) issues.push(`${npc.id}: 商店參照 ${npc.shopId} 無效`);
    }
  }

  for (const monster of monstersDatabase) {
    validateStats(monster.id, monster.stats);
    if (!mapsDatabase.some((map) => map.monstersPresent.includes(monster.id))) issues.push(`${monster.id}: 未被任何地圖列為可遭遇敵人`);
    if (monster.requiredQuestId && !getQuestById(monster.requiredQuestId)) issues.push(`${monster.id}: 找不到前置任務 ${monster.requiredQuestId}`);
  }

  for (const map of mapsDatabase) {
    for (const npcId of map.npcsPresent) {
      if (!npcsDatabase.some((npc) => npc.id === npcId && npc.mapId === map.id)) issues.push(`${map.id}: NPC 參照 ${npcId} 無效或所在地不一致`);
    }
    for (const monsterId of map.monstersPresent) {
      if (!getMonsterById(monsterId)) issues.push(`${map.id}: 怪物參照 ${monsterId} 無效`);
    }
  }

  return issues;
}
