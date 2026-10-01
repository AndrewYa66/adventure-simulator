import type { PlayerState, AIResponsePayload } from '../types/game';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isItemChangeList = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) =>
    isRecord(item) && typeof item.itemId === 'string' && Number.isInteger(item.quantity) && (item.quantity as number) > 0
  );

function parseAIResponse(value: unknown): AIResponsePayload | null {
  if (!isRecord(value) || typeof value.storyText !== 'string' || !Array.isArray(value.suggestedActions) ||
      !value.suggestedActions.every((action) => typeof action === 'string')) return null;

  if (value.stateChanges !== undefined) {
    const changes = value.stateChanges;
    if (!isRecord(changes)) return null;
    for (const field of ['hpChange', 'mpChange', 'expChange', 'goldChange']) {
      if (changes[field] !== undefined && (typeof changes[field] !== 'number' || !Number.isFinite(changes[field]))) return null;
    }
    if (changes.addItems !== undefined && !isItemChangeList(changes.addItems)) return null;
    if (changes.removeItems !== undefined && !isItemChangeList(changes.removeItems)) return null;
    if (changes.newLocationId !== undefined && changes.newLocationId !== null && typeof changes.newLocationId !== 'string') return null;
    if (changes.setFlags !== undefined && (!isRecord(changes.setFlags) || !Object.values(changes.setFlags).every((flag) => typeof flag === 'boolean'))) return null;
  }

  return value as unknown as AIResponsePayload;
}

// 輪替模型清單：優先使用 3.6-flash，若遇到 503 則順序嘗試其他模型
const SUPPORTED_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash'
];

/**
 * 遇到 503 / 429 時自動重試的 Fetch 輔助函式
 */
async function fetchWithRetry(url: string, options: RequestInit, retries = 2, delay = 1000): Promise<Response> {
  try {
    const res = await fetch(url, options);
    if ((res.status === 503 || res.status === 429) && retries > 0) {
      console.warn(`[Gemini API] 伺服器忙碌 (${res.status})，${delay / 1000} 秒後重試...`);
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
  apiKey: string,
  playerState: PlayerState,
  actionText: string,
  storyHistory: string[]
): Promise<AIResponsePayload> {
  const cleanApiKey = apiKey.trim();

  if (!cleanApiKey) {
    throw new Error('API Key 為空，請檢查右上角設定。');
  }

  const systemPrompt = `
你是一位中世紀奇幻 TRPG 的遊戲主持人 (GM)。
當前玩家狀態：
- 姓名: ${playerState.name} (Lv.${playerState.level})
- HP: ${playerState.hp} | MP: ${playerState.mp} | 金幣: ${playerState.gold}
- 當前地圖 ID: ${playerState.currentMapId}
- 背包物品 ID 列表: ${JSON.stringify(playerState.inventory)}
- 裝備物品 ID: ${JSON.stringify(playerState.equipped)}
- 劇情旗標 (Flags): ${JSON.stringify(playerState.storyFlags || {})}

請根據玩家行動進行劇情描述與戰鬥結算。
注意事項：
1. 當給予或扣除玩家道具時，請使用 Item ID (例如: "ITEM-001" 小型生命藥水, "ITEM-002" 哥布林耳朵, "ITEM-101" 精鋼短劍, "ITEM-201" 冒險者皮甲)。
2. 你必須【嚴格】以格式正確的 JSON 格式回答：

\`\`\`json
{
  "storyText": "精彩生動的情境描繪與戰況（約 100-200 字，繁體中文）",
  "suggestedActions": ["選項 1", "選項 2", "選項 3"],
  "stateChanges": {
    "hpChange": 0,
    "mpChange": 0,
    "expChange": 0,
    "goldChange": 0,
    "addItems": [{"itemId": "ITEM-001", "quantity": 1}],
    "removeItems": [],
    "newLocationId": null,
    "setFlags": {"MET_VILLAGE_CHIEF": true}
  }
}
\`\`\`
`;

  const recentHistory = storyHistory.slice(-4).join('\n');
  const userPrompt = `【近期劇情回顧】\n${recentHistory}\n\n【玩家行動】\n${actionText}`;

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json"
    }
  };

  let lastErrorDetail = '';

  for (const model of SUPPORTED_MODELS) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cleanApiKey}`;

    try {
      console.log(`[Gemini Request] 嘗試連線至模型: ${model}`);
      const response = await fetchWithRetry(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const data = await response.json();
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleanedJsonStr = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

        try {
          const parsed = parseAIResponse(JSON.parse(cleanedJsonStr) as unknown);
          if (parsed) return parsed;
          return {
            storyText: rawText || 'GM 回應格式不完整，請再嘗試一次。',
            suggestedActions: ['重新描述行動', '觀察周圍環境']
          };
        } catch (e) {
          return {
            storyText: rawText || '（GM 似乎沉思了一下）',
            suggestedActions: ['繼續觀察周圍', '檢查裝備']
          };
        }
      }

      const errorJson = await response.json().catch(() => null);
      const errorText = errorJson ? JSON.stringify(errorJson, null, 2) : response.statusText;
      console.warn(`⚠️ [${model}] 暫時無法使用 (${response.status})，切換至下一個模型...`);
      lastErrorDetail = `[Status ${response.status}] Model: ${model}\n詳細訊息: ${errorText}`;

    } catch (err: any) {
      console.warn(`⚠️ [${model}] 連線例外，切換至下一個模型...`);
      lastErrorDetail = err.message || '網路連線失敗';
    }
  }

  throw new Error(`所有 Gemini 服務節點均忙碌中，請稍後再試:\n${lastErrorDetail}`);
}
