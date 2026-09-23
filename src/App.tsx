import { useState, useEffect } from 'react';
import type { PlayerState, StoryMessage } from './types/game';
import { sendPlayerAction } from './services/geminiService';

const initialPlayer: PlayerState = {
  name: '亞瑟',
  level: 1,
  exp: 0,
  maxExp: 100,
  hp: 100,
  maxHp: 100,
  mp: 30,
  maxMp: 30,
  gold: 50,
  currentMapId: 'MAP-001',
  inventory: [
    { itemId: 'ITEM-001', name: '小型生命藥水', quantity: 2 },
    { itemId: 'ITEM-002', name: '哥布林耳朵', quantity: 1 }
  ],
  equipped: { weapon: '精鋼短劍', armor: '冒險者皮甲' }
};

export default function App() {
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('TRPG_GEMINI_KEY') || '');
  const [player, setPlayer] = useState<PlayerState>(() => {
    const saved = localStorage.getItem('TRPG_PLAYER_STATE');
    return saved ? JSON.parse(saved) : initialPlayer;
  });
  const [messages, setMessages] = useState<StoryMessage[]>([
    {
      id: '1',
      sender: 'ai',
      text: '你站在橡木村的微風旅館門口，陽光微微灑落。村長埃爾德正在公會告示板前發布關於野外哥布林襲擊的委託。你準備好開啟冒險了嗎？',
      options: ['向村長詢問任務細節', '前往綠林古道探索', '檢查背包裝備'],
      timestamp: new Date().toLocaleTimeString()
    }
  ]);
  const [inputAction, setInputAction] = useState('');
  const [loading, setLoading] = useState(false);

  // 當狀態改變時自動存檔至 LocalStorage
  useEffect(() => {
    localStorage.setItem('TRPG_PLAYER_STATE', JSON.stringify(player));
  }, [player]);

  const saveApiKey = (key: string) => {
    setApiKey(key);
    localStorage.setItem('TRPG_GEMINI_KEY', key);
  };

  const handleSendAction = async (actionText: string) => {
    if (!actionText.trim() || loading) return;
    if (!apiKey) {
      alert('請先點擊右上角設定輸入 Gemini API Key！');
      return;
    }

    const userMsg: StoryMessage = {
      id: Date.now().toString(),
      sender: 'user',
      text: actionText,
      timestamp: new Date().toLocaleTimeString()
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputAction('');
    setLoading(true);

    try {
      const historyTexts = messages.map((m) => `${m.sender === 'user' ? '玩家' : 'GM'}: ${m.text}`);
      const aiResponse = await sendPlayerAction(apiKey, player, actionText, historyTexts);

      // 更新玩家狀態
      if (aiResponse.stateChanges) {
        const sc = aiResponse.stateChanges;
        setPlayer((prev) => {
          let newHp = Math.min(prev.maxHp, Math.max(0, prev.hp + (sc.hpChange || 0)));
          let newMp = Math.min(prev.maxMp, Math.max(0, prev.mp + (sc.mpChange || 0)));
          let newGold = Math.max(0, prev.gold + (sc.goldChange || 0));
          let newExp = prev.exp + (sc.expChange || 0);

          return {
            ...prev,
            hp: newHp,
            mp: newMp,
            gold: newGold,
            exp: newExp,
            currentMapId: sc.newLocationId || prev.currentMapId
          };
        });
      }

      const aiMsg: StoryMessage = {
        id: (Date.now() + 1).toString(),
        sender: 'ai',
        text: aiResponse.storyText,
        options: aiResponse.suggestedActions,
        timestamp: new Date().toLocaleTimeString()
      };

      setMessages((prev) => [...prev, aiMsg]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          sender: 'system',
          text: `❌ 發生錯誤: ${err.message || '無法連線至 AI 服務'}`,
          timestamp: new Date().toLocaleTimeString()
        }
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh', backgroundColor: '#1a1a1a', color: '#eaeaea', fontFamily: 'sans-serif' }}>
      {/* 左側：對話故事區域 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid #333' }}>
        {/* 頂部 Header */}
        <div style={{ padding: '12px 20px', backgroundColor: '#252525', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '18px' }}>⚔️ AI TRPG 冒險引擎 (BYOK)</h2>
          <button
            onClick={() => {
              const k = prompt('請輸入 Gemini API Key:', apiKey);
              if (k !== null) saveApiKey(k);
            }}
            style={{ padding: '6px 12px', background: apiKey ? '#2e7d32' : '#c62828', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            {apiKey ? '🔑 Key 已設定' : '⚠️ 設定 API Key'}
          </button>
        </div>

        {/* 故事對話紀錄 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
          {messages.map((msg) => (
            <div
              key={msg.id}
              style={{
                marginBottom: '16px',
                textAlign: msg.sender === 'user' ? 'right' : 'left'
              }}
            >
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

              {/* 快捷行動選項按鈕 */}
              {msg.options && msg.options.length > 0 && (
                <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {msg.options.map((opt, idx) => (
                    <button
                      key={idx}
                      disabled={loading}
                      onClick={() => handleSendAction(opt)}
                      style={{
                        padding: '6px 12px',
                        backgroundColor: '#3e2723',
                        color: '#ffcc80',
                        border: '1px solid #8d6e63',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
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

        {/* 下方玩家輸入框 */}
        <div style={{ padding: '16px', backgroundColor: '#252525', display: 'flex', gap: '10px' }}>
          <input
            type="text"
            value={inputAction}
            onChange={(e) => setInputAction(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSendAction(inputAction)}
            placeholder="自由輸入你的行動（例如：拔出短劍朝哥布林砍去...）"
            disabled={loading}
            style={{ flex: 1, padding: '10px', borderRadius: '4px', border: '1px solid #444', backgroundColor: '#121212', color: '#fff' }}
          />
          <button
            onClick={() => handleSendAction(inputAction)}
            disabled={loading}
            style={{ padding: '10px 20px', backgroundColor: '#388e3c', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            發送行動
          </button>
        </div>
      </div>

      {/* 右側：玩家 HUD面板 (狀態/裝備/背包) */}
      <div style={{ width: '300px', backgroundColor: '#212121', padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <h3 style={{ margin: '0 0 10px 0', borderBottom: '1px solid #444', paddingBottom: '6px' }}>👤 角色狀態</h3>
          <p style={{ margin: '4px 0' }}><strong>姓名:</strong> {player.name}</p>
          <p style={{ margin: '4px 0' }}><strong>等級:</strong> Lv.{player.level} ({player.exp}/{player.maxExp} EXP)</p>
          <p style={{ margin: '4px 0' }}><strong>💰 金幣:</strong> {player.gold} Gold</p>
          <p style={{ margin: '4px 0' }}><strong>📍 當前位置:</strong> {player.currentMapId}</p>
        </div>

        {/* 血條與魔力條 */}
        <div>
          <div style={{ marginBottom: '8px' }}>
            <span style={{ fontSize: '12px' }}>❤️ HP ({player.hp}/{player.maxHp})</span>
            <div style={{ height: '10px', backgroundColor: '#424242', borderRadius: '5px', overflow: 'hidden' }}>
              <div style={{ width: `${(player.hp / player.maxHp) * 100}%`, height: '100%', backgroundColor: '#e53935' }} />
            </div>
          </div>
          <div>
            <span style={{ fontSize: '12px' }}>🔷 MP ({player.mp}/{player.maxMp})</span>
            <div style={{ height: '10px', backgroundColor: '#424242', borderRadius: '5px', overflow: 'hidden' }}>
              <div style={{ width: `${(player.mp / player.maxMp) * 100}%`, height: '100%', backgroundColor: '#1e88e5' }} />
            </div>
          </div>
        </div>

        {/* 裝備欄 */}
        <div>
          <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>⚔️ 當前裝備</h4>
          <p style={{ margin: '2px 0', fontSize: '13px' }}>主手: {player.equipped.weapon || '無'}</p>
          <p style={{ margin: '2px 0', fontSize: '13px' }}>防具: {player.equipped.armor || '無'}</p>
        </div>

        {/* 背包欄 */}
        <div style={{ flex: 1 }}>
          <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>🎒 背包物品</h4>
          <ul style={{ paddingLeft: '20px', margin: 0, fontSize: '13px' }}>
            {player.inventory.map((item, idx) => (
              <li key={idx} style={{ marginBottom: '4px' }}>
                {item.name} x{item.quantity}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}