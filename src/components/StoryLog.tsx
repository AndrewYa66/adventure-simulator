import React, { useState } from 'react';
import type { StoryMessage } from '../types/game';

interface StoryLogProps {
  messages: StoryMessage[];
  loading: boolean;
  onSendAction: (actionText: string) => void;
  onOpenKeyModal: () => void;
  hasApiKey: boolean;
}

export const StoryLog: React.FC<StoryLogProps> = ({ messages, loading, onSendAction, onOpenKeyModal, hasApiKey }) => {
  const [inputAction, setInputAction] = useState('');

  const handleSend = () => {
    if (!inputAction.trim() || loading) return;
    onSendAction(inputAction);
    setInputAction('');
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid #333' }}>
      {/* 頂部 Header */}
      <div style={{ padding: '12px 20px', backgroundColor: '#252525', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: '18px' }}>⚔️ AI TRPG 冒險引擎 (BYOK)</h2>
        <button
          onClick={onOpenKeyModal}
          style={{ padding: '6px 12px', background: hasApiKey ? '#2e7d32' : '#c62828', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
        >
          {hasApiKey ? '🔑 Key 已設定' : '⚠️ 設定 API Key'}
        </button>
      </div>

      {/* 對話紀錄區 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
        {messages.map((msg) => (
          <div key={msg.id} style={{ marginBottom: '16px', textAlign: msg.sender === 'user' ? 'right' : 'left' }}>
            <div
              style={{
                display: 'inline-block',
                maxWidth: '80%',
                padding: '12px 16px',
                borderRadius: '8px',
                backgroundColor: msg.sender === 'user' ? '#1565c0' : msg.sender === 'system' ? '#b71c1c' : '#2d2d2d',
                whiteSpace: 'pre-wrap',
                lineHeight: '1.5'
              }}
            >
              {msg.text}
            </div>

            {/* 建議快捷按鈕 */}
            {msg.options && msg.options.length > 0 && (
              <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {msg.options.map((opt, idx) => (
                  <button
                    key={idx}
                    disabled={loading}
                    onClick={() => onSendAction(opt)}
                    style={{ padding: '6px 12px', backgroundColor: '#3e2723', color: '#ffcc80', border: '1px solid #8d6e63', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {loading && <div style={{ color: '#888' }}>🎲 GM 正在擲骰子與構思劇情...</div>}
      </div>

      {/* 輸入框 */}
      <div style={{ padding: '16px', backgroundColor: '#252525', display: 'flex', gap: '10px' }}>
        <input
          type="text"
          value={inputAction}
          onChange={(e) => setInputAction(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="自由輸入你的行動（例如：拔出短劍朝哥布林砍去...）"
          disabled={loading}
          style={{ flex: 1, padding: '10px', borderRadius: '4px', border: '1px solid #444', backgroundColor: '#121212', color: '#fff' }}
        />
        <button onClick={handleSend} disabled={loading} style={{ padding: '10px 20px', backgroundColor: '#388e3c', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
          發送行動
        </button>
      </div>
    </div>
  );
};