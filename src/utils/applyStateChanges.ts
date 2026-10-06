import type { AIResponsePayload, PlayerState } from '../types/game';
import { getItemById, getMapById, getUnitDisplayName, getPlayerResourceCaps, getWorldUnitById, getWorldUnitDisposition, levelBenchmarksDatabase, MAX_UNIT_LEVEL } from '../data/staticData';
import { acceptQuest, canReachQuestGiver, findQuest, getActiveQuestGiverId, isGeneratedQuest } from './questRules';
import { markGeneratedQuestCompleted } from './generatedQuests';
import { resolveLevelFromExp } from './unitGrowth';

export function applyStateChanges(player: PlayerState, response: AIResponsePayload, source: 'ai' | 'game' = 'ai'): PlayerState {
  const changes = response.stateChanges;
  if (!changes) return player;

  const inventory = player.inventory.map((item) => ({ ...item }));
  const defeatedMonsters = { ...player.defeatedMonsters };
  let questExp = 0;
  let questGold = 0;
  const rewardItems: { itemId: string; quantity: number }[] = [];
  const activeQuests = player.activeQuests.map((quest) => ({ ...quest }));
  const unitInstances = Object.fromEntries(Object.entries(player.unitInstances).map(([npcId, state]) => [npcId, {
    ...state,
    inventory: state.inventory.map((item) => ({ ...item }))
  }]));
  const transactionHistory = [...player.transactionHistory];
  const unitDispositionOverrides = { ...player.unitDispositionOverrides };
  const recordTransaction = (type: PlayerState['transactionHistory'][number]['type'], description: string, goldChange = 0) => {
    transactionHistory.unshift({ id: `${Date.now()}-${Math.random()}`, type, description, goldChange, timestamp: Date.now() });
    if (transactionHistory.length > 100) transactionHistory.length = 100;
  };
  const currentMap = getMapById(player.currentMapId);
  let world = player.world;

  for (const change of changes.unitDispositionChanges ?? []) {
    const unit = getWorldUnitById(change.unitId);
    const isPresent = currentMap?.npcsPresent.includes(change.unitId) || currentMap?.monstersPresent.includes(change.unitId);
    const isAlive = unit?.kind !== 'npc' || (!player.unitInstances[unit.id]?.isDead && player.unitInstances[unit.id]?.currentHp !== 0);
    if (!unit || !isPresent || !isAlive || !['friendly', 'neutral', 'hostile'].includes(change.disposition)) continue;
    unitDispositionOverrides[unit.id] = change.disposition;
  }

  if (source === 'ai') {
    for (const transfer of changes.npcItemTransfers ?? []) {
      const unit = getWorldUnitById(transfer.npcId);
      const state = unitInstances[transfer.npcId];
      if (unit?.kind !== 'npc' || !unit.mapIds.includes(player.currentMapId) || !currentMap?.npcsPresent.includes(unit.id) ||
          getWorldUnitDisposition({ factionReputation: player.factionReputation, unitDispositionOverrides }, unit.id) === 'hostile' || !getItemById(transfer.itemId) ||
          !Number.isInteger(transfer.quantity) || transfer.quantity < 1 || !state || state.isDead || state.currentHp === 0) continue;
      const stock = state.inventory.find((entry) => entry.itemId === transfer.itemId);
      if (!stock || stock.quantity < transfer.quantity) continue;
      stock.quantity -= transfer.quantity;
      if (stock.quantity === 0) state.inventory.splice(state.inventory.indexOf(stock), 1);
      const owned = inventory.find((entry) => entry.itemId === transfer.itemId);
      if (owned) owned.quantity += transfer.quantity;
      else inventory.push({ itemId: transfer.itemId, quantity: transfer.quantity });
      recordTransaction('npc_transfer', `從 ${unit.name} 取得 ${getItemById(transfer.itemId)?.name ?? transfer.itemId} ×${transfer.quantity}`);
    }
  }

  for (const questId of changes.questAcceptances ?? []) {
    const quest = findQuest(player, questId);
    if (!quest) continue;
    const accepted = acceptQuest({ ...player, activeQuests, unitDispositionOverrides }, quest);
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
    const unit = getWorldUnitById(defeat.monsterId);
    if (unit?.kind === 'monster' && currentMap?.monstersPresent.includes(unit.id) && Number.isInteger(defeat.quantity) && defeat.quantity > 0) {
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
    const quest = findQuest(player, update.questId);
    const giverId = quest ? getActiveQuestGiverId(active, quest.questGiverId) : undefined;
    if (!active || !quest || !giverId || !canReachQuestGiver({ ...player, unitInstances, unitDispositionOverrides }, quest, giverId)) continue;
    const defeatsMet = (quest.requirements.defeatMonsters ?? []).every((requirement) =>
      (active.progress?.defeatedMonsters[requirement.monsterId] ?? 0) >= requirement.quantity
    );
    const itemsMet = (quest.requirements.collectItems ?? []).every((requirement) =>
      (inventory.find((item) => item.itemId === requirement.itemId)?.quantity ?? 0) >= requirement.quantity
    );
    if (!defeatsMet || !itemsMet) continue;
    active.status = 'completed';
    const giverState = unitInstances[giverId];
    if (isGeneratedQuest(quest)) {
      // 生成委託的報酬已於發布時自委託人預扣保留，完成時全額發放。
      questExp += quest.rewards.exp;
      questGold += quest.rewards.gold;
      rewardItems.push(...(quest.rewards.items ?? []).map((item) => ({ ...item })));
      world = markGeneratedQuestCompleted(world, quest.id);
      const itemText = (quest.rewards.items ?? []).map((item) => `${getItemById(item.itemId)?.name ?? item.itemId} ×${item.quantity}`).join('、');
      recordTransaction('quest_reward', `完成任務「${quest.title}」，領取 ${quest.rewards.gold} 金幣${itemText ? `、${itemText}` : ''}（委託人預先保留的報酬）`, quest.rewards.gold);
    } else {
      const limits = quest.rewardLimits;
      const bounded = (amount: number, range?: { min: number; max: number }) =>
        range ? Math.max(range.min, Math.min(range.max, amount)) : amount;
      questExp += bounded(quest.rewards.exp, limits?.exp);
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
    }
    for (const requirement of quest.requirements.collectItems ?? []) {
      const collected = inventory.find((item) => item.itemId === requirement.itemId);
      if (!collected) continue;
      collected.quantity -= requirement.quantity;
      if (collected.quantity <= 0) inventory.splice(inventory.indexOf(collected), 1);
      if (giverState) {
        const received = giverState.inventory.find((entry) => entry.itemId === requirement.itemId);
        if (received) received.quantity += requirement.quantity;
        else giverState.inventory.push({ itemId: requirement.itemId, quantity: requirement.quantity });
        recordTransaction('npc_transfer', `交付 ${getItemById(requirement.itemId)?.name ?? requirement.itemId} ×${requirement.quantity} 給 ${getUnitDisplayName(giverId)}`);
      }
    }
  }

  for (const item of rewardItems) {
    if (!getItemById(item.itemId) || !Number.isInteger(item.quantity) || item.quantity <= 0) continue;
    const existing = inventory.find((entry) => entry.itemId === item.itemId);
    if (existing) existing.quantity += item.quantity;
    else inventory.push({ itemId: item.itemId, quantity: item.quantity });
  }

  const trustedExpChange = source === 'game' ? changes.expChange ?? 0 : Math.min(0, changes.expChange ?? 0);
  const trustedGoldChange = source === 'game' ? changes.goldChange ?? 0 : Math.min(0, changes.goldChange ?? 0);
  if (trustedGoldChange !== 0) {
    recordTransaction('game_change', trustedGoldChange > 0 ? '遊戲金幣增加' : '遊戲金幣扣除', trustedGoldChange);
  }
  const exp = Math.max(0, player.exp + trustedExpChange + questExp);
  let hp = Math.max(0, player.hp + (changes.hpChange ?? 0));
  let mp = Math.max(0, player.mp + (changes.mpChange ?? 0));
  // 升級規則與 NPC/魔物共用：累計經驗達等級基準表門檻即升級，升級時增加的資源上限同步補給。
  const level = resolveLevelFromExp(levelBenchmarksDatabase, player.level, exp, MAX_UNIT_LEVEL);
  const previousCaps = getPlayerResourceCaps(player);
  const caps = getPlayerResourceCaps({ ...player, level });
  hp = Math.min(caps.maxHp, hp + Math.max(0, caps.maxHp - previousCaps.maxHp));
  mp = Math.min(caps.maxMp, mp + Math.max(0, caps.maxMp - previousCaps.maxMp));

  return {
    ...player,
    isDead: player.isDead || hp <= 0,
    level,
    exp,
    hp,
    mp,
    gold: Math.max(0, player.gold + trustedGoldChange + questGold),
    unitInstances,
    transactionHistory,
    unitDispositionOverrides,
    inventory,
    storyFlags: player.storyFlags,
    defeatedMonsters,
    activeQuests,
    currentMapId: player.currentMapId,
    world
  };
}
