import type { AIResponsePayload, PlayerState } from '../types/game';
import { getItemById, getMapById, getMonsterById, getNpcById, getPlayerGrowthByLevel, getPlayerResourceCaps, getQuestById } from '../data/staticData';
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
  const npcStates = Object.fromEntries(Object.entries(player.npcStates).map(([npcId, state]) => [npcId, {
    gold: state.gold,
    inventory: state.inventory.map((item) => ({ ...item }))
  }]));
  const transactionHistory = [...player.transactionHistory];
  const recordTransaction = (type: PlayerState['transactionHistory'][number]['type'], description: string, goldChange = 0) => {
    transactionHistory.unshift({ id: `${Date.now()}-${Math.random()}`, type, description, goldChange, timestamp: Date.now() });
    if (transactionHistory.length > 100) transactionHistory.length = 100;
  };
  const currentMap = getMapById(player.currentMapId);

  if (source === 'ai') {
    for (const transfer of changes.npcItemTransfers ?? []) {
      const npc = getNpcById(transfer.npcId);
      const state = npcStates[transfer.npcId];
      if (!npc || npc.mapId !== player.currentMapId || !currentMap?.npcsPresent.includes(npc.id) ||
          !getItemById(transfer.itemId) || !Number.isInteger(transfer.quantity) || transfer.quantity < 1 || !state) continue;
      const stock = state.inventory.find((entry) => entry.itemId === transfer.itemId);
      if (!stock || stock.quantity < transfer.quantity) continue;
      stock.quantity -= transfer.quantity;
      if (stock.quantity === 0) state.inventory.splice(state.inventory.indexOf(stock), 1);
      const owned = inventory.find((entry) => entry.itemId === transfer.itemId);
      if (owned) owned.quantity += transfer.quantity;
      else inventory.push({ itemId: transfer.itemId, quantity: transfer.quantity });
      recordTransaction('npc_transfer', `從 ${npc.name} 取得 ${getItemById(transfer.itemId)?.name ?? transfer.itemId} ×${transfer.quantity}`);
    }
  }

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
    if (!active || !quest || quest.mapId !== player.currentMapId || !currentMap?.npcsPresent.includes(quest.questGiverId)) continue;
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
    const giverState = npcStates[quest.questGiverId];
    const requestedGold = bounded(quest.rewards.gold, limits?.gold);
    const paidGold = Math.min(requestedGold, giverState?.gold ?? 0);
    questGold += paidGold;
    if (giverState) giverState.gold -= paidGold;
    const shortfalls: string[] = [];
    if (paidGold < requestedGold) shortfalls.push(`金幣短缺 ${requestedGold - paidGold}`);
    for (const reward of quest.rewards.items ?? []) {
      const desired = Math.min(reward.quantity, limits?.maxItemQuantity ?? reward.quantity);
      const stock = giverState?.inventory.find((entry) => entry.itemId === reward.itemId);
      const granted = Math.min(desired, stock?.quantity ?? 0);
      if (granted > 0) {
        rewardItems.push({ itemId: reward.itemId, quantity: granted });
        stock!.quantity -= granted;
        if (stock!.quantity === 0) giverState!.inventory.splice(giverState!.inventory.indexOf(stock!), 1);
      }
      if (granted < desired) shortfalls.push(`${getItemById(reward.itemId)?.name ?? reward.itemId} 短缺 ${desired - granted}`);
    }
    recordTransaction('quest_reward', `完成任務「${quest.title}」，領取 ${paidGold} 金幣${shortfalls.length ? `；獎勵短缺：${shortfalls.join('、')}` : ''}`, paidGold);
    for (const requirement of quest.requirements.collectItems ?? []) {
      const collected = inventory.find((item) => item.itemId === requirement.itemId);
      if (!collected) continue;
      collected.quantity -= requirement.quantity;
      if (collected.quantity <= 0) inventory.splice(inventory.indexOf(collected), 1);
      if (giverState) {
        const received = giverState.inventory.find((entry) => entry.itemId === requirement.itemId);
        if (received) received.quantity += requirement.quantity;
        else giverState.inventory.push({ itemId: requirement.itemId, quantity: requirement.quantity });
        recordTransaction('npc_transfer', `交付 ${getItemById(requirement.itemId)?.name ?? requirement.itemId} ×${requirement.quantity} 給 ${quest.questGiver}`);
      }
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
    const previousCaps = getPlayerResourceCaps(level, player.classId);
    const nextCaps = getPlayerResourceCaps(nextGrowth.level, player.classId);
    hp = Math.min(nextCaps.maxHp, hp + (nextCaps.maxHp - previousCaps.maxHp));
    mp = Math.min(nextCaps.maxMp, mp + (nextCaps.maxMp - previousCaps.maxMp));
    level = nextGrowth.level;
    growth = nextGrowth;
  }

  if (growth) {
    const caps = getPlayerResourceCaps(level, player.classId);
    hp = Math.min(hp, caps.maxHp);
    mp = Math.min(mp, caps.maxMp);
  }

  return {
    ...player,
    isDead: player.isDead || hp <= 0,
    level,
    exp,
    hp,
    mp,
    gold: Math.max(0, player.gold + trustedGoldChange + questGold),
    npcStates,
    transactionHistory,
    inventory,
    storyFlags: { ...player.storyFlags, ...(changes.setFlags ?? {}) },
    defeatedMonsters,
    activeQuests,
    currentMapId: player.currentMapId
  };
}
