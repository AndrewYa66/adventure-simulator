import type { PlayerState, AIResponsePayload } from '../types/game';
import type { AIModelSettings } from './aiModels';
import { getMapById } from '../data/staticData';

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

const isMonsterDefeatList = (value: unknown): boolean =>
  Array.isArray(value) && value.every((entry) =>
    isRecord(entry) && typeof entry.monsterId === 'string' && entry.quantity === 1
  );

function parseAIResponse(value: unknown): AIResponsePayload | null {
  if (!isRecord(value) || typeof value.storyText !== 'string' || !Array.isArray(value.suggestedActions) ||
      !value.suggestedActions.every((action) => typeof action === 'string')) return null;

  if (value.travelRequest !== undefined && value.travelRequest !== null &&
      (!isRecord(value.travelRequest) || typeof value.travelRequest.destinationMapId !== 'string')) return null;

  if (value.checkRequest !== undefined && value.checkRequest !== null) {
    const check = value.checkRequest;
    const outcomes = value.checkOutcomes;
    if (!isRecord(check) || !['atk', 'def', 'spd'].includes(String(check.stat)) ||
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
    if (changes.defeatedMonsters !== undefined && !isMonsterDefeatList(changes.defeatedMonsters)) return false;
    if ('newLocationId' in changes) return false;
    if (changes.setFlags !== undefined && (!isRecord(changes.setFlags) || !Object.values(changes.setFlags).every((flag) => typeof flag === 'boolean'))) return false;
    if (changes.questUpdates !== undefined && (!Array.isArray(changes.questUpdates) || !changes.questUpdates.every((quest) =>
      isRecord(quest) && typeof quest.questId === 'string' && quest.status === 'completed'
    ))) return false;
    return true;
  };
  if (!isValidStateChanges(value.stateChanges) || !isValidStateChanges(value.failureStateChanges)) return null;
  if (isRecord(value.stateChanges) && value.stateChanges.defeatedMonsters !== undefined &&
      (!isRecord(value.checkRequest) || value.checkRequest.stat !== 'atk')) return null;
  if (isRecord(value.failureStateChanges) &&
      ['expChange', 'addItems', 'defeatedMonsters', 'questUpdates', 'setFlags'].some((field) => field in (value.failureStateChanges as Record<string, unknown>))) return null;

  const storyText = getReadableNarrative(value.storyText);
  if (storyText === FORMAT_FALLBACK) return null;
  return { ...value, storyText } as unknown as AIResponsePayload;
}

/**
 * 遇到 503 / 429 時自動重試的 Fetch 輔助函式
 */
async function fetchWithRetry(url: string, options: RequestInit, retries = 2, delay = 1000): Promise<Response> {
  try {
    const res = await fetch(url, options);
    if ((res.status === 503 || res.status === 429) && retries > 0) {
      console.warn(`[AI API] 伺服器忙碌 (${res.status})，${delay / 1000} 秒後重試...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, delay * 1.5);
    }
    return res;
  } catch (err) {
    if (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, delay * 1.5);
    }
    throw err;
  }
}

export async function sendPlayerAction(
  settings: AIModelSettings,
  apiKey: string,
  playerState: PlayerState,
  actionText: string,
  storyHistory: string[]
): Promise<AIResponsePayload> {
  const cleanApiKey = apiKey.trim();
  const currentMap = getMapById(playerState.currentMapId);
  const availableDestinations = currentMap?.connectedMapIds.flatMap((mapId) => {
    const map = getMapById(mapId);
    return map ? [{ id: map.id, name: map.name }] : [];
  }) ?? [];

  if (!cleanApiKey) {
    throw new Error('所選模型的 API Key 尚未設定。請開啟模型設定。');
  }

  const systemPrompt = `
你是一位中世紀奇幻 TRPG 的遊戲主持人 (GM)。
當前玩家狀態：
- 姓名: ${playerState.name} (Lv.${playerState.level})
- HP: ${playerState.hp} | MP: ${playerState.mp} | 金幣: ${playerState.gold}
- 當前地區: ${currentMap?.name ?? playerState.currentMapId} (${playerState.currentMapId})
- 可前往的相鄰地區（只可選這些 ID）: ${JSON.stringify(availableDestinations)}
- 當前戰鬥: ${playerState.combat ? JSON.stringify(playerState.combat) : '無'}
- 背包物品 ID 列表: ${JSON.stringify(playerState.inventory)}
- 裝備物品 ID: ${JSON.stringify(playerState.equipped)}
- 劇情旗標 (Flags): ${JSON.stringify(playerState.storyFlags || {})}
- 進行中任務: ${JSON.stringify(playerState.activeQuests)}
- 已擊敗怪物數量: ${JSON.stringify(playerState.defeatedMonsters)}

請根據玩家行動進行劇情描述，並按下列規則判斷地區移動意圖：
- 只有玩家明確表達「前往、走到、離開目前地區去、移動到」某個可前往地區，才設定 travelRequest.destinationMapId。該 ID 必須完全符合上方相鄰地區清單。
- 詢問地點資訊、觀察遠方、談論某地或描述打算但尚未決定，都不算移動；travelRequest 設為 null。含糊的「去那裡看看」且目的地不明時，先在 storyText 詢問，不要猜測或切換。
- 不要透過 stateChanges 修改地區；實際移動由遊戲驗證 travelRequest 後套用。不可前往清單以外的地區。
- 一般戰鬥由遊戲規則結算，不可敘事中自行宣告擊敗或扣除怪物。
注意事項：
1. 當給予或扣除玩家道具時，請使用 Item ID (例如: "ITEM-001" 小型生命藥水, "ITEM-002" 哥布林耳朵, "ITEM-101" 精鋼短劍, "ITEM-201" 冒險者皮甲)。
2. 只有結果不確定且失敗會有實質影響時才要求檢定；一般對話、觀察或無風險行動不擲骰。
3. 檢定使用 checkRequest {"stat":"atk|def|spd","dc":5至25,"reason":"理由"}。不可在 storyText 中預先宣告檢定成功或失敗。
4. 有檢定時必須提供 checkOutcomes.successText 與 checkOutcomes.failureText。stateChanges 只會在檢定成功時套用；需要描述失敗時的代價可用 failureStateChanges。
5. 只有成功擊敗怪物後才回報 defeatedMonsters；完成任務時必須確認結構化需求均已滿足。
6. 你必須【嚴格】以格式正確的 JSON 格式回答：

\`\`\`json
{
  "storyText": "精彩生動的情境描繪與戰況（約 100-200 字，繁體中文）",
  "suggestedActions": ["選項 1", "選項 2", "選項 3"],
  "travelRequest": null,
  "checkRequest": null,
  "checkOutcomes": null,
  "stateChanges": {
    "hpChange": 0,
    "mpChange": 0,
    "expChange": 0,
    "goldChange": 0,
    "addItems": [{"itemId": "ITEM-001", "quantity": 1}],
    "removeItems": [],
    "defeatedMonsters": [],
    "setFlags": {"MET_VILLAGE_CHIEF": true},
    "questUpdates": [{"questId": "QST-001", "status": "completed"}]
  },
  "failureStateChanges": null
}
\`\`\`
只可回報玩家已接取且客觀目標已完成的任務；不可自行接取任務或宣告未完成目標完成。
`;

  const recentHistory = storyHistory.slice(-4).join('\n');
  const userPrompt = `【近期劇情回顧】\n${recentHistory}\n\n【玩家行動】\n${actionText}`;

  const isOpenAI = settings.provider === 'openai';
  const endpoint = isOpenAI
    ? 'https://api.openai.com/v1/responses'
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`;
  const requestBody = isOpenAI
    ? {
        model: settings.model,
        instructions: systemPrompt,
        input: userPrompt,
        text: { format: { type: 'json_object' } }
      }
    : {
        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
        generationConfig: { responseMimeType: 'application/json' }
      };

  try {
    const response = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: isOpenAI
        ? { 'Content-Type': 'application/json', Authorization: `Bearer ${cleanApiKey}` }
        : { 'Content-Type': 'application/json', 'x-goog-api-key': cleanApiKey },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      const detail = errorBody ? JSON.stringify(errorBody) : response.statusText;
      throw new Error(`${settings.provider} ${settings.model} 回應 HTTP ${response.status}: ${detail}`);
    }

    const data: unknown = await response.json();
    const rawText = extractResponseText(data, settings.provider);
    const cleanedJsonStr = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

    try {
      const parsed = parseAIResponse(JSON.parse(cleanedJsonStr) as unknown);
      if (parsed) return parsed;
    } catch {
      // Show a readable fallback below when the provider returns malformed JSON.
    }

    return {
      storyText: getReadableNarrative(rawText),
      suggestedActions: ['重新描述行動', '觀察周圍環境']
    };
  } catch (err: unknown) {
    throw new Error(err instanceof Error ? err.message : `${settings.provider} API 連線失敗。`, { cause: err });
  }
}
