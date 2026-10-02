import { useEffect, useState } from 'react';
import type { ActionCheckResult, PlayerGrowthStatic, PlayerState, StoryMessage } from './types/game';
import { loadGameSession, resetPlayerState, saveGameSession } from './utils/playerStorage';
import { applyStateChanges } from './utils/applyStateChanges';
import { canPlayerEnterMap, getCharacterClassById, getItemById, getMapById, getMonsterById, getPlayerResourceCaps, getQuestById, getUnlockedSkillsByLevel } from './data/staticData';
import { getPlayerStatBreakdown, resolveActionCheck } from './utils/gameChecks';
import { resolveExplicitTravelIntent, storyClaimsPlayerMoved } from './utils/travelIntent';
import { sendPlayerAction } from './services/aiService';
import { acceptQuest } from './utils/questRules';
import { canPlayerAct, isPlayerUnconscious } from './utils/playerStatus';
import type { AIProvider } from './services/aiModels';
import { loadAIModelSettings, saveAIModelSettings, type AIModelSettings } from './services/aiModels';
import { PlayerHUD } from './components/PlayerHUD';
import { StoryLog } from './components/StoryLog';
import { ApiKeyModal } from './components/ApiKeyModal';
import { CharacterSetup } from './components/CharacterSetup';
import { createInitialPlayer } from './utils/playerInit';
import type { CharacterAlignment } from './types/game';

function resolveEnemyTurn(player: PlayerState, combat: NonNullable<PlayerState['combat']>, monster: NonNullable<ReturnType<typeof getMonsterById>>) {
  const special = monster.specialAbilities.find((ability) => ability.combatAction && combat.round % ability.combatAction.triggerEveryRounds === 0);
  const action = special?.combatAction;
  const checkStat = action?.checkStat ?? 'def';
  const dc = action?.dc ?? 10 + Math.floor(monster.stats.atk / 2);
  const check = {
    ...resolveActionCheck(player, checkStat, dc),
    stat: checkStat,
    reason: action ? `${monster.name}施放${special?.name}：玩家進行${checkStat === 'dex' ? '閃避' : '抵抗'}檢定` : `${monster.name}反擊：玩家進行閃避檢定`,
    label: action ? `${special?.name}檢定` : '玩家閃避檢定'
  } satisfies ActionCheckResult;
  const damage = check.success ? 0 : Math.max(1, Math.floor(monster.stats.atk * (action?.damageMultiplier ?? 1)) - Math.floor(getPlayerStatBreakdown(player, 'def').statValue / 4));
  const hp = Math.max(0, player.hp - damage);
  const isDead = hp <= 0;
  const unconsciousTurns = !isDead && !check.success ? action?.applyUnconsciousTurnsOnFailure ?? 0 : 0;
  const statusEffects = player.statusEffects.filter((effect) => effect.id !== 'unconscious');
  if (unconsciousTurns > 0) statusEffects.push({ id: 'unconscious', remainingTurns: unconsciousTurns });
  const nextPlayer: PlayerState = {
    ...player, hp, isDead, statusEffects,
    ...(isDead ? { combat: undefined } : { combat: { ...combat, round: combat.round + 1 } })
  };
  const result = check.success
    ? action ? `你成功閃過${special?.name}。` : `你成功閃避${monster.name}的反擊。`
    : `${action ? `${special?.name}命中` : `${monster.name}反擊命中`}，你受到 ${damage} 點傷害。${unconsciousTurns ? `你陷入昏迷 ${unconsciousTurns} 回合。` : ''}`;
  return { player: nextPlayer, check, text: `${result}${isDead ? '\n☠️ HP 歸零，你已死亡。' : `\n第 ${combat.round + 1} 回合開始。`}` };
}

function createRestoreNotice(player: PlayerState, savedAt: number, messageCount: number): StoryMessage {
  const map = getMapById(player.currentMapId);
  const combatMonster = player.combat ? getMonsterById(player.combat.monsterId) : undefined;
  const activeQuests = player.activeQuests.filter((quest) => quest.status === 'in_progress')
    .map((quest) => getQuestById(quest.questId)?.title ?? quest.questId);
  const inventory = player.inventory.map((entry) => `${getItemById(entry.itemId)?.name ?? entry.itemId} ×${entry.quantity}`);
  const lines = [
    `📦 遊戲快照已恢復（${new Date(savedAt).toLocaleString()}）`,
    `地區：${map?.name ?? player.currentMapId}｜角色：${player.name} Lv.${player.level}｜HP ${player.hp}｜MP ${player.mp}｜金幣 ${player.gold}`,
    `已恢復最近對話：${messageCount} 則`,
    `進行中任務：${activeQuests.length ? activeQuests.join('、') : '無'}`,
    `持有物：${inventory.length ? inventory.join('、') : '無'}`
  ];
  if (combatMonster && player.combat) lines.push(`戰鬥恢復：第 ${player.combat.round} 回合，${combatMonster.name} HP ${player.combat.currentHp}/${combatMonster.stats.hp}`);
  else lines.push('戰鬥狀態：目前沒有進行中的戰鬥。');
  return {
    id: 'session-restore-notice',
    sender: 'system',
    text: lines.join('\n'),
    timestamp: new Date(savedAt).toLocaleTimeString()
  };
}

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
  const [isCharacterSetupOpen, setIsCharacterSetupOpen] = useState(!initialSession.player.setupComplete);

  const [messages, setMessages] = useState<StoryMessage[]>(initialSession.resumed
    ? [createRestoreNotice(initialSession.player, initialSession.savedAt!, initialSession.messages.filter((message) => message.id !== 'session-restore-notice').length), ...initialSession.messages.filter((message) => message.id !== 'session-restore-notice')]
    : initialSession.messages.length ? initialSession.messages : [
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
    setIsCharacterSetupOpen(true);
    setMessages([{
      id: Date.now().toString(),
      sender: 'ai',
      text: '新的冒險即將開始。你站在橡木村的微風旅館門口，村長正等待冒險者前來。',
      options: ['向村長詢問任務細節', '前往綠林古道探索', '檢查背包裝備'],
      timestamp: new Date().toLocaleTimeString()
    }]);
  };

  const handleCreateCharacter = (name: string, classId: string, alignment: CharacterAlignment) => {
    const newPlayer = createInitialPlayer(name, classId, alignment, true);
    updatePlayer(newPlayer);
    setIsCharacterSetupOpen(false);
    setMessages([{
      id: `${Date.now()}`,
      sender: 'ai',
      text: `新的冒險即將開始。${name}（${getCharacterClassById(classId)?.name ?? classId}）來到橡木村，村長埃爾德正在公會告示板前等候冒險者。`,
      options: ['向村長詢問任務細節', '前往綠林古道探索', '檢查背包裝備'],
      timestamp: new Date().toLocaleTimeString()
    }]);
  };

  const movePlayerTo = (mapId: string, sourcePlayer: PlayerState = player) => {
    if (sourcePlayer.combat || !canPlayerAct(sourcePlayer)) return null;
    const currentMap = getMapById(sourcePlayer.currentMapId);
    const destination = getMapById(mapId);
    if (!currentMap?.connectedMapIds.includes(mapId) || !destination || !canPlayerEnterMap(sourcePlayer, destination)) return null;
    const nextPlayer = { ...sourcePlayer, previousMapId: sourcePlayer.currentMapId, currentMapId: destination.id };
    updatePlayer(nextPlayer);
    return { player: nextPlayer, destination };
  };

  const handleTravel = (mapId: string) => {
    const travel = movePlayerTo(mapId);
    if (!travel) return;
    setMessages((previous) => [...previous, {
      id: Date.now().toString(),
      sender: 'system',
      text: `你已抵達${travel.destination.name}。${travel.destination.description}`,
      timestamp: new Date().toLocaleTimeString()
    }]);
  };

  const handleAcceptQuest = (questId: string) => {
    const quest = getQuestById(questId);
    if (!quest) return;
    const accepted = acceptQuest(player, quest);
    if (!accepted) return;
    updatePlayer(accepted);
    setMessages((previous) => [...previous, {
      id: Date.now().toString(),
      sender: 'system',
      text: `已接取任務「${quest.title}」：${quest.objective}`,
      timestamp: new Date().toLocaleTimeString()
    }]);
  };

  const appendSystemMessage = (text: string, checkResults?: ActionCheckResult[]) => {
    setMessages((previous) => [...previous, {
      id: `${Date.now()}-${Math.random()}`,
      sender: 'system',
      text,
      checkResults,
      timestamp: new Date().toLocaleTimeString()
    }]);
  };

  const handleStartCombat = (monsterId: string) => {
    const map = getMapById(player.currentMapId);
    const monster = getMonsterById(monsterId);
    if (player.combat || !canPlayerAct(player) || !map || map.isSafeZone || !map.monstersPresent.includes(monsterId) || !monster ||
        (monster.requiredQuestId && !player.activeQuests.some((quest) => quest.questId === monster.requiredQuestId && quest.status === 'in_progress'))) return;
    updatePlayer({ ...player, combat: { monsterId, currentHp: monster.stats.hp, round: 1 } });
    appendSystemMessage(`你與${monster.name}進入戰鬥！攻擊、已解鎖技能及消耗品各自消耗一個行動回合；敵人存活時會反擊並進行閃避檢定。`);
  };

  const handleFleeCombat = () => {
    if (!player.combat || !canPlayerAct(player)) return;
    const monster = getMonsterById(player.combat.monsterId);
    const outOfCombat = { ...player };
    delete outOfCombat.combat;
    updatePlayer(outOfCombat);
    appendSystemMessage(`你與${monster?.name ?? '敵人'}拉開距離，戰鬥結束。`);
  };

  const handleCombatAction = (skill?: NonNullable<PlayerGrowthStatic['unlockedSkill']>) => {
    const combat = player.combat;
    const monster = combat ? getMonsterById(combat.monsterId) : undefined;
    if (!combat || !monster || player.isDead) return;
    if (isPlayerUnconscious(player)) {
      const recovered = { ...player, statusEffects: player.statusEffects.filter((effect) => effect.id !== 'unconscious'), combat: { ...combat } };
      const enemyTurn = resolveEnemyTurn(recovered, combat, monster);
      updatePlayer(enemyTurn.player);
      appendSystemMessage(`你仍昏迷，失去本回合行動。\n${enemyTurn.text}`, [enemyTurn.check]);
      return;
    }
    if (skill && player.mp < skill.costMp) return;

    const attackCheck = {
      ...resolveActionCheck(player, 'atk', 10 + monster.stats.def),
      stat: 'atk' as const,
      reason: `第 ${combat.round} 回合：${skill?.name ?? '攻擊'}${monster.name}`,
      label: '玩家攻擊檢定'
    };
    const checks: ActionCheckResult[] = [attackCheck];
    const playerAttack = getPlayerStatBreakdown(player, 'atk').statValue;
    const damage = attackCheck.success
      ? Math.max(1, Math.floor(playerAttack * (skill?.effect.multiplier ?? 1)) - monster.stats.def)
      : 0;
    const monsterHp = attackCheck.success
      ? Math.max(0, combat.currentHp - damage)
      : combat.currentHp;
    const attackText = attackCheck.success
      ? `${skill?.name ?? '攻擊'}命中，對${monster.name}造成 ${damage} 點傷害。`
      : `${skill?.name ?? '攻擊'}未命中${monster.name}。`;
    const actionPlayer = skill ? { ...player, mp: player.mp - skill.costMp } : player;

    if (monsterHp <= 0) {
      const dropItems = monster.rewards.dropItems.flatMap((drop) => {
        if (!globalThis.crypto?.getRandomValues) return [];
        const roll = new Uint32Array(1);
        globalThis.crypto.getRandomValues(roll);
        return roll[0] / 0x1_0000_0000 < drop.chance ? [{ itemId: drop.itemId, quantity: 1 }] : [];
      });
      const questUpdates = player.activeQuests.filter((quest) => quest.status === 'in_progress')
        .map((quest) => ({ questId: quest.questId, status: 'completed' as const }));
      const nextPlayer = applyStateChanges(actionPlayer, {
        storyText: '', suggestedActions: [],
        stateChanges: {
          expChange: monster.rewards.exp,
          goldChange: monster.rewards.gold,
          addItems: dropItems,
          defeatedMonsters: [{ monsterId: monster.id, quantity: 1 }],
          questUpdates
        }
      }, 'game');
      const completedQuests = nextPlayer.activeQuests.filter((quest) => quest.status === 'completed' &&
        player.activeQuests.some((previous) => previous.questId === quest.questId && previous.status === 'in_progress'));
      const dropText = dropItems.length ? `取得掉落物：${dropItems.map((item) => `${getItemById(item.itemId)?.name ?? item.itemId} ×${item.quantity}`).join('、')}。` : '沒有掉落物。';
      const questText = completedQuests.map((quest) => `任務「${getQuestById(quest.questId)?.title ?? quest.questId}」完成，需求道具已交付並領取獎勵。`).join('\n');
      const victoryState = { ...nextPlayer };
      delete victoryState.combat;
      updatePlayer(victoryState);
      appendSystemMessage(`🏆 ${attackText}\n${monster.name}已被擊敗！獲得 ${monster.rewards.exp} EXP、${monster.rewards.gold} 金幣。${dropText}${questText ? `\n${questText}` : ''}`, checks);
      return;
    }

    const enemyTurn = resolveEnemyTurn({ ...actionPlayer, combat: { ...combat, currentHp: monsterHp } }, { ...combat, currentHp: monsterHp }, monster);
    updatePlayer(enemyTurn.player);
    appendSystemMessage(`${attackText}\n${enemyTurn.text}`, [...checks, enemyTurn.check]);
  };

  const handleAttack = () => handleCombatAction();

  const handleUseSkill = (skillId: string) => {
    const skill = getUnlockedSkillsByLevel(player.level).find((entry) => entry.id === skillId);
    if (!skill || !player.combat || !canPlayerAct(player) || player.mp < skill.costMp) return;
    handleCombatAction(skill);
  };

  const handleUseItem = (itemId: string) => {
    const item = getItemById(itemId);
    const inventoryEntry = player.inventory.find((entry) => entry.itemId === itemId);
    if (!item || item.type !== 'consumable' || !inventoryEntry || inventoryEntry.quantity <= 0 || !canPlayerAct(player) || (player.combat && !item.usableInCombat)) return;
    const caps = getPlayerResourceCaps(player.level, player.classId);
    const hpRestore = Math.min(item.effect.hpRestore ?? 0, Math.max(0, caps.maxHp - player.hp));
    const mpRestore = Math.min(item.effect.mpRestore ?? 0, Math.max(0, caps.maxMp - player.mp));
    if (hpRestore <= 0 && mpRestore <= 0) {
      appendSystemMessage(`${item.name}目前無法恢復任何 HP 或 MP，沒有消耗道具。`);
      return;
    }

    const next = applyStateChanges(player, {
      storyText: '', suggestedActions: [],
      stateChanges: { hpChange: hpRestore, mpChange: mpRestore, removeItems: [{ itemId, quantity: 1 }] }
    }, 'game');
    const details = [hpRestore > 0 ? `HP +${hpRestore}` : '', mpRestore > 0 ? `MP +${mpRestore}` : ''].filter(Boolean).join('、');
    if (!player.combat) {
      updatePlayer(next);
      appendSystemMessage(`使用${item.name}，${details}。`);
      return;
    }

    const monster = getMonsterById(player.combat.monsterId);
    if (!monster) return;
    const enemyTurn = resolveEnemyTurn({ ...next, combat: player.combat }, player.combat, monster);
    updatePlayer(enemyTurn.player);
    appendSystemMessage(`使用${item.name}，${details}。\n${enemyTurn.text}`, [enemyTurn.check]);
  };

  const handleSendAction = async (actionText: string) => {
    if (player.combat || !canPlayerAct(player)) {
      appendSystemMessage(player.isDead ? '角色已死亡，無法繼續行動。請重設角色開始新的冒險。' : '角色目前昏迷，無法採取行動。');
      return;
    }
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
      let nextPlayer = player;

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
        nextPlayer = applyStateChanges(player, resultToApply);
        updatePlayer(nextPlayer);
      }
      const deathNotice = !player.isDead && nextPlayer.isDead
        ? '\n\n☠️ 你的生命值降至 0，角色死亡。這段冒險已結束。'
        : '';
      const acceptedQuests = nextPlayer.activeQuests.filter((entry) => entry.status === 'in_progress' &&
        !player.activeQuests.some((previous) => previous.questId === entry.questId));
      const questNotice = acceptedQuests.length
        ? `\n\n📜 已接取任務「${acceptedQuests.map((entry) => getQuestById(entry.questId)?.title ?? entry.questId).join('、')}」。`
        : '';

      const textTravelIntent = resolveExplicitTravelIntent(actionText, player);
      const requestedDestinationId = textTravelIntent.kind === 'resolved'
        ? textTravelIntent.destination.id
        : textTravelIntent.kind === 'ambiguous'
          ? undefined
          : aiResponse.travelRequest?.destinationMapId;
      const travel = requestedDestinationId ? movePlayerTo(requestedDestinationId, nextPlayer) : null;
      if (travel) nextPlayer = travel.player;

      const previousMap = getMapById(player.currentMapId);
      const nextMap = getMapById(nextPlayer.currentMapId);
      const locationNotice = travel
        ? `\n\n📍 你已抵達${travel.destination.name}。${travel.destination.description}`
        : textTravelIntent.kind === 'ambiguous'
          ? `\n\n📍 你想前往的地區有多個可能地點，請選擇目的地：`
          : requestedDestinationId
          ? `\n\n⚠️ 目前無法前往「${getMapById(requestedDestinationId)?.name ?? requestedDestinationId}」，所在地區未變更。請選擇右側「鄰近地點」中的可前往區域。`
          : storyClaimsPlayerMoved(storyText)
            ? `\n\n⚠️ 目前沒有有效的地區移動請求，因此所在地區未變更。若要移動，請明確指定可前往地點。`
          : previousMap && nextMap && previousMap.id !== nextMap.id
            ? `\n\n⚠️ AI 敘事提及地區變更，但沒有有效的移動請求；所在地區維持${previousMap.name}。`
            : '';

      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          sender: 'ai',
          text: `${storyText}${questNotice}${locationNotice}${deathNotice}`,
          options: aiResponse.suggestedActions,
          travelOptions: textTravelIntent.kind === 'ambiguous'
            ? textTravelIntent.candidates.map((candidate) => ({ mapId: candidate.id, name: candidate.name }))
            : undefined,
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
        combatActive={!!player.combat}
        inputDisabled={player.isDead || isPlayerUnconscious(player)}
        onTravel={handleTravel}
      />
      {isSidebarOpen && <PlayerHUD player={player} onReset={handleResetPlayer} storageWarning={storageWarning} onTravel={handleTravel} onAcceptQuest={handleAcceptQuest} onStartCombat={handleStartCombat} onFleeCombat={handleFleeCombat} onAttack={handleAttack} onUseSkill={handleUseSkill} onUseItem={handleUseItem} />}
      {isKeyModalOpen && <ApiKeyModal
        isOpen={true}
        currentSettings={modelSettings}
        currentKeys={apiKeys}
        onSave={handleSaveAISettings}
        onClose={() => setIsKeyModalOpen(false)}
      />}
      {isCharacterSetupOpen && <CharacterSetup onCreate={handleCreateCharacter} />}
    </div>
  );
}
