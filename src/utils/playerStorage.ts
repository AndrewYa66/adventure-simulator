import type { GameSession, PlayerState, StoryMessage } from '../types/game';
import { createDefaultNpcWorldState, getCharacterClassById, getItemById, getMapById, getPlayerResourceCaps, getQuestById, getWorldUnitById, npcsDatabase, PLAYER_UNIT_ID } from '../data/staticData';
import { createInitialPlayer } from './playerInit';
import { GAME_START_MINUTES, isValidGameTime } from './gameTime';

const PLAYER_STORAGE_KEY = 'TRPG_PLAYER_STATE';
const SESSION_STORAGE_KEY = 'TRPG_GAME_SESSION';

export interface LoadedGameSession {
  player: PlayerState;
  messages: StoryMessage[];
  resumed: boolean;
  savedAt?: number;
}

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
      !Array.isArray(value.activeQuests)) return null;

  const classId = typeof value.classId === 'string' && getCharacterClassById(value.classId) ? value.classId : 'adventurer';
  const resourceCaps = getPlayerResourceCaps(value.level as number, classId);
  if ((value.hp as number) > resourceCaps.maxHp || (value.mp as number) > resourceCaps.maxMp) return null;
  const abilityKeys = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
  const savedAbilities = isRecord(value.abilities) ? value.abilities : {};
  const abilityDefaults = getCharacterClassById(classId)?.baseAbilities ?? { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 };
  const abilities = Object.fromEntries(abilityKeys.map((key) => {
    const score = savedAbilities[key];
    return [key, Number.isInteger(score) && (score as number) >= 1 && (score as number) <= 30 ? score as number : abilityDefaults[key]];
  })) as typeof abilityDefaults;

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
  if (value.defeatedMonsters !== undefined && !isRecord(value.defeatedMonsters)) return null;
  for (const [monsterId, count] of Object.entries(value.defeatedMonsters ?? {})) {
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

  let combat: PlayerState['combat'];
  if (value.combat !== undefined && value.combat !== null) {
    const combatUnitId = isRecord(value.combat) && typeof value.combat.unitId === 'string'
      ? value.combat.unitId
      : isRecord(value.combat) && typeof value.combat.monsterId === 'string' ? value.combat.monsterId : undefined;
    const combatUnit = combatUnitId ? getWorldUnitById(combatUnitId) : undefined;
    const combatUnitIsPresent = combatUnit?.kind === 'npc'
      ? getMapById(value.currentMapId)?.npcsPresent.includes(combatUnitId!)
      : !!combatUnit && getMapById(value.currentMapId)?.monstersPresent.includes(combatUnitId!);
    const savedCombatNpcState = combatUnit?.kind === 'npc' && isRecord(value.npcStates) && isRecord(value.npcStates[combatUnitId!])
      ? value.npcStates[combatUnitId!] as Record<string, unknown> : undefined;
    if (!isRecord(value.combat) || !combatUnitId || !combatUnit || !combatUnitIsPresent ||
        !Number.isInteger(value.combat.currentHp) || (value.combat.currentHp as number) <= 0 ||
        (value.combat.currentHp as number) > combatUnit.stats.hp ||
        !Number.isInteger(value.combat.round) || (value.combat.round as number) < 1 ||
        (savedCombatNpcState?.isDead === true || savedCombatNpcState?.currentHp === 0)) return null;
    combat = { unitId: combatUnitId, currentHp: value.combat.currentHp as number, round: value.combat.round as number };
  }
  const previousMapId = typeof value.previousMapId === 'string' &&
    getMapById(value.currentMapId)?.connectedMapIds.includes(value.previousMapId)
    ? value.previousMapId
    : undefined;
  const savedEncounteredUnitId = typeof value.encounteredUnitId === 'string'
    ? value.encounteredUnitId
    : typeof value.encounteredMonsterId === 'string' ? value.encounteredMonsterId : undefined;
  const encounteredUnit = typeof savedEncounteredUnitId === 'string' ? getWorldUnitById(savedEncounteredUnitId) : undefined;
  const encounteredUnitIsPresent = encounteredUnit?.kind === 'npc'
    ? getMapById(value.currentMapId)?.npcsPresent.includes(savedEncounteredUnitId!)
    : !!encounteredUnit && getMapById(value.currentMapId)?.monstersPresent.includes(savedEncounteredUnitId!);
  const savedEncounteredNpcState = encounteredUnit?.kind === 'npc' && isRecord(value.npcStates) && isRecord(value.npcStates[savedEncounteredUnitId!])
    ? value.npcStates[savedEncounteredUnitId!] as Record<string, unknown> : undefined;
  const encounteredUnitId = typeof savedEncounteredUnitId === 'string' && encounteredUnit && encounteredUnitIsPresent &&
    savedEncounteredNpcState?.isDead !== true && savedEncounteredNpcState?.currentHp !== 0
    ? savedEncounteredUnitId
    : undefined;
  const hp = Math.max(0, value.hp as number);
  const statusEffects = Array.isArray(value.statusEffects)
    ? value.statusEffects.flatMap((effect) => isRecord(effect) && effect.id === 'unconscious' &&
      Number.isInteger(effect.remainingTurns) && (effect.remainingTurns as number) > 0
      ? [{ id: 'unconscious' as const, remainingTurns: effect.remainingTurns as number }]
      : [])
    : [];
  const isDead = value.isDead === true || hp === 0;
  const savedNpcStates = isRecord(value.npcStates) ? value.npcStates : {};
  const npcStates = Object.fromEntries(npcsDatabase.map((npc) => {
    const savedState = savedNpcStates[npc.id];
    const maxHp = getWorldUnitById(npc.id)?.stats.hp ?? 1;
    if (!isRecord(savedState)) return [npc.id, createDefaultNpcWorldState(npc)];
    const savedInventory = Array.isArray(savedState.inventory) ? savedState.inventory.flatMap((entry) =>
      isRecord(entry) && typeof entry.itemId === 'string' && getItemById(entry.itemId) &&
      Number.isInteger(entry.quantity) && (entry.quantity as number) > 0
        ? [{ itemId: entry.itemId, quantity: entry.quantity as number }]
        : []) : [];
    return [npc.id, {
      gold: Number.isSafeInteger(savedState.gold) && (savedState.gold as number) >= 0 ? savedState.gold as number : 0,
      inventory: savedInventory,
      currentHp: Number.isInteger(savedState.currentHp) && (savedState.currentHp as number) >= 0 && (savedState.currentHp as number) <= maxHp
        ? savedState.currentHp as number : maxHp,
      isDead: savedState.isDead === true || savedState.currentHp === 0
    }];
  }));
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
    classId,
    alignment: ['守序善良', '中立善良', '混亂善良', '守序中立', '絕對中立', '混亂中立', '守序邪惡', '中立邪惡', '混亂邪惡'].includes(String(value.alignment))
      ? value.alignment as PlayerState['alignment']
      : '絕對中立',
    setupComplete: typeof value.setupComplete === 'boolean' ? value.setupComplete : true,
    abilities,
    isDead,
    statusEffects,
    level: value.level as number,
    exp: value.exp as number,
    hp,
    mp: Math.max(0, value.mp as number),
    gold: value.gold as number,
    npcStates,
    transactionHistory,
    currentMapId: value.currentMapId,
    ...(previousMapId ? { previousMapId } : {}),
    gameTimeMinutes: isValidGameTime(value.gameTimeMinutes) ? value.gameTimeMinutes : GAME_START_MINUTES,
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

function isStoryMessage(value: unknown): value is StoryMessage {
  return isRecord(value) && typeof value.id === 'string' &&
    ['ai', 'user', 'system'].includes(String(value.sender)) && typeof value.text === 'string' &&
    typeof value.timestamp === 'string' && (value.options === undefined ||
      (Array.isArray(value.options) && value.options.every((option) => typeof option === 'string')));
}

export function loadGameSession(): LoadedGameSession {
  try {
    const saved = localStorage.getItem(SESSION_STORAGE_KEY);
    if (saved) {
      const value: unknown = JSON.parse(saved);
      if (isRecord(value) && value.schemaVersion === 1 && Number.isFinite(value.savedAt) && Array.isArray(value.messages) &&
          value.messages.every(isStoryMessage)) {
        const player = normalizePlayerState(value.player);
        if (player) return { player, messages: (value.messages as StoryMessage[]).slice(-100), resumed: true, savedAt: value.savedAt as number };
      }
    }
  } catch {
    // Fall back to the last valid player-only save below.
  }
  return { player: loadPlayerState(), messages: [], resumed: false };
}

export function saveGameSession(player: PlayerState, messages: StoryMessage[]): boolean {
  try {
    const snapshot: GameSession = { schemaVersion: 1, savedAt: Date.now(), player, messages: messages.slice(-100) };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    return savePlayerState(player);
  } catch {
    return false;
  }
}

export function loadPlayerState(): PlayerState {
  try {
    const saved = localStorage.getItem(PLAYER_STORAGE_KEY);
    if (!saved) return createInitialPlayer();
    return normalizePlayerState(JSON.parse(saved) as unknown) ?? createInitialPlayer();
  } catch {
    return createInitialPlayer();
  }
}

export function savePlayerState(player: PlayerState): boolean {
  try {
    localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(player));
    return true;
  } catch {
    return false;
  }
}

export function resetPlayerState(): PlayerState {
  const player = createInitialPlayer();
  try {
    localStorage.removeItem(PLAYER_STORAGE_KEY);
    localStorage.removeItem(SESSION_STORAGE_KEY);
    localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(player));
  } catch {
    // Keep the in-memory reset even when browser storage is unavailable.
  }
  return player;
}
