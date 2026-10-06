import type { PlayerState, AIResponsePayload, CharacterHistoryEntry, StoryMessage } from '../types/game';
import type { AIModelSettings } from './aiModels';
import { getItemById } from '../data/staticData';
import { resolveExplicitTravelIntent, storyClaimsPlayerMoved } from '../utils/travelIntent';
import { buildAIContext, buildDialogueHistory, estimateTokens, recordAIContextReport, SUPPORTED_AI_RESPONSE_FORMAT_VERSIONS } from './aiContext';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const FORMAT_FALLBACK = '模型回應格式不完整，請重新描述行動再試一次。';

function extractResponseText(data: unknown, provider: AIModelSettings['provider']): string {
  if (!isRecord(data)) return '';
  if (provider === 'openai') {
    if (typeof data.output_text === 'string') return data.output_text;
    if (!Array.isArray(data.output)) return '';
    return data.output.flatMap((item) => {
      if (!isRecord(item) || !Array.isArray(item.content)) return [];
      return item.content.flatMap((part) =>
        isRecord(part) && part.type === 'output_text' && typeof part.text === 'string' ? [part.text] : []
      );
    }).join('');
  }

  if (!Array.isArray(data.candidates) || !isRecord(data.candidates[0])) return '';
  const content = data.candidates[0].content;
  if (!isRecord(content) || !Array.isArray(content.parts)) return '';
  return content.parts.flatMap((part) => isRecord(part) && typeof part.text === 'string' ? [part.text] : []).join('');
}

function getReadableNarrative(text: string, depth = 0): string {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!cleaned) return FORMAT_FALLBACK;

  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (isRecord(parsed) && typeof parsed.storyText === 'string' && depth < 2) {
      return getReadableNarrative(parsed.storyText, depth + 1);
    }
    return FORMAT_FALLBACK;
  } catch {
    // Plain text is a useful fallback; JSON-like text is not suitable for the story log.
  }

  if (cleaned.startsWith('{') || cleaned.startsWith('[') || /"(?:storyText|suggestedActions|stateChanges)"\s*:/.test(cleaned)) {
    return FORMAT_FALLBACK;
  }
  return cleaned;
}

const isItemChangeList = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) =>
    isRecord(item) && typeof item.itemId === 'string' && Number.isInteger(item.quantity) && (item.quantity as number) > 0
  );

const isUnitDefeatList = (value: unknown): boolean =>
  Array.isArray(value) && value.every((entry) =>
    isRecord(entry) && typeof entry.unitId === 'string' && entry.quantity === 1
  );

/** 第 1、2 版回應的單位欄位使用舊名稱；轉為第 3 版名稱後再驗證。格式不符的舊欄位原樣保留，交給驗證拒絕。 */
function upgradeLegacyUnitFields(value: Record<string, unknown>): Record<string, unknown> {
  const rename = (entries: unknown, from: string) => Array.isArray(entries)
    ? entries.map((entry) => isRecord(entry) && from in entry ? (({ [from]: id, ...rest }) => ({ unitId: id, ...rest }))(entry) : entry)
    : entries;
  const upgradeChanges = (changes: unknown) => {
    if (!isRecord(changes)) return changes;
    const { npcItemTransfers, defeatedMonsters, ...rest } = changes;
    return {
      ...rest,
      ...(npcItemTransfers !== undefined ? { unitItemTransfers: rename(npcItemTransfers, 'npcId') } : {}),
      ...(defeatedMonsters !== undefined ? { defeatedUnits: rename(defeatedMonsters, 'monsterId') } : {})
    };
  };
  const encounter = value.encounterRequest;
  return {
    ...value,
    encounterRequest: isRecord(encounter) && 'monsterId' in encounter ? { unitId: encounter.monsterId } : encounter,
    stateChanges: upgradeChanges(value.stateChanges),
    failureStateChanges: upgradeChanges(value.failureStateChanges)
  };
}

const isUnitDispositionChangeList = (value: unknown): boolean =>
  Array.isArray(value) && value.every((entry) =>
    isRecord(entry) && typeof entry.unitId === 'string' && ['friendly', 'neutral', 'hostile'].includes(String(entry.disposition))
  );

/** 回應的格式版本：沒有版本號視為第 1 版；回傳 null 代表版本號無效或不支援。 */
function readFormatVersion(value: Record<string, unknown>): number | null {
  if (value.formatVersion === undefined || value.formatVersion === null) return 1;
  return Number.isInteger(value.formatVersion) && SUPPORTED_AI_RESPONSE_FORMAT_VERSIONS.includes(value.formatVersion as number) ? value.formatVersion as number : null;
}

/** 回應是 JSON 但版本號不支援時回傳該版本號（字串化），否則 undefined。 */
function readUnsupportedFormatVersion(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim());
    return isRecord(value) && readFormatVersion(value) === null ? String(value.formatVersion) : undefined;
  } catch {
    return undefined;
  }
}

function parseAIResponse(raw: unknown): AIResponsePayload | null {
  const version = isRecord(raw) ? readFormatVersion(raw) : null;
  if (!isRecord(raw) || version === null) return null;
  const value = version < 3 ? upgradeLegacyUnitFields(raw) : raw;
  if (typeof value.storyText !== 'string' || !Array.isArray(value.suggestedActions) ||
      !value.suggestedActions.every((action) => typeof action === 'string')) return null;

  if (value.travelRequest !== undefined && value.travelRequest !== null &&
      (!isRecord(value.travelRequest) || typeof value.travelRequest.destinationMapId !== 'string')) return null;
  if (value.serviceRequest !== undefined && value.serviceRequest !== null &&
      (!isRecord(value.serviceRequest) || typeof value.serviceRequest.shopId !== 'string' || typeof value.serviceRequest.serviceId !== 'string')) return null;
  if (value.encounterRequest !== undefined && value.encounterRequest !== null &&
      (!isRecord(value.encounterRequest) || typeof value.encounterRequest.unitId !== 'string')) return null;

  if (value.checkRequest !== undefined && value.checkRequest !== null) {
    const check = value.checkRequest;
    const outcomes = value.checkOutcomes;
    if (!isRecord(check) || !['atk', 'def', 'spd', 'str', 'dex', 'con', 'int', 'wis', 'cha'].includes(String(check.stat)) ||
        !Number.isInteger(check.dc) || (check.dc as number) < 5 || (check.dc as number) > 25 ||
        typeof check.reason !== 'string' || !isRecord(outcomes) ||
        typeof outcomes.successText !== 'string' || typeof outcomes.failureText !== 'string') return null;
  } else if (value.checkOutcomes !== undefined && value.checkOutcomes !== null) {
    return null;
  }

  const isValidStateChanges = (changes: unknown): boolean => {
    if (changes === undefined || changes === null) return true;
    if (!isRecord(changes)) return false;
    for (const field of ['hpChange', 'mpChange', 'expChange', 'goldChange']) {
      if (changes[field] !== undefined && (typeof changes[field] !== 'number' || !Number.isFinite(changes[field]))) return false;
    }
    if (changes.addItems !== undefined && !isItemChangeList(changes.addItems)) return false;
    if (changes.removeItems !== undefined && !isItemChangeList(changes.removeItems)) return false;
    if (changes.unitItemTransfers !== undefined && (!Array.isArray(changes.unitItemTransfers) || !changes.unitItemTransfers.every((transfer) =>
      isRecord(transfer) && typeof transfer.unitId === 'string' && typeof transfer.itemId === 'string' &&
      !!getItemById(transfer.itemId) && Number.isInteger(transfer.quantity) && (transfer.quantity as number) > 0 && (transfer.quantity as number) <= 99
    ))) return false;
    if (changes.defeatedUnits !== undefined && !isUnitDefeatList(changes.defeatedUnits)) return false;
    if (changes.unitDispositionChanges !== undefined && !isUnitDispositionChangeList(changes.unitDispositionChanges)) return false;
    if (changes.questUpdates !== undefined && (!Array.isArray(changes.questUpdates) || !changes.questUpdates.every((quest) =>
      isRecord(quest) && typeof quest.questId === 'string' && quest.status === 'completed'
    ))) return false;
    return true;
  };
  if (!isValidStateChanges(value.stateChanges) || !isValidStateChanges(value.failureStateChanges)) return null;
  for (const changes of [value.stateChanges, value.failureStateChanges]) {
    if (isRecord(changes) && changes.questAcceptances !== undefined &&
        (!Array.isArray(changes.questAcceptances) || !changes.questAcceptances.every((questId) => typeof questId === 'string'))) return null;
  }
  if (isRecord(value.stateChanges) && value.stateChanges.defeatedUnits !== undefined &&
      (!isRecord(value.checkRequest) || value.checkRequest.stat !== 'atk')) return null;
  if (isRecord(value.failureStateChanges) &&
      ['expChange', 'addItems', 'unitItemTransfers', 'defeatedUnits', 'unitDispositionChanges', 'questUpdates', 'questAcceptances'].some((field) => field in (value.failureStateChanges as Record<string, unknown>))) return null;

  if (value.questProposals !== undefined && value.questProposals !== null && (!Array.isArray(value.questProposals) || !value.questProposals.every((proposal) =>
    isRecord(proposal) && typeof proposal.templateId === 'string' && typeof proposal.giverId === 'string' && typeof proposal.targetUnitId === 'string' &&
    (proposal.itemId === undefined || proposal.itemId === null || typeof proposal.itemId === 'string') && Number.isInteger(proposal.quantity) &&
    (proposal.rewardGold === undefined || Number.isInteger(proposal.rewardGold)) && (proposal.rewardItems === undefined || isItemChangeList(proposal.rewardItems))
  ))) return null;
  if (value.eventProposals !== undefined && value.eventProposals !== null &&
      (!Array.isArray(value.eventProposals) || !value.eventProposals.every((eventId) => typeof eventId === 'string'))) return null;
  if (value.memoryNotes !== undefined && value.memoryNotes !== null && (!Array.isArray(value.memoryNotes) || !value.memoryNotes.every((entry) =>
    isRecord(entry) && typeof entry.unitId === 'string' && typeof entry.note === 'string'))) return null;
  if (value.storyletProposals !== undefined && value.storyletProposals !== null &&
      (!Array.isArray(value.storyletProposals) || !value.storyletProposals.every((storyletId) => typeof storyletId === 'string'))) return null;

  const storyText = getReadableNarrative(value.storyText);
  if (storyText === FORMAT_FALLBACK) return null;
  const stateChanges = isRecord(value.stateChanges) ? { ...value.stateChanges } : value.stateChanges;
  // 劇情旗標只能經由事件設定；舊格式的 setFlags 一律忽略。
  if (isRecord(stateChanges)) delete stateChanges.setFlags;
  const travelRequest = value.travelRequest ?? null;
  const eventProposals = (value.eventProposals as string[] | null | undefined) ?? [];
  // 主持人 AI 不指定報酬（由規則自委託人持有物組成），回應中的報酬欄位一律忽略。
  const questProposals = ((value.questProposals as Record<string, unknown>[] | null | undefined) ?? []).map((proposal) => {
    const rest = { ...proposal };
    delete rest.rewardGold;
    delete rest.rewardItems;
    return rest;
  });
  // 人物記憶的在場與存活條件、字數與則數上限由 applyMemoryNotes 驗證。
  const memoryNotes = ((value.memoryNotes as { unitId: string; note: string }[] | null | undefined) ?? []).map(({ unitId, note }) => ({ unitId, note }));
  // 劇情片段是否為候選、每回合上限與進行中上限由 startStorylets 驗證。
  const storyletProposals = (value.storyletProposals as string[] | null | undefined) ?? [];
  return { ...value, formatVersion: version, storyText, stateChanges, travelRequest, eventProposals, questProposals, memoryNotes, storyletProposals } as unknown as AIResponsePayload;
}

/**
 * 遇到 503 / 429 時自動重試的 Fetch 輔助函式
 */
/** 429 額度錯誤的分類：每日／帳戶額度用完不重試；每分鐘額度只在建議等待時間很短時重試。 */
interface RateLimitInfo {
  kind: 'daily' | 'account' | 'per_minute';
  retryAfterSeconds?: number;
}

/** 等待時間不超過此秒數才自動重試，否則直接告知玩家，避免卡在載入中或浪費額度。 */
const MAX_AUTO_RETRY_WAIT_SECONDS = 10;

async function readRateLimitInfo(res: Response): Promise<RateLimitInfo> {
  const headerSeconds = Number(res.headers.get('retry-after'));
  const body: unknown = await res.clone().json().catch(() => null);
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  const details = Array.isArray(error.details) ? error.details.filter(isRecord) : [];
  // Gemini：QuotaFailure.violations[].quotaId（例如 GenerateRequestsPerDayPerProjectPerModel-FreeTier）與 RetryInfo.retryDelay（例如 "49s"）。
  const quotaIds = details.flatMap((detail) => Array.isArray(detail.violations) ? detail.violations : [])
    .flatMap((violation) => isRecord(violation) && typeof violation.quotaId === 'string' ? [violation.quotaId] : []);
  const retryDelay = details.find((detail) => typeof detail.retryDelay === 'string')?.retryDelay as string | undefined;
  const retryAfterSeconds = retryDelay ? Number.parseFloat(retryDelay) : Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds : undefined;
  // OpenAI：error.code / error.type 為 insufficient_quota 代表帳戶額度不足。
  if (error.code === 'insufficient_quota' || error.type === 'insufficient_quota') return { kind: 'account' };
  if (quotaIds.some((id) => /PerDay/i.test(id))) return { kind: 'daily', retryAfterSeconds };
  return { kind: 'per_minute', retryAfterSeconds };
}

function formatWait(seconds: number): string {
  const total = Math.ceil(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours} 小時${minutes ? ` ${minutes} 分鐘` : ''}`;
  if (minutes) return `${minutes} 分鐘`;
  return `${total} 秒`;
}

function describeRateLimit(info: RateLimitInfo): string {
  if (info.kind === 'account') return 'AI 服務帳戶額度不足，請檢查方案與帳單設定，或在模型設定改用其他服務。';
  if (info.kind === 'daily') {
    return `目前模型的每日免費額度已用完${info.retryAfterSeconds ? `（約 ${formatWait(info.retryAfterSeconds)}後恢復）` : ''}。可在模型設定改用其他模型，或稍後再試。`;
  }
  return `AI 請求太頻繁，已達每分鐘額度上限，請${info.retryAfterSeconds ? `約 ${formatWait(info.retryAfterSeconds)}後` : '稍後'}再試。`;
}

/**
 * 503 與網路錯誤以退避重試；429 依額度種類處理：每日或帳戶額度用完直接告知玩家，
 * 每分鐘額度只在建議等待時間很短時重試一次，避免重試反而消耗更多額度。
 */
async function fetchWithRetry(url: string, options: RequestInit, retries = 2, delay = 1000): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    if (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, delay * 1.5);
    }
    throw err;
  }
  if (res.status === 503 && retries > 0) {
    console.warn(`[AI API] 伺服器忙碌 (503)，${delay / 1000} 秒後重試...`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return fetchWithRetry(url, options, retries - 1, delay * 1.5);
  }
  if (res.status === 429) {
    const info = await readRateLimitInfo(res);
    const wait = info.retryAfterSeconds ?? delay / 1000;
    if (info.kind === 'per_minute' && retries > 0 && wait <= MAX_AUTO_RETRY_WAIT_SECONDS) {
      console.warn(`[AI API] 已達每分鐘額度上限，${wait} 秒後重試一次...`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return fetchWithRetry(url, options, 0, delay);
    }
    throw new Error(describeRateLimit(info));
  }
  return res;
}

export async function sendPlayerAction(
  settings: AIModelSettings,
  apiKey: string,
  playerState: PlayerState,
  actionText: string,
  /** 本回合玩家行動之前的對話紀錄；依 ai_context.json 的 dialogue 設定取近期視窗。 */
  storyHistory: StoryMessage[],
  /** 同一世界中已結束的歷代角色，供傳聞與人物回憶。 */
  characterHistory: CharacterHistoryEntry[] = []
): Promise<AIResponsePayload> {
  const cleanApiKey = apiKey.trim();
  if (!cleanApiKey) {
    throw new Error('所選模型的 API Key 尚未設定。請開啟模型設定。');
  }

  const { systemPrompt, report, responseSchema: jsonResponseSchema, availableDestinationIds } = buildAIContext(playerState, characterHistory);
  const dialogue = buildDialogueHistory(storyHistory);
  const userPrompt = `【近期劇情回顧】\n${dialogue.text || '（尚無）'}\n\n【玩家行動】\n${actionText}`;
  // totalChars 與預算只計系統提示；估計 tokens 含使用者提示，反映整個請求的大小。
  recordAIContextReport({ ...report, sections: [...report.sections, dialogue.report], estimatedTokens: estimateTokens(systemPrompt + userPrompt), builtAt: Date.now(), userPrompt });

  const isOpenAI = settings.provider === 'openai';
  const endpoint = isOpenAI
    ? 'https://api.openai.com/v1/responses'
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`;
  const createRequestBody = (input: string) => isOpenAI
    ? {
        model: settings.model,
        instructions: systemPrompt,
        input,
        text: { format: { type: 'json_object' } }
      }
    : {
        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${input}` }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: jsonResponseSchema }
      };
  const headers: Record<string, string> = isOpenAI
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${cleanApiKey}` }
    : { 'Content-Type': 'application/json', 'x-goog-api-key': cleanApiKey };
  const requestModelText = async (input: string) => {
    const response = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(createRequestBody(input))
    });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      const detail = errorBody ? JSON.stringify(errorBody) : response.statusText;
      throw new Error(`${settings.provider} ${settings.model} 回應 HTTP ${response.status}: ${detail}`);
    }
    return extractResponseText(await response.json() as unknown, settings.provider);
  };
  const parseResponseText = (text: string): AIResponsePayload | null => {
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    try {
      return parseAIResponse(JSON.parse(cleaned) as unknown);
    } catch {
      return null;
    }
  };

  try {
    const rawText = await requestModelText(userPrompt);
    let parsed = parseResponseText(rawText);
    if (parsed) {
      const requestedId = parsed.travelRequest?.destinationMapId;
      const requestIsValid = !!requestedId && availableDestinationIds.includes(requestedId);
      const localIntent = resolveExplicitTravelIntent(actionText, playerState);
      const narrativeClaimsTravel = storyClaimsPlayerMoved(parsed.storyText, playerState.currentMapId);

      const requestNeedsRepair = (!!requestedId && !requestIsValid) ||
        (!requestedId && (localIntent.kind === 'ambiguous' || narrativeClaimsTravel));
      // 每回合呼叫上限：主持人敘事 1 次，額度足夠時才送移動修正請求。
      if (requestNeedsRepair && report.maxCallsPerTurn > 1) {
        const repairPrompt = `${userPrompt}\n\n【移動回應一致性修正】\n上一份 JSON 的玩家行動為「${actionText}」，AI 敘事為「${parsed.storyText}」，但 travelRequest 缺漏或不是合法的相鄰地區 ID。請重新產生完整 JSON：如果玩家確實要求移動且目的地可唯一判斷，travelRequest.destinationMapId 必須使用可前往清單中的精確 ID；若目的地有多個可能，travelRequest 設為 null 並在 storyText 詢問玩家；若沒有實際移動，請改寫 storyText，不要描述玩家已抵達或切換地區。不要宣稱未執行的移動已完成。`;
        try {
          const repairedText = await requestModelText(repairPrompt);
          const repaired = parseResponseText(repairedText);
          if (repaired) {
            const repairedId = repaired.travelRequest?.destinationMapId;
            if (!repairedId || availableDestinationIds.includes(repairedId)) parsed = repaired;
          }
        } catch (repairError) {
          console.warn('AI 移動回應修正失敗，保留初始回應並由遊戲端驗證。', repairError);
        }
      }
      return parsed;
    }

    // 版本號不支援的回應安全拒絕：不顯示其敘事、不套用任何變更，也不重試。
    const unsupportedVersion = readUnsupportedFormatVersion(rawText);
    return {
      storyText: unsupportedVersion !== undefined ? `AI 回應的格式版本（${unsupportedVersion}）不受支援，本回合未套用任何變更，請重新描述行動再試一次。` : getReadableNarrative(rawText),
      suggestedActions: ['重新描述行動', '觀察周圍環境']
    };
  } catch (err: unknown) {
    throw new Error(err instanceof Error ? err.message : `${settings.provider} API 連線失敗。`, { cause: err });
  }
}
