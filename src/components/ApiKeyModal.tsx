import React, { useState } from 'react';

interface ApiKeyModalProps {
  isOpen: boolean;
  currentKey: string;
  onSave: (key: string) => void;
  onClose: () => void;
}

export const ApiKeyModal: React.FC<ApiKeyModalProps> = ({ isOpen, currentKey, onSave, onClose }) => {
  const [inputKey, setInputKey] = useState(currentKey);

  if (!isOpen) return null;

  const handleSave = () => {
    onSave(inputKey);
    onClose();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ backgroundColor: '#252525', padding: '24px', borderRadius: '8px', width: '360px', color: '#fff' }}>
        <h3 style={{ marginTop: 0 }}>🔑 設定 Gemini API Key</h3>
        <input
          type="password"
          value={inputKey}
          onChange={(e) => setInputKey(e.target.value)}
          placeholder="請貼上你的 Gemini API Key"
          style={{ width: '100%', padding: '8px', marginBottom: '16px', boxSizing: 'border-box', backgroundColor: '#121212', border: '1px solid #444', color: '#fff', borderRadius: '4px' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button onClick={onClose} style={{ padding: '6px 12px', background: '#555', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>取消</button>
          <button onClick={handleSave} style={{ padding: '6px 12px', background: '#2e7d32', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>儲存</button>
        </div>
      </div>
    </div>
  );
};