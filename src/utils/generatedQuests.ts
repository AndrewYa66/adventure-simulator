import type { GeneratedQuest, PlayerState, QuestProposal, QuestTemplateStatic, WorldUnitStatic } from '../types/game';
import {
  getFactionRelation,
  getItemById,
  getMapById,
  getQuestTemplateById,
  getUnitDisplayName,
  getWorldUnitById,
  getWorldUnitDisposition,
  getWorldUnitsAtMap,
  questsDatabase,
  questTemplateData,
  questTemplatesDatabase
} from '../data/staticData';
import { matchesFactionConditions } from './factions';
import { getGameDay } from './gameTime';
import { canAcceptQuest, getActiveQuestGiverId } from './questRules';

/**
 * 依任務範本生成支線委託（O30）。
 * AI 只能在合法候選內選擇範本、發布者、目標、數量與報酬；經驗值、標題與目標說明由範本公式產生。
 * 報酬在發布時自發布者持有物預扣保留（記在委託的 rewards），完成時發放，失敗或逾期時退回發布者。
 */

const MINUTES_PER_DAY = 24 * 60;
/** 已結束且與目前角色無關的生成委託最多保留筆數。 */
const MAX_FINISHED_GENERATED_QUESTS = 30;

type QuestState = PlayerState;
type ItemStack = { itemId: string; quantity: number };

/** 報酬物品的價值：以買價與賣價較高者計算。 */
export const getItemRewardValue = (itemId: string): number => {
  const item = getItemById(itemId);
  return item ? Math.max(item.buyPrice, item.sellPrice) : 0;
};

const isAlive = (state: Pick<PlayerState, 'unitInstances'>, unitId: string) => {
  const instance = state.unitInstances[unitId];
  return !!instance && !instance.isDead && instance.currentHp !== 0 && !instance.isDormant;
};

const templateConditionsMet = (state: QuestState, template: QuestTemplateStatic) =>
  (template.requires?.flags ?? []).every((flag) => state.storyFlags[flag] === true) &&
  !(template.excludes?.flags ?? []).some((flag) => state.storyFlags[flag] === true) &&
  matchesFactionConditions(state, template.requires ?? {});

/** 仍開放（含已被目前角色接取、尚未完成）的生成委託。 */
const openQuests = (state: QuestState) => state.world.generatedQuests.filter((quest) => quest.status === 'open');

/** 發布者不能發布的原因；可發布時回傳 undefined。 */
function giverBlockReason(state: QuestState, template: QuestTemplateStatic, giver: WorldUnitStatic | undefined): string | undefined {
  const map = getMapById(state.currentMapId);
  if (!giver || giver.requiresEncounter || !map?.unitsPresent.includes(giver.id)) return '發布者不在目前地區';
  if (!isAlive(state, giver.id)) return '發布者已死亡';
  if (getWorldUnitDisposition(state, giver.id) === 'hostile') return '發布者對你敵對';
  if (!giver.factionId) return '發布者不屬於任何勢力';
  if (template.giver?.factionIds?.length && !template.giver.factionIds.includes(giver.factionId)) return '發布者的勢力不符合範本';
  if (template.giver?.classIds?.length && (!giver.classId || !template.giver.classIds.includes(giver.classId))) return '發布者的職階不符合範本';
  const own = state.world.generatedQuests.filter((quest) => quest.questGiverId === giver.id);
  if (own.filter((quest) => quest.status === 'open').length >= questTemplateData.limits.maxOpenPerGiver) return '發布者已有開放中的委託';
  const lastPosted = Math.max(-Infinity, ...own.map((quest) => quest.postedAtMinutes));
  if (Number.isFinite(lastPosted) && getGameDay(state.gameTimeMinutes) < getGameDay(lastPosted) + questTemplateData.limits.giverCooldownDays) return '發布者今天已發布過委託';
  // 有劇本任務可接取時，由該任務優先，不另外發布支線委託。
  if (questsDatabase.some((quest) => quest.questGiverId === giver.id && canAcceptQuest(state, quest))) return '發布者目前有可接取的劇本任務';
  const holdings = state.unitInstances[giver.id];
  if (!holdings || (holdings.gold <= 0 && !holdings.inventory.some((entry) => getItemRewardValue(entry.itemId) > 0))) return '發布者沒有可作為報酬的持有物';
  return undefined;
}

interface TargetCandidate {
  targetUnitId: string;
  itemId?: string;
  name: string;
  level: number;
  expReward: number;
}

/** 目標候選：發布者所在地區與相鄰地區需遭遇的單位（不含頭目、需前置任務者、同勢力或友好勢力）；收集範本取其掉落物，以等級最低的掉落者計算。 */
function getTargetCandidates(state: QuestState, template: QuestTemplateStatic, giver: WorldUnitStatic): TargetCandidate[] {
  const giverMap = getMapById(giver.mapIds[0]);
  if (!giverMap) return [];
  const mapIds = [giverMap.id, ...giverMap.connectedMapIds];
  // 討伐目標：附近需遭遇的單位，不含頭目與需要前置任務者。
  const targets = [...new Set(mapIds.flatMap((mapId) => getMapById(mapId)?.unitsPresent ?? []))].flatMap((unitId) => {
    const unit = getWorldUnitById(unitId, state);
    if (!unit?.requiresEncounter || unit.isBoss || unit.requiredQuestId || !isAlive(state, unit.id)) return [];
    if (unit.factionId && giver.factionId && (unit.factionId === giver.factionId ||
        ['friendly', 'alliance'].includes(getFactionRelation(state.world, unit.factionId, giver.factionId).status))) return [];
    return [unit];
  });
  if (template.type === 'defeat') {
    return targets.map((unit) => ({ targetUnitId: unit.id, name: unit.name, level: unit.level, expReward: unit.expReward }));
  }
  const byItem = new Map<string, TargetCandidate>();
  for (const unit of [...targets].sort((a, b) => a.level - b.level)) {
    for (const drop of unit.loot?.dropItems ?? []) {
      const item = getItemById(drop.itemId);
      if (!item || drop.chance <= 0 || byItem.has(item.id)) continue;
      byItem.set(item.id, { targetUnitId: unit.id, itemId: item.id, name: item.name, level: unit.level, expReward: unit.expReward });
    }
  }
  return [...byItem.values()];
}

const computeExp = (template: QuestTemplateStatic, target: TargetCandidate, quantity: number) =>
  Math.min(template.reward.maxExp, Math.round(target.expReward * quantity * template.reward.expRatio));

const computeValueCap = (template: QuestTemplateStatic, target: TargetCandidate, quantity: number) =>
  Math.min(template.reward.maxValue, target.level * template.reward.valuePerLevel * quantity);

/** AI 上下文：目前可提議的範本、發布者（含可作為報酬的持有物）與目標（含經驗與報酬上限）。沒有任何候選時回傳空陣列。 */
export function getQuestPostingOptions(state: QuestState) {
  if (openQuests(state).length >= questTemplateData.limits.maxOpenQuests) return [];
  const residents = getWorldUnitsAtMap(state.currentMapId, state).filter((unit) => !unit.requiresEncounter);
  return questTemplatesDatabase.filter((template) => templateConditionsMet(state, template)).flatMap((template) => {
    const givers = residents.filter((unit) => !giverBlockReason(state, template, unit)).flatMap((giver) => {
      const targets = getTargetCandidates(state, template, giver);
      if (!targets.length) return [];
      return [{
        giverId: giver.id,
        name: getUnitDisplayName(giver.id),
        targets: targets.map((target) => ({
          targetUnitId: target.targetUnitId,
          ...(target.itemId ? { itemId: target.itemId } : {}),
          name: target.name,
          quantity: template.quantity,
          expPerQuantity: computeExp(template, target, 1),
          rewardValuePerQuantity: computeValueCap(template, target, 1),
          maxRewardValue: template.reward.maxValue
        }))
      }];
    });
    return givers.length ? [{ templateId: template.id, type: template.type, name: template.name, when: template.aiHint, givers }] : [];
  });
}

/** 依規則組成報酬：先付金幣（不超過上限與發布者存量），剩餘額度再以發布者持有物中價值最高且放得下的物品補足。 */
function composeReward(holdings: { gold: number; inventory: ItemStack[] }, cap: number, maxItemQuantity: number, excludeItemId?: string) {
  const gold = Math.min(cap, holdings.gold);
  let remaining = cap - gold;
  const items: ItemStack[] = [];
  const stock = holdings.inventory.filter((entry) => entry.itemId !== excludeItemId && getItemRewardValue(entry.itemId) > 0)
    .map((entry) => ({ ...entry })).sort((a, b) => getItemRewardValue(b.itemId) - getItemRewardValue(a.itemId));
  let count = 0;
  for (const entry of stock) {
    const value = getItemRewardValue(entry.itemId);
    const quantity = Math.min(entry.quantity, maxItemQuantity - count, Math.floor(remaining / value));
    if (quantity <= 0) continue;
    items.push({ itemId: entry.itemId, quantity });
    count += quantity;
    remaining -= value * quantity;
  }
  return { gold, items };
}

const fillPattern = (pattern: string, target: string, quantity: number) =>
  pattern.replaceAll('{target}', target).replaceAll('{quantity}', String(quantity));

/** 驗證 AI 的委託提議；通過時回傳待發布的委託（尚未配發 ID、尚未預扣）。 */
export function validateQuestProposal(state: QuestState, proposal: QuestProposal):
  { ok: true; quest: Omit<GeneratedQuest, 'id'> } | { ok: false; reason: string } {
  const template = getQuestTemplateById(proposal.templateId);
  if (!template) return { ok: false, reason: '沒有這種委託範本' };
  if (!templateConditionsMet(state, template)) return { ok: false, reason: '目前不符合此範本的條件' };
  if (openQuests(state).length >= questTemplateData.limits.maxOpenQuests) return { ok: false, reason: '世界上開放中的委託已達上限' };
  const giver = getWorldUnitById(proposal.giverId, state);
  const blocked = giverBlockReason(state, template, giver);
  if (blocked || !giver) return { ok: false, reason: blocked ?? '發布者無效' };
  const quantity = proposal.quantity;
  if (!Number.isInteger(quantity) || quantity < template.quantity.min || quantity > template.quantity.max) return { ok: false, reason: `數量須介於 ${template.quantity.min}–${template.quantity.max}` };
  const candidates = getTargetCandidates(state, template, giver);
  // 收集範本以物品為準（目標單位由遊戲依掉落資料決定）；討伐範本以單位為準。
  const target = template.type === 'collect'
    ? candidates.find((candidate) => candidate.itemId === proposal.itemId)
    : candidates.find((candidate) => candidate.targetUnitId === proposal.targetUnitId);
  if (!target) return { ok: false, reason: '目標不是附近實際存在的單位或物品' };

  const holdings = state.unitInstances[giver.id];
  const cap = computeValueCap(template, target, quantity);
  const explicit = proposal.rewardGold !== undefined || (proposal.rewardItems?.length ?? 0) > 0;
  const reward = explicit
    ? { gold: proposal.rewardGold ?? 0, items: proposal.rewardItems ?? [] }
    : composeReward(holdings, cap, template.reward.maxItemQuantity, target.itemId);
  const gold = reward.gold;
  if (!Number.isInteger(gold) || gold < 0) return { ok: false, reason: '金幣報酬無效' };
  if (gold > holdings.gold) return { ok: false, reason: '發布者的金幣不足以支付報酬' };
  const items: ItemStack[] = [];
  for (const entry of reward.items) {
    if (!getItemById(entry.itemId) || !Number.isInteger(entry.quantity) || entry.quantity <= 0) return { ok: false, reason: '報酬物品無效' };
    if (entry.itemId === target.itemId) return { ok: false, reason: '報酬不可為要收集的物品本身' };
    const existing = items.find((item) => item.itemId === entry.itemId);
    if (existing) existing.quantity += entry.quantity;
    else items.push({ itemId: entry.itemId, quantity: entry.quantity });
  }
  for (const item of items) {
    if ((holdings.inventory.find((entry) => entry.itemId === item.itemId)?.quantity ?? 0) < item.quantity) return { ok: false, reason: '報酬物品不是發布者持有的物品或數量不足' };
  }
  if (items.reduce((sum, item) => sum + item.quantity, 0) > template.reward.maxItemQuantity) return { ok: false, reason: `報酬物品最多 ${template.reward.maxItemQuantity} 件` };
  const value = gold + items.reduce((sum, item) => sum + getItemRewardValue(item.itemId) * item.quantity, 0);
  if (value <= 0) return { ok: false, reason: '委託必須有報酬' };
  if (value > cap) return { ok: false, reason: `報酬價值 ${value} 超過上限 ${cap}` };

  return {
    ok: true,
    quest: {
      generated: true,
      templateId: template.id,
      targetUnitId: target.targetUnitId,
      title: fillPattern(template.titlePattern, target.name, quantity),
      questGiverId: giver.id,
      questGiver: getUnitDisplayName(giver.id),
      mapId: giver.mapIds[0],
      objective: fillPattern(template.objectivePattern, target.name, quantity),
      requirements: template.type === 'defeat'
        ? { defeatUnits: [{ unitId: target.targetUnitId, quantity }] }
        : { collectItems: [{ itemId: target.itemId!, quantity }] },
      rewards: { exp: computeExp(template, target, quantity), gold, items },
      status: 'open',
      postedAtMinutes: state.gameTimeMinutes,
      expiresAtMinutes: state.gameTimeMinutes + template.durationDays * MINUTES_PER_DAY
    }
  };
}

/** 發布通過驗證的委託：配發 ID、自發布者持有物預扣報酬並寫入世界狀態。每次最多發布一件。 */
export function postQuestProposals<T extends QuestState>(state: T, proposals: readonly QuestProposal[] = []):
  { state: T; posted: GeneratedQuest[]; rejected: string[] } {
  const proposal = proposals[0];
  if (!proposal) return { state, posted: [], rejected: [] };
  const result = validateQuestProposal(state, proposal);
  if (!result.ok) return { state, posted: [], rejected: [result.reason] };
  const quest: GeneratedQuest = { id: `QST-GEN-${String(state.world.nextGeneratedQuestSeq).padStart(4, '0')}`, ...result.quest };
  const holdings = state.unitInstances[quest.questGiverId];
  const inventory = holdings.inventory.map((entry) => ({ ...entry }));
  for (const item of quest.rewards.items ?? []) {
    const stock = inventory.find((entry) => entry.itemId === item.itemId)!;
    stock.quantity -= item.quantity;
  }
  return {
    state: {
      ...state,
      unitInstances: { ...state.unitInstances, [quest.questGiverId]: { ...holdings, gold: holdings.gold - quest.rewards.gold, inventory: inventory.filter((entry) => entry.quantity > 0) } },
      world: { ...state.world, generatedQuests: [...state.world.generatedQuests, quest], nextGeneratedQuestSeq: state.world.nextGeneratedQuestSeq + 1 }
    },
    posted: [quest],
    rejected: proposals.length > 1 ? ['每次最多發布一件委託，其餘提議已忽略'] : []
  };
}

/** 結束一件生成委託：改變狀態，失敗或逾期時把預扣的報酬退回目前負責的委託人（即使已死亡，也留在其持有物中）。 */
export function closeGeneratedQuest<T extends Pick<PlayerState, 'world' | 'unitInstances'>>(state: T, questId: string, status: 'failed' | 'expired', giverId: string): T {
  const quest = state.world.generatedQuests.find((entry) => entry.id === questId);
  if (!quest || quest.status !== 'open') return state;
  const holdings = state.unitInstances[giverId];
  const unitInstances = { ...state.unitInstances };
  if (holdings) {
    const inventory = holdings.inventory.map((entry) => ({ ...entry }));
    for (const item of quest.rewards.items ?? []) {
      const owned = inventory.find((entry) => entry.itemId === item.itemId);
      if (owned) owned.quantity += item.quantity;
      else inventory.push({ ...item });
    }
    unitInstances[giverId] = { ...holdings, gold: holdings.gold + quest.rewards.gold, inventory };
  }
  return {
    ...state,
    unitInstances,
    world: { ...state.world, generatedQuests: state.world.generatedQuests.map((entry) => entry.id === questId ? { ...entry, status } : entry) }
  };
}

/** 逾期的生成委託失效並退回報酬；已被目前角色接取的改為失敗。 */
export function expireGeneratedQuests<T extends QuestState>(state: T): T {
  let next = state;
  for (const quest of state.world.generatedQuests) {
    if (quest.status !== 'open' || state.gameTimeMinutes < quest.expiresAtMinutes) continue;
    const active = next.activeQuests.find((entry) => entry.questId === quest.id && entry.status === 'in_progress');
    next = closeGeneratedQuest(next, quest.id, 'expired', getActiveQuestGiverId(active, quest.questGiverId));
    if (active) next = { ...next, activeQuests: next.activeQuests.map((entry) => entry === active ? { ...entry, status: 'failed' as const } : entry) };
  }
  return next;
}

/** 移除舊的已結束委託；目前角色任務清單引用的委託保留。 */
export function pruneGeneratedQuests<T extends QuestState>(state: T): T {
  const finished = state.world.generatedQuests.filter((quest) => quest.status !== 'open' && !state.activeQuests.some((entry) => entry.questId === quest.id));
  if (finished.length <= MAX_FINISHED_GENERATED_QUESTS) return state;
  const removed = new Set(finished.slice(0, finished.length - MAX_FINISHED_GENERATED_QUESTS).map((quest) => quest.id));
  return { ...state, world: { ...state.world, generatedQuests: state.world.generatedQuests.filter((quest) => !removed.has(quest.id)) } };
}

/** 標記生成委託已完成（報酬已由交付流程自預扣中發放）。 */
export const markGeneratedQuestCompleted = (world: PlayerState['world'], questId: string): PlayerState['world'] => ({
  ...world,
  generatedQuests: world.generatedQuests.map((quest) => quest.id === questId && quest.status === 'open' ? { ...quest, status: 'completed' } : quest)
});

