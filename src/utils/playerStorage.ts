import type { GeneratedQuest, PlayerState, StoryMessage, StoryState, UnitMemoryNote, WorldEvent, WorldModifier, WorldRuntimeState } from '../types/game';
import { clampReputation, createDefaultUnitInstance, createInitialReputation, FACTION_RELATION_STATUSES, factionData, getBaseExpForLevel, getEventById, getCharacterClassById, getFactionById, getItemById, getMapById, getPlayerResourceCaps, getQuestTemplateById, getSpeciesById, getStoryActById, getStoryEndingById, getStoryletById, getUnitAbilities, getUnitLevelCap, getWorldUnitById, MAX_UNIT_LEVEL, PLAYER_UNIT_ID, scenario, unitTemplatesDatabase } from '../data/staticData';
import { isValidGameTime } from './gameTime';
import { isValidSpeciesClassCombo, UNIT_STAT_KEYS } from './unitGrowth';
import { createCombat } from './combatState';
import { parseModifierScope } from './worldModifiers';
import { findQuest } from './questRules';

/** 存檔內容驗證：拒絕無效 ID、數值範圍與不在場的戰鬥目標；存檔的讀寫見 saveStorage.ts。 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const EVENT_TYPES = ['unit_death', 'unit_respawn', 'unit_occupation', 'quest_failed', 'quest_transferred', 'reputation_change', 'scenario_event', 'story_progress'];
const KNOWN_BY = ['witnesses', 'faction', 'region', 'world'];
const DEATH_CAUSES = ['combat', 'self_inflicted', 'misadventure', 'unknown'];

function isWorldEvent(value: unknown): value is WorldEvent {
  if (!isRecord(value) || typeof value.id !== 'string' || !EVENT_TYPES.includes(String(value.type)) || !isValidGameTime(value.gameTimeMinutes) ||
      typeof value.mapId !== 'string' || typeof value.summary !== 'string' || (value.detail !== undefined && typeof value.detail !== 'string') ||
      !KNOWN_BY.includes(String(value.knownBy)) || !isStringArray(value.witnessUnitIds) || !isStringArray(value.awareFactionIds) || typeof value.cause !== 'string' ||
      (value.eventId !== undefined && typeof value.eventId !== 'string') || (value.sourceEventId !== undefined && typeof value.sourceEventId !== 'string') ||
      (value.characterSeq !== undefined && (!Number.isSafeInteger(value.characterSeq) || (value.characterSeq as number) < 1))) return false;
  if (value.reputationChanges !== undefined && !(Array.isArray(value.reputationChanges) && value.reputationChanges.every((change) =>
    isRecord(change) && typeof change.factionId === 'string' && Number.isInteger(change.change)))) return false;
  if (value.death !== undefined) {
    const death = value.death;
    if (!isRecord(death) || typeof death.victimUnitId !== 'string' || typeof death.victimName !== 'string' || !DEATH_CAUSES.includes(String(death.cause)) ||
        (death.killerUnitId !== undefined && typeof death.killerUnitId !== 'string') || (death.killerName !== undefined && typeof death.killerName !== 'string')) return false;
  }
  return value.changes === undefined || (isRecord(value.changes) &&
    Object.values(value.changes).every((entry) => isStringArray(entry)));
}

function isWorldModifier(value: unknown): value is WorldModifier {
  return isRecord(value) && typeof value.id === 'string' && typeof value.scope === 'string' && !!parseModifierScope(value.scope) &&
    UNIT_STAT_KEYS.includes(value.stat as never) && (value.op === 'add' || value.op === 'multiply') && Number.isFinite(value.value) &&
    typeof value.sourceEventId === 'string' && (value.expiresAtMinutes === undefined || isValidGameTime(value.expiresAtMinutes));
}

const isItemStackList = (value: unknown): value is { itemId: string; quantity: number }[] => Array.isArray(value) && value.every((entry) =>
  isRecord(entry) && typeof entry.itemId === 'string' && !!getItemById(entry.itemId) && Number.isInteger(entry.quantity) && (entry.quantity as number) > 0);

/** 生成委託：格式錯誤即整份拒絕；引用的範本、委託人或目標已從靜態資料移除時回傳 undefined（略過該委託）。 */
function normalizeGeneratedQuest(value: unknown): GeneratedQuest | null | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^QST-GEN-\d{4,}$/.test(value.id) || value.generated !== true ||
      typeof value.templateId !== 'string' || typeof value.targetUnitId !== 'string' || typeof value.title !== 'string' ||
      typeof value.questGiverId !== 'string' || typeof value.questGiver !== 'string' || typeof value.mapId !== 'string' || typeof value.objective !== 'string' ||
      !['open', 'completed', 'failed', 'expired'].includes(String(value.status)) || !isValidGameTime(value.postedAtMinutes) || !isValidGameTime(value.expiresAtMinutes) ||
      (value.closedAtMinutes !== undefined && !isValidGameTime(value.closedAtMinutes)) ||
      !isRecord(value.requirements) || !isRecord(value.rewards) || !Number.isSafeInteger(value.rewards.exp) || (value.rewards.exp as number) < 0 ||
      !Number.isSafeInteger(value.rewards.gold) || (value.rewards.gold as number) < 0 || !(value.rewards.items === undefined || Array.isArray(value.rewards.items))) return null;
  const requirements = value.requirements;
  const defeats = requirements.defeatUnits;
  const collects = requirements.collectItems;
  if ((defeats !== undefined && !(Array.isArray(defeats) && defeats.every((entry) => isRecord(entry) && typeof entry.unitId === 'string' && Number.isInteger(entry.quantity) && (entry.quantity as number) > 0))) ||
      (collects !== undefined && !Array.isArray(collects))) return null;
  if (!getQuestTemplateById(value.templateId) || !isResidentUnitId(value.questGiverId) || getWorldUnitById(value.targetUnitId)?.requiresEncounter !== true ||
      !getMapById(value.mapId) || (defeats ?? []).some((entry) => getWorldUnitById(String((entry as Record<string, unknown>).unitId))?.requiresEncounter !== true) ||
      (collects !== undefined && !isItemStackList(collects)) || (value.rewards.items !== undefined && !isItemStackList(value.rewards.items))) return undefined;
  return value as unknown as GeneratedQuest;
}

const STORYLET_CHANNELS = ['notice_board', 'letter', 'relic', 'none'];

/** 主線進度：格式錯誤、目前幕或已達成的結局已從靜態資料移除時整份拒絕；已移除的片段略過。 */
function normalizeStoryState(value: unknown): StoryState | null {
  if (!isRecord(value) || typeof value.currentActId !== 'string' || !getStoryActById(value.currentActId) ||
      !Array.isArray(value.activeStorylets) || !Array.isArray(value.completedStorylets) || !isRecord(value.endingTraits) ||
      !Object.values(value.endingTraits).every((trait) => typeof trait === 'string')) return null;
  if (!value.activeStorylets.every((entry) => isRecord(entry) && typeof entry.id === 'string' && isValidGameTime(entry.startedAtMinutes) &&
      (entry.giverUnitId === undefined || typeof entry.giverUnitId === 'string') &&
      (entry.giverChannel === undefined || STORYLET_CHANNELS.includes(String(entry.giverChannel))))) return null;
  if (!value.completedStorylets.every((entry) => isRecord(entry) && typeof entry.id === 'string' && isValidGameTime(entry.completedAtMinutes) &&
      typeof entry.wasActive === 'boolean' && (entry.forced === undefined || entry.forced === true))) return null;
  if (value.stuckSinceMinutes !== undefined && !isValidGameTime(value.stuckSinceMinutes)) return null;
  if (!isValidGameTime(value.actStartedAtMinutes)) return null;
  const ending = value.ending;
  if (ending !== undefined && !(isRecord(ending) && typeof ending.id === 'string' && isValidGameTime(ending.reachedAtMinutes) &&
      Array.isArray(ending.epilogueIndexes) && ending.epilogueIndexes.every((index) => Number.isInteger(index) && (index as number) >= 0))) return null;
  const endingStatic = isRecord(ending) ? getStoryEndingById(String(ending.id)) : undefined;
  if (ending !== undefined && !endingStatic) return null;
  return {
    currentActId: value.currentActId,
    activeStorylets: (value.activeStorylets as StoryState['activeStorylets']).filter((entry) => !!getStoryletById(entry.id)),
    completedStorylets: (value.completedStorylets as StoryState['completedStorylets']).filter((entry) => !!getStoryletById(entry.id)),
    endingTraits: value.endingTraits as Record<string, string>,
    actStartedAtMinutes: value.actStartedAtMinutes,
    ...(value.stuckSinceMinutes !== undefined ? { stuckSinceMinutes: value.stuckSinceMinutes as number } : {}),
    ...(isRecord(ending) && endingStatic ? { ending: {
      id: endingStatic.id, reachedAtMinutes: ending.reachedAtMinutes as number,
      // 靜態資料的尾聲段落減少時，略過已不存在的段落。
      epilogueIndexes: (ending.epilogueIndexes as number[]).filter((index) => index < endingStatic.epilogues.length)
    } } : {})
  };
}

/** 驗證世界狀態；任何部分無效即整份拒絕（與其他存檔欄位一致，不部分載入）。 */
function normalizeWorldState(value: unknown): WorldRuntimeState | null {
  if (!isRecord(value) || !Array.isArray(value.events) || !value.events.every(isWorldEvent) || !isStringArray(value.chronicle) ||
      !Number.isSafeInteger(value.nextEventSeq) || (value.nextEventSeq as number) < 1 ||
      !Array.isArray(value.modifiers) || !value.modifiers.every(isWorldModifier) || !isStringArray(value.firedEventIds) || !isRecord(value.regions) ||
      !isRecord(value.factionRelations) || !Array.isArray(value.generatedQuests) ||
      !Number.isSafeInteger(value.nextGeneratedQuestSeq) || (value.nextGeneratedQuestSeq as number) < 1 || !isRecord(value.unitMemories)) return null;
  const story = normalizeStoryState(value.story);
  if (!story) return null;
  const generatedQuests: GeneratedQuest[] = [];
  for (const entry of value.generatedQuests) {
    const quest = normalizeGeneratedQuest(entry);
    if (quest === null) return null;
    if (quest) generatedQuests.push(quest);
  }
  const regions: WorldRuntimeState['regions'] = {};
  for (const [mapId, region] of Object.entries(value.regions)) {
    if (!getMapById(mapId) || !isRecord(region) || !Number.isSafeInteger(region.lastRestockDay)) return null;
    regions[mapId] = { lastRestockDay: region.lastRestockDay as number };
  }
  // 勢力關係：靜態資料移除的勢力或附加關係略過，其餘格式錯誤即整份拒絕。
  const factionRelations: WorldRuntimeState['factionRelations'] = {};
  for (const [key, relation] of Object.entries(value.factionRelations)) {
    if (!isRecord(relation) || !FACTION_RELATION_STATUSES.includes(relation.status as never) || !isStringArray(relation.tags)) return null;
    const [a, b] = key.split('|');
    if (!a || !b || !getFactionById(a) || !getFactionById(b)) continue;
    factionRelations[key] = {
      status: relation.status as WorldRuntimeState['factionRelations'][string]['status'],
      tags: relation.tags.filter((tag) => factionData.relationTags.some((entry) => entry.id === tag))
    };
  }
  // 人物記憶：靜態資料移除的單位略過，其餘格式錯誤即整份拒絕。
  const unitMemories: WorldRuntimeState['unitMemories'] = {};
  for (const [unitId, notes] of Object.entries(value.unitMemories)) {
    if (!Array.isArray(notes) || !notes.every((entry) => isRecord(entry) && typeof entry.note === 'string' &&
      Number.isSafeInteger(entry.gameTimeMinutes) && Number.isSafeInteger(entry.characterSeq))) return null;
    if (!isKnownUnitId(unitId)) continue;
    unitMemories[unitId] = notes as UnitMemoryNote[];
  }
  return {
    events: value.events as WorldEvent[],
    chronicle: value.chronicle,
    nextEventSeq: value.nextEventSeq as number,
    modifiers: value.modifiers as WorldModifier[],
    // 靜態資料移除的事件不再視為已觸發。
    firedEventIds: value.firedEventIds.filter((eventId) => !!getEventById(eventId)),
    regions,
    factionRelations,
    generatedQuests,
    nextGeneratedQuestSeq: value.nextGeneratedQuestSeq as number,
    unitMemories,
    story
  };
}

const isKnownUnitId = (unitId: string): boolean => !!getWorldUnitById(unitId);
const isResidentUnitId = (unitId: string): boolean => { const unit = getWorldUnitById(unitId); return !!unit && !unit.requiresEncounter; };

export function normalizePlayerState(value: unknown): PlayerState | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim() ||
      !Number.isInteger(value.level) || (value.level as number) < 1 ||
      !Number.isFinite(value.exp) || (value.exp as number) < 0 ||
      !Number.isFinite(value.hp) || !Number.isFinite(value.mp) ||
      !Number.isFinite(value.gold) || (value.gold as number) < 0 ||
      typeof value.currentMapId !== 'string' || !getMapById(value.currentMapId) ||
      !Array.isArray(value.inventory) || !isRecord(value.equipped) ||
      !isRecord(value.storyFlags) || !Object.values(value.storyFlags).every((flag) => typeof flag === 'boolean') ||
      !Array.isArray(value.activeQuests) || value.unitId !== PLAYER_UNIT_ID || typeof value.speciesId !== 'string' ||
      typeof value.setupComplete !== 'boolean' || !isValidGameTime(value.gameTimeMinutes) || !isRecord(value.unitInstances) ||
      !isRecord(value.abilities) || !Array.isArray(value.statusEffects) || !Array.isArray(value.transactionHistory) ||
      !isRecord(value.defeatedUnits) || !isRecord(value.unitDispositionOverrides) || !isRecord(value.factionReputation) ||
      !Number.isSafeInteger(value.characterSeq) || (value.characterSeq as number) < 1) return null;
  const world = normalizeWorldState(value.world);
  if (!world) return null;

  const classId = typeof value.classId === 'string' && getCharacterClassById(value.classId)?.playerSelectable ? value.classId : scenario.defaultPlayer.classId;
  // 種族不存在或與職階組合無效時回到劇本預設種族。
  const savedSpecies = typeof value.speciesId === 'string' ? getSpeciesById(value.speciesId) : undefined;
  const speciesId = savedSpecies && isValidSpeciesClassCombo(savedSpecies, getCharacterClassById(classId)) ? savedSpecies.id : scenario.defaultPlayer.speciesId;
  const level = Math.min(value.level as number, MAX_UNIT_LEVEL);
  // 靜態數值調整後，存檔的 HP/MP 可能略高於新上限；夾回上限而非整份存檔作廢。
  const resourceCaps = getPlayerResourceCaps({ speciesId, classId, level });
  const abilityKeys = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
  const savedAbilities = isRecord(value.abilities) ? value.abilities : {};
  const abilityDefaults = getUnitAbilities({ speciesId, classId })!;
  const abilities = Object.fromEntries(abilityKeys.map((key) => {
    const score = savedAbilities[key];
    return [key, Number.isInteger(score) && (score as number) >= 1 && (score as number) <= 30 ? score as number : abilityDefaults[key]];
  })) as unknown as typeof abilityDefaults;

  const inventory = value.inventory.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.itemId !== 'string' || !getItemById(entry.itemId) ||
        !Number.isInteger(entry.quantity) || (entry.quantity as number) <= 0) return [];
    return [{ itemId: entry.itemId, quantity: entry.quantity as number }];
  });
  const activeQuests = value.activeQuests.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.questId !== 'string' || !findQuest({ world }, entry.questId) ||
        !['in_progress', 'completed', 'failed'].includes(String(entry.status))) return [];
    const defeated: Record<string, number> = {};
    const savedDefeats = isRecord(entry.progress) && isRecord(entry.progress.defeatedUnits) ? entry.progress.defeatedUnits : {};
    for (const [unitId, count] of Object.entries(savedDefeats)) {
      if (isKnownUnitId(unitId) && Number.isInteger(count) && (count as number) >= 0) defeated[unitId] = count as number;
    }
    const giverUnitId = typeof entry.giverUnitId === 'string' && isResidentUnitId(entry.giverUnitId) ? entry.giverUnitId : undefined;
    return [{ questId: entry.questId, status: entry.status as 'in_progress' | 'completed' | 'failed', progress: { defeatedUnits: defeated }, ...(giverUnitId ? { giverUnitId } : {}) }];
  });
  const defeatedUnits: Record<string, number> = {};
  for (const [unitId, count] of Object.entries(value.defeatedUnits)) {
    if (isKnownUnitId(unitId) && Number.isInteger(count) && (count as number) >= 0) defeatedUnits[unitId] = count as number;
  }
  const unitDispositionOverrides: PlayerState['unitDispositionOverrides'] = {};
  if (isRecord(value.unitDispositionOverrides)) {
    for (const [unitId, disposition] of Object.entries(value.unitDispositionOverrides)) {
      if (getWorldUnitById(unitId) && ['friendly', 'neutral', 'hostile'].includes(String(disposition))) {
        unitDispositionOverrides[unitId] = disposition as PlayerState['unitDispositionOverrides'][string];
      }
    }
  }

  const equipped: PlayerState['equipped'] = {};
  for (const slot of ['weaponItemId', 'armorItemId', 'accessoryItemId'] as const) {
    const id = value.equipped[slot];
    if (typeof id === 'string' && getItemById(id)) equipped[slot] = id;
  }

  // 單位實例：靜態資料新增的單位在存檔中沒有實例，由樣板補上。
  const savedInstances = value.unitInstances as Record<string, unknown>;
  const unitInstances = Object.fromEntries(unitTemplatesDatabase().map((template) => {
    const savedState = savedInstances[template.id];
    const defaults = createDefaultUnitInstance(template);
    if (!isRecord(savedState)) return [template.id, defaults];
    const level = Number.isInteger(savedState.level) && (savedState.level as number) >= template.level &&
      (savedState.level as number) <= getUnitLevelCap(template.id) ? savedState.level as number : defaults.level;
    const exp = Number.isSafeInteger(savedState.exp) && (savedState.exp as number) >= getBaseExpForLevel(level)
      ? savedState.exp as number : getBaseExpForLevel(level);
    const maxHp = getWorldUnitById(template.id, { unitInstances: { [template.id]: { level } }, world })?.stats.hp ?? 1;
    const savedInventory = Array.isArray(savedState.inventory) ? savedState.inventory.flatMap((entry) =>
      isRecord(entry) && typeof entry.itemId === 'string' && getItemById(entry.itemId) &&
      Number.isInteger(entry.quantity) && (entry.quantity as number) > 0
        ? [{ itemId: entry.itemId, quantity: entry.quantity as number }]
        : []) : [];
    return [template.id, {
      level,
      exp,
      gold: Number.isSafeInteger(savedState.gold) && (savedState.gold as number) >= 0 ? savedState.gold as number : 0,
      inventory: savedInventory,
      currentHp: Number.isInteger(savedState.currentHp) && (savedState.currentHp as number) >= 0
        ? Math.min(savedState.currentHp as number, maxHp) : maxHp,
      isDead: savedState.isDead === true || savedState.currentHp === 0,
      ...(isValidGameTime(savedState.diedAtMinutes) ? { diedAtMinutes: savedState.diedAtMinutes } : {}),
      // 潛伏狀態只對潛伏樣板有效；佔領發生後即為一般實例。
      ...(savedState.isDormant === true && template.dormantUntilOccupation ? { isDormant: true } : {})
    }];
  })) as PlayerState['unitInstances'];

  let combat: PlayerState['combat'];
  if (value.combat !== undefined && value.combat !== null) {
    if (!isRecord(value.combat) || !Number.isInteger(value.combat.round) || (value.combat.round as number) < 1 || !Array.isArray(value.combat.participants)) return null;
    const savedEnemies = value.combat.participants.filter((participant) => isRecord(participant) && participant.side === 'enemy');
    const enemies: { unitId: string; currentHp: number }[] = [];
    for (const enemy of savedEnemies) {
      const unitId = isRecord(enemy) && typeof enemy.unitId === 'string' ? enemy.unitId : undefined;
      const unit = unitId ? getWorldUnitById(unitId, { unitInstances, world }) : undefined;
      const isPresent = !!unit && getMapById(value.currentMapId)?.unitsPresent.includes(unitId!);
      // 唯一個體的實例已死亡時不可仍在戰鬥中；族群樣板的個體以戰鬥狀態追蹤 HP。
      const savedUnitState = !!unit && !unit.population && isRecord(savedInstances[unitId!]) ? savedInstances[unitId!] as Record<string, unknown> : undefined;
      if (!isRecord(enemy) || !unitId || !unit || !isPresent || !Number.isInteger(enemy.currentHp) || (enemy.currentHp as number) <= 0 ||
          savedUnitState?.isDead === true || savedUnitState?.currentHp === 0) return null;
      enemies.push({ unitId, currentHp: Math.min(enemy.currentHp as number, unit.stats.hp) });
    }
    if (!enemies.length) return null;
    const savedTarget = value.combat.targetUnitId;
    const targetUnitId = typeof savedTarget === 'string' && enemies.some((enemy) => enemy.unitId === savedTarget) ? savedTarget : enemies[0].unitId;
    combat = { ...createCombat([PLAYER_UNIT_ID], enemies), round: value.combat.round as number, targetUnitId };
  }
  const previousMapId = typeof value.previousMapId === 'string' &&
    getMapById(value.currentMapId)?.connectedMapIds.includes(value.previousMapId)
    ? value.previousMapId
    : undefined;
  const savedEncounteredUnitId = typeof value.encounteredUnitId === 'string' ? value.encounteredUnitId : undefined;
  const encounteredUnit = typeof savedEncounteredUnitId === 'string' ? getWorldUnitById(savedEncounteredUnitId) : undefined;
  const encounteredUnitIsPresent = !!encounteredUnit && getMapById(value.currentMapId)?.unitsPresent.includes(savedEncounteredUnitId!);
  const savedEncounteredState = !!encounteredUnit && !encounteredUnit.population && isRecord(savedInstances[savedEncounteredUnitId!])
    ? savedInstances[savedEncounteredUnitId!] as Record<string, unknown> : undefined;
  const encounteredUnitId = typeof savedEncounteredUnitId === 'string' && encounteredUnit && encounteredUnitIsPresent &&
    savedEncounteredState?.isDead !== true && savedEncounteredState?.currentHp !== 0
    ? savedEncounteredUnitId
    : undefined;
  // 聲望：缺少的勢力（靜態資料新增）補初始值，數值夾在範圍內，已移除的勢力略過。
  const factionReputation = createInitialReputation();
  for (const [factionId, reputation] of Object.entries(value.factionReputation as Record<string, unknown>)) {
    if (getFactionById(factionId) && Number.isFinite(reputation)) factionReputation[factionId] = clampReputation(reputation as number);
  }
  const hp = Math.min(resourceCaps.maxHp, Math.max(0, value.hp as number));
  const statusEffects = Array.isArray(value.statusEffects)
    ? value.statusEffects.flatMap((effect) => isRecord(effect) && effect.id === 'unconscious' &&
      Number.isInteger(effect.remainingTurns) && (effect.remainingTurns as number) > 0
      ? [{ id: 'unconscious' as const, remainingTurns: effect.remainingTurns as number }]
      : [])
    : [];
  const isDead = value.isDead === true || hp === 0;
  const transactionHistory = Array.isArray(value.transactionHistory) ? value.transactionHistory.flatMap((record) =>
    isRecord(record) && typeof record.id === 'string' &&
    ['purchase', 'sale', 'service', 'quest_reward', 'unit_transfer', 'game_change'].includes(String(record.type)) &&
    typeof record.description === 'string' && Number.isFinite(record.goldChange) && Number.isFinite(record.timestamp)
      ? [{
        id: record.id,
        type: record.type as PlayerState['transactionHistory'][number]['type'],
        description: record.description,
        goldChange: record.goldChange as number,
        timestamp: record.timestamp as number
      }]
      : []).slice(-100) : [];

  return {
    unitId: PLAYER_UNIT_ID,
    characterSeq: value.characterSeq as number,
    name: value.name.trim(),
    speciesId,
    classId,
    alignment: ['守序善良', '中立善良', '混亂善良', '守序中立', '絕對中立', '混亂中立', '守序邪惡', '中立邪惡', '混亂邪惡'].includes(String(value.alignment))
      ? value.alignment as PlayerState['alignment']
      : '絕對中立',
    setupComplete: value.setupComplete as boolean,
    abilities,
    isDead,
    statusEffects,
    level,
    exp: value.exp as number,
    hp,
    mp: Math.min(resourceCaps.maxMp, Math.max(0, value.mp as number)),
    gold: value.gold as number,
    unitInstances,
    transactionHistory,
    currentMapId: value.currentMapId,
    ...(previousMapId ? { previousMapId } : {}),
    gameTimeMinutes: value.gameTimeMinutes as number,
    inventory,
    equipped,
    storyFlags: value.storyFlags as Record<string, boolean>,
    defeatedUnits,
    unitDispositionOverrides,
    factionReputation,
    activeQuests,
    world,
    ...(encounteredUnitId && !isDead ? { encounteredUnitId } : {}),
    ...(combat && !isDead ? { combat } : {})
  };
}

export function isStoryMessage(value: unknown): value is StoryMessage {
  return isRecord(value) && typeof value.id === 'string' &&
    ['ai', 'user', 'system'].includes(String(value.sender)) && typeof value.text === 'string' &&
    typeof value.timestamp === 'string' && (value.options === undefined ||
      (Array.isArray(value.options) && value.options.every((option) => typeof option === 'string')));
}
