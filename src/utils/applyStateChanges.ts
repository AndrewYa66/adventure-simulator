import type { AIResponsePayload, PlayerState } from '../types/game';
import { getItemById, getMapById, getMonsterById, getPlayerGrowthByLevel, getQuestById } from '../data/staticData';
import { acceptQuest } from './questRules';

export function applyStateChanges(player: PlayerState, response: AIResponsePayload, source: 'ai' | 'game' = 'ai'): PlayerState {
  const changes = response.stateChanges;
  if (!changes) return player;

  const inventory = player.inventory.map((item) => ({ ...item }));
  const defeatedMonsters = { ...player.defeatedMonsters };
  let questExp = 0;
  let questGold = 0;
  const rewardItems: { itemId: string; quantity: number }[] = [];
  const activeQuests = player.activeQuests.map((quest) => ({ ...quest }));

  for (const questId of changes.questAcceptances ?? []) {
    const quest = getQuestById(questId);
    if (!quest) continue;
    const accepted = acceptQuest({ ...player, activeQuests }, quest);
    if (accepted) activeQuests.push(accepted.activeQuests[accepted.activeQuests.length - 1]);
  }

  for (const item of (source === 'game' ? changes.addItems ?? [] : [])) {
    if (!getItemById(item.itemId) || !Number.isInteger(item.quantity) || item.quantity <= 0) continue;
    const existing = inventory.find((entry) => entry.itemId === item.itemId);
    if (existing) existing.quantity += item.quantity;
    else inventory.push({ itemId: item.itemId, quantity: item.quantity });
  }

  for (const item of (source === 'game' ? changes.removeItems ?? [] : [])) {
    if (!getItemById(item.itemId) || !Number.isInteger(item.quantity) || item.quantity <= 0) continue;
    const existing = inventory.find((entry) => entry.itemId === item.itemId);
    if (!existing) continue;
    existing.quantity -= Math.min(existing.quantity, item.quantity);
    if (existing.quantity <= 0) inventory.splice(inventory.indexOf(existing), 1);
  }

  for (const defeat of (source === 'game' ? changes.defeatedMonsters ?? [] : [])) {
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
    const limits = quest.rewardLimits;
    const bounded = (amount: number, range?: { min: number; max: number }) =>
      range ? Math.max(range.min, Math.min(range.max, amount)) : amount;
    questExp += bounded(quest.rewards.exp, limits?.exp);
    questGold += bounded(quest.rewards.gold, limits?.gold);
    rewardItems.push(...(quest.rewards.items ?? []).map((item) => ({
      ...item,
      quantity: Math.min(item.quantity, limits?.maxItemQuantity ?? item.quantity)
    })));
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

  let level = player.level;
  const trustedExpChange = source === 'game' ? changes.expChange ?? 0 : Math.min(0, changes.expChange ?? 0);
  const trustedGoldChange = source === 'game' ? changes.goldChange ?? 0 : Math.min(0, changes.goldChange ?? 0);
  const exp = Math.max(0, player.exp + trustedExpChange + questExp);
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
    isDead: player.isDead || hp <= 0,
    level,
    exp,
    hp,
    mp,
    gold: Math.max(0, player.gold + trustedGoldChange + questGold),
    inventory,
    storyFlags: { ...player.storyFlags, ...(changes.setFlags ?? {}) },
    defeatedMonsters,
    activeQuests,
    currentMapId: player.currentMapId
  };
}
