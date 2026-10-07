import type { AgentCondition, AgentDecision, AgentFallbackRule, AgentRuntimeState, PlayerState, WorldRuntimeState } from '../types/game';
import {
  agentRules,
  FACTION_RELATION_STATUSES,
  getEventById,
  getFactionById,
  getFactionRelation,
  getMapById,
  getQuestTemplateById,
  getResidentUnitIds,
  getUnitDisplayName,
  getUnitTemplateById,
  getWorldUnitById,
  unitTemplatesDatabase
} from '../data/staticData';
import { applyFactionRelationChanges, matchesFactionConditions, RELATION_NAMES } from './factions';
import { getQuestTargetOptions, postQuestProposals, validateQuestProposal } from './generatedQuests';
import { getGameDay } from './gameTime';
import { appendEvent, applyScenarioEvent, canTriggerEvent, findQuestSuccessor, getEventKnowledgeLevel, hasUnitDied, isUnitAlive } from './worldEvents';

/**
 * 重要角色決策（O34 第 1 階段）。
 * 設有 agent 的單位每個遊戲日決策一次，只能從合法行動中選擇；前端驗證後套用，影響世界的結果以事件寫入紀錄。
 * 第 1 階段一律使用規則後備（ruleFallback）；AI 決策（第 2 階段）沿用同一套驗證與套用。
 */

const EMPTY_AGENT_STATE: AgentRuntimeState = { actionDays: {} };

export const getAgentState = (world: Pick<WorldRuntimeState, 'agents'>, unitId: string): AgentRuntimeState =>
  world.agents[unitId] ?? EMPTY_AGENT_STATE;

/** 角色的身分：自己，加上依序接手的已故角色。事件的 agentUnitIds 與這些身分比對。 */
export const getAgentIdentityIds = (world: Pick<WorldRuntimeState, 'agents'>, unitId: string): string[] =>
  [unitId, ...(getAgentState(world, unitId).inheritedFrom ?? [])];

export interface EffectiveAgentProfile {
  goals: string[];
  traits: string[];
  leaderOf?: string;
  ruleFallback: AgentFallbackRule[];
  inheritedFrom: string[];
}

/**
 * 角色目前的盤算：自身設定加上接手的已故角色設定。個性只取自身（沒有自身設定時取第一位接手對象）；
 * 規則後備依序為自身與接手對象的非 idle 規則，最後一條為 idle。只有與角色同勢力的領袖身分會被接手。
 * 不是重要角色時回傳 undefined。
 */
export function getEffectiveAgentProfile(world: Pick<WorldRuntimeState, 'agents'>, unitId: string): EffectiveAgentProfile | undefined {
  const unit = getUnitTemplateById(unitId);
  const ids = getAgentIdentityIds(world, unitId);
  const profiles = ids.flatMap((id) => {
    const agent = getUnitTemplateById(id)?.agent;
    return agent ? [{ id, agent }] : [];
  });
  if (!unit || !profiles.length) return undefined;
  const inheritedFrom = ids.slice(1);
  const idle = profiles.flatMap(({ agent }) => agent.ruleFallback.filter((rule) => rule.action === 'idle' && !rule.when))[0];
  return {
    goals: profiles.flatMap(({ id, agent }) => id === unitId ? agent.goals : agent.goals.map((goal) => `（承接${getUnitDisplayName(id)}）${goal}`)),
    traits: profiles[0].agent.traits,
    leaderOf: profiles.map(({ agent }) => agent.leaderOf).find((factionId) => !!factionId && factionId === unit.factionId),
    ruleFallback: [
      ...profiles.flatMap(({ agent }) => agent.ruleFallback.filter((rule) => rule.action !== 'idle')),
      ...(idle ? [idle] : [{ action: 'idle' as const, intent: '暫時按兵不動。' }])
    ],
    inheritedFrom
  };
}

/** 角色的居所（決策的發生地）：居民為其居住地，需遭遇的單位為第一個出沒地區。 */
const getAgentHomeMapId = (unitId: string) => getWorldUnitById(unitId)?.homeMapId ?? '';

/** 目前會決策的重要角色：存活、未潛伏，且自身或接手的對象設有 agent。 */
export function getActiveAgentIds(state: PlayerState): string[] {
  return unitTemplatesDatabase().filter((unit) => isUnitAlive(state, unit.id) && !state.unitInstances[unit.id]?.isDormant &&
    !!getEffectiveAgentProfile(state.world, unit.id)).map((unit) => unit.id);
}

/** 角色知道某單位已經死亡：死亡事件在紀錄中且角色有認知；已壓縮進編年史的舊死亡視為眾所周知的往事。 */
function knowsDeath(state: PlayerState, unitId: string, victimId: string): boolean {
  if (!hasUnitDied(state.unitInstances[victimId])) return false;
  const event = [...state.world.events].reverse().find((entry) => entry.type === 'unit_death' && entry.death?.victimUnitId === victimId);
  return !event || !!getEventKnowledgeLevel(state, event, unitId);
}

/** 角色知道某劇本事件已經發生（判定方式同 knowsDeath）。 */
function knowsScenarioEvent(state: PlayerState, unitId: string, eventId: string): boolean {
  if (!state.world.firedEventIds.includes(eventId)) return false;
  const event = [...state.world.events].reverse().find((entry) => entry.eventId === eventId);
  return !event || !!getEventKnowledgeLevel(state, event, unitId);
}

/** 規則後備的條件是否成立；已知死亡與已知事件依角色的認知判定，不是全知。 */
export function matchesAgentCondition(state: PlayerState, unitId: string, when: AgentCondition = {}): boolean {
  return (when.flags ?? []).every((flag) => state.storyFlags[flag] === true) &&
    !(when.excludesFlags ?? []).some((flag) => state.storyFlags[flag] === true) &&
    matchesFactionConditions(state, when) &&
    (when.knownDeaths ?? []).every((victimId) => knowsDeath(state, unitId, victimId)) &&
    (when.knownEvents ?? []).every((eventId) => knowsScenarioEvent(state, unitId, eventId));
}

/** 勢力關係往某方向移動一階後的狀態；已在盡頭時為 undefined。 */
function stepRelation(status: (typeof FACTION_RELATION_STATUSES)[number], direction: 'worse' | 'better') {
  const index = FACTION_RELATION_STATUSES.indexOf(status) + (direction === 'worse' ? -1 : 1);
  return FACTION_RELATION_STATUSES[index];
}

/** 已到達或越過 until 的關係不再往同方向移動。 */
function reachedUntil(status: (typeof FACTION_RELATION_STATUSES)[number], direction: 'worse' | 'better', until?: (typeof FACTION_RELATION_STATUSES)[number]) {
  if (!until) return false;
  const current = FACTION_RELATION_STATUSES.indexOf(status);
  const limit = FACTION_RELATION_STATUSES.indexOf(until);
  return direction === 'worse' ? current <= limit : current >= limit;
}

export type AgentDecisionCheck = { ok: true } | { ok: false; reason: string };

/** 驗證一次決策：角色仍會決策、行動不在冷卻中、行動的前置條件成立。規則後備與 AI 決策共用。 */
export function validateAgentDecision(state: PlayerState, decision: AgentDecision, day: number): AgentDecisionCheck {
  const profile = getEffectiveAgentProfile(state.world, decision.unitId);
  if (!profile || !getActiveAgentIds(state).includes(decision.unitId)) return { ok: false, reason: '角色目前無法決策' };
  const cooldown = agentRules.actions[decision.action]?.cooldownDays;
  if (cooldown === undefined) return { ok: false, reason: '不是合法的行動' };
  const lastDay = getAgentState(state.world, decision.unitId).actionDays[decision.action];
  if (lastDay !== undefined && cooldown > 0 && day < lastDay + cooldown) return { ok: false, reason: `${agentRules.actions[decision.action].label}仍在冷卻中` };
  if (!decision.intent.trim()) return { ok: false, reason: '缺少動機' };
  const params = decision.params;
  if (decision.action === 'idle') return { ok: true };
  if (decision.action === 'post_quest') {
    if (!params.templateId || !params.targetUnitId || params.quantity === undefined) return { ok: false, reason: '委託缺少範本、目標或數量' };
    const result = validateQuestProposal(state, {
      templateId: params.templateId, giverId: decision.unitId, targetUnitId: params.targetUnitId, itemId: params.itemId ?? null, quantity: params.quantity,
      ...(params.rewardGold !== undefined ? { rewardGold: params.rewardGold } : {}), ...(params.rewardItems ? { rewardItems: params.rewardItems } : {})
    }, { requirePresence: false });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }
  if (decision.action === 'trigger_event') {
    const event = params.eventId ? getEventById(params.eventId) : undefined;
    if (event?.trigger !== 'agent') return { ok: false, reason: '不是重要角色可觸發的事件' };
    const identity = getAgentIdentityIds(state.world, decision.unitId);
    if (!(event.agentUnitIds ?? []).some((unitId) => identity.includes(unitId))) return { ok: false, reason: '這個角色不能觸發此事件' };
    return canTriggerEvent(state, event, getAgentHomeMapId(decision.unitId)) ? { ok: true } : { ok: false, reason: '事件的條件不成立' };
  }
  // change_faction_relation：只有勢力領袖，每次一階。
  if (!profile.leaderOf) return { ok: false, reason: '只有勢力領袖可以改變勢力關係' };
  if (!params.factionId || !getFactionById(params.factionId) || params.factionId === profile.leaderOf) return { ok: false, reason: '對象勢力無效' };
  if (params.direction !== 'worse' && params.direction !== 'better') return { ok: false, reason: '方向無效' };
  const current = getFactionRelation(state.world, profile.leaderOf, params.factionId).status;
  return stepRelation(current, params.direction) ? { ok: true } : { ok: false, reason: '勢力關係已到盡頭' };
}

/** 決策的發生地與目擊者：角色居所的存活居民。 */
function agentWitnesses(state: PlayerState, unitId: string) {
  const map = getMapById(getAgentHomeMapId(unitId));
  return { mapId: map?.id ?? state.currentMapId, witnessUnitIds: map ? getResidentUnitIds(map).filter((residentId) => isUnitAlive(state, residentId)) : [] };
}

const withActionDay = (state: PlayerState, unitId: string, decision: AgentDecision, day: number): PlayerState => {
  const current = getAgentState(state.world, unitId);
  return { ...state, world: { ...state.world, agents: { ...state.world.agents, [unitId]: { ...current, actionDays: { ...current.actionDays, [decision.action]: day } } } } };
};

/**
 * 套用通過驗證的決策並記錄冷卻。維持現狀不寫事件；其他行動以事件寫入紀錄，動機寫在事件經過（只有目擊者知道）。
 * 未通過驗證時不改動狀態。
 */
export function applyAgentDecision(state: PlayerState, decision: AgentDecision, day: number): PlayerState {
  if (!validateAgentDecision(state, decision, day).ok) return state;
  const unitId = decision.unitId;
  const name = getUnitDisplayName(unitId);
  const agent = { unitId, action: decision.action, intent: decision.intent };
  const cause = `重要角色決策（${name}${decision.source === 'ai' ? '，AI' : '，規則'}）`;
  const params = decision.params;
  let next = withActionDay(state, unitId, decision, day);
  if (decision.action === 'post_quest') {
    const posting = postQuestProposals(next, [{
      templateId: params.templateId!, giverId: unitId, targetUnitId: params.targetUnitId!, itemId: params.itemId ?? null, quantity: params.quantity!,
      ...(params.rewardGold !== undefined ? { rewardGold: params.rewardGold } : {}), ...(params.rewardItems ? { rewardItems: params.rewardItems } : {})
    }], { requirePresence: false });
    const quest = posting.posted[0];
    if (!quest) return state;
    const summary = `${name}發布了委託「${quest.title}」。`;
    return appendEvent(posting.state, {
      type: 'agent_action', gameTimeMinutes: next.gameTimeMinutes, ...agentWitnesses(next, unitId), summary, detail: `${summary}用意：${decision.intent}`,
      knownBy: 'region', cause, agent, changes: { questIds: [quest.id], unitIds: [unitId] }
    }).state;
  }
  if (decision.action === 'trigger_event') {
    const result = applyScenarioEvent(next, getEventById(params.eventId!)!, cause, { atMapId: getAgentHomeMapId(unitId), agent });
    return result === next ? state : result;
  }
  if (decision.action === 'change_faction_relation') {
    const leaderOf = getEffectiveAgentProfile(next.world, unitId)!.leaderOf!;
    const status = stepRelation(getFactionRelation(next.world, leaderOf, params.factionId!).status, params.direction!)!;
    next = { ...next, world: applyFactionRelationChanges(next.world, [{ factionIds: [leaderOf, params.factionId!], status }]) };
    const summary = `${getFactionById(leaderOf)?.name ?? leaderOf}與${getFactionById(params.factionId!)?.name ?? params.factionId}的關係${params.direction === 'worse' ? '惡化' : '改善'}為「${RELATION_NAMES[status]}」。`;
    return appendEvent(next, {
      type: 'agent_action', gameTimeMinutes: next.gameTimeMinutes, ...agentWitnesses(next, unitId), summary,
      detail: `${summary}這是${name}的決定，用意：${decision.intent}`,
      knownBy: 'faction', knownByFactions: [leaderOf, params.factionId!], cause, agent, changes: { factionIds: [leaderOf, params.factionId!], unitIds: [unitId] }
    }).state;
  }
  return next;
}

/** 由一條規則後備產生決策；條件不成立或沒有合法參數時為 undefined（尚未檢查冷卻與前置條件）。 */
function decisionFromRule(state: PlayerState, unitId: string, rule: AgentFallbackRule, leaderOf?: string): AgentDecision | undefined {
  if (!matchesAgentCondition(state, unitId, rule.when)) return undefined;
  const base = { unitId, action: rule.action, intent: rule.intent, source: 'rule' as const };
  if (rule.action === 'post_quest') {
    const template = rule.templateId ? getQuestTemplateById(rule.templateId) : undefined;
    const target = template ? getQuestTargetOptions(state, template.id, unitId, { requirePresence: false })[0] : undefined;
    if (!template || !target) return undefined;
    return { ...base, params: { templateId: template.id, targetUnitId: target.targetUnitId, itemId: target.itemId ?? null, quantity: rule.quantity ?? template.quantity.min } };
  }
  if (rule.action === 'trigger_event') return { ...base, params: { eventId: rule.eventId } };
  if (rule.action === 'change_faction_relation') {
    if (!leaderOf || !rule.factionId || !rule.direction) return undefined;
    if (reachedUntil(getFactionRelation(state.world, leaderOf, rule.factionId).status, rule.direction, rule.until)) return undefined;
    return { ...base, params: { factionId: rule.factionId, direction: rule.direction } };
  }
  return { ...base, params: {} };
}

/** 規則後備：依序找第一條條件成立且通過驗證的規則；都不成立時維持現狀。 */
export function decideByRule(state: PlayerState, unitId: string, day: number): AgentDecision {
  const profile = getEffectiveAgentProfile(state.world, unitId);
  for (const rule of profile?.ruleFallback ?? []) {
    const decision = decisionFromRule(state, unitId, rule, profile?.leaderOf);
    if (decision && validateAgentDecision(state, decision, day).ok) return decision;
  }
  return { unitId, action: 'idle', params: {}, intent: '暫時按兵不動。', source: 'rule' };
}

/**
 * 死亡與繼承：重要角色（含已接手他人的角色）死亡後停止決策，盤算依序交給資料指定的接手人選（存活的居民），
 * 其次是同勢力、同職階的存活居民（與委託接手相同）；接手時寫入事件。每位死者只處理一次。
 */
function resolveAgentSuccessions(state: PlayerState): PlayerState {
  let next = state;
  for (const unit of unitTemplatesDatabase()) {
    const record = getAgentState(next.world, unit.id);
    if (record.succeededBy !== undefined || !hasUnitDied(next.unitInstances[unit.id])) continue;
    const profile = getEffectiveAgentProfile(next.world, unit.id);
    if (!profile) continue;
    const explicit = [unit.id, ...profile.inheritedFrom].flatMap((id) => getUnitTemplateById(id)?.agent?.successors ?? []);
    const successorId = explicit.find((id) => isUnitAlive(next, id) && !getUnitTemplateById(id)?.requiresEncounter) ?? findQuestSuccessor(next, unit.id) ?? '';
    const agents = { ...next.world.agents, [unit.id]: { ...record, succeededBy: successorId } };
    if (successorId) {
      const successor = getAgentState(next.world, successorId);
      agents[successorId] = { ...successor, inheritedFrom: [...new Set([...(successor.inheritedFrom ?? []), unit.id, ...profile.inheritedFrom])] };
    }
    next = { ...next, world: { ...next.world, agents } };
    if (!successorId) continue;
    const factionId = getUnitTemplateById(successorId)?.factionId;
    const summary = `${getUnitDisplayName(successorId)}接下了${getUnitDisplayName(unit.id)}生前的職責。`;
    const intent = `承接${getUnitDisplayName(unit.id)}未竟的盤算：${profile.goals.join('；')}`;
    next = appendEvent(next, {
      type: 'agent_action', gameTimeMinutes: next.gameTimeMinutes, ...agentWitnesses(next, successorId), summary, detail: `${summary}${intent}`,
      knownBy: factionId ? 'faction' : 'region', ...(factionId ? { knownByFactions: [factionId] } : {}), cause: '重要角色死亡，由接手者承接盤算',
      agent: { unitId: successorId, action: 'succession', intent }, changes: { unitIds: [unit.id, successorId] }
    }).state;
  }
  return next;
}

/**
 * 每日決策：先處理死亡角色的接手；行動跨過遊戲日時，每個新的一天每位重要角色決策一次。
 * 跨多日時逐日補算，最多補算最近 maxCatchUpDays 天。第 1 階段每天都使用規則後備。
 */
export function settleAgents(previous: PlayerState, state: PlayerState): PlayerState {
  let next = resolveAgentSuccessions(state);
  const fromDay = getGameDay(previous.gameTimeMinutes);
  const toDay = getGameDay(next.gameTimeMinutes);
  if (toDay <= fromDay) return next;
  for (let day = Math.max(fromDay + 1, toDay - agentRules.maxCatchUpDays + 1); day <= toDay; day += 1) {
    for (const unitId of getActiveAgentIds(next)) next = applyAgentDecision(next, decideByRule(next, unitId, day), day);
  }
  return next;
}
