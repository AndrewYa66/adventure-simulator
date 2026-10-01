import type { PlayerState } from '../types/game';
import { getItemById, getMapById, getPlayerGrowthByLevel, getQuestById } from '../data/staticData';
import { createInitialPlayer } from './playerInit';

const PLAYER_STORAGE_KEY = 'TRPG_PLAYER_STATE';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePlayerState(value: unknown): PlayerState | null {
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
    return [{ questId: entry.questId, status: entry.status as 'in_progress' | 'completed' }];
  });

  const equipped: PlayerState['equipped'] = {};
  for (const slot of ['weaponItemId', 'armorItemId', 'accessoryItemId'] as const) {
    const id = value.equipped[slot];
    if (typeof id === 'string' && getItemById(id)) equipped[slot] = id;
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
    activeQuests
  };
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
    localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(player));
  } catch {
    // Keep the in-memory reset even when browser storage is unavailable.
  }
  return player;
}
