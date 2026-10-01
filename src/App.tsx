import { useState, useEffect } from 'react';
import type { PlayerState, StoryMessage } from './types/game';
import { loadPlayerState, resetPlayerState, savePlayerState } from './utils/playerStorage';
import { applyStateChanges } from './utils/applyStateChanges';
import { sendPlayerAction } from './services/geminiService';
import { PlayerHUD } from './components/PlayerHUD';
import { StoryLog } from './components/StoryLog';
import { ApiKeyModal } from './components/ApiKeyModal';

export default function App() {
  const [apiKey, setApiKey] = useState<string>(() => {
    try { return localStorage.getItem('TRPG_GEMINI_KEY') || ''; } catch { return ''; }
  });
  const [isKeyModalOpen, setIsKeyModalOpen] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);
  const [player, setPlayer] = useState<PlayerState>(loadPlayerState);

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
    setStorageWarning(!savePlayerState(player));
  }, [player]);

  const handleSaveApiKey = (key: string) => {
    setApiKey(key);
    try {
      localStorage.setItem('TRPG_GEMINI_KEY', key);
    } catch {
      setStorageWarning(true);
    }
  };

  const handleResetPlayer = () => {
    if (!window.confirm('確定要清除目前角色存檔並重新開始嗎？')) return;
    setPlayer(resetPlayerState());
    setMessages([{
      id: Date.now().toString(),
      sender: 'ai',
      text: '新的冒險即將開始。你站在橡木村的微風旅館門口，村長正等待冒險者前來。',
      options: ['向村長詢問任務細節', '前往綠林古道探索', '檢查背包裝備'],
      timestamp: new Date().toLocaleTimeString()
    }]);
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
        setPlayer((prev) => applyStateChanges(prev, aiResponse));
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
      <PlayerHUD player={player} onReset={handleResetPlayer} storageWarning={storageWarning} />
      <ApiKeyModal
        isOpen={isKeyModalOpen}
        currentKey={apiKey}
        onSave={handleSaveApiKey}
        onClose={() => setIsKeyModalOpen(false)}
      />
    </div>
  );
}
