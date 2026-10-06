import React, { useState } from 'react';
import type { ActionCheckResult, StoryMessage } from '../types/game';
import { STAT_LABELS } from '../utils/gameChecks';
import { scenario } from '../data/staticData';

interface StoryLogProps {
  messages: StoryMessage[];
  loading: boolean;
  onSendAction: (actionText: string) => void;
  onOpenKeyModal: () => void;
  hasApiKey: boolean;
  selectedModel: string;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  combatActive: boolean;
  inputDisabled: boolean;
  onTravel: (mapId: string) => void;
  /** 角色死亡時顯示讀檔訊息；未死亡時不傳。 */
  deathActions?: { onLoadAutoSave: () => void; onOpenSaveManager: () => void };
}

export const StoryLog: React.FC<StoryLogProps> = ({ messages, loading, onSendAction, onOpenKeyModal, hasApiKey, selectedModel, isSidebarOpen, onToggleSidebar, combatActive, inputDisabled, onTravel, deathActions }) => {
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
        <div>
          <h2 style={{ margin: 0, fontSize: '18px' }}>⚔️ AI TRPG 冒險引擎</h2>
          <span style={{ color: '#aaa', fontSize: '12px' }}>目前模型：{selectedModel}</span>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={onToggleSidebar} aria-expanded={isSidebarOpen} aria-controls="player-sidebar" style={{ padding: '6px 10px', background: '#424242', color: '#fff', border: '1px solid #666', borderRadius: '4px', cursor: 'pointer' }}>
            {isSidebarOpen ? '隱藏選單' : '顯示選單'}
          </button>
          <button
            onClick={onOpenKeyModal}
            style={{ padding: '6px 12px', background: hasApiKey ? '#2e7d32' : '#c62828', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            {hasApiKey ? '⚙️ 模型設定' : '⚠️ 設定 API Key'}
          </button>
        </div>
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
                backgroundColor: msg.sender === 'user' ? '#1565c0' : msg.id === 'session-restore-notice' ? '#263b48' : msg.sender === 'system' ? '#b71c1c' : '#2d2d2d',
                whiteSpace: 'pre-wrap',
                lineHeight: '1.5'
              }}
            >
              {msg.text}
            </div>

            {msg.checkResult && <CheckResultCard result={msg.checkResult} />}
            {msg.checkResults?.map((result, index) => <CheckResultCard key={`${msg.id}-check-${index}`} result={result} />)}
            {msg.travelOptions && msg.travelOptions.length > 0 && <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {msg.travelOptions.map((destination) => <button
                key={destination.mapId}
                disabled={loading || combatActive}
                onClick={() => onTravel(destination.mapId)}
                style={{ padding: '6px 12px', backgroundColor: '#303c30', color: '#dcedc8', border: '1px solid #546e45', borderRadius: '4px', cursor: 'pointer' }}
              >前往 {destination.name}</button>)}
            </div>}

            {/* 建議快捷按鈕 */}
            {msg.options && msg.options.length > 0 && (
              <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {msg.options.map((opt, idx) => (
                  <button
                    key={idx}
                    disabled={loading || combatActive || inputDisabled}
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

      {deathActions && <section role="alert" aria-label="角色死亡" style={{ padding: '14px 16px', backgroundColor: '#3a1c1c', borderTop: '1px solid #8e2424', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
        <span style={{ flex: '1 1 260px', color: '#ffcdd2' }}>☠️ 你已死亡。自動存檔停在致命行動之前（戰鬥中死亡則停在該場戰鬥開始前），可讀取後重新嘗試，或從存檔管理讀取手動存檔。</span>
        <button onClick={deathActions.onLoadAutoSave} disabled={loading} style={{ padding: '8px 14px', backgroundColor: '#2e5d32', color: '#fff', border: '1px solid #4a8', borderRadius: '4px', cursor: 'pointer' }}>讀取自動存檔（死亡前）</button>
        <button onClick={deathActions.onOpenSaveManager} style={{ padding: '8px 14px', backgroundColor: '#333', color: '#fff', border: '1px solid #666', borderRadius: '4px', cursor: 'pointer' }}>開啟存檔管理</button>
      </section>}

      {/* 輸入框 */}
      <div style={{ padding: '16px', backgroundColor: '#252525', display: 'flex', gap: '10px' }}>
        {combatActive && <span style={{ color: '#ffcc80', alignSelf: 'center', fontSize: '12px' }}>戰鬥中請使用右側攻擊按鈕，確保每次攻防都有擲骰結算。</span>}
        <input
          type="text"
          value={inputAction}
          onChange={(e) => setInputAction(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder={scenario.inputPlaceholder}
          disabled={loading || combatActive || inputDisabled}
          style={{ flex: 1, padding: '10px', borderRadius: '4px', border: '1px solid #444', backgroundColor: '#121212', color: '#fff' }}
        />
        <button onClick={handleSend} disabled={loading || combatActive || inputDisabled} style={{ padding: '10px 20px', backgroundColor: '#388e3c', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
          發送行動
        </button>
      </div>
    </div>
  );
};

const CheckResultCard: React.FC<{ result: ActionCheckResult }> = ({ result }) => (
  <section
    role="status"
    aria-label="擲骰檢定結果"
    style={{
      maxWidth: '420px', marginTop: '8px', padding: '12px 14px', borderRadius: '8px',
      backgroundColor: result.success ? '#173522' : '#432222',
      border: `1px solid ${result.success ? '#3d8053' : '#985050'}`,
      color: '#f3f3f3', fontSize: '13px', lineHeight: 1.55
    }}
  >
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
      <strong>🎲 {result.label ?? `${STAT_LABELS[result.stat]}檢定`}</strong>
      <strong style={{ color: result.success ? '#91e3a9' : '#ffaaaa' }}>{result.success ? '成功' : '失敗'}</strong>
    </div>
    <div style={{ color: '#ddd', marginBottom: '7px' }}>{result.reason}</div>
    <div style={{ color: '#ddd', marginBottom: '4px' }}>擲骰數量：{result.d20Rolls.length} 顆 d20</div>
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '7px' }}>
      {result.d20Rolls.map((roll, index) => (
        <span key={`${roll}-${index}`} style={{ padding: '3px 8px', borderRadius: '4px', background: '#111a', border: '1px solid #ffffff30' }}>
          d20{result.d20Rolls.length > 1 ? ` #${index + 1}` : ''}: <strong>{roll}</strong>
        </span>
      ))}
    </div>
    <div>{STAT_LABELS[result.stat]}能力：{result.baseStat} 基礎 {result.equipmentBonus >= 0 ? '+' : '−'} {Math.abs(result.equipmentBonus)} 裝備 = {result.statValue}</div>
    <div>檢定計算：{result.d20Rolls[0]} {result.modifier >= 0 ? '+' : '−'} {Math.abs(result.modifier)} 修正{result.checkBonus ? `（含種族/職階加值 ${result.checkBonus > 0 ? '+' : ''}${result.checkBonus}）` : ''} = <strong>{result.total}</strong>，目標 DC {result.dc}</div>
  </section>
);
