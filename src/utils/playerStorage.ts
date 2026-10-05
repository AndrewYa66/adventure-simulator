import type { PlayerState, StoryMessage } from '../types/game';
import { createDefaultUnitInstance, getBaseExpForLevel, getCharacterClassById, getItemById, getMapById, getPlayerResourceCaps, getQuestById, getSpeciesById, getUnitAbilities, getUnitLevelCap, getWorldUnitById, MAX_UNIT_LEVEL, PLAYER_UNIT_ID, scenario, unitTemplatesDatabase } from '../data/staticData';
import { isValidGameTime } from './gameTime';
import { isValidSpeciesClassCombo } from './unitGrowth';
import { createCombat } from './combatState';

/** 存檔內容驗證：拒絕無效 ID、數值範圍與不在場的戰鬥目標；存檔的讀寫見 saveStorage.ts。 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isMonsterUnitId = (unitId: string): boolean => getWorldUnitById(unitId)?.kind === 'monster';

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
      !isRecord(value.defeatedMonsters) || !isRecord(value.unitDispositionOverrides)) return null;

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
    if (!isRecord(entry) || typeof entry.questId !== 'string' || !getQuestById(entry.questId) ||
        (entry.status !== 'in_progress' && entry.status !== 'completed')) return [];
    const defeated: Record<string, number> = {};
    const savedDefeats = isRecord(entry.progress) && isRecord(entry.progress.defeatedMonsters) ? entry.progress.defeatedMonsters : {};
    for (const [monsterId, count] of Object.entries(savedDefeats)) {
      if (isMonsterUnitId(monsterId) && Number.isInteger(count) && (count as number) >= 0) defeated[monsterId] = count as number;
    }
    return [{ questId: entry.questId, status: entry.status as 'in_progress' | 'completed', progress: { defeatedMonsters: defeated } }];
  });
  const defeatedMonsters: Record<string, number> = {};
  for (const [monsterId, count] of Object.entries(value.defeatedMonsters)) {
    if (isMonsterUnitId(monsterId) && Number.isInteger(count) && (count as number) >= 0) defeatedMonsters[monsterId] = count as number;
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
    const maxHp = getWorldUnitById(template.id, { [template.id]: { level } })?.stats.hp ?? 1;
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
      isDead: savedState.isDead === true || savedState.currentHp === 0
    }];
  })) as PlayerState['unitInstances'];

  let combat: PlayerState['combat'];
  if (value.combat !== undefined && value.combat !== null) {
    if (!isRecord(value.combat) || !Number.isInteger(value.combat.round) || (value.combat.round as number) < 1 || !Array.isArray(value.combat.participants)) return null;
    const savedEnemies = value.combat.participants.filter((participant) => isRecord(participant) && participant.side === 'enemy');
    const enemies: { unitId: string; currentHp: number }[] = [];
    for (const enemy of savedEnemies) {
      const unitId = isRecord(enemy) && typeof enemy.unitId === 'string' ? enemy.unitId : undefined;
      const unit = unitId ? getWorldUnitById(unitId, unitInstances) : undefined;
      const isPresent = unit?.kind === 'npc'
        ? getMapById(value.currentMapId)?.npcsPresent.includes(unitId!)
        : !!unit && getMapById(value.currentMapId)?.monstersPresent.includes(unitId!);
      const savedNpcState = unit?.kind === 'npc' && isRecord(savedInstances[unitId!]) ? savedInstances[unitId!] as Record<string, unknown> : undefined;
      if (!isRecord(enemy) || !unitId || !unit || !isPresent || !Number.isInteger(enemy.currentHp) || (enemy.currentHp as number) <= 0 ||
          savedNpcState?.isDead === true || savedNpcState?.currentHp === 0) return null;
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
  const encounteredUnitIsPresent = encounteredUnit?.kind === 'npc'
    ? getMapById(value.currentMapId)?.npcsPresent.includes(savedEncounteredUnitId!)
    : !!encounteredUnit && getMapById(value.currentMapId)?.monstersPresent.includes(savedEncounteredUnitId!);
  const savedEncounteredNpcState = encounteredUnit?.kind === 'npc' && isRecord(savedInstances[savedEncounteredUnitId!])
    ? savedInstances[savedEncounteredUnitId!] as Record<string, unknown> : undefined;
  const encounteredUnitId = typeof savedEncounteredUnitId === 'string' && encounteredUnit && encounteredUnitIsPresent &&
    savedEncounteredNpcState?.isDead !== true && savedEncounteredNpcState?.currentHp !== 0
    ? savedEncounteredUnitId
    : undefined;
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
    ['purchase', 'sale', 'service', 'quest_reward', 'npc_transfer', 'game_change'].includes(String(record.type)) &&
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
    defeatedMonsters,
    unitDispositionOverrides,
    activeQuests,
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
