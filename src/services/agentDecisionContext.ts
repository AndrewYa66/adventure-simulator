import type { AgentDecision, PlayerState } from '../types/game';
import { agentRules, scenario, factionsDatabase, getFactionById, getFactionRelation, getMapById, getUnitDisplayName, getUnitTemplateById, getWorldUnitById } from '../data/staticData';
import { RELATION_NAMES } from '../utils/factions';
import { formatGameTime } from '../utils/gameTime';
import { getEffectiveAgentProfile, listAgentCandidates, type AgentBatch, type AgentCandidate } from '../utils/agents';
import { getKnownEventsForUnit, KNOWLEDGE_LABELS } from '../utils/worldEvents';
import { getUnitMemoriesForAI } from '../utils/unitMemory';

/**
 * 重要角色 AI 批次決策的請求與回應（O34 第 2 階段）。
 * 與主持人回應格式各自獨立：角色決策格式第 1 版（agentFormatVersion: 1），AI 只回 { unitId, candidateId, intent }，
 * 前端換回候選的 action／params，再交給 applyAgentBatch 驗證與套用。
 */

export const AGENT_FORMAT_VERSION = 1;

export interface AgentRequestEntry {
  unitId: string;
  candidates: AgentCandidate[];
}

export interface AgentBatchRequest {
  batch: AgentBatch;
  /** 實際送出的角色（依優先順序）；因字數上限省略的角色不在其中，改用規則。 */
  agents: AgentRequestEntry[];
  /** 因請求字數上限省略的角色。 */
  omittedUnitIds: string[];
  /** 每人實際附上的已知事件數上限（超出字數時減少）。 */
  knownEventsPerAgent: number;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: Record<string, unknown>;
}

const SYSTEM_PROMPT = `你是${scenario.worldDescription}的「重要角色決策者」。世界剛進入新的一天，以下每位角色要決定今天做什麼。
規則：
1. 每位角色只能從他自己的「候選行動」中選一個，以候選編號（例如 C2）回答；不可自創行動或使用其他角色的編號。
2. 依角色的盤算、個性、所在勢力的立場、對玩家的記憶，以及他「已知的事件」做判斷。角色只知道列出的事件；不可依據未列出的事情決策。
3. 「維持現狀」是合理的選擇；只有在角色的盤算或已知事件讓他有理由時才採取其他行動。
4. intent 以角色的視角用一句話說明動機（繁體中文，${agentRules.ai.maxIntentChars} 字以內），不可提到角色不知道的事，也不要提到候選編號。
5. 每位角色回答一次。只輸出 JSON：{"agentFormatVersion": ${AGENT_FORMAT_VERSION}, "decisions": [{"unitId": "...", "candidateId": "C1", "intent": "..."}]}`;

/** 角色所屬勢力與其他勢力的立場；中立且沒有附加關係的勢力省略。 */
function describeFactionStance(state: PlayerState, factionId: string | undefined) {
  if (!factionId) return undefined;
  const relations = factionsDatabase.filter((faction) => faction.id !== factionId).flatMap((faction) => {
    const relation = getFactionRelation(state.world, factionId, faction.id);
    return relation.status !== 'neutral' ? [{ faction: faction.name, status: RELATION_NAMES[relation.status] }] : [];
  });
  return { faction: getFactionById(factionId)?.name ?? factionId, relations, others: '未列出的勢力為中立' };
}

/** 一位角色的上下文區段：盤算、個性、所在地、勢力立場、人物記憶、最近的已知事件與候選行動。 */
function describeAgent(state: PlayerState, entry: AgentRequestEntry, maxEvents: number) {
  const profile = getEffectiveAgentProfile(state.world, entry.unitId);
  const unit = getWorldUnitById(entry.unitId, state);
  const known = maxEvents > 0 ? getKnownEventsForUnit(state, entry.unitId).slice(-maxEvents) : [];
  const memories = getUnitMemoriesForAI(state, entry.unitId);
  return {
    unitId: entry.unitId,
    name: getUnitDisplayName(entry.unitId),
    ...(unit?.title ? { title: unit.title } : {}),
    location: getMapById(unit?.homeMapId ?? '')?.name ?? unit?.homeMapId ?? '',
    goals: profile?.goals ?? [],
    traits: profile?.traits ?? [],
    ...(profile?.leaderOf ? { leaderOf: getFactionById(profile.leaderOf)?.name ?? profile.leaderOf } : {}),
    ...(() => {
      const stance = describeFactionStance(state, getUnitTemplateById(entry.unitId)?.factionId);
      return stance ? { factionStance: stance } : {};
    })(),
    ...(memories.length ? { memoriesOfPlayer: memories } : {}),
    knownEvents: known.map(({ event, level, knows }) => ({
      time: formatGameTime(event.gameTimeMinutes),
      place: getMapById(event.mapId)?.name ?? event.mapId,
      knowledge: KNOWLEDGE_LABELS[level],
      content: knows
    })),
    candidates: entry.candidates.map((candidate) => ({ id: candidate.id, action: candidate.label }))
  };
}

const renderUserPrompt = (state: PlayerState, agents: AgentRequestEntry[], maxEvents: number) =>
  `【今天】${formatGameTime(state.gameTimeMinutes)}\n【角色】\n${agents.map((entry) => JSON.stringify(describeAgent(state, entry, maxEvents))).join('\n')}`;

/**
 * 組裝一批角色的請求。候選以目前狀態重算（只剩維持現狀的角色不送）；整個請求超過 maxRequestChars 時，
 * 先逐步減少每人的已知事件數，仍超出才從優先順序最低的角色開始省略（省略的角色改用規則）。
 */
export function buildAgentBatchRequest(state: PlayerState, batch: AgentBatch): AgentBatchRequest {
  const { maxKnownEventsPerAgent, maxRequestChars } = agentRules.ai;
  const eligible = batch.unitIds.map((unitId) => ({ unitId, candidates: listAgentCandidates(state, unitId, batch.day) }))
    .filter((entry) => entry.candidates.length > 1);
  let agents = eligible;
  let maxEvents = maxKnownEventsPerAgent;
  const size = () => SYSTEM_PROMPT.length + renderUserPrompt(state, agents, maxEvents).length;
  while (size() > maxRequestChars && maxEvents > 0) maxEvents -= 1;
  while (size() > maxRequestChars && agents.length > 0) agents = agents.slice(0, -1);
  const unitIds = agents.map((entry) => entry.unitId);
  const candidateIds = [...new Set(agents.flatMap((entry) => entry.candidates.map((candidate) => candidate.id)))];
  return {
    batch,
    agents,
    omittedUnitIds: eligible.filter((entry) => !unitIds.includes(entry.unitId)).map((entry) => entry.unitId),
    knownEventsPerAgent: maxEvents,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: renderUserPrompt(state, agents, maxEvents),
    responseSchema: {
      type: 'object',
      properties: {
        agentFormatVersion: { type: 'integer', enum: [AGENT_FORMAT_VERSION] },
        decisions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              unitId: { type: 'string', enum: unitIds.length ? unitIds : [''] },
              candidateId: { type: 'string', enum: candidateIds.length ? candidateIds : [''] },
              intent: { type: 'string' }
            },
            required: ['unitId', 'candidateId', 'intent']
          }
        }
      },
      required: ['agentFormatVersion', 'decisions']
    }
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export type ParsedAgentResponse =
  | { ok: true; choices: Record<string, AgentDecision>; rejected: { unitId: string; reason: string }[] }
  | { ok: false; reason: string };

/**
 * 解析角色決策回應。整份不是 JSON、版本不符或沒有 decisions 陣列時整批無效；
 * 個別項目無效（未知角色、編號不在該角色的候選中、缺動機）只略過該角色。動機超過上限時截斷；同一角色重複時取第一個。
 */
export function parseAgentDecisionResponse(text: string, request: AgentBatchRequest): ParsedAgentResponse {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim());
  } catch {
    return { ok: false, reason: '回應不是 JSON' };
  }
  if (!isRecord(value) || value.agentFormatVersion !== AGENT_FORMAT_VERSION || !Array.isArray(value.decisions)) return { ok: false, reason: '回應格式錯誤' };
  const choices: Record<string, AgentDecision> = {};
  const rejected: { unitId: string; reason: string }[] = [];
  for (const entry of value.decisions) {
    const unitId = isRecord(entry) && typeof entry.unitId === 'string' ? entry.unitId : '';
    const agent = request.agents.find((candidate) => candidate.unitId === unitId);
    if (!agent) { rejected.push({ unitId, reason: '不是本批的角色' }); continue; }
    if (choices[unitId]) continue;
    const candidate = isRecord(entry) ? agent.candidates.find((option) => option.id === entry.candidateId) : undefined;
    if (!candidate) { rejected.push({ unitId, reason: '候選編號不在清單中' }); continue; }
    // 以字元（code point）截斷，避免把 emoji 或罕用字切成一半。
    const intent = isRecord(entry) && typeof entry.intent === 'string' ? Array.from(entry.intent.replace(/\s+/g, ' ').trim()).slice(0, agentRules.ai.maxIntentChars).join('') : '';
    if (!intent) { rejected.push({ unitId, reason: '缺少動機' }); continue; }
    choices[unitId] = { ...candidate.decision, intent, source: 'ai' };
  }
  return { ok: true, choices, rejected };
}
