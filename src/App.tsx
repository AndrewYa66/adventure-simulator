import { useState, useEffect } from 'react';
import type { PlayerState, StoryMessage } from './types/game';
import { createInitialPlayer } from './utils/playerInit';
import { sendPlayerAction } from './services/geminiService';
import { PlayerHUD } from './components/PlayerHUD';
import { StoryLog } from './components/StoryLog';
import { ApiKeyModal } from './components/ApiKeyModal';

export default function App() {
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('TRPG_GEMINI_KEY') || '');
  const [isKeyModalOpen, setIsKeyModalOpen] = useState(false);

  // 無 LocalStorage 紀錄時，調用 createInitialPlayer()
  const [player, setPlayer] = useState<PlayerState>(() => {
    const saved = localStorage.getItem('TRPG_PLAYER_STATE');
    return saved ? JSON.parse(saved) : createInitialPlayer();
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
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    localStorage.setItem('TRPG_PLAYER_STATE', JSON.stringify(player));
  }, [player]);

  const handleSaveApiKey = (key: string) => {
    setApiKey(key);
    localStorage.setItem('TRPG_GEMINI_KEY', key);
  };

  const handleSendAction = async (actionText: string) => {
    if (!apiKey) {
      setIsKeyModalOpen(true);
      return;
    }

    const userMsg: StoryMessage = {
      id: Date.now().toString(),
      sender: 'user',
      text: actionText,
      timestamp: new Date().toLocaleTimeString()
    };

    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      const historyTexts = messages.map((m) => `${m.sender === 'user' ? '玩家' : 'GM'}: ${m.text}`);
      const aiResponse = await sendPlayerAction(apiKey, player, actionText, historyTexts);

      // 更新玩家 Local State
      if (aiResponse.stateChanges) {
        const sc = aiResponse.stateChanges;
        setPlayer((prev) => {
          let updatedInventory = [...prev.inventory];

          if (sc.addItems) {
            sc.addItems.forEach((item) => {
              const idx = updatedInventory.findIndex((i) => i.itemId === item.itemId);
              if (idx > -1) {
                updatedInventory[idx].quantity += item.quantity;
              } else {
                updatedInventory.push({ itemId: item.itemId, quantity: item.quantity });
              }
            });
          }

          if (sc.removeItems) {
            sc.removeItems.forEach((item) => {
              const idx = updatedInventory.findIndex((i) => i.itemId === item.itemId);
              if (idx > -1) {
                updatedInventory[idx].quantity -= item.quantity;
                if (updatedInventory[idx].quantity <= 0) updatedInventory.splice(idx, 1);
              }
            });
          }

          return {
            ...prev,
            hp: Math.max(0, prev.hp + (sc.hpChange || 0)),
            mp: Math.max(0, prev.mp + (sc.mpChange || 0)),
            gold: Math.max(0, prev.gold + (sc.goldChange || 0)),
            exp: prev.exp + (sc.expChange || 0),
            inventory: updatedInventory,
            storyFlags: { ...prev.storyFlags, ...(sc.setFlags || {}) },
            currentMapId: sc.newLocationId || prev.currentMapId
          };
        });
      }

      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          sender: 'ai',
          text: aiResponse.storyText,
          options: aiResponse.suggestedActions,
          timestamp: new Date().toLocaleTimeString()
        }
      ]);
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
      <StoryLog
        messages={messages}
        loading={loading}
        onSendAction={handleSendAction}
        onOpenKeyModal={() => setIsKeyModalOpen(true)}
        hasApiKey={!!apiKey}
      />
      <PlayerHUD player={player} />
      <ApiKeyModal
        isOpen={isKeyModalOpen}
        currentKey={apiKey}
        onSave={handleSaveApiKey}
        onClose={() => setIsKeyModalOpen(false)}
      />
    </div>
  );
}