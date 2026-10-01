import type { AIResponsePayload, PlayerState } from '../types/game';
import { getItemById, getMapById, getMonsterById, getPlayerGrowthByLevel, getQuestById } from '../data/staticData';

export function applyStateChanges(player: PlayerState, response: AIResponsePayload): PlayerState {
  const changes = response.stateChanges;
  if (!changes) return player;

  const inventory = player.inventory.map((item) => ({ ...item }));
  const defeatedMonsters = { ...player.defeatedMonsters };
  let questExp = 0;
  let questGold = 0;
  const rewardItems: { itemId: string; quantity: number }[] = [];
  const activeQuests = player.activeQuests.map((quest) => ({ ...quest }));

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

  for (const defeat of changes.defeatedMonsters ?? []) {
    const currentMap = getMapById(player.currentMapId);
    if (getMonsterById(defeat.monsterId) && currentMap?.monstersPresent.includes(defeat.monsterId) && Number.isInteger(defeat.quantity) && defeat.quantity > 0) {
      defeatedMonsters[defeat.monsterId] = (defeatedMonsters[defeat.monsterId] ?? 0) + defeat.quantity;
      for (const active of activeQuests) {
        if (active.status !== 'in_progress') continue;
        active.progress ??= { defeatedMonsters: {} };
        const progress = active.progress.defeatedMonsters;
        progress[defeat.monsterId] = (progress[defeat.monsterId] ?? 0) + defeat.quantity;
      }
    }
  }

  for (const update of changes.questUpdates ?? []) {
    const active = activeQuests.find((entry) => entry.questId === update.questId && entry.status === 'in_progress');
    const quest = getQuestById(update.questId);
    if (!active || !quest) continue;
    const defeatsMet = (quest.requirements.defeatMonsters ?? []).every((requirement) =>
      (active.progress?.defeatedMonsters[requirement.monsterId] ?? 0) >= requirement.quantity
    );
    const itemsMet = (quest.requirements.collectItems ?? []).every((requirement) =>
      (inventory.find((item) => item.itemId === requirement.itemId)?.quantity ?? 0) >= requirement.quantity
    );
    if (!defeatsMet || !itemsMet) continue;
    active.status = 'completed';
    questExp += quest.rewards.exp;
    questGold += quest.rewards.gold;
    rewardItems.push(...(quest.rewards.items ?? []));
    for (const requirement of quest.requirements.collectItems ?? []) {
      const collected = inventory.find((item) => item.itemId === requirement.itemId);
      if (!collected) continue;
      collected.quantity -= requirement.quantity;
      if (collected.quantity <= 0) inventory.splice(inventory.indexOf(collected), 1);
    }
  }

  for (const item of rewardItems) {
    if (!getItemById(item.itemId) || !Number.isInteger(item.quantity) || item.quantity <= 0) continue;
    const existing = inventory.find((entry) => entry.itemId === item.itemId);
    if (existing) existing.quantity += item.quantity;
    else inventory.push({ itemId: item.itemId, quantity: item.quantity });
  }

  const map = changes.newLocationId ? getMapById(changes.newLocationId) : undefined;
  const canMove = map && (map.id === player.currentMapId || getMapById(player.currentMapId)?.connectedMapIds.includes(map.id));
  let level = player.level;
  const exp = Math.max(0, player.exp + (changes.expChange ?? 0) + questExp);
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
    gold: Math.max(0, player.gold + (changes.goldChange ?? 0) + questGold),
    inventory,
    storyFlags: { ...player.storyFlags, ...(changes.setFlags ?? {}) },
    defeatedMonsters,
    activeQuests,
    currentMapId: canMove ? map.id : player.currentMapId
  };
}
