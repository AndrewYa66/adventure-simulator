import type { GameSession, PlayerState, StoryMessage } from '../types/game';
import { getItemById, getMapById, getMonsterById, getPlayerGrowthByLevel, getQuestById } from '../data/staticData';
import { createInitialPlayer } from './playerInit';

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

  const growth = getPlayerGrowthByLevel(value.level as number);
  if (!growth || (value.hp as number) > growth.maxHp || (value.mp as number) > growth.maxMp) return null;

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
      if (getMonsterById(monsterId) && Number.isInteger(count) && (count as number) >= 0) defeated[monsterId] = count as number;
    }
    return [{ questId: entry.questId, status: entry.status as 'in_progress' | 'completed', progress: { defeatedMonsters: defeated } }];
  });
  const defeatedMonsters: Record<string, number> = {};
  if (value.defeatedMonsters !== undefined && !isRecord(value.defeatedMonsters)) return null;
  for (const [monsterId, count] of Object.entries(value.defeatedMonsters ?? {})) {
    if (getMonsterById(monsterId) && Number.isInteger(count) && (count as number) >= 0) defeatedMonsters[monsterId] = count as number;
  }

  const equipped: PlayerState['equipped'] = {};
  for (const slot of ['weaponItemId', 'armorItemId', 'accessoryItemId'] as const) {
    const id = value.equipped[slot];
    if (typeof id === 'string' && getItemById(id)) equipped[slot] = id;
  }

  let combat: PlayerState['combat'];
  if (value.combat !== undefined && value.combat !== null) {
    if (!isRecord(value.combat) || typeof value.combat.monsterId !== 'string' || !getMonsterById(value.combat.monsterId) ||
        !Number.isInteger(value.combat.currentHp) || (value.combat.currentHp as number) <= 0 ||
        (value.combat.currentHp as number) > (getMonsterById(value.combat.monsterId)?.stats.hp ?? 0) ||
        !Number.isInteger(value.combat.round) || (value.combat.round as number) < 1 ||
        !getMapById(value.currentMapId)?.monstersPresent.includes(value.combat.monsterId)) return null;
    combat = { monsterId: value.combat.monsterId, currentHp: value.combat.currentHp as number, round: value.combat.round as number };
  }

  return {
    name: value.name.trim(),
    level: value.level as number,
    exp: value.exp as number,
    hp: Math.max(0, value.hp as number),
    mp: Math.max(0, value.mp as number),
    gold: value.gold as number,
    currentMapId: value.currentMapId,
    inventory,
    equipped,
    storyFlags: value.storyFlags as Record<string, boolean>,
    defeatedMonsters,
    activeQuests,
    ...(combat ? { combat } : {})
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
