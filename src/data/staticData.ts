import type {
  AbilityScores,
  AgentActionType,
  AgentRulesStatic,
  ItemStatic,
  CharacterClassStatic,
  EventStatic,
  FactionDataStatic,
  FactionRelationStatus,
  FactionStatic,
  LevelBenchmarkStatic,
  MapFacility,
  MapStatic,
  UnitInstance,
  PlayerState,
  QuestStatic,
  QuestTemplateDataStatic,
  AIContextConfigStatic,
  QuestTemplateStatic,
  ReputationTierStatic,
  ScenarioStatic,
  ShopStatic,
  SkillStatic,
  SpeciesStatic,
  StoryActStatic,
  StoryDataStatic,
  StoryEndingStatic,
  StoryletStatic,
  UnitBuild,
  UnitDisposition,
  UnitStatBlock,
  UnitStatic,
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
import rawUnits from './units.json';
import rawQuests from './quests.json';
import rawShops from './shops.json';
import rawSkills from './skills.json';
import rawSpecies from './species.json';
import rawScenario from './scenario.json';
import rawEvents from './events.json';
import rawFactions from './factions.json';
import rawQuestTemplates from './quest_templates.json';
import rawAIContext from './ai_context.json';
import rawStory from './story.json';
import rawAgentRules from './agent_rules.json';

// 進行靜態型別轉型，確保導出的資料陣列完全符合 DTO 規範
export const itemsDatabase: ItemStatic[] = rawItems as ItemStatic[];
export const characterClassesDatabase: CharacterClassStatic[] = rawCharacterClasses as CharacterClassStatic[];
export const levelBenchmarksDatabase: LevelBenchmarkStatic[] = rawLevelBenchmarks as LevelBenchmarkStatic[];
export const mapsDatabase: MapStatic[] = rawMaps as MapStatic[];
export const unitsDatabase: UnitStatic[] = rawUnits as UnitStatic[];
export const questsDatabase: QuestStatic[] = rawQuests as QuestStatic[];
export const shopsDatabase: ShopStatic[] = rawShops as ShopStatic[];
export const skillsDatabase: SkillStatic[] = rawSkills as SkillStatic[];
export const speciesDatabase: SpeciesStatic[] = rawSpecies as SpeciesStatic[];
export const scenario: ScenarioStatic = rawScenario as ScenarioStatic;
export const eventsDatabase: EventStatic[] = rawEvents as EventStatic[];
export const factionData: FactionDataStatic = rawFactions as FactionDataStatic;
export const factionsDatabase: FactionStatic[] = factionData.factions;
export const questTemplateData: QuestTemplateDataStatic = rawQuestTemplates as QuestTemplateDataStatic;
export const questTemplatesDatabase: QuestTemplateStatic[] = questTemplateData.templates;
export const aiContextConfig: AIContextConfigStatic = rawAIContext as AIContextConfigStatic;
export const storyData: StoryDataStatic = rawStory as StoryDataStatic;
export const agentRules: AgentRulesStatic = rawAgentRules as AgentRulesStatic;
/** 重要角色的行動種類（O34 第 1 階段）。 */
export const AGENT_ACTION_TYPES: AgentActionType[] = ['idle', 'post_quest', 'trigger_event', 'change_faction_relation'];
/** 依順序排列的幕。 */
export const storyActs: StoryActStatic[] = [...storyData.acts].sort((a, b) => a.order - b.order);
export const storyletsDatabase: StoryletStatic[] = storyData.storylets;
export const getStoryActById = (id: string): StoryActStatic | undefined => storyActs.find((act) => act.id === id);
export const getStoryletById = (id: string): StoryletStatic | undefined => storyletsDatabase.find((storylet) => storylet.id === id);
export const storyEndingsDatabase: StoryEndingStatic[] = storyData.endings ?? [];
export const getStoryEndingById = (id: string): StoryEndingStatic | undefined => storyEndingsDatabase.find((ending) => ending.id === id);
/** 下一幕；已是最後一幕時為 undefined。 */
export const getNextStoryAct = (actId: string): StoryActStatic | undefined => {
  const index = storyActs.findIndex((act) => act.id === actId);
  return index < 0 ? undefined : storyActs[index + 1];
};

export const getQuestTemplateById = (id: string): QuestTemplateStatic | undefined =>
  questTemplatesDatabase.find((template) => template.id === id);

/** 玩家的穩定單位 ID；單位資料不得使用此 ID。 */
export const PLAYER_UNIT_ID = 'PLAYER-001';

/** 需遭遇單位的成長上限：所在地區建議等級上限 +3（已確認的設計決策「難度」）。 */
const ENCOUNTER_LEVEL_CAP_OVER_REGION = 3;

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

/** 基準表中的最高等級；玩家與地區居民的成長上限。 */
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

/** 玩家未含裝備的數值；與其他單位同一公式。 */
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

/** 地圖列出的單位（居民與需遭遇的單位）。 */
export const isUnitListedOnMap = (map: MapStatic, unitId: string): boolean => map.unitsPresent.includes(unitId);

/** 需遭遇單位的等級上限：出沒地區建議等級上限的最大值 +3，且不超過基準表。 */
export const getEncounterLevelCap = (unitId: string): number => {
  const ceilings = mapsDatabase.filter((map) => isUnitListedOnMap(map, unitId))
    .flatMap((map) => {
      const ceiling = getMapLevelCeiling(map);
      return ceiling === undefined ? [] : [ceiling];
    });
  return ceilings.length ? Math.min(MAX_UNIT_LEVEL, Math.max(...ceilings) + ENCOUNTER_LEVEL_CAP_OVER_REGION) : MAX_UNIT_LEVEL;
};

/** 單位樣板（units.json）。 */
export const getUnitTemplateById = (id: string): UnitStatic | undefined =>
  unitsDatabase.find((unit) => unit.id === id);

/** 設有 agent 的重要角色（O34）。 */
export const getAgentUnitIds = (): string[] => unitsDatabase.filter((unit) => unit.agent).map((unit) => unit.id);

export const getShopById = (id: string): ShopStatic | undefined =>
  shopsDatabase.find((shop) => shop.id === id);

export const getShopForUnit = (unit: UnitStatic): ShopStatic | undefined =>
  unit.shopId ? getShopById(unit.shopId) : undefined;

/** 所有單位樣板（玩家以外）。 */
export const unitTemplatesDatabase = (): UnitStatic[] => unitsDatabase;

/** 單位查詢的世界狀態來源；可直接傳入 PlayerState（執行期合併狀態）。 */
export interface UnitWorldSource {
  unitInstances?: Record<string, Pick<UnitInstance, 'level' | 'isDormant'>>;
  world?: { modifiers: WorldModifier[] };
  gameTimeMinutes?: number;
}

/**
 * 共用單位查詢。
 * 傳入世界狀態時，數值與擊倒獎勵依實例目前等級計算並套用世界修正；否則使用樣板等級與靜態數值。
 */
export const getWorldUnitById = (id: string, source?: UnitWorldSource): WorldUnitStatic | undefined => {
  const template = getUnitTemplateById(id);
  if (!template) return undefined;
  const level = source?.unitInstances?.[id]?.level ?? template.level;
  const build = { ...template, level };
  const baseStats = getUnitBuildStats(build);
  if (!baseStats) return undefined;
  const expReward = getUnitExpReward(build);
  const mapIds = mapsDatabase.filter((map) => isUnitListedOnMap(map, id)).map((map) => map.id);
  const stats = applyWorldModifiers(baseStats, { unitId: id, speciesId: template.speciesId, mapIds }, source?.world?.modifiers, source?.gameTimeMinutes);
  return { ...template, level, stats, expReward, mapIds, homeMapId: mapIds[0] ?? '', source: template };
};

/** 單位成長上限：需遭遇的單位受出沒地區限制，地區居民以基準表最高等級為限。 */
export const getUnitLevelCap = (unitId: string): number =>
  getUnitTemplateById(unitId)?.requiresEncounter ? getEncounterLevelCap(unitId) : MAX_UNIT_LEVEL;

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
export const createDefaultUnitInstance = (template: UnitStatic, options: { awake?: boolean } = {}): UnitInstance => {
  const dormant = template.dormantUntilOccupation === true && !options.awake;
  return {
    level: template.level,
    exp: getBaseExpForLevel(template.level),
    gold: template.startingGold ?? 0,
    inventory: (template.startingInventory ?? []).flatMap((entry) =>
      getItemById(entry.itemId) && Number.isInteger(entry.quantity) && entry.quantity > 0 ? [{ ...entry }] : []),
    currentHp: dormant ? 0 : getWorldUnitById(template.id)?.stats.hp ?? 1,
    isDead: dormant,
    ...(dormant ? { isDormant: true } : {})
  };
};

export const createDefaultUnitInstances = (): Record<string, UnitInstance> =>
  Object.fromEntries(unitTemplatesDatabase().map((template) => [template.id, createDefaultUnitInstance(template)]));

/** 地圖上列出的單位（依資料順序）。潛伏中的單位不在場，不列出。 */
export const getWorldUnitsAtMap = (mapId: string, source?: UnitWorldSource): WorldUnitStatic[] => {
  const map = getMapById(mapId);
  if (!map) return [];
  return map.unitsPresent
    .flatMap((unitId) => {
      if (source?.unitInstances?.[unitId]?.isDormant) return [];
      const unit = getWorldUnitById(unitId, source);
      return unit ? [unit] : [];
    });
};

/** 地區居民（進入地區即在場、可交談；不含需遭遇的單位）的 ID。 */
export const getResidentUnitIds = (map: MapStatic): string[] =>
  map.unitsPresent.filter((unitId) => getUnitTemplateById(unitId)?.requiresEncounter !== true);

/** 需遭遇才出現的單位 ID。 */
export const getEncounterUnitIds = (map: MapStatic): string[] =>
  map.unitsPresent.filter((unitId) => getUnitTemplateById(unitId)?.requiresEncounter === true);

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
  getUnitTemplateById(unitId)?.factionId;

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

/** 單位顯示名稱：有稱號時為「稱號 + 名字」；找不到時回傳 ID。 */
export const getUnitDisplayName = (unitId: string): string => {
  const unit = getWorldUnitById(unitId);
  return unit ? `${unit.title ?? ''}${unit.name}` : unitId;
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

/** 驗證單位資料（units.json）、地圖列出的單位與商店經營者。 */
export function validateWorldUnitData(): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  const validAlignments = new Set([
    '守序善良', '中立善良', '混亂善良', '守序中立', '絕對中立',
    '混亂中立', '守序邪惡', '中立邪惡', '混亂邪惡'
  ]);

  for (const unit of unitsDatabase) {
    if (typeof unit.id !== 'string' || !unit.id.trim() || typeof unit.name !== 'string' || !unit.name.trim()) {
      issues.push('單位缺少有效的 ID 或名稱');
    }
    if (seenIds.has(unit.id)) issues.push(`單位 ID 重複：${unit.id}`);
    if (unit.id === PLAYER_UNIT_ID) issues.push(`單位 ID 與玩家保留 ID 衝突：${unit.id}`);
    seenIds.add(unit.id);
    if (unit.alignment !== undefined && !validAlignments.has(unit.alignment)) issues.push(`${unit.id}: 無效陣營 ${unit.alignment}`);
    if (!['friendly', 'neutral', 'hostile'].includes(unit.defaultDisposition)) issues.push(`${unit.id}: 無效預設關係 ${unit.defaultDisposition}`);
    validateUnitBuild(unit.id, unit, issues);

    const listedOn = mapsDatabase.filter((map) => isUnitListedOnMap(map, unit.id));
    if (!listedOn.length) issues.push(`${unit.id}: 未被任何地圖的 unitsPresent 列出`);
    if (!unit.requiresEncounter && listedOn.length > 1) issues.push(`${unit.id}: 地區居民只能列在一張地圖（目前 ${listedOn.map((map) => map.id).join('、')}）`);
    // 族群代表可重複遭遇的一群個體；居民的戰鬥 HP 會保留，兩者不相容。
    if (unit.population && !unit.requiresEncounter) issues.push(`${unit.id}: 族群樣板（population）須同時為需遭遇單位（requiresEncounter）`);
    if (unit.population && unit.isBoss) issues.push(`${unit.id}: 頭目不可是族群樣板`);
    if (unit.shopId) {
      const shop = getShopById(unit.shopId);
      if (!shop || shop.ownerUnitId !== unit.id) issues.push(`${unit.id}: 商店參照 ${unit.shopId} 無效`);
    }
    if (unit.requiredQuestId && !getQuestById(unit.requiredQuestId)) issues.push(`${unit.id}: 找不到前置任務 ${unit.requiredQuestId}`);
    if (unit.requiresEncounter && unit.level > getEncounterLevelCap(unit.id)) issues.push(`${unit.id}: 等級 ${unit.level} 超過出沒地區上限 ${getEncounterLevelCap(unit.id)}`);
    for (const drop of unit.loot?.dropItems ?? []) {
      if (!getItemById(drop.itemId) || !(drop.chance > 0 && drop.chance <= 1)) issues.push(`${unit.id}: 掉落物 ${drop.itemId} 無效或機率不在 0～1`);
    }
  }

  for (const shop of shopsDatabase) {
    if (getUnitTemplateById(shop.ownerUnitId)?.shopId !== shop.id) issues.push(`${shop.id}: 經營者 ${shop.ownerUnitId} 不存在或未指向此商店`);
  }

  for (const map of mapsDatabase) {
    for (const unitId of map.unitsPresent) {
      if (!getUnitTemplateById(unitId)) issues.push(`${map.id}: 單位參照 ${unitId} 無效`);
    }
    for (const facility of map.facilities ?? []) {
      if (!MAP_FACILITIES.includes(facility)) issues.push(`${map.id}: 無效的地點設施 ${facility}`);
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
    if (!['auto', 'aiProposal', 'storylet', 'stuck', 'agent'].includes(event.trigger)) issues.push(`${label}: 無效觸發方式 ${event.trigger}`);
    if (event.trigger === 'agent') {
      if (!event.agentUnitIds?.length) issues.push(`${label}: 重要角色觸發的事件須列出 agentUnitIds`);
      for (const unitId of event.agentUnitIds ?? []) {
        if (!getUnitTemplateById(unitId)?.agent) issues.push(`${label}: agentUnitIds 中的 ${unitId} 不是重要角色（沒有 agent）`);
      }
      if (!unitsDatabase.some((unit) => unit.agent?.ruleFallback.some((rule) => rule.action === 'trigger_event' && rule.eventId === event.id))) {
        issues.push(`${label}: 沒有任何重要角色的規則後備會觸發此事件`);
      }
    } else if (event.agentUnitIds !== undefined) issues.push(`${label}: 只有觸發方式為 agent 的事件可設定 agentUnitIds`);
    if (event.trigger === 'stuck') {
      if (!storyData.acts.some((act) => act.stuckEventId === event.id)) issues.push(`${label}: 卡死保底事件沒有任何幕引用`);
      // 保底事件必須在玩家身處何處都能觸發。
      if (event.requires?.mapIds?.length) issues.push(`${label}: 卡死保底事件不可限制發生地點`);
    }
    if (event.trigger === 'storylet' && !storyletsDatabase.some((storylet) => storylet.onComplete?.eventIds?.includes(event.id))) {
      issues.push(`${label}: 劇情片段觸發的事件沒有任何片段引用`);
    }
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
      const sharedMap = mapsDatabase.some((map) => isUnitListedOnMap(map, unit.id) && isUnitListedOnMap(map, unit.occupation!.byUnitId));
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

  if (typeof scenario.rules?.residentKillGrantsExp !== 'boolean') issues.push(`劇本 ${scenario.id}: rules.residentKillGrantsExp 須為布林值`);
  const maxSegments = scenario.rules?.routeTravel?.maxSegmentsPerAction;
  if (!Number.isInteger(maxSegments) || maxSegments < 1) issues.push(`劇本 ${scenario.id}: rules.routeTravel.maxSegmentsPerAction 須為正整數`);
  if (scenario.succession) {
    const ratio = scenario.succession.reputationInheritRatio;
    if (!scenario.succession.relatedLabel?.trim()) issues.push(`劇本 ${scenario.id}: succession.relatedLabel 不可為空`);
    if (!(Number.isFinite(ratio) && ratio > 0 && ratio <= 1)) issues.push(`劇本 ${scenario.id}: succession.reputationInheritRatio 須介於 0（不含）與 1 之間`);
  }
  return issues;
}

/** 驗證任務範本：ID 唯一、類型、數量與報酬上限、發布者限制與條件的參照。 */
export function validateQuestTemplateData(): string[] {
  const issues: string[] = [];
  const { limits } = questTemplateData;
  for (const key of ['maxOpenQuests', 'maxOpenPerGiver', 'giverCooldownDays', 'maxOpenPerTarget', 'targetCooldownDays'] as const) {
    if (!Number.isInteger(limits?.[key]) || limits[key] < (key.endsWith('CooldownDays') ? 0 : 1)) issues.push(`任務範本上限 ${key} 無效`);
  }
  const isPositiveInteger = (value: unknown) => Number.isInteger(value) && (value as number) > 0;
  const seen = new Set<string>();
  for (const template of questTemplatesDatabase) {
    const label = `任務範本 ${template.id}`;
    if (!/^QTPL-\d{3,}$/.test(template.id)) issues.push(`${label}: ID 格式應為 QTPL-xxx`);
    if (seen.has(template.id)) issues.push(`任務範本 ID 重複：${template.id}`);
    seen.add(template.id);
    if (!['defeat', 'collect'].includes(template.type)) issues.push(`${label}: 無效類型 ${template.type}`);
    if (!template.name?.trim() || !template.titlePattern?.trim() || !template.objectivePattern?.trim()) issues.push(`${label}: 缺少名稱、標題或目標格式`);
    if (!template.objectivePattern?.includes('{quantity}') || !template.objectivePattern.includes('{target}')) issues.push(`${label}: 目標格式須包含 {quantity} 與 {target}`);
    if (!template.aiHint?.trim()) issues.push(`${label}: 需說明使用時機（aiHint）`);
    if (!isPositiveInteger(template.quantity?.min) || !isPositiveInteger(template.quantity?.max) || template.quantity.min > template.quantity.max) issues.push(`${label}: 數量範圍無效`);
    if (!isPositiveInteger(template.durationDays)) issues.push(`${label}: 期限天數須為正整數`);
    const reward = template.reward;
    if (!(Number.isFinite(reward?.expRatio) && reward.expRatio >= 0 && reward.expRatio <= 2)) issues.push(`${label}: expRatio 須介於 0 與 2 之間`);
    for (const key of ['maxExp', 'valuePerLevel', 'maxValue', 'maxItemQuantity'] as const) {
      if (!Number.isInteger(reward?.[key]) || reward[key] < 0) issues.push(`${label}: reward.${key} 須為非負整數`);
    }
    for (const factionId of template.giver?.factionIds ?? []) {
      if (!getFactionById(factionId)) issues.push(`${label}: 找不到發布者勢力 ${factionId}`);
    }
    for (const classId of template.giver?.classIds ?? []) {
      if (!getCharacterClassById(classId)) issues.push(`${label}: 找不到發布者職階 ${classId}`);
    }
    validateFactionConditions(label, template.requires ?? {}, issues);
    for (const flag of [...(template.requires?.flags ?? []), ...(template.excludes?.flags ?? [])]) {
      if (typeof flag !== 'string' || !flag.trim()) issues.push(`${label}: 旗標名稱無效`);
    }
  }
  return issues;
}

const STORYLET_CHANNELS = ['notice_board', 'letter', 'relic', 'none'];
const MAP_FACILITIES: MapFacility[] = ['notice_board'];

/**
 * 驗證主線資料（O31、O32）：幕與片段的 ID、參照、條件、目標與完成效果；
 * 每一幕有且只有一個預設片段，且預設片段只靠保底管道給予、不依賴任何單位存活；
 * 最後一幕以外，預設片段必須推進幕、且有卡死保底事件；最後一幕的預設片段必須進入結局（O33）；片段用到的旗標都要有設定來源；主線節點要有保底管道；結局都要有進入方式。
 */
export function validateStoryData(): string[] {
  const issues: string[] = [];
  const { rules, acts, storylets } = storyData;
  for (const key of ['maxActiveStorylets', 'maxStartsPerTurn', 'maxCandidatesForAI'] as const) {
    if (!Number.isInteger(rules?.[key]) || rules[key] < 1) issues.push(`主線規則 ${key} 須為正整數`);
  }
  if (!Number.isInteger(rules?.stuckGraceMinutes) || rules.stuckGraceMinutes < 0) issues.push('主線規則 stuckGraceMinutes 須為 0 以上的整數');
  if (!acts.length) issues.push('主線至少需要一幕');
  const lastActId = storyActs[storyActs.length - 1]?.id;
  const actIds = new Set<string>();
  for (const act of acts) {
    const label = `幕 ${act.id}`;
    if (!/^ACT-\d+$/.test(act.id)) issues.push(`${label}: ID 格式應為 ACT-n`);
    if (actIds.has(act.id)) issues.push(`幕 ID 重複：${act.id}`);
    actIds.add(act.id);
    if (!act.title?.trim() || !act.goal?.trim()) issues.push(`${label}: 缺少標題或幕目標`);
    if (!Number.isInteger(act.order)) issues.push(`${label}: 順序須為整數`);
    const defaults = storylets.filter((storylet) => storylet.actId === act.id && storylet.isDefault);
    if (defaults.length !== 1) issues.push(`${label}: 必須有且只有一個預設片段（目前 ${defaults.length} 個）`);
    const declared = getStoryletById(act.defaultStoryletId);
    if (!declared || declared.actId !== act.id || !declared.isDefault) issues.push(`${label}: 預設片段 ${act.defaultStoryletId} 不存在、不屬於本幕或未標為預設`);
    if (act.id !== lastActId) {
      // 卡死保底最後會強制完成預設片段，預設片段因此必須能單獨完成本幕。
      if (declared && !declared.onComplete?.advanceAct) issues.push(`${label}: 預設片段必須推進下一幕（卡死保底會強制完成它）`);
      if (!act.stuckEventId) issues.push(`${label}: 缺少卡死保底事件（stuckEventId）`);
    }
    if (act.stuckEventId !== undefined && getEventById(act.stuckEventId)?.trigger !== 'stuck') issues.push(`${label}: 卡死保底事件 ${act.stuckEventId} 不存在或觸發方式不是 stuck`);
    // 最後一幕的卡死保底同樣會強制完成預設片段，預設片段因此必須進入結局（O33）。
    if (act.id === lastActId && declared && !declared.onComplete?.endingId) issues.push(`${label}: 最後一幕的預設片段必須進入結局（endingId，卡死保底會強制完成它）`);
    if (act.deadline !== undefined) {
      if (!Number.isInteger(act.deadline.days) || act.deadline.days < 1) issues.push(`${label}: 期限天數須為正整數`);
      if (!getStoryEndingById(act.deadline.endingId)) issues.push(`${label}: 期限結局 ${act.deadline.endingId} 不存在`);
    }
  }
  if (new Set(acts.map((act) => act.order)).size !== acts.length) issues.push('幕的順序不可重複');

  const unitExists = (id: string) => unitTemplatesDatabase().some((unit) => unit.id === id);
  const isResident = (id: string) => { const unit = getUnitTemplateById(id); return !!unit && !unit.requiresEncounter; };
  const isFlag = (flag: unknown) => typeof flag === 'string' && !!flag.trim();
  // 旗標的設定來源：事件效果與片段完成效果。
  const flagSources = new Set([...eventsDatabase.flatMap((event) => event.effects?.setFlags ?? []), ...storylets.flatMap((storylet) => storylet.onComplete?.setFlags ?? [])]);
  // 其他片段的進入條件或目標用到的旗標：設定這些旗標的片段是主線節點。
  const flagsUsedByStory = new Set(storylets.flatMap((storylet) => [
    ...(storylet.requires?.flags ?? []),
    ...(storylet.goal?.type === 'flagSet' ? [storylet.goal.flag] : storylet.goal?.orFlag ? [storylet.goal.orFlag] : [])
  ]));
  const seen = new Set<string>();
  for (const storylet of storylets) {
    const label = `劇情片段 ${storylet.id}`;
    if (!/^STORY-\d+-\d{2,}$/.test(storylet.id)) issues.push(`${label}: ID 格式應為 STORY-幕-編號（例如 STORY-1-01）`);
    if (seen.has(storylet.id)) issues.push(`劇情片段 ID 重複：${storylet.id}`);
    seen.add(storylet.id);
    if (!actIds.has(storylet.actId)) issues.push(`${label}: 找不到所屬幕 ${storylet.actId}`);
    if (!storylet.title?.trim()) issues.push(`${label}: 缺少標題`);
    if (!Number.isInteger(storylet.priority) || storylet.priority < 0 || storylet.priority > 100) issues.push(`${label}: 優先度須為 0–100 的整數`);

    const requires = storylet.requires ?? {};
    validateFactionConditions(label, requires, issues);
    for (const unitId of [...(requires.unitsAlive ?? []), ...(requires.unitsDead ?? [])]) {
      if (!unitExists(unitId)) issues.push(`${label}: 找不到單位 ${unitId}`);
    }
    for (const mapId of requires.mapIds ?? []) {
      if (!getMapById(mapId)) issues.push(`${label}: 找不到地圖 ${mapId}`);
    }
    for (const flag of [...(requires.flags ?? []), ...(storylet.excludes?.flags ?? []), ...(storylet.onComplete?.setFlags ?? [])]) {
      if (!isFlag(flag)) issues.push(`${label}: 旗標名稱無效`);
    }

    const giver = storylet.giver;
    if (!giver || !STORYLET_CHANNELS.includes(giver.fallback)) issues.push(`${label}: 保底管道須為 notice_board、letter、relic 或 none`);
    else {
      if (giver.fallback === 'relic') issues.push(`${label}: 遺物管道需要死亡遺物（O26），目前尚未支援`);
      if (giver.preferredUnitId !== undefined && !isResident(giver.preferredUnitId)) issues.push(`${label}: 首選給予者 ${giver.preferredUnitId} 必須是地區居民`);
      for (const classId of giver.role?.classIds ?? []) {
        if (!getCharacterClassById(classId)) issues.push(`${label}: 找不到給予者職階 ${classId}`);
      }
      for (const factionId of giver.role?.factionIds ?? []) {
        if (!getFactionById(factionId)) issues.push(`${label}: 找不到給予者勢力 ${factionId}`);
      }
      if (giver.role?.minLevel !== undefined && !(Number.isInteger(giver.role.minLevel) && giver.role.minLevel >= 1)) issues.push(`${label}: 給予者最低等級須為正整數`);
      if (giver.scope !== undefined && !['map', 'world'].includes(giver.scope)) issues.push(`${label}: 接手範圍須為 map 或 world`);
      if (!giver.preferredUnitId && !giver.role && giver.fallback === 'none') issues.push(`${label}: 沒有首選給予者、角色條件或保底管道，永遠無法開始`);
      const isMainNode = !!storylet.onComplete?.advanceAct || !!storylet.onComplete?.endingId || (storylet.onComplete?.setFlags ?? []).some((flag) => flagsUsedByStory.has(flag));
      if (isMainNode && giver.fallback === 'none') issues.push(`${label}: 主線節點（推進幕或設定其他片段需要的旗標）必須有保底管道`);
      if (giver.fallback === 'notice_board') {
        const locations = requires.mapIds?.length ? requires.mapIds : mapsDatabase.map((map) => map.id);
        if (!locations.some((mapId) => getMapById(mapId)?.facilities?.includes('notice_board'))) issues.push(`${label}: 保底管道是告示板，但發生地點沒有告示板`);
      }
    }
    for (const flag of [...(requires.flags ?? []), ...(storylet.goal?.type === 'flagSet' ? [storylet.goal.flag] : storylet.goal?.orFlag ? [storylet.goal.orFlag] : [])]) {
      if (isFlag(flag) && !flagSources.has(flag)) issues.push(`${label}: 旗標「${flag}」沒有任何事件或片段會設定`);
    }

    const goal = storylet.goal;
    if (!goal?.summary?.trim()) issues.push(`${label}: 目標缺少說明`);
    if (goal?.type === 'threatRemoved') {
      if (!goal.unitIds?.length) issues.push(`${label}: 威脅消除目標須列出單位`);
      for (const unitId of goal.unitIds ?? []) {
        const unit = getUnitTemplateById(unitId);
        if (!unit) issues.push(`${label}: 找不到目標單位 ${unitId}`);
        // 族群樣板會重生，無法以死亡判定威脅消除；需改用事件設定旗標（例如據點消滅）。
        else if (unit.population) issues.push(`${label}: 目標單位 ${unitId} 是族群樣板，請改用旗標目標`);
      }
    } else if (goal?.type === 'locationReached') {
      if (!getMapById(goal.mapId)) issues.push(`${label}: 找不到目標地圖 ${goal.mapId}`);
    } else if (goal?.type === 'flagSet') {
      if (!isFlag(goal.flag)) issues.push(`${label}: 目標旗標名稱無效`);
    } else issues.push(`${label}: 無效的目標類型 ${(goal as { type?: string } | undefined)?.type}`);
    if ((goal?.type === 'threatRemoved' || goal?.type === 'locationReached') && goal.orFlag !== undefined && !isFlag(goal.orFlag)) issues.push(`${label}: 「或旗標成立」的旗標名稱無效`);

    const onComplete = storylet.onComplete;
    if (!onComplete?.summary?.trim()) issues.push(`${label}: 缺少完成描述`);
    if (onComplete?.knownBy !== undefined && !['witnesses', 'faction', 'region', 'world'].includes(onComplete.knownBy)) issues.push(`${label}: 無效的完成傳播範圍 ${onComplete.knownBy}`);
    if (onComplete?.knownBy === 'faction') issues.push(`${label}: 完成描述的傳播範圍不支援同勢力`);
    for (const eventId of onComplete?.eventIds ?? []) {
      const event = getEventById(eventId);
      if (!event) issues.push(`${label}: 找不到完成事件 ${eventId}`);
      else if (event.trigger !== 'storylet') issues.push(`${label}: 完成事件 ${eventId} 的觸發方式須為 storylet`);
    }
    for (const [key, value] of Object.entries(onComplete?.endingTraits ?? {})) {
      if (!key.trim() || typeof value !== 'string' || !value.trim()) issues.push(`${label}: 結局特徵須為「項目: 值」的文字`);
    }
    if (onComplete?.advanceAct && storylet.actId === lastActId) issues.push(`${label}: 最後一幕不可推進下一幕，請改用結局（endingId）`);
    if (onComplete?.endingId !== undefined) {
      if (!getStoryEndingById(onComplete.endingId)) issues.push(`${label}: 找不到結局 ${onComplete.endingId}`);
      if (onComplete.advanceAct) issues.push(`${label}: 推進幕與進入結局只能擇一`);
    }

    const scene = storylet.scene;
    if (!scene?.purpose?.trim() || !Array.isArray(scene.mustConvey) || !Array.isArray(scene.forbidden)) issues.push(`${label}: 演出要求須有場面目的、必須傳達的資訊與禁止事項`);

    if (storylet.isDefault) {
      if (giver?.preferredUnitId || giver?.role) issues.push(`${label}: 預設片段只能由保底管道給予，不可指定給予者`);
      if (giver?.fallback === 'none') issues.push(`${label}: 預設片段的保底管道不可為「無」`);
      if (requires.unitsAlive?.length) issues.push(`${label}: 預設片段不可依賴任何單位存活`);
    }
  }

  // 結局（O33）：ID、標題、結局後走向、尾聲段落條件；每個結局都要有進入方式（片段或幕期限）。
  const endingIds = new Set<string>();
  for (const ending of storyData.endings ?? []) {
    const label = `結局 ${ending.id}`;
    if (!/^END-\d+$/.test(ending.id)) issues.push(`${label}: ID 格式應為 END-n`);
    if (endingIds.has(ending.id)) issues.push(`結局 ID 重複：${ending.id}`);
    endingIds.add(ending.id);
    if (!ending.title?.trim() || !ending.summary?.trim()) issues.push(`${label}: 缺少標題或結果描述`);
    if (!['continue', 'end'].includes(ending.afterEnding)) issues.push(`${label}: 結局後走向須為 continue 或 end`);
    if (!Array.isArray(ending.epilogues) || !ending.epilogues.length) issues.push(`${label}: 至少需要一段尾聲`);
    for (const [index, epilogue] of (ending.epilogues ?? []).entries()) {
      const where = `${label} 尾聲第 ${index + 1} 段`;
      if (!epilogue.text?.trim()) issues.push(`${where}: 缺少文字`);
      const when = epilogue.when ?? {};
      for (const unitId of [...(when.unitsAlive ?? []), ...(when.unitsDead ?? [])]) {
        if (!unitExists(unitId)) issues.push(`${where}: 找不到單位 ${unitId}`);
      }
      for (const flag of [...(when.flags ?? []), ...(when.excludesFlags ?? [])]) {
        if (!isFlag(flag)) issues.push(`${where}: 旗標名稱無效`);
        else if (!flagSources.has(flag)) issues.push(`${where}: 旗標「${flag}」沒有任何事件或片段會設定`);
      }
      for (const [key, value] of Object.entries(when.traits ?? {})) {
        if (!key.trim() || typeof value !== 'string' || !value.trim()) issues.push(`${where}: 結局特徵條件須為「項目: 值」的文字`);
      }
    }
    const entered = storylets.some((storylet) => storylet.onComplete?.endingId === ending.id) || acts.some((act) => act.deadline?.endingId === ending.id);
    if (!entered) issues.push(`${label}: 沒有任何劇情片段或幕期限會進入此結局`);
  }
  return issues;
}

/**
 * 驗證重要角色（O34）：決策規則的數值、角色的盤算與個性、規則後備的行動與參照、接手人選。
 * 規則後備的最後一條必須是沒有條件的 idle，保證每天都有合法行動。
 */
export function validateAgentData(): string[] {
  const issues: string[] = [];
  if (!Number.isInteger(agentRules.maxCatchUpDays) || agentRules.maxCatchUpDays < 1) issues.push('重要角色規則 maxCatchUpDays 須為正整數');
  for (const action of AGENT_ACTION_TYPES) {
    const rule = agentRules.actions?.[action];
    if (!rule || !rule.label?.trim() || !Number.isInteger(rule.cooldownDays) || rule.cooldownDays < 0) issues.push(`重要角色規則 actions.${action} 須有名稱與 0 以上的整數冷卻`);
  }
  for (const unit of unitsDatabase) {
    const agent = unit.agent;
    if (!agent) continue;
    const label = `重要角色 ${unit.id}`;
    if (unit.population) issues.push(`${label}: 族群樣板不可是重要角色`);
    if (!agent.goals?.length || agent.goals.some((goal) => !goal?.trim())) issues.push(`${label}: 至少需要一項盤算（goals）`);
    if (!agent.traits?.length || agent.traits.some((trait) => !trait?.trim())) issues.push(`${label}: 至少需要一項個性（traits）`);
    if (agent.leaderOf !== undefined && (!getFactionById(agent.leaderOf) || agent.leaderOf !== unit.factionId)) issues.push(`${label}: leaderOf 須為自己所屬的勢力`);
    for (const successorId of agent.successors ?? []) {
      const successor = getUnitTemplateById(successorId);
      if (!successor || successor.requiresEncounter || successorId === unit.id) issues.push(`${label}: 接手人選 ${successorId} 須為其他地區居民`);
    }
    const rules = agent.ruleFallback ?? [];
    const last = rules[rules.length - 1];
    if (!last || last.action !== 'idle' || last.when) issues.push(`${label}: 規則後備的最後一條必須是沒有條件的 idle`);
    for (const [index, rule] of rules.entries()) {
      const where = `${label} 規則後備第 ${index + 1} 條`;
      if (!AGENT_ACTION_TYPES.includes(rule.action)) issues.push(`${where}: 無效行動 ${rule.action}`);
      if (!rule.intent?.trim()) issues.push(`${where}: 缺少動機（intent）`);
      const when = rule.when ?? {};
      validateFactionConditions(where, when, issues);
      for (const unitId of when.knownDeaths ?? []) {
        if (!getUnitTemplateById(unitId)) issues.push(`${where}: 找不到單位 ${unitId}`);
      }
      for (const eventId of when.knownEvents ?? []) {
        if (!getEventById(eventId)) issues.push(`${where}: 找不到事件 ${eventId}`);
      }
      if (rule.action === 'post_quest') {
        const template = rule.templateId ? getQuestTemplateById(rule.templateId) : undefined;
        if (!template) issues.push(`${where}: 找不到任務範本 ${rule.templateId}`);
        if (unit.requiresEncounter || !unit.factionId) issues.push(`${where}: 只有屬於勢力的地區居民可以發布委託`);
        if (template && rule.quantity !== undefined && !(Number.isInteger(rule.quantity) && rule.quantity >= template.quantity.min && rule.quantity <= template.quantity.max)) issues.push(`${where}: 數量超出範本範圍`);
      }
      if (rule.action === 'trigger_event') {
        const event = rule.eventId ? getEventById(rule.eventId) : undefined;
        if (!event || event.trigger !== 'agent') issues.push(`${where}: 事件 ${rule.eventId} 不存在或觸發方式不是 agent`);
        else if (!event.agentUnitIds?.includes(unit.id)) issues.push(`${where}: 事件 ${event.id} 的 agentUnitIds 沒有列出 ${unit.id}`);
      }
      if (rule.action === 'change_faction_relation') {
        if (!agent.leaderOf) issues.push(`${where}: 只有勢力領袖（leaderOf）可以改變勢力關係`);
        if (!rule.factionId || !getFactionById(rule.factionId) || rule.factionId === agent.leaderOf) issues.push(`${where}: 對象勢力 ${rule.factionId} 無效`);
        if (!['worse', 'better'].includes(String(rule.direction))) issues.push(`${where}: direction 須為 worse 或 better`);
        if (rule.until !== undefined && !FACTION_RELATION_STATUSES.includes(rule.until)) issues.push(`${where}: until 不是有效的勢力關係`);
      }
    }
  }
  return issues;
}

/** 全部靜態資料驗證；建置前由 scripts/validate-data.mjs 執行，有錯誤即中止建置。 */
export const validateGameData = (): string[] => [...validateGrowthData(), ...validateWorldUnitData(), ...validateEventData(), ...validateFactionData(), ...validateQuestTemplateData(), ...validateStoryData(), ...validateAgentData()];
