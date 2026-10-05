import type {
  AbilityScores,
  ItemStatic,
  CharacterClassStatic,
  EventStatic,
  FactionDataStatic,
  FactionRelationStatus,
  FactionStatic,
  LevelBenchmarkStatic,
  MapStatic,
  MonsterStatic,
  NpcStatic,
  UnitInstance,
  PlayerState,
  QuestStatic,
  ReputationTierStatic,
  ScenarioStatic,
  ShopStatic,
  SkillStatic,
  SpeciesStatic,
  UnitBuild,
  UnitDisposition,
  UnitStatBlock,
  WorldModifier,
  WorldRuntimeState,
  WorldUnitStatic
} from '../types/game';
import { computeExpReward, computeUnitAbilities, computeUnitStats, isValidSpeciesClassCombo, UNIT_STAT_KEYS } from '../utils/unitGrowth';
import { applyWorldModifiers, parseModifierScope } from '../utils/worldModifiers';

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
import rawEvents from './events.json';
import rawFactions from './factions.json';

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
export const eventsDatabase: EventStatic[] = rawEvents as EventStatic[];
export const factionData: FactionDataStatic = rawFactions as FactionDataStatic;
export const factionsDatabase: FactionStatic[] = factionData.factions;

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

/** 玩家數值來源；帶有世界狀態時一併套用世界修正（種族、所在地區或玩家單位）。 */
type PlayerBuildSource = Pick<PlayerState, 'speciesId' | 'classId' | 'level'> & Partial<Pick<PlayerState, 'unitId' | 'currentMapId' | 'world' | 'gameTimeMinutes'>>;

const FALLBACK_STATS: UnitStatBlock = { hp: 1, mp: 0, atk: 0, def: 0, spd: 0 };

/** 玩家未含裝備的數值；與 NPC/魔物同一公式。 */
export const getPlayerBaseStats = (player: PlayerBuildSource): UnitStatBlock => {
  const stats = getUnitBuildStats({ speciesId: player.speciesId, classId: player.classId, level: player.level }) ?? FALLBACK_STATS;
  return player.world ? applyWorldModifiers(stats, {
    unitId: player.unitId ?? PLAYER_UNIT_ID, speciesId: player.speciesId, mapIds: player.currentMapId ? [player.currentMapId] : []
  }, player.world.modifiers, player.gameTimeMinutes) : stats;
};

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
  speciesId: unit.speciesId, classId: unit.classId, level: unit.level, statAdjustments: unit.statAdjustments,
  factionId: unit.factionId, occupation: unit.occupation, dormantUntilOccupation: unit.dormantUntilOccupation
});

/** 所有 NPC/魔物單位樣板（UnitTemplate）。 */
export const unitTemplatesDatabase = (): (NpcStatic | MonsterStatic)[] => [...npcsDatabase, ...monstersDatabase];

/** 單位查詢的世界狀態來源；可直接傳入 PlayerState（執行期合併狀態）。 */
export interface UnitWorldSource {
  unitInstances?: Record<string, Pick<UnitInstance, 'level' | 'isDormant'>>;
  world?: { modifiers: WorldModifier[] };
  gameTimeMinutes?: number;
}

/**
 * Shared lookup adapter. Legacy NPC/monster records and their IDs remain unchanged.
 * 傳入世界狀態時，數值與擊倒獎勵依實例目前等級計算並套用世界修正；否則使用樣板等級與靜態數值。
 */
export const getWorldUnitById = (id: string, source?: UnitWorldSource): WorldUnitStatic | undefined => {
  const instances = source?.unitInstances;
  const npc = getNpcById(id);
  const monster = getMonsterById(id);
  if (Boolean(npc) === Boolean(monster)) return undefined;
  const template = (npc ?? monster)!;
  const level = instances?.[id]?.level ?? template.level;
  const build = { ...template, level };
  const baseStats = getUnitBuildStats(build);
  if (!baseStats) return undefined;
  const expReward = getUnitExpReward(build);
  const mapIds = npc ? [npc.mapId] : mapsDatabase.filter((map) => map.monstersPresent.includes(monster!.id)).map((map) => map.id);
  const stats = applyWorldModifiers(baseStats, { unitId: id, speciesId: template.speciesId, mapIds }, source?.world?.modifiers, source?.gameTimeMinutes);

  if (npc) {
    return { ...toUnitBase(npc), level, kind: 'npc', title: npc.title, stats, expReward, mapIds, source: npc };
  }

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

/**
 * 單位實例預設值（取自樣板）；新存檔建立與存檔中缺少的單位共用。
 * 潛伏單位（dormantUntilOccupation）預設為潛伏狀態，經由「他方佔領」出現時以 awake 建立。
 */
export const createDefaultUnitInstance = (template: NpcStatic | MonsterStatic, options: { awake?: boolean } = {}): UnitInstance => {
  const npc = 'mapId' in template ? template : undefined;
  const dormant = template.dormantUntilOccupation === true && !options.awake;
  return {
    level: template.level,
    exp: getBaseExpForLevel(template.level),
    gold: npc?.startingGold ?? 0,
    inventory: (npc?.startingInventory ?? []).flatMap((entry) =>
      getItemById(entry.itemId) && Number.isInteger(entry.quantity) && entry.quantity > 0 ? [{ ...entry }] : []),
    currentHp: dormant ? 0 : getWorldUnitById(template.id)?.stats.hp ?? 1,
    isDead: dormant,
    ...(dormant ? { isDormant: true } : {})
  };
};

export const createDefaultUnitInstances = (): Record<string, UnitInstance> =>
  Object.fromEntries(unitTemplatesDatabase().map((template) => [template.id, createDefaultUnitInstance(template)]));

/** Return the normalized units referenced by a map, preserving NPC and monster order. 潛伏中的單位不在場，不列出。 */
export const getWorldUnitsAtMap = (mapId: string, source?: UnitWorldSource): WorldUnitStatic[] => {
  const map = getMapById(mapId);
  if (!map) return [];
  return [...map.npcsPresent, ...map.monstersPresent]
    .flatMap((unitId) => {
      if (source?.unitInstances?.[unitId]?.isDormant) return [];
      const unit = getWorldUnitById(unitId, source);
      return unit ? [unit] : [];
    });
};

// ==========================================
// 勢力（O38）
// ==========================================

export const getFactionById = (id: string): FactionStatic | undefined =>
  factionsDatabase.find((faction) => faction.id === id);

/** 聲望等級，依最低值由低到高排序。 */
export const reputationTiers: ReputationTierStatic[] = [...factionData.reputation.tiers].sort((a, b) => a.min - b.min);

export const clampReputation = (value: number): number =>
  Math.max(factionData.reputation.min, Math.min(factionData.reputation.max, Math.round(value)));

export const getReputationTier = (value: number): ReputationTierStatic =>
  [...reputationTiers].reverse().find((tier) => value >= tier.min) ?? reputationTiers[0];

export const getReputationTierIndex = (tierId: string): number => reputationTiers.findIndex((tier) => tier.id === tierId);

/** 各勢力的初始聲望；新角色使用。 */
export const createInitialReputation = (): Record<string, number> =>
  Object.fromEntries(factionsDatabase.map((faction) => [faction.id, clampReputation(faction.initialReputation)]));

/** 玩家對勢力的聲望；存檔沒有記錄時使用勢力初始值。 */
export const getFactionReputation = (player: Pick<PlayerState, 'factionReputation'>, factionId: string): number =>
  player.factionReputation[factionId] ?? getFactionById(factionId)?.initialReputation ?? 0;

export const getUnitFactionId = (unitId: string): string | undefined =>
  (getNpcById(unitId) ?? getMonsterById(unitId))?.factionId;

/** 勢力關係的存檔鍵：兩個勢力 ID 排序後以「|」相連。 */
export const factionRelationKey = (a: string, b: string): string => [a, b].sort().join('|');

/** 兩勢力目前的關係：世界狀態中的變更優先，其次是 factions.json 初始值，未列出則為中立。 */
export const getFactionRelation = (
  world: Pick<WorldRuntimeState, 'factionRelations'> | undefined,
  a: string,
  b: string
): { status: FactionRelationStatus; tags: string[] } => {
  const changed = world?.factionRelations[factionRelationKey(a, b)];
  if (changed) return changed;
  const initial = factionData.relations.find((relation) => factionRelationKey(...relation.factionIds) === factionRelationKey(a, b));
  return initial ? { status: initial.status, tags: [...(initial.tags ?? [])] } : { status: 'neutral', tags: [] };
};

/**
 * Alignment expresses values; disposition is the unit's current relation to this player.
 * 判定順序：個人關係覆寫 → 所屬勢力聲望等級（只有最低/最高等級強制敵對/友善）→ 單位預設關係。
 */
export const getWorldUnitDisposition = (
  player: Pick<PlayerState, 'unitDispositionOverrides' | 'factionReputation'>,
  unitId: string
): UnitDisposition | undefined => {
  const unit = getWorldUnitById(unitId);
  if (!unit) return undefined;
  const factionDisposition = unit.factionId ? getReputationTier(getFactionReputation(player, unit.factionId)).disposition : undefined;
  return player.unitDispositionOverrides[unitId] ?? factionDisposition ?? unit.defaultDisposition;
};

export const getEventById = (id: string): EventStatic | undefined =>
  eventsDatabase.find((event) => event.id === id);

/** 單位顯示名稱：NPC 為「職稱 + 名字」；找不到時回傳 ID。 */
export const getUnitDisplayName = (unitId: string): string => {
  const unit = getWorldUnitById(unitId);
  return unit ? `${unit.kind === 'npc' ? unit.title : ''}${unit.name}` : unitId;
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

/** 驗證靜態事件：ID 唯一、引用可解析、效果與世界修正格式正確。 */
export function validateEventData(): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const unitExists = (id: string) => unitTemplatesDatabase().some((unit) => unit.id === id);
  for (const event of eventsDatabase) {
    const label = `事件 ${event.id}`;
    if (!/^EVT-\d{3,}$/.test(event.id)) issues.push(`${label}: ID 格式應為 EVT-xxx`);
    if (seen.has(event.id)) issues.push(`事件 ID 重複：${event.id}`);
    seen.add(event.id);
    if (!event.title?.trim() || !event.summary?.trim()) issues.push(`${label}: 缺少標題或描述`);
    if (!['auto', 'aiProposal'].includes(event.trigger)) issues.push(`${label}: 無效觸發方式 ${event.trigger}`);
    if (!['witnesses', 'faction', 'region', 'world'].includes(event.knownBy)) issues.push(`${label}: 無效傳播範圍 ${event.knownBy}`);
    if (event.knownBy === 'faction' && !event.knownByFactions?.length) issues.push(`${label}: 傳播範圍為同勢力時須列出 knownByFactions`);
    for (const factionId of event.knownByFactions ?? []) {
      if (!getFactionById(factionId)) issues.push(`${label}: 找不到傳播勢力 ${factionId}`);
    }
    validateFactionConditions(label, event.requires ?? {}, issues);
    for (const change of event.effects?.reputation ?? []) {
      if (!getFactionById(change.factionId)) issues.push(`${label}: 找不到聲望勢力 ${change.factionId}`);
      if (!Number.isInteger(change.change) || change.change === 0) issues.push(`${label}: 聲望變化須為非零整數`);
    }
    for (const change of event.effects?.factionRelations ?? []) {
      validateFactionPair(label, change.factionIds, issues);
      if (change.status !== undefined && !FACTION_RELATION_STATUSES.includes(change.status)) issues.push(`${label}: 無效的勢力關係 ${change.status}`);
      for (const tag of [...(change.addTags ?? []), ...(change.removeTags ?? [])]) {
        if (!factionData.relationTags.some((entry) => entry.id === tag)) issues.push(`${label}: 找不到附加關係 ${tag}`);
      }
      if (change.status === undefined && !change.addTags?.length && !change.removeTags?.length) issues.push(`${label}: 勢力關係變化沒有任何內容`);
    }
    if (event.trigger === 'auto' && !event.requires?.flags?.length && !event.requires?.unitsDead?.length && !event.requires?.unitsAlive?.length) {
      issues.push(`${label}: 自動事件至少需要一個旗標或單位條件，避免開局即觸發`);
    }
    if (event.trigger === 'aiProposal' && !event.aiHint?.trim()) issues.push(`${label}: AI 提議事件需說明使用時機（aiHint）`);
    if (!event.effects || typeof event.effects !== 'object') {
      issues.push(`${label}: 缺少效果`);
      continue;
    }
    for (const unitId of [...(event.requires?.unitsAlive ?? []), ...(event.requires?.unitsDead ?? [])]) {
      if (!unitExists(unitId)) issues.push(`${label}: 找不到單位 ${unitId}`);
    }
    for (const mapId of event.requires?.mapIds ?? []) {
      if (!getMapById(mapId)) issues.push(`${label}: 找不到地圖 ${mapId}`);
    }
    for (const flag of [...(event.requires?.flags ?? []), ...(event.excludes?.flags ?? []), ...(event.effects.setFlags ?? []), ...(event.effects.clearFlags ?? [])]) {
      if (typeof flag !== 'string' || !flag.trim()) issues.push(`${label}: 旗標名稱無效`);
    }
    for (const modifier of event.effects.worldModifiers ?? []) {
      const scope = parseModifierScope(modifier.scope);
      if (!scope) issues.push(`${label}: 無效的修正對象 ${modifier.scope}`);
      else if (scope.kind === 'unit' && !unitExists(scope.id)) issues.push(`${label}: 找不到修正單位 ${scope.id}`);
      else if (scope.kind === 'species' && !getSpeciesById(scope.id)) issues.push(`${label}: 找不到修正種族 ${scope.id}`);
      else if (scope.kind === 'map' && !getMapById(scope.id)) issues.push(`${label}: 找不到修正地圖 ${scope.id}`);
      if (!UNIT_STAT_KEYS.includes(modifier.stat)) issues.push(`${label}: 無效的修正數值 ${modifier.stat}`);
      if (!['add', 'multiply'].includes(modifier.op)) issues.push(`${label}: 無效的修正方式 ${modifier.op}`);
      if (modifier.op === 'add' && !Number.isInteger(modifier.value)) issues.push(`${label}: 加減修正必須為整數`);
      if (modifier.op === 'multiply' && !(modifier.value > 0 && modifier.value <= 3)) issues.push(`${label}: 倍率修正必須介於 0 與 3 之間`);
      if (modifier.durationMinutes !== undefined && !(Number.isSafeInteger(modifier.durationMinutes) && modifier.durationMinutes > 0)) issues.push(`${label}: 修正持續時間無效`);
    }
  }
  for (const species of speciesDatabase) {
    if (species.respawnDays !== undefined && !(Number.isInteger(species.respawnDays) && species.respawnDays > 0)) issues.push(`種族 ${species.id}: respawnDays 必須為正整數`);
  }
  return issues;
}

/** 勢力關係狀態，由敵到友。 */
export const FACTION_RELATION_STATUSES: FactionRelationStatus[] = ['war', 'hostile', 'tense', 'neutral', 'friendly', 'alliance'];

function validateFactionPair(label: string, factionIds: unknown, issues: string[]) {
  if (!Array.isArray(factionIds) || factionIds.length !== 2 || factionIds[0] === factionIds[1]) {
    issues.push(`${label}: 勢力組合須為兩個不同的勢力`);
    return;
  }
  for (const factionId of factionIds) {
    if (!getFactionById(String(factionId))) issues.push(`${label}: 找不到勢力 ${factionId}`);
  }
}

/** 驗證勢力條件；事件、日後的劇情片段與任務範本共用。 */
export function validateFactionConditions(label: string, conditions: { reputation?: { factionId: string; minTier?: string; maxTier?: string }[]; factionRelations?: { factionIds: [string, string]; status: FactionRelationStatus[] }[] }, issues: string[]) {
  for (const condition of conditions.reputation ?? []) {
    if (!getFactionById(condition.factionId)) issues.push(`${label}: 聲望條件找不到勢力 ${condition.factionId}`);
    const min = condition.minTier === undefined ? 0 : getReputationTierIndex(condition.minTier);
    const max = condition.maxTier === undefined ? reputationTiers.length - 1 : getReputationTierIndex(condition.maxTier);
    if (min < 0 || max < 0) issues.push(`${label}: 聲望條件的等級不存在`);
    else if (min > max) issues.push(`${label}: 聲望條件的最低等級高於最高等級`);
    if (condition.minTier === undefined && condition.maxTier === undefined) issues.push(`${label}: 聲望條件至少需要 minTier 或 maxTier`);
  }
  for (const condition of conditions.factionRelations ?? []) {
    validateFactionPair(label, condition.factionIds, issues);
    if (!Array.isArray(condition.status) || !condition.status.length || condition.status.some((status) => !FACTION_RELATION_STATUSES.includes(status))) {
      issues.push(`${label}: 勢力關係條件的狀態無效`);
    }
  }
}

/** 驗證勢力資料：聲望等級、規則、勢力、初始關係、單位所屬與「他方佔領」設定，以及劇本的接續規則。 */
export function validateFactionData(): string[] {
  const issues: string[] = [];
  const { min, max, tiers, rules } = factionData.reputation;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min >= max) issues.push('聲望範圍 min/max 無效');
  const tierIds = new Set<string>();
  for (const tier of tiers) {
    if (!tier.id?.trim() || !tier.name?.trim()) issues.push('聲望等級缺少 ID 或名稱');
    if (tierIds.has(tier.id)) issues.push(`聲望等級 ID 重複：${tier.id}`);
    tierIds.add(tier.id);
    if (!Number.isInteger(tier.min) || tier.min < min || tier.min > max) issues.push(`聲望等級 ${tier.id}: min 須為範圍內的整數`);
    if (tier.disposition !== undefined && !['hostile', 'friendly'].includes(tier.disposition)) issues.push(`聲望等級 ${tier.id}: disposition 只能是 hostile 或 friendly`);
  }
  if (reputationTiers[0]?.min !== min) issues.push('最低聲望等級的 min 必須等於聲望下限');
  if (new Set(tiers.map((tier) => tier.min)).size !== tiers.length) issues.push('聲望等級的 min 不可重複');
  // 只有最低的連續等級可強制敵對、最高的連續等級可強制友善，確保聲望提高時態度不會反而變差。
  const firstNonHostile = reputationTiers.findIndex((tier) => tier.disposition !== 'hostile');
  const lastNonFriendly = reputationTiers.map((tier) => tier.disposition !== 'friendly').lastIndexOf(true);
  reputationTiers.forEach((tier, index) => {
    if (tier.disposition === 'hostile' && firstNonHostile !== -1 && index > firstNonHostile) issues.push(`聲望等級 ${tier.id}: 只有最低的連續等級可設為 hostile`);
    if (tier.disposition === 'friendly' && index < lastNonFriendly) issues.push(`聲望等級 ${tier.id}: 只有最高的連續等級可設為 friendly`);
  });
  for (const key of ['memberKilled', 'memberAttacked', 'questCompleted', 'enemyMemberKilled'] as const) {
    if (!Number.isInteger(rules?.[key])) issues.push(`聲望規則 ${key} 須為整數`);
  }

  const factionIds = new Set<string>();
  for (const faction of factionsDatabase) {
    if (!/^FAC-\d{3,}$/.test(faction.id)) issues.push(`勢力 ${faction.id}: ID 格式應為 FAC-xxx`);
    if (factionIds.has(faction.id)) issues.push(`勢力 ID 重複：${faction.id}`);
    factionIds.add(faction.id);
    if (!faction.name?.trim() || !faction.summary?.trim()) issues.push(`勢力 ${faction.id}: 缺少名稱或簡介`);
    if (!Number.isInteger(faction.initialReputation) || faction.initialReputation < min || faction.initialReputation > max) issues.push(`勢力 ${faction.id}: 初始聲望須為範圍內的整數`);
  }
  const seenPairs = new Set<string>();
  for (const relation of factionData.relations) {
    const label = `勢力關係 ${relation.factionIds?.join('–')}`;
    validateFactionPair(label, relation.factionIds, issues);
    if (Array.isArray(relation.factionIds) && relation.factionIds.length === 2) {
      const key = factionRelationKey(...relation.factionIds);
      if (seenPairs.has(key)) issues.push(`${label}: 重複定義`);
      seenPairs.add(key);
    }
    if (!FACTION_RELATION_STATUSES.includes(relation.status)) issues.push(`${label}: 無效的關係 ${relation.status}`);
    for (const tag of relation.tags ?? []) {
      if (!factionData.relationTags.some((entry) => entry.id === tag)) issues.push(`${label}: 找不到附加關係 ${tag}`);
    }
  }
  if (new Set(factionData.relationTags.map((tag) => tag.id)).size !== factionData.relationTags.length) issues.push('附加關係 ID 重複');

  for (const unit of unitTemplatesDatabase()) {
    if (unit.factionId !== undefined && !getFactionById(unit.factionId)) issues.push(`${unit.id}: 找不到所屬勢力 ${unit.factionId}`);
    if (unit.occupation) {
      const occupier = unitTemplatesDatabase().find((entry) => entry.id === unit.occupation!.byUnitId);
      const sharedMap = mapsDatabase.some((map) => [...map.npcsPresent, ...map.monstersPresent].includes(unit.id) &&
        [...map.npcsPresent, ...map.monstersPresent].includes(unit.occupation!.byUnitId));
      if (!occupier) issues.push(`${unit.id}: 找不到佔領單位 ${unit.occupation.byUnitId}`);
      else if (!occupier.dormantUntilOccupation) issues.push(`${unit.id}: 佔領單位 ${occupier.id} 必須設定 dormantUntilOccupation`);
      if (occupier && !sharedMap) issues.push(`${unit.id}: 佔領單位 ${unit.occupation.byUnitId} 必須出現在同一張地圖`);
      if (!Number.isInteger(unit.occupation.afterDays) || unit.occupation.afterDays <= 0) issues.push(`${unit.id}: 佔領天數須為正整數`);
      if (unit.dormantUntilOccupation) issues.push(`${unit.id}: 潛伏單位本身不可再設定佔領`);
    }
    if (unit.dormantUntilOccupation && !unitTemplatesDatabase().some((entry) => entry.occupation?.byUnitId === unit.id)) {
      issues.push(`${unit.id}: 潛伏單位沒有任何單位會讓它出現`);
    }
    if (unit.dormantUntilOccupation && questsDatabase.some((quest) => quest.questGiverId === unit.id)) issues.push(`${unit.id}: 潛伏單位不可擔任任務給予者`);
  }

  if (typeof scenario.rules?.npcKillGrantsExp !== 'boolean') issues.push(`劇本 ${scenario.id}: rules.npcKillGrantsExp 須為布林值`);
  if (scenario.succession) {
    const ratio = scenario.succession.reputationInheritRatio;
    if (!scenario.succession.relatedLabel?.trim()) issues.push(`劇本 ${scenario.id}: succession.relatedLabel 不可為空`);
    if (!(Number.isFinite(ratio) && ratio > 0 && ratio <= 1)) issues.push(`劇本 ${scenario.id}: succession.reputationInheritRatio 須介於 0（不含）與 1 之間`);
  }
  return issues;
}

/** 全部靜態資料驗證；建置前由 scripts/validate-data.mjs 執行，有錯誤即中止建置。 */
export const validateGameData = (): string[] => [...validateGrowthData(), ...validateWorldUnitData(), ...validateEventData(), ...validateFactionData()];
