import { useEffect, useState } from 'react';
import type { ActionCheckResult, PlayerState, StoryMessage } from './types/game';
import { loadGameSession, resetPlayerState, saveGameSession } from './utils/playerStorage';
import { applyStateChanges } from './utils/applyStateChanges';
import { getMapById, getQuestById } from './data/staticData';
import { resolveActionCheck } from './utils/gameChecks';
import { sendPlayerAction } from './services/aiService';
import type { AIProvider } from './services/aiModels';
import { loadAIModelSettings, saveAIModelSettings, type AIModelSettings } from './services/aiModels';
import { PlayerHUD } from './components/PlayerHUD';
import { StoryLog } from './components/StoryLog';
import { ApiKeyModal } from './components/ApiKeyModal';

export default function App() {
  const [initialSession] = useState(loadGameSession);
  const [modelSettings, setModelSettings] = useState<AIModelSettings>(loadAIModelSettings);
  const [apiKeys, setApiKeys] = useState<Record<AIProvider, string>>(() => {
    try { return { gemini: localStorage.getItem('TRPG_GEMINI_KEY') || '', openai: '' }; }
    catch { return { gemini: '', openai: '' }; }
  });
  const apiKey = apiKeys[modelSettings.provider];
  const [isKeyModalOpen, setIsKeyModalOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [storageWarning, setStorageWarning] = useState(false);
  const [player, setPlayer] = useState<PlayerState>(initialSession.player);

  const [messages, setMessages] = useState<StoryMessage[]>(initialSession.messages.length ? initialSession.messages : [
    {
      id: '1',
      sender: 'ai',
      text: '你站在橡木村的微風旅館門口，陽光微微灑落。村長埃爾德正在公會告示板前發布關於野外哥布林襲擊的委託。你準備好開啟冒險了嗎？',
      options: ['向村長詢問任務細節', '前往綠林古道探索', '檢查背包裝備'],
      timestamp: new Date().toLocaleTimeString()
    }
  ]);
  const [loading, setLoading] = useState(false);

  const updatePlayer = (nextPlayer: PlayerState) => {
    setPlayer(nextPlayer);
  };

  useEffect(() => {
    if (!loading && !saveGameSession(player, messages)) console.warn('遊戲快照保存失敗。');
  }, [player, messages, loading]);

  const handleSaveAISettings = (settings: AIModelSettings, keys: Record<AIProvider, string>) => {
    setModelSettings(settings);
    setApiKeys(keys);
    setStorageWarning(!saveAIModelSettings(settings));
    try {
      localStorage.setItem('TRPG_GEMINI_KEY', keys.gemini);
    } catch {
      setStorageWarning(true);
    }
  };

  const handleResetPlayer = () => {
    if (!window.confirm('確定要清除目前角色存檔並重新開始嗎？')) return;
    updatePlayer(resetPlayerState());
    setMessages([{
      id: Date.now().toString(),
      sender: 'ai',
      text: '新的冒險即將開始。你站在橡木村的微風旅館門口，村長正等待冒險者前來。',
      options: ['向村長詢問任務細節', '前往綠林古道探索', '檢查背包裝備'],
      timestamp: new Date().toLocaleTimeString()
    }]);
  };

  const handleTravel = (mapId: string) => {
    const currentMap = getMapById(player.currentMapId);
    const destination = getMapById(mapId);
    if (!currentMap?.connectedMapIds.includes(mapId) || !destination) return;
    updatePlayer({ ...player, currentMapId: destination.id });
    setMessages((previous) => [...previous, {
      id: Date.now().toString(),
      sender: 'system',
      text: `你已抵達${destination.name}。${destination.description}`,
      timestamp: new Date().toLocaleTimeString()
    }]);
  };

  const handleAcceptQuest = (questId: string) => {
    const quest = getQuestById(questId);
    if (!quest || player.activeQuests.some((active) => active.questId === questId)) return;
    updatePlayer({
      ...player,
      activeQuests: [...player.activeQuests, { questId, status: 'in_progress', progress: { defeatedMonsters: {} } }]
    });
    setMessages((previous) => [...previous, {
      id: Date.now().toString(),
      sender: 'system',
      text: `已接取任務「${quest.title}」：${quest.objective}`,
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
      const aiResponse = await sendPlayerAction(modelSettings, apiKey, player, actionText, historyTexts);
      let storyText = aiResponse.storyText;
      let resultToApply = aiResponse;
      let checkResult: ActionCheckResult | undefined;

      if (aiResponse.checkRequest && aiResponse.checkOutcomes) {
        const check = resolveActionCheck(player, aiResponse.checkRequest.stat, aiResponse.checkRequest.dc);
        storyText = check.success ? aiResponse.checkOutcomes.successText : aiResponse.checkOutcomes.failureText;
        checkResult = { ...check, stat: aiResponse.checkRequest.stat, reason: aiResponse.checkRequest.reason };
        resultToApply = {
          ...aiResponse,
          stateChanges: check.success ? aiResponse.stateChanges : aiResponse.failureStateChanges
        };
      }

      // 更新玩家 Local State
      if (resultToApply.stateChanges) {
        updatePlayer(applyStateChanges(player, resultToApply));
      }

      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          sender: 'ai',
          text: storyText,
          options: aiResponse.suggestedActions,
          checkResult,
          timestamp: new Date().toLocaleTimeString()
        }
      ]);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : '無法連線至 AI 服務';
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          sender: 'system',
          text: `❌ 發生錯誤: ${errorMessage}`,
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
        selectedModel={modelSettings.model}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen((open) => !open)}
      />
      {isSidebarOpen && <PlayerHUD player={player} onReset={handleResetPlayer} storageWarning={storageWarning} onTravel={handleTravel} onAcceptQuest={handleAcceptQuest} />}
      {isKeyModalOpen && <ApiKeyModal
        isOpen={true}
        currentSettings={modelSettings}
        currentKeys={apiKeys}
        onSave={handleSaveAISettings}
        onClose={() => setIsKeyModalOpen(false)}
      />}
    </div>
  );
}
