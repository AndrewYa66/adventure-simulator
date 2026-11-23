import type { PlayerState } from '../types/game';
import type { AIModelSettings } from './aiModels';
import { agentRules, getUnitDisplayName } from '../data/staticData';
import { estimateTokens, noteAICall } from './aiContext';
import { extractResponseText } from './aiService';
import { applyAgentBatch, type AgentBatch, type AgentBatchOutcome } from '../utils/agents';
import { buildAgentBatchRequest, parseAgentDecisionResponse, type AgentBatchRequest } from './agentDecisionContext';

/**
 * 重要角色 AI 批次決策的呼叫（O34 第 2 階段）。與主持人相同的服務與模型；只送一次，不重試，逾時 timeoutMs。
 * 任何整批失敗（連線、HTTP 錯誤含 429、逾時、格式錯誤）都改用規則後備，不在故事中顯示。
 */

/** 上一次角色決策（設定頁與除錯面板）。 */
export interface AgentDecisionReport {
  builtAt: number;
  /** 'ai'：有回應且至少一位角色採用 AI；'rule'：整批改用規則後備。 */
  result: 'ai' | 'rule' | 'pending';
  /** 整批改用規則時的原因，或部分角色改用規則的說明。 */
  reason?: string;
  agentCount: number;
  estimatedTokens: number;
  totalChars: number;
  systemPrompt: string;
  userPrompt: string;
  /** 模型原始回應（截斷），供開發模式檢視。 */
  responseText?: string;
  outcomes: { name: string; source: 'ai' | 'rule'; reason?: string }[];
}

let lastAgentReport: AgentDecisionReport | null = null;
const agentReportListeners = new Set<() => void>();
export const subscribeAgentDecisionReport = (listener: () => void) => {
  agentReportListeners.add(listener);
  return () => { agentReportListeners.delete(listener); };
};
export const getLastAgentDecisionReport = () => lastAgentReport;
export function recordAgentDecisionReport(report: AgentDecisionReport | null) {
  lastAgentReport = report;
  for (const listener of agentReportListeners) listener();
}

/** 送出請求並回傳模型的原始文字；失敗時丟出可讀的原因。 */
export async function requestAgentDecisionText(settings: AIModelSettings, apiKey: string, request: AgentBatchRequest, timeoutMs = agentRules.ai.timeoutMs): Promise<string> {
  const isOpenAI = settings.provider === 'openai';
  const endpoint = isOpenAI
    ? 'https://api.openai.com/v1/responses'
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`;
  const body = isOpenAI
    ? { model: settings.model, instructions: request.systemPrompt, input: request.userPrompt, text: { format: { type: 'json_object' } } }
    : {
        contents: [{ role: 'user', parts: [{ text: `${request.systemPrompt}\n\n${request.userPrompt}` }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: request.responseSchema }
      };
  const headers: Record<string, string> = isOpenAI
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey.trim()}` }
    : { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  noteAICall();
  try {
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    if (response.status === 429) throw new Error('AI 額度用完或請求太頻繁（HTTP 429）');
    if (!response.ok) throw new Error(`AI 服務回應 HTTP ${response.status}`);
    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      throw new Error('回應不是 JSON', { cause: error });
    }
    return extractResponseText(data, settings.provider);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`逾時（${Math.round(timeoutMs / 1000)} 秒）`, { cause: error });
    if (error instanceof Error && (/HTTP \d+/.test(error.message) || error.message === '回應不是 JSON')) throw error;
    throw new Error('無法連線至 AI 服務', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

export interface AgentBatchResolution {
  state: PlayerState;
  outcomes: AgentBatchOutcome[];
  report: AgentDecisionReport;
}

const describeOutcomes = (outcomes: AgentBatchOutcome[]) =>
  outcomes.map((outcome) => ({ name: getUnitDisplayName(outcome.unitId), source: outcome.source, ...(outcome.reason ? { reason: outcome.reason } : {}) }));

/** 組裝請求的報告（送出前記錄，供除錯面板與設定頁顯示請求大小）。 */
export function createPendingReport(request: AgentBatchRequest): AgentDecisionReport {
  const totalChars = request.systemPrompt.length + request.userPrompt.length;
  return {
    builtAt: Date.now(), result: 'pending', agentCount: request.agents.length, estimatedTokens: estimateTokens(request.systemPrompt + request.userPrompt),
    totalChars, systemPrompt: request.systemPrompt, userPrompt: request.userPrompt, outcomes: []
  };
}

/**
 * 依回應文字（或整批失敗原因）套用一批角色的決策，並產生報告。
 * responseText 為 undefined 時整批改用規則後備（failure 為原因）。
 */
export function resolveAgentBatch(state: PlayerState, request: AgentBatchRequest, responseText: string | undefined, failure?: string): AgentBatchResolution {
  const pending = createPendingReport(request);
  const parsed = responseText !== undefined ? parseAgentDecisionResponse(responseText, request) : { ok: false as const, reason: failure ?? '沒有 AI 回應' };
  const batch: AgentBatch = request.batch;
  if (!parsed.ok) {
    const result = applyAgentBatch(state, batch, {}, parsed.reason);
    return { ...result, report: { ...pending, result: 'rule', reason: parsed.reason, ...(responseText ? { responseText: responseText.slice(0, 2000) } : {}), outcomes: describeOutcomes(result.outcomes) } };
  }
  const rejectedReasons = Object.fromEntries(parsed.rejected.map((entry) => [entry.unitId, entry.reason]));
  const result = applyAgentBatch(state, batch, parsed.choices, 'AI 沒有回應這位角色');
  const outcomes = result.outcomes.map((outcome) => outcome.source === 'rule'
    ? { ...outcome, reason: request.omittedUnitIds.includes(outcome.unitId) ? '請求字數超過上限，未送出'
      : !request.agents.some((entry) => entry.unitId === outcome.unitId) ? '只剩維持現狀，未送出'
      : rejectedReasons[outcome.unitId] ?? outcome.reason } : outcome);
  const ruleCount = outcomes.filter((outcome) => outcome.source === 'rule').length;
  const aiCount = outcomes.length - ruleCount;
  return {
    state: result.state,
    outcomes,
    report: {
      ...pending,
      result: aiCount > 0 ? 'ai' : 'rule',
      ...(ruleCount ? { reason: aiCount > 0 ? `${ruleCount} 位角色改用規則` : outcomes[0]?.reason ?? '回應無效' } : {}),
      responseText: responseText!.slice(0, 2000),
      outcomes: describeOutcomes(outcomes)
    }
  };
}

export { buildAgentBatchRequest };
