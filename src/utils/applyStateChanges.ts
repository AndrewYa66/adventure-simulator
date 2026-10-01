import type { AIResponsePayload, PlayerState } from '../types/game';
import { getItemById, getMapById, getPlayerGrowthByLevel } from '../data/staticData';

export function applyStateChanges(player: PlayerState, response: AIResponsePayload): PlayerState {
  const changes = response.stateChanges;
  if (!changes) return player;

  const inventory = player.inventory.map((item) => ({ ...item }));
  for (const item of changes.addItems ?? []) {
    if (!getItemById(item.itemId) || !Number.isInteger(item.quantity) || item.quantity <= 0) continue;
    const existing = inventory.find((entry) => entry.itemId === item.itemId);
    if (existing) existing.quantity += item.quantity;
    else inventory.push({ itemId: item.itemId, quantity: item.quantity });
  }

  for (const item of changes.removeItems ?? []) {
    if (!getItemById(item.itemId) || !Number.isInteger(item.quantity) || item.quantity <= 0) continue;
    const existing = inventory.find((entry) => entry.itemId === item.itemId);
    if (!existing) continue;
    existing.quantity -= Math.min(existing.quantity, item.quantity);
    if (existing.quantity <= 0) inventory.splice(inventory.indexOf(existing), 1);
  }

  const map = changes.newLocationId ? getMapById(changes.newLocationId) : undefined;
  const canMove = map && (map.id === player.currentMapId || getMapById(player.currentMapId)?.connectedMapIds.includes(map.id));
  let level = player.level;
  const exp = Math.max(0, player.exp + (changes.expChange ?? 0));
  let hp = Math.max(0, player.hp + (changes.hpChange ?? 0));
  let mp = Math.max(0, player.mp + (changes.mpChange ?? 0));
  let growth = getPlayerGrowthByLevel(level);

  while (growth && exp >= growth.requiredExp) {
    const nextGrowth = getPlayerGrowthByLevel(level + 1);
    if (!nextGrowth) break;
    hp = Math.min(nextGrowth.maxHp, hp + (nextGrowth.maxHp - growth.maxHp));
    mp = Math.min(nextGrowth.maxMp, mp + (nextGrowth.maxMp - growth.maxMp));
    level = nextGrowth.level;
    growth = nextGrowth;
  }

  if (growth) {
    hp = Math.min(hp, growth.maxHp);
    mp = Math.min(mp, growth.maxMp);
  }

  return {
    ...player,
    level,
    exp,
    hp,
    mp,
    gold: Math.max(0, player.gold + (changes.goldChange ?? 0)),
    inventory,
    storyFlags: { ...player.storyFlags, ...(changes.setFlags ?? {}) },
    currentMapId: canMove ? map.id : player.currentMapId
  };
}
