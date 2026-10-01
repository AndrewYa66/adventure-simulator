import React, { useState } from 'react';
import type { AIModelSettings, AIProvider } from '../services/aiModels';
import { AI_PROVIDERS, getModels } from '../services/aiModels';

interface ApiKeyModalProps {
  isOpen: boolean;
  currentSettings: AIModelSettings;
  currentKeys: Record<AIProvider, string>;
  onSave: (settings: AIModelSettings, keys: Record<AIProvider, string>) => void;
  onClose: () => void;
}

export const ApiKeyModal: React.FC<ApiKeyModalProps> = ({ isOpen, currentSettings, currentKeys, onSave, onClose }) => {
  const [provider, setProvider] = useState<AIProvider>(currentSettings.provider);
  const [model, setModel] = useState(currentSettings.model);
  const [keys, setKeys] = useState(currentKeys);

  if (!isOpen) return null;

  const models = getModels(provider);
  const handleProviderChange = (nextProvider: AIProvider) => {
    setProvider(nextProvider);
    setModel(getModels(nextProvider)[0].id);
  };

  const handleSave = () => {
    onSave({ provider, model }, keys);
    onClose();
  };

  const providerLabel = AI_PROVIDERS.find((entry) => entry.id === provider)?.label ?? provider;

  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ backgroundColor: '#252525', padding: '24px', borderRadius: '8px', width: 'min(420px, calc(100vw - 32px))', color: '#fff' }}>
        <h3 style={{ marginTop: 0 }}>⚙️ AI 模型設定</h3>
        <label style={{ display: 'block', marginBottom: '6px' }} htmlFor="ai-provider">AI 服務</label>
        <select id="ai-provider" value={provider} onChange={(event) => handleProviderChange(event.target.value as AIProvider)} style={selectStyle}>
          {AI_PROVIDERS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>

        <label style={{ display: 'block', margin: '14px 0 6px' }} htmlFor="ai-model">模型</label>
        <select id="ai-model" value={model} onChange={(event) => setModel(event.target.value)} style={selectStyle}>
          {models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} ({entry.id})</option>)}
        </select>

        <label style={{ display: 'block', margin: '14px 0 6px' }} htmlFor="ai-api-key">{providerLabel} API Key</label>
        <input
          id="ai-api-key"
          type="password"
          value={keys[provider]}
          onChange={(event) => setKeys((previous) => ({ ...previous, [provider]: event.target.value }))}
          placeholder={`輸入 ${providerLabel} API Key`}
          autoComplete="off"
          style={{ ...selectStyle, marginBottom: '10px' }}
        />
        <p style={{ color: '#bbb', fontSize: '12px', lineHeight: 1.5, margin: '0 0 18px' }}>
          {provider === 'openai'
            ? 'OpenAI API Key 只保留在目前分頁記憶體中，不寫入存檔；呼叫仍由瀏覽器直接送出。'
            : 'Gemini API Key 會保存在此瀏覽器，方便下次使用。'}
        </p>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button onClick={onClose} style={buttonStyle('#555')}>取消</button>
          <button onClick={handleSave} style={buttonStyle('#2e7d32')}>儲存</button>
        </div>
      </div>
    </div>
  );
};

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '9px', boxSizing: 'border-box', backgroundColor: '#121212',
  border: '1px solid #444', color: '#fff', borderRadius: '4px'
};

const buttonStyle = (background: string): React.CSSProperties => ({
  padding: '7px 12px', background, color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer'
});
