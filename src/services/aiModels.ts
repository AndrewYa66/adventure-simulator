export type AIProvider = 'gemini' | 'openai';

export interface AIModelOption {
  provider: AIProvider;
  id: string;
  label: string;
}

export interface AIModelSettings {
  provider: AIProvider;
  model: string;
  /** 重要角色決策使用 AI（O34 第 2 階段）；關閉時依規則行動。預設開啟，存於瀏覽器、不寫入存檔。 */
  agentDecisionsEnabled?: boolean;
}

/** 角色 AI 開關；舊設定沒有此欄位時視為開啟。 */
export const isAgentAIEnabled = (settings: AIModelSettings) => settings.agentDecisionsEnabled !== false;

export const AI_PROVIDERS: { id: AIProvider; label: string }[] = [
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'openai', label: 'OpenAI' }
];

export const AI_MODELS: AIModelOption[] = [
  // 各服務的第一個模型即切換服務時的預設。
  { provider: 'gemini', id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite（推薦・預設）' },
  { provider: 'gemini', id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { provider: 'gemini', id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { provider: 'openai', id: 'gpt-6-luna', label: 'GPT-6 Luna' },
  { provider: 'openai', id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
  { provider: 'openai', id: 'gpt-6-astra', label: 'GPT-6 Astra' }
];

/** 預設模型：Gemini 免費額度可用且對話速度快，一般玩家不需付費即可遊玩。 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

const SETTINGS_STORAGE_KEY = 'TRPG_AI_MODEL_SETTINGS';

export function getModels(provider: AIProvider): AIModelOption[] {
  return AI_MODELS.filter((model) => model.provider === provider);
}

export function defaultModelSettings(): AIModelSettings {
  return { provider: 'gemini', model: DEFAULT_GEMINI_MODEL, agentDecisionsEnabled: true };
}

export function loadAIModelSettings(): AIModelSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaultModelSettings();
    const saved = JSON.parse(raw) as Partial<AIModelSettings>;
    if ((saved.provider !== 'gemini' && saved.provider !== 'openai') ||
        typeof saved.model !== 'string' || !getModels(saved.provider).some((model) => model.id === saved.model)) {
      return defaultModelSettings();
    }
    return { provider: saved.provider, model: saved.model, agentDecisionsEnabled: saved.agentDecisionsEnabled !== false };
  } catch {
    return defaultModelSettings();
  }
}

export function saveAIModelSettings(settings: AIModelSettings): boolean {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
