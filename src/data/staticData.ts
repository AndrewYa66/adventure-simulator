import type {
  AbilityScores,
  ItemStatic,
  CharacterClassStatic,
  LevelBenchmarkStatic,
  MapStatic,
  MonsterStatic,
  NpcStatic,
  UnitInstance,
  PlayerState,
  QuestStatic,
  ScenarioStatic,
  ShopStatic,
  SkillStatic,
  SpeciesStatic,
  UnitBuild,
  UnitDisposition,
  UnitStatBlock,
  WorldUnitStatic
} from '../types/game';
import { computeExpReward, computeUnitAbilities, computeUnitStats, isValidSpeciesClassCombo, UNIT_STAT_KEYS } from '../utils/unitGrowth';

import rawItems from './items.json';
import rawCharacterClasses from './character_classes.json';
import rawLevelBenchmarks from './level_benchmarks.json';
import rawMaps from './maps.json';
import rawMonsters from './monsters.json';
import rawNpcs from './npcs.json';
import rawQuests from './quests.json';
import rawShops from './shops.json';
import rawSkills from './skills.json';
import rawSpecies from './species.json';
import rawScenario from './scenario.json';

// 進行靜態型別轉型，確保導出的資料陣列完全符合 DTO 規範
export const itemsDatabase: ItemStatic[] = rawItems as ItemStatic[];
export const characterClassesDatabase: CharacterClassStatic[] = rawCharacterClasses as CharacterClassStatic[];
export const levelBenchmarksDatabase: LevelBenchmarkStatic[] = rawLevelBenchmarks as LevelBenchmarkStatic[];
export const mapsDatabase: MapStatic[] = rawMaps as MapStatic[];
export const monstersDatabase: MonsterStatic[] = rawMonsters as MonsterStatic[];
export const npcsDatabase: NpcStatic[] = rawNpcs as NpcStatic[];
export const questsDatabase: QuestStatic[] = rawQuests as QuestStatic[];
export const shopsDatabase: ShopStatic[] = rawShops as ShopStatic[];
export const skillsDatabase: SkillStatic[] = rawSkills as SkillStatic[];
export const speciesDatabase: SpeciesStatic[] = rawSpecies as SpeciesStatic[];
export const scenario: ScenarioStatic = rawScenario as ScenarioStatic;

/** 玩家的穩定單位 ID；NPC/魔物資料不得使用此 ID。 */
export const PLAYER_UNIT_ID = 'PLAYER-001';

/** 魔物成長上限：所在地區建議等級上限 +3（已確認的設計決策「難度」）。 */
const MONSTER_LEVEL_CAP_OVER_REGION = 3;

// ==========================================
// 靜態資料查詢 Helper Functions
// ==========================================

export const getItemById = (id: string): ItemStatic | undefined => {
  return itemsDatabase.find((item) => item.id === id);
};

export const getCharacterClassById = (id: string): CharacterClassStatic | undefined =>
  characterClassesDatabase.find((characterClass) => characterClass.id === id);

export const getSpeciesById = (id: string): SpeciesStatic | undefined =>
  speciesDatabase.find((species) => species.id === id);

export const getSkillById = (id: string): SkillStatic | undefined =>
  skillsDatabase.find((skill) => skill.id === id);

export const playerSelectableClasses = (): CharacterClassStatic[] =>
  characterClassesDatabase.filter((characterClass) => characterClass.playerSelectable);

/** 基準表中的最高等級；玩家與 NPC 的成長上限。 */
export const MAX_UNIT_LEVEL = Math.max(...levelBenchmarksDatabase.map((entry) => entry.level));

/** 取得等級基準；超出表格時使用最高等級列。 */
export const getLevelBenchmark = (level: number): LevelBenchmarkStatic | undefined =>
  levelBenchmarksDatabase.find((entry) => entry.level === Math.min(level, MAX_UNIT_LEVEL));

/** 依種族 × 職階 × 等級計算單位數值（不含裝備）；資料無效時回傳 undefined。 */
export const getUnitBuildStats = (build: UnitBuild): UnitStatBlock | undefined => {
  const benchmark = getLevelBenchmark(build.level);
  const species = getSpeciesById(build.speciesId);
  const characterClass = build.classId ? getCharacterClassById(build.classId) : undefined;
  if (!benchmark || !species || (build.classId && !characterClass)) return undefined;
  return computeUnitStats(benchmark, species, characterClass, build.statAdjustments);
};

/** 依種族 × 職階 × 等級計算擊倒獎勵經驗。 */
export const getUnitExpReward = (build: UnitBuild): number => {
  const benchmark = getLevelBenchmark(build.level);
  const species = getSpeciesById(build.speciesId);
  if (!benchmark || !species) return 0;
  return computeExpReward(benchmark, species, build.classId ? getCharacterClassById(build.classId) : undefined);
};

/** 依種族 × 職階計算能力值；玩家建立角色時寫入存檔。 */
export const getUnitAbilities = (build: Pick<UnitBuild, 'speciesId' | 'classId'>): AbilityScores | undefined => {
  const species = getSpeciesById(build.speciesId);
  return species ? computeUnitAbilities(species, build.classId ? getCharacterClassById(build.classId) : undefined) : undefined;
};

type PlayerBuildSource =Pick<PlayerState, 'speciesId' | 'classId' | 'level'>;

const FALLBACK_STATS: UnitStatBlock = { hp: 1, mp: 0, atk: 0, def: 0, spd: 0 };

/** 玩家未含裝備的數值；與 NPC/魔物同一公式。 */
export const getPlayerBaseStats = (player: PlayerBuildSource): UnitStatBlock =>
  getUnitBuildStats({ speciesId: player.speciesId, classId: player.classId, level: player.level }) ?? FALLBACK_STATS;

export const getPlayerResourceCaps = (player: PlayerBuildSource) => {
  const stats = getPlayerBaseStats(player);
  return { maxHp: Math.max(1, stats.hp), maxMp: Math.max(0, stats.mp) };
};

/** 職階依等級解鎖的主動技能。 */
export const getUnlockedSkills = (classId: string, level: number): SkillStatic[] =>
  (getCharacterClassById(classId)?.skillUnlocks ?? [])
    .filter((unlock) => unlock.level <= level)
    .flatMap((unlock) => {
      const skill = getSkillById(unlock.skillId);
      return skill?.type === 'active' ? [skill] : [];
    });

export const getMapById = (id: string): MapStatic | undefined => {
  return mapsDatabase.find((map) => map.id === id);
};

/** 解析地圖建議等級（例如 "1-3"）的上限。 */
const getMapLevelCeiling = (map: MapStatic): number | undefined => {
  const levels = map.recommendedLevel.match(/\d+/g)?.map(Number) ?? [];
  return levels.length ? Math.max(...levels) : undefined;
};

/** 魔物等級上限：出沒地區建議等級上限的最大值 +3，且不超過基準表。 */
export const getMonsterLevelCap = (monsterId: string): number => {
  const ceilings = mapsDatabase.filter((map) => map.monstersPresent.includes(monsterId))
    .flatMap((map) => {
      const ceiling = getMapLevelCeiling(map);
      return ceiling === undefined ? [] : [ceiling];
    });
  return ceilings.length ? Math.min(MAX_UNIT_LEVEL, Math.max(...ceilings) + MONSTER_LEVEL_CAP_OVER_REGION) : MAX_UNIT_LEVEL;
};

/** 舊查詢介面：已無外部呼叫端，僅供共同查詢層內部使用。 */
const getMonsterById = (id: string): MonsterStatic | undefined => {
  return monstersDatabase.find((monster) => monster.id === id);
};

/** 舊查詢介面：已無外部呼叫端，僅供共同查詢層內部使用。 */
const getNpcById = (id: string): NpcStatic | undefined =>
  npcsDatabase.find((npc) => npc.id === id);

export const getShopById = (id: string): ShopStatic | undefined =>
  shopsDatabase.find((shop) => shop.id === id);

export const getShopForNpc = (npc: NpcStatic): ShopStatic | undefined =>
  npc.shopId ? getShopById(npc.shopId) : undefined;

const toUnitBase = (unit: NpcStatic | MonsterStatic) => ({
  id: unit.id, name: unit.name, title: unit.title, alignment: unit.alignment, defaultDisposition: unit.defaultDisposition,
  speciesId: unit.speciesId, classId: unit.classId, level: unit.level, statAdjustments: unit.statAdjustments
});

/** 所有 NPC/魔物單位樣板（UnitTemplate）。 */
export const unitTemplatesDatabase = (): (NpcStatic | MonsterStatic)[] => [...npcsDatabase, ...monstersDatabase];

type UnitInstanceSource = Record<string, Pick<UnitInstance, 'level'>> | undefined;

/**
 * Shared lookup adapter. Legacy NPC/monster records and their IDs remain unchanged.
 * 傳入存檔的 unitInstances 時，數值與擊倒獎勵依實例目前等級計算；否則使用樣板等級。
 */
export const getWorldUnitById = (id: string, instances?: UnitInstanceSource): WorldUnitStatic | undefined => {
  const npc = getNpcById(id);
  const monster = getMonsterById(id);
  if (Boolean(npc) === Boolean(monster)) return undefined;
  const template = (npc ?? monster)!;
  const level = instances?.[id]?.level ?? template.level;
  const build = { ...template, level };
  const stats = getUnitBuildStats(build);
  if (!stats) return undefined;
  const expReward = getUnitExpReward(build);

  if (npc) {
    return { ...toUnitBase(npc), level, kind: 'npc', title: npc.title, stats, expReward, mapIds: [npc.mapId], source: npc };
  }

  const mapIds = mapsDatabase.filter((map) => map.monstersPresent.includes(monster!.id)).map((map) => map.id);
  return { ...toUnitBase(monster!), level, kind: 'monster', stats, expReward, mapIds, source: monster! };
};

/** 單位成長上限：魔物受出沒地區限制，NPC 以基準表最高等級為限。 */
export const getUnitLevelCap = (unitId: string): number =>
  getMonsterById(unitId) ? getMonsterLevelCap(unitId) : MAX_UNIT_LEVEL;

/** 到達某等級所需的累計經驗（實例初始經驗）。 */
export const getBaseExpForLevel = (level: number): number =>
  level > 1 ? getLevelBenchmark(level - 1)?.requiredExp ?? 0 : 0;

/** 單位的種族/職階顯示名稱，例如「哥布林・斥候 Lv.1」。 */
export const describeUnitBuild = (build: UnitBuild): string => {
  const speciesName = getSpeciesById(build.speciesId)?.name ?? build.speciesId;
  const className = build.classId ? getCharacterClassById(build.classId)?.name ?? build.classId : undefined;
  return `${className ? `${speciesName}・${className}` : speciesName} Lv.${build.level}`;
};

/** 單位實例預設值（取自樣板）；新存檔建立與舊存檔補欄位共用。 */
export const createDefaultUnitInstance = (template: NpcStatic | MonsterStatic): UnitInstance => {
  const npc = 'mapId' in template ? template : undefined;
  return {
    level: template.level,
    exp: getBaseExpForLevel(template.level),
    gold: npc?.startingGold ?? 0,
    inventory: (npc?.startingInventory ?? []).flatMap((entry) =>
      getItemById(entry.itemId) && Number.isInteger(entry.quantity) && entry.quantity > 0 ? [{ ...entry }] : []),
    currentHp: getWorldUnitById(template.id)?.stats.hp ?? 1,
    isDead: false
  };
};

export const createDefaultUnitInstances = (): Record<string, UnitInstance> =>
  Object.fromEntries(unitTemplatesDatabase().map((template) => [template.id, createDefaultUnitInstance(template)]));

/** Return the normalized units referenced by a map, preserving NPC and monster order. */
export const getWorldUnitsAtMap = (mapId: string, instances?: UnitInstanceSource): WorldUnitStatic[] => {
  const map = getMapById(mapId);
  if (!map) return [];
  return [...map.npcsPresent, ...map.monstersPresent]
    .flatMap((unitId) => {
      const unit = getWorldUnitById(unitId, instances);
      return unit ? [unit] : [];
    });
};

/** Alignment expresses values; disposition is the unit's current relation to this player. */
export const getWorldUnitDisposition = (
  player: Pick<PlayerState, 'unitDispositionOverrides'>,
  unitId: string
): UnitDisposition | undefined => {
  const unit = getWorldUnitById(unitId);
  return unit ? player.unitDispositionOverrides[unitId] ?? unit.defaultDisposition : undefined;
};

export const getQuestById = (id: string): QuestStatic | undefined => {
  return questsDatabase.find((quest) => quest.id === id);
};

export const canPlayerEnterMap = (player: PlayerState, map: MapStatic): boolean => {
  if (!map.requiredQuestId) return true;
  return player.activeQuests.some((quest) => quest.questId === map.requiredQuestId &&
    (quest.status === 'in_progress' || quest.status === 'completed'));
};

/** 個體相對修正不得超過公式結果的此比例，避免以修正值繞過強度基準造成數值膨脹。 */
const MAX_STAT_ADJUSTMENT_RATIO = 0.5;

/** 驗證單位組成：種族/職階存在、組合合法、等級在基準表內、相對修正有界。 */
function validateUnitBuild(label: string, build: UnitBuild, issues: string[]) {
  const species = getSpeciesById(build.speciesId);
  const characterClass = build.classId ? getCharacterClassById(build.classId) : undefined;
  if (!species) issues.push(`${label}: 找不到種族 ${build.speciesId}`);
  if (build.classId && !characterClass) issues.push(`${label}: 找不到職階 ${build.classId}`);
  if (species && (!build.classId || characterClass) && !isValidSpeciesClassCombo(species, characterClass)) {
    issues.push(`${label}: 種族「${species.name}」不可搭配${characterClass ? `職階「${characterClass.name}」` : '無職階'}`);
  }
  if (!Number.isInteger(build.level) || build.level < 1 || build.level > MAX_UNIT_LEVEL) {
    issues.push(`${label}: 等級 ${build.level} 不在基準表 1–${MAX_UNIT_LEVEL} 範圍內`);
  }
  const unadjusted = getUnitBuildStats({ ...build, statAdjustments: undefined });
  for (const [key, value] of Object.entries(build.statAdjustments ?? {})) {
    if (!UNIT_STAT_KEYS.includes(key as keyof UnitStatBlock) || !Number.isInteger(value)) {
      issues.push(`${label}: 無效的數值修正 ${key}`);
      continue;
    }
    const base = unadjusted?.[key as keyof UnitStatBlock] ?? 0;
    if (Math.abs(value as number) > Math.max(1, Math.ceil(base * MAX_STAT_ADJUSTMENT_RATIO))) {
      issues.push(`${label}: ${key} 修正 ${value} 超過公式結果 ${base} 的 ${MAX_STAT_ADJUSTMENT_RATIO * 100}%`);
    }
  }
}

/** 驗證種族、職階、等級基準表、技能與劇本設定。 */
export function validateGrowthData(): string[] {
  const issues: string[] = [];
  const unique = (label: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) issues.push(`${label} ID 重複：${id}`);
      seen.add(id);
    }
  };
  unique('種族', speciesDatabase.map((species) => species.id));
  unique('職階', characterClassesDatabase.map((characterClass) => characterClass.id));
  unique('技能', skillsDatabase.map((skill) => skill.id));

  const isMultiplierBlock = (value: unknown) => !!value && typeof value === 'object' &&
    UNIT_STAT_KEYS.every((key) => Number.isFinite((value as Record<string, unknown>)[key]) && ((value as Record<string, number>)[key]) >= 0);
  for (const species of speciesDatabase) {
    if (!isMultiplierBlock(species.statMultipliers)) issues.push(`種族 ${species.id}: 數值倍率不完整或為負數`);
    if (!species.allowsNoClass && species.allowedClassCategories.length === 0) issues.push(`種族 ${species.id}: 沒有任何可搭配的職階`);
  }
  for (const characterClass of characterClassesDatabase) {
    if (!['combat', 'social', 'life'].includes(characterClass.category)) issues.push(`職階 ${characterClass.id}: 無效類別 ${characterClass.category}`);
    if (!isMultiplierBlock(characterClass.statMultipliers)) issues.push(`職階 ${characterClass.id}: 數值倍率不完整或為負數`);
    for (const unlock of characterClass.skillUnlocks ?? []) {
      if (!getSkillById(unlock.skillId)) issues.push(`職階 ${characterClass.id}: 找不到技能 ${unlock.skillId}`);
    }
    if (characterClass.playerSelectable) {
      if (!characterClass.startingItems || !characterClass.startingEquipment) issues.push(`職階 ${characterClass.id}: 玩家可選職階缺少初始持有物或裝備`);
      for (const entry of characterClass.startingItems ?? []) {
        if (!getItemById(entry.itemId)) issues.push(`職階 ${characterClass.id}: 找不到初始物品 ${entry.itemId}`);
      }
      for (const itemId of Object.values(characterClass.startingEquipment ?? {})) {
        if (itemId && !getItemById(itemId)) issues.push(`職階 ${characterClass.id}: 找不到初始裝備 ${itemId}`);
      }
    }
  }

  const sortedLevels = levelBenchmarksDatabase.map((entry) => entry.level).sort((a, b) => a - b);
  if (sortedLevels[0] !== 1 || sortedLevels.some((level, index) => level !== index + 1)) issues.push('等級基準表必須從 1 開始連續編號');
  for (const entry of levelBenchmarksDatabase) {
    const previous = getLevelBenchmark(entry.level - 1);
    if (previous && entry.level > 1 && previous.level === entry.level - 1) {
      if (entry.requiredExp <= previous.requiredExp) issues.push(`等級基準 Lv.${entry.level}: requiredExp 必須大於前一級`);
      if (UNIT_STAT_KEYS.some((key) => entry[key] < previous[key])) issues.push(`等級基準 Lv.${entry.level}: 數值不可低於前一級`);
    }
  }

  const startMap = getMapById(scenario.start.mapId);
  if (!startMap) issues.push(`劇本 ${scenario.id}: 找不到起始地圖 ${scenario.start.mapId}`);
  const defaultClass = getCharacterClassById(scenario.defaultPlayer.classId);
  if (!defaultClass?.playerSelectable) issues.push(`劇本 ${scenario.id}: 預設職階 ${scenario.defaultPlayer.classId} 不存在或不可由玩家選擇`);
  validateUnitBuild(`劇本 ${scenario.id} 預設角色`, { speciesId: scenario.defaultPlayer.speciesId, classId: scenario.defaultPlayer.classId, level: 1 }, issues);
  for (const characterClass of playerSelectableClasses()) {
    const species = getSpeciesById(scenario.defaultPlayer.speciesId);
    if (species && !isValidSpeciesClassCombo(species, characterClass)) {
      issues.push(`職階 ${characterClass.id}: 玩家可選，但劇本預設種族 ${species.id} 不可搭配`);
    }
  }
  if (!Number.isSafeInteger(scenario.start.gameTimeMinutes) || scenario.start.gameTimeMinutes < 0) issues.push(`劇本 ${scenario.id}: 起始時間無效`);
  return issues;
}

/** Validate the existing split NPC/monster files against the shared unit contract. */
export function validateWorldUnitData(): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  const validAlignments = new Set([
    '守序善良', '中立善良', '混亂善良', '守序中立', '絕對中立',
    '混亂中立', '守序邪惡', '中立邪惡', '混亂邪惡'
  ]);

  for (const unit of [...npcsDatabase, ...monstersDatabase]) {
    if (typeof unit.id !== 'string' || !unit.id.trim() || typeof unit.name !== 'string' || !unit.name.trim()) {
      issues.push('單位缺少有效的 ID 或名稱');
    }
    if (seenIds.has(unit.id)) issues.push(`單位 ID 重複：${unit.id}`);
    if (unit.id === PLAYER_UNIT_ID) issues.push(`單位 ID 與玩家保留 ID 衝突：${unit.id}`);
    seenIds.add(unit.id);
    if (unit.alignment !== undefined && !validAlignments.has(unit.alignment)) issues.push(`${unit.id}: 無效陣營 ${unit.alignment}`);
    if (!['friendly', 'neutral', 'hostile'].includes(unit.defaultDisposition)) issues.push(`${unit.id}: 無效預設關係 ${unit.defaultDisposition}`);
    validateUnitBuild(unit.id, unit, issues);
  }

  for (const npc of npcsDatabase) {
    const map = getMapById(npc.mapId);
    if (!map || !map.npcsPresent.includes(npc.id)) issues.push(`${npc.id}: 所在地圖 ${npc.mapId} 未正確列出此 NPC`);
    if (npc.shopId) {
      const shop = getShopById(npc.shopId);
      if (!shop || shop.npcId !== npc.id) issues.push(`${npc.id}: 商店參照 ${npc.shopId} 無效`);
    }
  }

  for (const monster of monstersDatabase) {
    if (!mapsDatabase.some((map) => map.monstersPresent.includes(monster.id))) issues.push(`${monster.id}: 未被任何地圖列為可遭遇敵人`);
    if (monster.requiredQuestId && !getQuestById(monster.requiredQuestId)) issues.push(`${monster.id}: 找不到前置任務 ${monster.requiredQuestId}`);
    if (monster.level > getMonsterLevelCap(monster.id)) issues.push(`${monster.id}: 等級 ${monster.level} 超過出沒地區上限 ${getMonsterLevelCap(monster.id)}`);
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

/** 全部靜態資料驗證；建置前由 scripts/validate-data.mjs 執行，有錯誤即中止建置。 */
export const validateGameData = (): string[] => [...validateGrowthData(), ...validateWorldUnitData()];
