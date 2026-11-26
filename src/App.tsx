import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ActionCheckResult, CharacterHistoryEntry, SaveSlotId, SkillStatic, PlayerState, StoryMessage } from './types/game';
import { AUTO_SLOT_ID, clearLegacySaves, continueWorldWithCharacter, createHistoryEntry, createWorld, deleteSlot, deleteWorld, exportWorld, getLastWriteFailed, importWorld, loadSaveIndex, readSlot, setActiveWorld, subscribeSaveStatus, writeSlot, type LoadedSlot } from './utils/saveStorage';
import { SaveManager } from './components/SaveManager';
import { applyStateChanges } from './utils/applyStateChanges';
import { applyMemoryNotes, getMemoryEligibleUnitIds } from './utils/unitMemory';
import { aiContextConfig, canPlayerEnterMap, combatRules, getCharacterClassById, getItemById, getMapById, getPlayerResourceCaps, getShopById, getUnlockedSkills, getWorldUnitById, getWorldUnitDisposition, getWorldUnitsAtMap, itemsDatabase, scenario } from './data/staticData';
import { getClaimedArrivalMapIds, resolveExplicitTravelIntent, storyClaimsPlayerMoved, type TravelIntentResolution } from './utils/travelIntent';
import { buildSystemOptions, getCombatStartBlock, type SystemAction } from './utils/systemOptions';
import { OptionBar } from './components/OptionBar';
import { travelAlongRoute, type RouteTravelResult } from './utils/travelRoute';
import { sendPlayerAction } from './services/aiService';
import { acceptQuest, canTurnInQuest, findQuest, getQuestGiverName } from './utils/questRules';
import { postQuestProposals } from './utils/generatedQuests';
import { describeStoryProgress, startStorylets } from './utils/storylets';
import { canPlayerAct, isPlayerUnconscious, isTimelineEnded } from './utils/playerStatus';
import type { AIProvider } from './services/aiModels';
import { isAgentAIEnabled, loadAIModelSettings, saveAIModelSettings, type AIModelSettings } from './services/aiModels';
import { canMakeAnotherCall, getAICallCount } from './services/aiContext';
import { buildAgentBatchRequest, createPendingReport, recordAgentDecisionReport, requestAgentDecisionText, resolveAgentBatch } from './services/agentDecisionService';
import type { AgentBatch } from './utils/agents';
import { PlayerHUD } from './components/PlayerHUD';
import { StoryLog } from './components/StoryLog';
import { ApiKeyModal } from './components/ApiKeyModal';
import { CharacterSetup } from './components/CharacterSetup';
import { createInitialPlayer } from './utils/playerInit';
import { isSelfDamageIntent, parseExplicitSelfDamage, parseWaitIntent, unsupportedInventoryItemRequested } from './utils/playerActionIntent';
import { buyItem, getAvailableServices, purchaseService, sellItem } from './utils/tradeRules';
import { ACTION_DURATIONS, advanceGameTime, formatDuration, formatGameTime, getGameDay, isValidWaitMinutes, MAX_WAIT_MINUTES, waitGameTime } from './utils/gameTime';
import { getCombatTarget } from './utils/combatState';
import { resolveActionCheck } from './utils/gameChecks';
import { applyPostActionRules, getCombatActionBlock, OPENING_LABELS, resolveAmbush, resolveCombatRequest, resolveFoundByEnemy, resolvePlayerCombatAction, resolveTrapWait, startCombatByPlan, startNormalCombat, switchCombatTarget, type CombatStepResult, type PlayerCombatAction } from './utils/combatResolution';
import { getInviteBlock, joinParty, leaveParty, getCompanionResources } from './utils/party';
import { clearEncounter, filterCombatSuggestions, findAggressiveResident, getAmbushableUnit, getEncounteredUnit, getSpottedHostileEncounter, hasCombatClaim, hasEnemyNearby, isTypedAmbushText, isTypedCombatText, isTypedTrapText, setEncounter } from './utils/encounters';
import { applyEventProposals, finalizeWorldWithAgentBatch, getEventSeq, getPlayerKnownEvents, isKnownToPlayerOnOccurrence, type DeathHint, type PlayerPosition } from './utils/worldEvents';
import { createSuccessorReputation, describeReputationChanges } from './utils/factions';
import { rollWaitInterruption } from './utils/waitRules';
import type { CharacterAlignment } from './types/game';

/** 多段移動的結果說明（O44）：途經地區、耗時，以及途中遭遇或未抵達的原因。 */
function describeRouteTravel(travel: RouteTravelResult, player: PlayerState): string {
  const via = travel.passed.length ? `途經${travel.passed.map((map) => map.name).join('、')}，` : '';
  const unit = travel.interruptedByUnitId ? getWorldUnitById(travel.interruptedByUnitId, player) : undefined;
  if (unit) {
    // 途中被找上（O45）：附上察覺結果（先發現對方，或遭到偷襲）。
    return `📍 你從${travel.origin.name}出發前往${travel.destination.name}，${via}在${travel.arrived.name}遇到${unit.name}，移動被打斷（耗時 ${formatDuration(travel.elapsedMinutes)}）。\n${travel.foundByEnemy?.text ?? `👁️ 遭遇：${unit.name}。`}`;
  }
  if (travel.stoppedBySegmentLimit) {
    return `📍 你從${travel.origin.name}出發前往${travel.destination.name}，${via}走了 ${formatDuration(travel.elapsedMinutes)}，目前停在${travel.arrived.name}，尚未抵達。單次行動最多移動 ${travel.passed.length + 1} 段，請繼續前往。`;
  }
  const time = travel.passed.length ? `耗時 ${formatDuration(travel.elapsedMinutes)}，` : '';
  return `📍 你${travel.passed.length ? `從${travel.origin.name}出發，` : ''}${via}${time}抵達${travel.arrived.name}。${travel.arrived.description}`;
}

/** 隊伍變化的系統訊息（O35-1）：入隊、離隊（含原因與回到的地方）。 */
function describePartyChange(before: PlayerState, after: PlayerState): string | undefined {
  const name = (unitId: string) => getWorldUnitById(unitId, after)?.name ?? unitId;
  const joined = after.party.filter((unitId) => !before.party.includes(unitId));
  const left = before.party.filter((unitId) => !after.party.includes(unitId));
  const lines = [
    ...joined.map((unitId) => `🤝 ${name(unitId)}加入了你的隊伍，會跟著你行動、一起戰鬥。`),
    ...left.map((unitId) => {
      const home = getMapById(getWorldUnitById(unitId)?.homeMapId ?? '')?.name ?? '原處';
      if (after.unitInstances[unitId]?.isDead) return `☠️ ${name(unitId)}已經不在人世，離開了隊伍。`;
      const hostile = getWorldUnitDisposition(after, unitId) === 'hostile';
      return `👋 ${name(unitId)}${hostile ? '對你轉為敵對，' : ''}離開了隊伍，回到${home}。${hostile ? '' : '之後可以再邀請同行。'}`;
    })
  ];
  return lines.length ? lines.join('\n') : undefined;
}

function createRestoreNotice(player: PlayerState, savedAt: number, messageCount: number): StoryMessage {
  const map = getMapById(player.currentMapId);
  const combatTarget = player.combat ? getCombatTarget(player.combat) : undefined;
  const activeQuests = player.activeQuests.filter((quest) => quest.status === 'in_progress')
    .map((quest) => findQuest(player, quest.questId)?.title ?? quest.questId);
  const inventory = player.inventory.map((entry) => `${getItemById(entry.itemId)?.name ?? entry.itemId} ×${entry.quantity}`);
  const lines = [
    `📦 遊戲快照已恢復（${new Date(savedAt).toLocaleString()}）`,
    `時間：${formatGameTime(player.gameTimeMinutes)}｜地區：${map?.name ?? player.currentMapId}｜角色：${player.name} Lv.${player.level}｜HP ${player.hp}｜MP ${player.mp}｜金幣 ${player.gold}`,
    `已恢復最近對話：${messageCount} 則`,
    `進行中任務：${activeQuests.length ? activeQuests.join('、') : '無'}`,
    `持有物：${inventory.length ? inventory.join('、') : '無'}`
  ];
  // 隊伍（O35-1）獨立一行，不影響下面的戰鬥／遭遇判斷（review 第 1 輪 R1）。
  if (player.party.length) lines.push(`隊伍：${player.party.map((unitId) => getWorldUnitById(unitId, player)?.name ?? unitId).join('、')}`);
  if (combatTarget && player.combat) lines.push(`戰鬥恢復：第 ${player.combat.round} 回合，${combatTarget.label} HP ${combatTarget.currentHp}（${OPENING_LABELS[player.combat.opening]}）`);
  else if (player.encounteredUnitId) lines.push(`已遭遇單位：${getWorldUnitById(player.encounteredUnitId)?.name ?? player.encounteredUnitId}${player.encounterInfo?.playerSpottedFirst ? '（你先發現對方，可從選項列伏擊或挑戰）' : '（可從選項列挑戰）'}`);
  else lines.push('戰鬥狀態：目前沒有進行中的戰鬥，也尚未遭遇敵人。');
  return {
    id: 'session-restore-notice',
    sender: 'system',
    text: lines.join('\n'),
    timestamp: new Date(savedAt).toLocaleTimeString()
  };
}

function createOpeningMessage(id: string, text: string): StoryMessage {
  return { id, sender: 'ai', text, options: [...scenario.opening.suggestedActions], timestamp: new Date().toLocaleTimeString() };
}

/** 讀檔後的對話：開頭附上恢復摘要（取代舊的摘要）。 */
function withRestoreNotice(slot: LoadedSlot): StoryMessage[] {
  const previous = slot.messages.filter((message) => message.id !== 'session-restore-notice');
  return [createRestoreNotice(slot.player, slot.savedAt, previous.length), ...previous];
}

/** 啟動時讀取目前世界的自動存檔；沒有可用世界時準備建立新世界。 */
function loadInitialState() {
  clearLegacySaves();
  const index = loadSaveIndex();
  const slot = index.activeWorldId ? readSlot(index.activeWorldId, AUTO_SLOT_ID) : null;
  if (index.activeWorldId && slot) {
    return { worldId: index.activeWorldId, player: slot.player, messages: withRestoreNotice(slot), characterHistory: slot.characterHistory };
  }
  return { worldId: undefined, player: createInitialPlayer(), messages: [createOpeningMessage('1', scenario.opening.introText)], characterHistory: [] };
}

/** 窄螢幕：側欄改為抽屜（O50）。 */
const NARROW_QUERY = '(max-width: 767px)';

function downloadJson(fileName: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [initialSession] = useState(loadInitialState);
  const [modelSettings, setModelSettings] = useState<AIModelSettings>(loadAIModelSettings);
  const [apiKeys, setApiKeys] = useState<Record<AIProvider, string>>(() => {
    try { return { gemini: localStorage.getItem('TRPG_GEMINI_KEY') || '', openai: '' }; }
    catch { return { gemini: '', openai: '' }; }
  });
  const apiKey = apiKeys[modelSettings.provider];
  const [isKeyModalOpen, setIsKeyModalOpen] = useState(false);
  // 窄螢幕（手機）時側欄預設收起，展開時以抽屜覆蓋在故事上方，點遮罩收起（O50 選項列需要完整寬度）。
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches);
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => setIsNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const [storageWarning, setStorageWarning] = useState(false);
  const [player, setPlayer] = useState<PlayerState>(initialSession.player);
  const [activeWorldId, setActiveWorldId] = useState<string | undefined>(initialSession.worldId);
  const [characterHistory, setCharacterHistory] = useState<CharacterHistoryEntry[]>(initialSession.characterHistory);
  // new-world：建立新世界的第一位角色；continue：在目前世界接續新角色。
  const [setupMode, setSetupMode] = useState<'new-world' | 'continue' | null>(initialSession.worldId ? null : 'new-world');
  const [isSaveManagerOpen, setIsSaveManagerOpen] = useState(false);
  const autosaveFailed = useSyncExternalStore(subscribeSaveStatus, getLastWriteFailed);

  const [messages, setMessages] = useState<StoryMessage[]>(initialSession.messages);
  const [loading, setLoading] = useState(false);
  // 重要角色 AI 批次決策進行中（O34 第 2 階段）：選項列與輸入顯示「各方正在盤算…」並停用。
  const [agentThinking, setAgentThinking] = useState(false);
  // 非同步流程（角色決策回應）需要的最新狀態；讀檔、開新世界、建立角色時讀檔世代加一，用來丟棄過期結果。
  const playerRef = useRef(player);
  const activeWorldIdRef = useRef(activeWorldId);
  const sessionGenRef = useRef(0);
  // AI 回合開始時的呼叫計數；回合外為 null（每回合呼叫上限用）。
  const turnCallBaseRef = useRef<number | null>(null);
  useEffect(() => { playerRef.current = player; }, [player]);
  useEffect(() => { activeWorldIdRef.current = activeWorldId; }, [activeWorldId]);
  /** 讀檔、開新世界、建立角色：進行中的角色決策結果作廢。 */
  const startNewSession = () => {
    sessionGenRef.current += 1;
    setAgentThinking(false);
  };

  /**
   * 行動造成的狀態變更一律經此套用：先執行世界規則（死亡紀錄、地區結算、自動事件），
   * 新寫入的世界事件以系統訊息附在本次行動結果之後。讀檔與換角色不是行動，直接 setPlayer。
   */
  const updatePlayer = (rawNextPlayer: PlayerState, rawDeathHints?: Record<string, DeathHint>) => {
    // O45：遭遇失效、離開地區清除強制開戰紀錄、進入新地區時敵對居民主動攻擊；結果以系統訊息附在本次行動之後。
    const post = applyPostActionRules(player, rawNextPlayer);
    const nextPlayer = post.player;
    const deathHints = post.deathHints ? { ...rawDeathHints, ...post.deathHints } : rawDeathHints;
    for (const notice of post.notices) setTimeout(() => appendSystemMessage(notice.text, notice.checks.length ? notice.checks : undefined, true), 0);
    const usedThisTurn = turnCallBaseRef.current === null ? 0 : getAICallCount() - turnCallBaseRef.current;
    const skipReason = !isAgentAIEnabled(modelSettings) ? '設定已關閉角色 AI' : !apiKey.trim() ? '尚未設定 API Key'
      : nextPlayer.isDead ? '角色已死亡' : !canMakeAnotherCall(usedThisTurn) ? '已達每回合呼叫上限' : undefined;
    const { state: finalized, agentBatch } = finalizeWorldWithAgentBatch(player, nextPlayer, deathHints, { deferAgentsToAI: !skipReason });
    commitWorldUpdate(player, finalized);
    if (agentBatch) startAgentBatch(finalized, agentBatch, { currentMapId: player.currentMapId, gameTimeMinutes: player.gameTimeMinutes });
    else if (skipReason && getGameDay(finalized.gameTimeMinutes) > getGameDay(player.gameTimeMinutes)) recordRuleOnlyAgentDecision(skipReason);
  };

  /**
   * 套用已結算的狀態並附上訊息：主線進度、本次行動中玩家當下得知的新事件（🌍 世界變化），
   * 以及抵達地區時得知的事件（得知消息，最多 news.maxNoticeEvents 件、不含例行事件）。positionBefore 為行動前的位置（判定移動用）。
   */
  function commitWorldUpdate(before: PlayerState, finalized: PlayerState, positionBefore: PlayerPosition = before) {
    setPlayer(finalized);
    playerRef.current = finalized;
    // 隊伍變化（O35-1）：邀請、離隊、劇情效果與自動離隊都在這裡告知，避免重複訊息。
    const partyNotice = describePartyChange(before, finalized);
    if (partyNotice) setTimeout(() => appendSystemMessage(partyNotice, undefined, true), 0);
    // 劇情片段完成與推進幕另以主線訊息呈現，不重複列在世界變化中。
    const storyNotice = describeStoryProgress(before, finalized);
    if (storyNotice) setTimeout(() => appendSystemMessage(storyNotice), 0);
    const knownBefore = new Set(before.world.playerKnownEventIds);
    const learned = getPlayerKnownEvents(finalized).filter((event) => !knownBefore.has(event.id));
    const knownOnOccurrence = (event: typeof learned[number]) => getEventSeq(event) >= before.world.nextEventSeq && isKnownToPlayerOnOccurrence(positionBefore, finalized, event);
    const worldChanges = learned.filter((event) => knownOnOccurrence(event) && event.type !== 'story_progress');
    if (worldChanges.length) {
      // 劇情事件附帶的聲望變化另外列出（玩家行動造成的聲望事件已寫在描述中）。
      const describe = (event: typeof worldChanges[number]) => event.type === 'scenario_event' && event.reputationChanges?.length
        ? `${event.summary}（聲望變化：${describeReputationChanges(before, event.reputationChanges)}）` : event.summary;
      setTimeout(() => appendSystemMessage(`🌍 世界變化：\n${worldChanges.map((event) => `・${describe(event)}`).join('\n')}`), 0);
    }
    // 抵達時得知（含旅途中目的地在午夜發生的事）。
    const news = learned.filter((event) => !knownOnOccurrence(event) && !aiContextConfig.chronicle.routineEventTypes.includes(event.type))
      .slice(-aiContextConfig.news.maxNoticeEvents);
    if (news.length) {
      setTimeout(() => appendSystemMessage(`${scenario.news.noticePrefix}\n${news.map((event) => `・${formatGameTime(event.gameTimeMinutes)}｜${event.summary}`).join('\n')}`), 0);
    }
  }

  /** 沒有送出角色決策請求、整批依規則時的設定頁說明。 */
  function recordRuleOnlyAgentDecision(reason: string) {
    recordAgentDecisionReport({ builtAt: Date.now(), result: 'rule', reason, agentCount: 0, estimatedTokens: 0, totalChars: 0, systemPrompt: '', userPrompt: '', outcomes: [] });
  }

  /**
   * 角色決策批次（O34 第 2 階段）：本回合敘事已顯示後送出請求，期間暫停操作；結果回來時若已讀檔、換世界或時間改變則丟棄。
   * 沒有可送的角色或時間線已結束時，立即以規則套用。
   */
  function startAgentBatch(base: PlayerState, batch: AgentBatch, positionBefore: PlayerPosition) {
    // 套用時沿用行動前的位置判定玩家是否在場（例如旅途中跨午夜，目的地的決策不算在場）。
    const finalizeBatch = (current: PlayerState, decided: PlayerState) => finalizeWorldWithAgentBatch(current, decided, {}, { positionBefore }).state;
    const request = buildAgentBatchRequest(base, batch);
    const ruleReason = isTimelineEnded(base) ? '時間線已結束' : !request.agents.length ? '只剩維持現狀的角色' : undefined;
    if (ruleReason) {
      const resolution = resolveAgentBatch(base, request, undefined, ruleReason);
      commitWorldUpdate(base, finalizeBatch(base, resolution.state), positionBefore);
      recordAgentDecisionReport(resolution.report);
      return;
    }
    const token = { gen: sessionGenRef.current, worldId: activeWorldIdRef.current, time: base.gameTimeMinutes };
    recordAgentDecisionReport(createPendingReport(request));
    setAgentThinking(true);
    void (async () => {
      let text: string | undefined;
      let failure: string | undefined;
      try {
        text = await requestAgentDecisionText(modelSettings, apiKey, request);
      } catch (error) {
        failure = error instanceof Error ? error.message : '無法連線至 AI 服務';
      }
      const current = playerRef.current;
      if (sessionGenRef.current !== token.gen || activeWorldIdRef.current !== token.worldId || current.gameTimeMinutes !== token.time) {
        recordAgentDecisionReport({ ...createPendingReport(request), result: 'rule', reason: '結果回來前已讀檔或換世界，結果已丟棄' });
        if (sessionGenRef.current === token.gen) setAgentThinking(false);
        return;
      }
      try {
        if (failure) console.info('角色決策改用規則後備：', failure);
        const resolution = resolveAgentBatch(current, request, text, failure);
        commitWorldUpdate(current, finalizeBatch(current, resolution.state), positionBefore);
        recordAgentDecisionReport(resolution.report);
      } catch (error) {
        // 套用時的非預期錯誤：不改動狀態，但一定恢復操作，避免選項列卡在盤算中。
        console.error('角色決策套用失敗：', error);
        recordAgentDecisionReport({ ...createPendingReport(request), result: 'rule', reason: '套用失敗，本日未套用' });
      } finally {
        setAgentThinking(false);
      }
    })();
  }

  // 自動存檔：每次狀態變更（且非 AI 回合進行中）覆寫目前世界的自動存檔欄位。
  // 死亡與戰鬥中不寫入：自動存檔停在致命行動或該場戰鬥開始之前，死亡後讀檔不會落入無法脫身的戰鬥。
  // 時間線結束的結局（O33）同樣不寫入，自動存檔停在進入結局的行動之前。
  useEffect(() => {
    if (loading || !activeWorldId || player.isDead || player.combat || isTimelineEnded(player)) return;
    const saved = writeSlot(activeWorldId, AUTO_SLOT_ID, player, messages, characterHistory);
    if (!saved) console.warn('自動存檔失敗，瀏覽器儲存空間可能不足。');
  }, [player, messages, characterHistory, loading, activeWorldId]);

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

  /** 建立新世界：目前世界保留在存檔中，角色建立後才寫入新世界。 */
  const handleNewWorld = () => {
    startNewSession();
    setIsSaveManagerOpen(false);
    setActiveWorld(undefined);
    setActiveWorldId(undefined);
    setCharacterHistory([]);
    setPlayer(createInitialPlayer());
    setMessages([createOpeningMessage(Date.now().toString(), scenario.opening.resetText)]);
    setSetupMode('new-world');
  };

  // 接續分支（setupMode 'continue'）目前沒有入口：死亡改為讀檔制，接續系統保留給 O42 非同步多人。
  const handleCreateCharacter = (name: string, classId: string, alignment: CharacterAlignment, relatedToPrevious = false) => {
    const created = createInitialPlayer(name, classId, alignment, true);
    startNewSession();
    // 新角色對各勢力的聲望預設重置；劇本允許且玩家選擇與前角色有關聯時，部分繼承前角色的聲望變化。
    const inheritRatio = setupMode === 'continue' && relatedToPrevious ? scenario.succession?.reputationInheritRatio ?? 0 : 0;
    const newCharacter = inheritRatio > 0 ? { ...created, factionReputation: createSuccessorReputation(player, inheritRatio) } : created;
    const text = scenario.opening.newCharacterText
      .replaceAll('{name}', name)
      .replaceAll('{className}', getCharacterClassById(classId)?.name ?? classId);
    const opening = createOpeningMessage(`${Date.now()}`, text);
    if (setupMode === 'continue' && activeWorldId) {
      // 同一世界接續：世界狀態保留，前一位角色列入歷代紀錄；不繼承等級、背包與任務。
      const previous = player;
      setCharacterHistory((history) => [...history, createHistoryEntry(previous)]);
      setPlayer(continueWorldWithCharacter(previous, newCharacter));
      setMessages([{
        id: `${Date.now()}-legacy`, sender: 'system', timestamp: new Date().toLocaleTimeString(),
        text: `📜 ${previous.name}（Lv.${previous.level}）的故事已結束，其事蹟將在這個世界流傳。世界的時間與變化都保留了下來。${inheritRatio > 0 ? '\n各勢力記得你與前任冒險者的關係，你繼承了部分聲望。' : '\n各勢力對你的聲望從頭開始。'}`
      }, opening]);
    } else {
      const world = createWorld(newCharacter, [opening]);
      setActiveWorldId(world?.id);
      setCharacterHistory([]);
      setPlayer(newCharacter);
      setMessages([opening]);
    }
    setSetupMode(null);
  };

  // ---------- 存檔管理 ----------
  const saveBlockedReason = player.isDead ? '角色已死亡，無法存檔；請讀取死亡前的自動存檔或手動存檔。'
    : isTimelineEnded(player) ? '這條時間線已經結束，無法存檔；請讀取結局前的自動存檔或手動存檔。'
    : player.combat ? '戰鬥中無法存檔；戰鬥結束後才會存檔。' : undefined;
  const handleSaveManual = (slotId: SaveSlotId) => {
    if (!activeWorldId) return '目前沒有進行中的世界。';
    if (saveBlockedReason) return saveBlockedReason;
    return writeSlot(activeWorldId, slotId, player, messages, characterHistory)
      ? '已存檔。' : '存檔失敗：瀏覽器儲存空間可能不足，請先匯出備份並刪除不需要的存檔。';
  };

  const handleLoadSlot = (worldId: string, slotId: SaveSlotId) => {
    const slot = readSlot(worldId, slotId);
    if (!slot) return '存檔無效或已損壞，未讀取。';
    startNewSession();
    setActiveWorld(worldId);
    setActiveWorldId(worldId);
    setCharacterHistory(slot.characterHistory);
    setPlayer(slot.player);
    setMessages(withRestoreNotice(slot));
    setSetupMode(null);
    setIsSaveManagerOpen(false);
    return '已讀取存檔。';
  };

  const handleLoadAutoSave = () => {
    if (!activeWorldId) return;
    const result = handleLoadSlot(activeWorldId, AUTO_SLOT_ID);
    if (result !== '已讀取存檔。') appendSystemMessage(`⚠️ ${result}可開啟存檔管理讀取手動存檔。`);
  };

  const handleDeleteSlot = (worldId: string, slotId: SaveSlotId) => {
    deleteSlot(worldId, slotId);
    return '已刪除存檔欄位。';
  };

  const handleDeleteWorld = (worldId: string) => {
    deleteWorld(worldId);
    if (worldId === activeWorldId) handleNewWorld();
    return '已刪除世界。';
  };

  const handleExportWorld = (worldId: string) => {
    const data = exportWorld(worldId);
    if (!data) return '找不到可匯出的有效存檔。';
    downloadJson(`${data.world.name}-${new Date().toISOString().slice(0, 10)}.json`, data);
    return `已匯出「${data.world.name}」。`;
  };

  const handleImportWorld = (text: string) => {
    const result = importWorld(text);
    return result.ok ? `已匯入「${result.world.name}」，可在「其他世界」切換。` : `匯入失敗：${result.reason}現有存檔未受影響。`;
  };

  const movePlayerTo = (mapId: string, sourcePlayer: PlayerState = player) => {
    if (sourcePlayer.combat || !canPlayerAct(sourcePlayer)) return null;
    const currentMap = getMapById(sourcePlayer.currentMapId);
    const destination = getMapById(mapId);
    if (!currentMap?.connectedMapIds.includes(mapId) || !destination || !canPlayerEnterMap(sourcePlayer, destination)) return null;
    const nextPlayer = advanceGameTime(clearEncounter({ ...sourcePlayer, previousMapId: sourcePlayer.currentMapId, currentMapId: destination.id }), 'travel');
    return { player: nextPlayer, destination };
  };

  /** 沿最短路徑移動（相鄰地區即一段）；戰鬥中、無法行動或無法抵達時回傳 null。 */
  const travelPlayerTo = (mapId: string, sourcePlayer: PlayerState = player) =>
    sourcePlayer.combat || !canPlayerAct(sourcePlayer) ? null : travelAlongRoute(sourcePlayer, mapId);

  const createUserMessage = (text: string): StoryMessage => ({ id: `${Date.now()}-user`, sender: 'user', text, timestamp: new Date().toLocaleTimeString() });

  /**
   * 一般 AI 回合：玩家行動交給 AI 敘事，AI 的提議由規則驗證後套用。
   * resolvedTravel 是本回合已由規則先結算的移動（O44），AI 以移動後的狀態敘事；
   * 文字的移動意圖已判定（resolved／ambiguous）時忽略 AI 的 travelRequest。
   */
  const runAiTurn = async (actionText: string, textTravelIntent: TravelIntentResolution, resolvedTravel?: RouteTravelResult) => {
    setMessages((prev) => [...prev, createUserMessage(actionText)]);
    setLoading(true);
    turnCallBaseRef.current = getAICallCount();
    const turnPlayer = resolvedTravel?.player ?? player;
    // 本回合結果已套用後才發生的錯誤，不再以已結算的移動覆蓋狀態。
    let applied = false;

    try {
      const aiResponse = await sendPlayerAction(modelSettings, apiKey, turnPlayer, actionText, messages, characterHistory, resolvedTravel);
      // O45：玩家以敘事方式開戰（combatRequest）。合法時由規則開戰，只採用 AI 的敘事（接近的過程），
      // 不套用 AI 的檢定、狀態變更與人物記憶，也不另外呼叫開戰敘事（D13）。已先結算移動的回合不處理。
      const combatPlan = resolvedTravel ? undefined : resolveCombatRequest(turnPlayer, aiResponse.combatRequest, (unitId) => getCombatStartBlock(turnPlayer, unitId, true));
      if (combatPlan?.ok) {
        const started = startCombatByPlan(advanceGameTime(turnPlayer, 'dialogue'), combatPlan);
        if (started) {
          updatePlayer(started.player, started.deathHints);
          applied = true;
          setMessages((prev) => [...prev,
            { id: `${Date.now()}-ai`, sender: 'ai', text: aiResponse.storyText, timestamp: new Date().toLocaleTimeString() },
            { id: `${Date.now()}-combat`, sender: 'system', text: started.text, checkResults: started.checks.length ? started.checks : undefined, invalidatesOptions: true, timestamp: new Date().toLocaleTimeString() }]);
          return;
        }
      }
      const combatRequestNotice = combatPlan && !combatPlan.ok ? `\n\n⚠️ 系統說明：無法依敘事開戰（${combatPlan.reason}），本回合照一般行動處理。` : '';
      let storyText = aiResponse.storyText;
      let resultToApply = aiResponse;
      let checkResult: ActionCheckResult | undefined;
      let nextPlayer = turnPlayer;

      if (aiResponse.checkRequest && aiResponse.checkOutcomes) {
        const check = resolveActionCheck(turnPlayer, aiResponse.checkRequest.stat, aiResponse.checkRequest.dc);
        storyText = check.success ? aiResponse.checkOutcomes.successText : aiResponse.checkOutcomes.failureText;
        checkResult = { ...check, stat: aiResponse.checkRequest.stat, reason: aiResponse.checkRequest.reason };
        resultToApply = {
          ...aiResponse,
          stateChanges: check.success ? aiResponse.stateChanges : aiResponse.failureStateChanges
        };
      }

      // 更新玩家 Local State
      if (resultToApply.stateChanges) {
        nextPlayer = applyStateChanges(turnPlayer, resultToApply);
      }
      // AI 提議的世界事件：只在沒有檢定或檢定成功時考慮，條件由遊戲再驗證；劇情旗標只能經由事件設定。
      if (!checkResult || checkResult.success) nextPlayer = applyEventProposals(nextPlayer, aiResponse.eventProposals).state;
      // AI 依任務範本提議的支線委託：同樣只在沒有檢定或檢定成功時考慮，由遊戲驗證後發布並預扣報酬。
      const questPosting = !checkResult || checkResult.success ? postQuestProposals(nextPlayer, aiResponse.questProposals) : undefined;
      if (questPosting) nextPlayer = questPosting.state;
      // 沒開戰卻宣稱攻防（O45 D14）：有敵人可交戰時，敘事宣稱命中、擊殺、閃避等，附上說明並捨棄本回合人物記憶。
      const falseCombatClaim = !turnPlayer.combat && hasEnemyNearby(turnPlayer) && hasCombatClaim(storyText);
      // 人物記憶：對話已發生，不論檢定結果都記下；以行動前的在場人物驗證。
      if (!falseCombatClaim) nextPlayer = applyMemoryNotes(nextPlayer, aiResponse.memoryNotes, getMemoryEligibleUnitIds(turnPlayer)).state;
      // 劇情片段：只在沒有檢定或檢定成功時考慮，以行動前（AI 看到的狀態）的候選驗證。
      const storyStart = !checkResult || checkResult.success ? startStorylets(turnPlayer, nextPlayer, aiResponse.storyletProposals) : undefined;
      if (storyStart) nextPlayer = storyStart.state;
      if (storyStart?.rejected.length) console.info('劇情片段提議未採用：', storyStart.rejected.join('；'));
      const storyletNotice = storyStart?.started.length
        ? `\n\n📖 主線開始：${storyStart.started.map((storylet) => `「${storylet.title}」——${storylet.goal.summary}`).join('；')}。`
        : '';
      const postedQuestNotice = questPosting?.posted.length
        ? `

📌 新委託「${questPosting.posted.map((quest) => `${quest.title}」（${quest.questGiver}）：${quest.objective}。報酬 ${quest.rewards.exp} EXP、${quest.rewards.gold} 金幣${(quest.rewards.items ?? []).map((item) => `、${getItemById(item.itemId)?.name ?? item.itemId} ×${item.quantity}`).join('')}，期限至${formatGameTime(quest.expiresAtMinutes)}`).join('')}。可從選項列的「任務」接取，或在對話中表示接受。`
        : questPosting?.rejected.length ? `

⚠️ 委託未成立：${questPosting.rejected.join('；')}。` : '';
      if (nextPlayer.isDead) nextPlayer = clearEncounter(nextPlayer);
      // AI 回報遭遇的對象已離開（O45 D5）：清除遭遇（之後若同回合提出新遭遇，照常設定）。
      const endedUnit = aiResponse.encounterEnded && !nextPlayer.combat ? getEncounteredUnit(nextPlayer) : undefined;
      if (aiResponse.encounterEnded && !nextPlayer.combat) nextPlayer = clearEncounter(nextPlayer);
      const encounterEndedNotice = endedUnit ? `\n\n👁️ ${endedUnit.name}離開了，遭遇結束。` : '';
      const requestedEncounter = aiResponse.encounterRequest?.unitId;
      const requestedUnit = requestedEncounter ? getWorldUnitById(requestedEncounter) : undefined;
      const encounterUnit = requestedUnit?.requiresEncounter ? requestedUnit : undefined;
      const currentMap = getMapById(turnPlayer.currentMapId);
      const encounterAllowed = !nextPlayer.combat && !nextPlayer.isDead && canPlayerAct(nextPlayer) && !!currentMap && !currentMap.isSafeZone &&
        !!encounterUnit && encounterUnit.mapIds.includes(currentMap.id) && currentMap.unitsPresent.includes(encounterUnit.id) &&
        (!encounterUnit.requiredQuestId || nextPlayer.activeQuests.some((quest) => quest.questId === encounterUnit.requiredQuestId && quest.status === 'in_progress'));
      // 移動途中的遭遇已在移動說明中列出，AI 重複提出同一單位時不再提示。
      // 主動探索遇到（O45 D1）：玩家先發現對方；對同一單位重複提出時沿用原本的遭遇（不重設時限）。
      const isNewEncounter = encounterAllowed && !!encounterUnit && encounterUnit.id !== nextPlayer.encounteredUnitId;
      const hostileEncounter = !!encounterUnit && getWorldUnitDisposition(nextPlayer, encounterUnit.id) === 'hostile';
      // 本回合的檢定失敗（例如搜索時弄出聲響）卻遇到敵對對象：視為被對方找上，改擲察覺（試玩發現的敘事與規則不一致）。
      const encounterFound = isNewEncounter && encounterUnit && hostileEncounter && checkResult && !checkResult.success
        ? resolveFoundByEnemy(nextPlayer, encounterUnit, '') : undefined;
      const encounterNotice = isNewEncounter && encounterUnit && encounterUnit.id !== turnPlayer.encounteredUnitId
        ? `\n\n👁️ 遭遇：${encounterUnit.name}。${encounterFound ? `你的行動驚動了對方。\n${encounterFound.text}`
          : hostileEncounter ? '你先發現了對方，可從下方選項列伏擊、挑戰，或移動離開；做其他事會被發現並開戰。'
          : '對方目前沒有敵意，你可以觀望或離開；選項列的伏擊會使對方轉為敵對。'}`
        : '';
      if (encounterFound) nextPlayer = encounterFound.player;
      else if (isNewEncounter && encounterUnit) nextPlayer = setEncounter(nextPlayer, encounterUnit.id, !(checkResult && !checkResult.success));
      const deathNotice = !turnPlayer.isDead && nextPlayer.isDead
        ? '\n\n☠️ 你的生命值降至 0，角色死亡。可讀取死亡前的自動存檔重新嘗試。'
        : '';
      const acceptedQuests = nextPlayer.activeQuests.filter((entry) => entry.status === 'in_progress' &&
        !turnPlayer.activeQuests.some((previous) => previous.questId === entry.questId));
      const questNotice = acceptedQuests.length
        ? `\n\n📜 已接取任務「${acceptedQuests.map((entry) => findQuest(nextPlayer, entry.questId)?.title ?? entry.questId).join('、')}」。`
        : '';
      const completedQuests = nextPlayer.activeQuests.filter((entry) => entry.status === 'completed' &&
        turnPlayer.activeQuests.some((previous) => previous.questId === entry.questId && previous.status === 'in_progress'));
      const rewardRecords = nextPlayer.transactionHistory.filter((record) =>
        record.type === 'quest_reward' && !turnPlayer.transactionHistory.some((previous) => previous.id === record.id));
      const questCompletionNotice = completedQuests.length
        ? `\n\n✅ ${completedQuests.map((entry) => {
          const title = findQuest(nextPlayer, entry.questId)?.title ?? entry.questId;
          const reward = rewardRecords.find((record) => record.description.includes(title));
          return reward?.description ?? `任務「${title}」已完成。`;
        }).join('\n')}`
        : '';
      const newUnitTransfers = nextPlayer.transactionHistory.filter((record) => record.type === 'unit_transfer' &&
        !turnPlayer.transactionHistory.some((previous) => previous.id === record.id));
      const requestedUnitTransfers = resultToApply.stateChanges?.unitItemTransfers?.length ?? 0;
      const successfulUnitTransfers = newUnitTransfers.filter((record) => record.description.startsWith('從 '));
      const unitTransferNotice = successfulUnitTransfers.length || successfulUnitTransfers.length < requestedUnitTransfers
        ? `\n\n📦 ${[
          ...successfulUnitTransfers.map((record) => record.description),
          ...(successfulUnitTransfers.length < requestedUnitTransfers ? ['對方不在場或持有物不足，未能取得敘事中提及的全部物品。'] : [])
        ].join('\n')}`
        : '';
      const relationLabels = { friendly: '友善', neutral: '中立', hostile: '敵對' } as const;
      const appliedRelationChanges = (resultToApply.stateChanges?.unitDispositionChanges ?? []).filter((change) =>
        nextPlayer.unitDispositionOverrides[change.unitId] === change.disposition &&
        getWorldUnitDisposition(turnPlayer, change.unitId) !== change.disposition
      );
      const unitDispositionNotice = appliedRelationChanges.length
        ? `\n\n🤝 關係變化：${appliedRelationChanges.map((change) => `${getWorldUnitById(change.unitId)?.name ?? change.unitId} 對你的態度變為${relationLabels[change.disposition]}。`).join('')}`
        : '';

      // 已先結算移動時忽略 AI 的 travelRequest；否則只接受相鄰地區（意圖不明確、由 AI 判斷的移動）。
      const requestedDestinationId = resolvedTravel || textTravelIntent.kind !== 'none'
        ? undefined
        : aiResponse.travelRequest?.destinationMapId;
      const travel = requestedDestinationId ? movePlayerTo(requestedDestinationId, nextPlayer) : null;
      // 服務請求以與選項列相同的規則結算（含扣款轉帳、恢復與固定耗時）；同回合由 AI 移動時不處理服務（先結算的移動已在 AI 看到的狀態中）。
      // 只處理指向目前地區實際服務的請求；佔位或不存在的 ID 視為沒有請求，不顯示失敗訊息。
      const requestedService = !travel && aiResponse.serviceRequest && getAvailableServices(turnPlayer).some((service) =>
        service.shopId === aiResponse.serviceRequest?.shopId && service.serviceId === aiResponse.serviceRequest?.serviceId)
        ? aiResponse.serviceRequest : undefined;
      const requestedShop = requestedService ? getShopById(requestedService.shopId) : undefined;
      const serviceResult = requestedService && requestedShop ? purchaseService(nextPlayer, requestedShop, requestedService.serviceId, nextPlayer.currentMapId) : undefined;
      const serviceName = requestedShop?.services?.find((service) => service.id === requestedService?.serviceId)?.name ?? '服務';
      // 先結算的移動已推進時間，本回合不再另計對話時間。
      nextPlayer = travel ? travel.player : serviceResult?.ok ? serviceResult.player : resolvedTravel ? nextPlayer : advanceGameTime(nextPlayer, 'dialogue');
      const serviceNotice = !requestedService ? ''
        : serviceResult?.ok
          ? `\n\n🛏️ 使用${serviceName}，支付 ${serviceResult.totalPrice} 金幣，經過 ${formatDuration(ACTION_DURATIONS.rest)}，生命與魔力已恢復。`
          : `\n\n⚠️ ${serviceName}未完成：${serviceResult && !serviceResult.ok ? serviceResult.reason : '找不到這項服務。'}`;
      updatePlayer(nextPlayer, nextPlayer.isDead && !player.isDead
        ? (encounterFound?.deathHints && nextPlayer.isDead ? encounterFound.deathHints
          : { [player.unitId]: { cause: isSelfDamageIntent(actionText) ? 'self_inflicted' : 'misadventure', note: checkResult?.reason } })
        : resolvedTravel?.foundByEnemy?.deathHints);
      applied = true;
      const falseClaimNotice = falseCombatClaim
        ? '\n\n⚠️ 系統說明：尚未交戰，敘事中的攻防沒有生效。若要動手，可從選項列伏擊或挑戰。'
        : '';
      // 有敵人可交戰時，不建議以打字進行戰鬥（O45 D15），改由選項列的伏擊、挑戰處理。
      const suggestions = hasEnemyNearby(nextPlayer) ? filterCombatSuggestions(aiResponse.suggestedActions) : aiResponse.suggestedActions;

      const previousMap = getMapById(turnPlayer.currentMapId);
      const nextMap = getMapById(nextPlayer.currentMapId);
      // 安全網（O44）：敘事宣稱抵達實際所在地與本回合途經地區以外的地方時，附上系統說明（修正請求已在 AI 服務中處理）。
      const routeMapIds = resolvedTravel ? [resolvedTravel.origin.id, ...resolvedTravel.passed.map((map) => map.id)] : [player.currentMapId];
      const mismatchedClaims = resolvedTravel || travel ? getClaimedArrivalMapIds(storyText, nextPlayer.currentMapId, routeMapIds) : [];
      const mismatchNotice = mismatchedClaims.length
        ? `\n\n⚠️ 系統說明：敘事提到抵達${mismatchedClaims.map((mapId) => getMapById(mapId)?.name ?? mapId).join('、')}，但你實際位於${nextMap?.name ?? nextPlayer.currentMapId}。`
        : '';
      const locationNotice = resolvedTravel
        ? `\n\n${describeRouteTravel(resolvedTravel, turnPlayer)}${mismatchNotice}`
        : travel
        ? `\n\n📍 你已抵達${travel.destination.name}。${travel.destination.description}${mismatchNotice}`
        : textTravelIntent.kind === 'ambiguous'
          ? `\n\n📍 你想前往的地區有多個可能地點，請選擇目的地：`
          : requestedDestinationId
          ? `\n\n⚠️ 目前無法前往「${getMapById(requestedDestinationId)?.name ?? requestedDestinationId}」，所在地區未變更。請從選項列的「移動」選擇可前往的地區。`
          : storyClaimsPlayerMoved(storyText, turnPlayer.currentMapId)
            ? `\n\n⚠️ 目前沒有有效的地區移動請求，因此所在地區未變更。若要移動，請明確指定可前往地點。`
          : previousMap && nextMap && previousMap.id !== nextMap.id
            ? `\n\n⚠️ AI 敘事提及地區變更，但沒有有效的移動請求；所在地區維持${previousMap.name}。`
            : '';

      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          sender: 'ai',
          text: `${storyText}${falseClaimNotice}${combatRequestNotice}${storyletNotice}${postedQuestNotice}${questNotice}${questCompletionNotice}${unitTransferNotice}${unitDispositionNotice}${encounterEndedNotice}${encounterNotice}${serviceNotice}${locationNotice}${deathNotice}`,
          options: suggestions,
          checkResults: [...(resolvedTravel?.foundByEnemy?.checks ?? []), ...(encounterFound?.checks ?? [])].length
            ? [...(resolvedTravel?.foundByEnemy?.checks ?? []), ...(encounterFound?.checks ?? [])] : undefined,
          travelOptions: textTravelIntent.kind === 'ambiguous'
            ? textTravelIntent.candidates.map((candidate) => ({ mapId: candidate.id, name: candidate.name }))
            : undefined,
          checkResult,
          timestamp: new Date().toLocaleTimeString()
        }
      ]);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : '無法連線至 AI 服務';
      // 已由規則結算的移動（O44／O50）不因 AI 失敗而取消：照常套用移動與途中遭遇，只略過敘事。
      if (resolvedTravel && !applied) {
        updatePlayer(resolvedTravel.player, resolvedTravel.foundByEnemy?.deathHints);
        setMessages((prev) => [...prev, {
          id: `${Date.now()}-travel`, sender: 'system', invalidatesOptions: true, timestamp: new Date().toLocaleTimeString(),
          checkResults: resolvedTravel.foundByEnemy?.checks.length ? resolvedTravel.foundByEnemy.checks : undefined,
          text: `${describeRouteTravel(resolvedTravel, resolvedTravel.player)}\n⚠️ 敘事失敗，移動已完成：${errorMessage}`
        }]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            sender: 'system',
            text: `❌ 發生錯誤: ${errorMessage}`,
            timestamp: new Date().toLocaleTimeString()
          }
        ]);
      }
    } finally {
      turnCallBaseRef.current = null;
      setLoading(false);
    }
  };

  /**
   * 移動（O50）：選項列、打字的明確移動意圖、多個候選地點的按鈕都經此執行。
   * 規則先結算移動，再接一次 AI 敘事（O44 先移動再敘事）；尚未設定 AI 時只顯示移動結果。
   * 打字的移動在規則無法移動時（例如前置任務未完成）交給一般回合，由 AI 回應並維持原地。
   */
  const executeTravel = (mapId: string, typed?: { actionText: string; intent: TravelIntentResolution }) => {
    const destination = getMapById(mapId);
    const actionText = typed?.actionText ?? `前往${destination?.name ?? mapId}`;
    const travel = travelPlayerTo(mapId);
    if (!travel) {
      if (typed) {
        if (!apiKey) { setIsKeyModalOpen(true); return; }
        void runAiTurn(actionText, typed.intent);
        return;
      }
      setMessages((previous) => [...previous, createUserMessage(actionText), { id: `${Date.now()}-travel`, sender: 'system', text: `目前無法前往${destination?.name ?? mapId}。`, timestamp: new Date().toLocaleTimeString() }]);
      return;
    }
    // 途中遭到偷襲（O45，已開戰或已死亡）時不送 AI 敘事，以規則結果呈現；未設定 AI 時同樣只顯示移動結果。
    const ambushedOnRoute = !!travel.player.combat || travel.player.isDead;
    if (!apiKey || ambushedOnRoute) {
      updatePlayer(travel.player, travel.foundByEnemy?.deathHints);
      setMessages((previous) => [...previous, createUserMessage(actionText), {
        id: `${Date.now()}-travel`, sender: 'system', text: `${describeRouteTravel(travel, travel.player)}${apiKey ? '' : '\n（尚未設定 AI，略過敘事。）'}`,
        checkResults: travel.foundByEnemy?.checks.length ? travel.foundByEnemy.checks : undefined, invalidatesOptions: true, timestamp: new Date().toLocaleTimeString()
      }]);
      return;
    }
    void runAiTurn(actionText, typed?.intent ?? { kind: 'resolved', destination: travel.destination }, travel);
  };

  /** 交談（O50）：送出固定格式的玩家行動，走一般 AI 回合。 */
  const executeTalk = (unitId: string) => {
    const unit = getWorldUnitById(unitId, player);
    if (!unit || !canPlayerAct(player) || player.combat) return;
    if (!apiKey) { setIsKeyModalOpen(true); return; }
    void runAiTurn(`與${unit.name}交談`, { kind: 'none' });
  };

  const handleAcceptQuest = (questId: string) => {
    const quest = findQuest(player, questId);
    if (!quest) return;
    const accepted = acceptQuest(player, quest);
    if (!accepted) return;
    updatePlayer(advanceGameTime(accepted, 'dialogue'));
    setMessages((previous) => [...previous, {
      id: Date.now().toString(),
      sender: 'system',
      text: `已接取任務「${quest.title}」：${quest.objective}`,
      invalidatesOptions: true,
      timestamp: new Date().toLocaleTimeString()
    }]);
  };

  const handleTurnInQuest = (questId: string) => {
    const quest = findQuest(player, questId);
    if (!quest || !canTurnInQuest(player, quest)) return;
    const nextPlayer = applyStateChanges(advanceGameTime(player, 'dialogue'), {
      storyText: '', suggestedActions: [], stateChanges: { questUpdates: [{ questId, status: 'completed' }] }
    }, 'game');
    updatePlayer(nextPlayer);
    const rewardRecord = nextPlayer.transactionHistory.find((record) => record.type === 'quest_reward' &&
      !player.transactionHistory.some((previous) => previous.id === record.id));
    appendSystemMessage(rewardRecord?.description ?? `已向${getQuestGiverName(player, quest)}交付任務「${quest.title}」。`, undefined, true);
  };

  const handleBuyItem = (shopId: string, itemId: string) => {
    const shop = getShopById(shopId);
    const item = getItemById(itemId);
    if (!shop || !item) return;
    const result = buyItem(player, shop, item, player.currentMapId);
    if (!result.ok) {
      appendSystemMessage(`交易未完成：${result.reason}`);
      return;
    }
    updatePlayer(advanceGameTime(result.player, 'trade'));
    appendSystemMessage(`向${shop.name}購買${item.name} ×${result.quantity}，支付 ${result.totalPrice} 金幣。`);
  };

  const handleSellItem = (shopId: string, itemId: string) => {
    const shop = getShopById(shopId);
    const item = getItemById(itemId);
    if (!shop || !item) return;
    const result = sellItem(player, shop, item, player.currentMapId);
    if (!result.ok) {
      appendSystemMessage(`交易未完成：${result.reason}`);
      return;
    }
    updatePlayer(advanceGameTime(result.player, 'trade'));
    appendSystemMessage(`向${shop.name}出售${item.name} ×${result.quantity}，取得 ${result.totalPrice} 金幣。`);
  };

  const handleUseService = (shopId: string, serviceId: string) => {
    const shop = getShopById(shopId);
    if (!shop) return;
    const service = shop.services?.find((entry) => entry.id === serviceId);
    const result = purchaseService(player, shop, serviceId, player.currentMapId);
    if (!result.ok) {
      appendSystemMessage(`服務未完成：${result.reason}`);
      return;
    }
    updatePlayer(result.player);
    appendSystemMessage(`使用${service?.name ?? '服務'}，支付 ${result.totalPrice} 金幣，休息 ${formatDuration(ACTION_DURATIONS.rest)}後生命與魔力已恢復。`, undefined, true);
  };

  const handleEquipItem = (itemId: string) => {
    const item = getItemById(itemId);
    const owned = player.inventory.some((entry) => entry.itemId === itemId && entry.quantity > 0);
    if (!item || !owned || !canPlayerAct(player) || player.combat) return;
    const slot = item.type === 'weapon' ? 'weaponItemId' : item.type === 'armor' ? 'armorItemId' : item.type === 'accessory' ? 'accessoryItemId' : undefined;
    if (!slot) return;
    updatePlayer(advanceGameTime({ ...player, equipped: { ...player.equipped, [slot]: itemId } }, 'quick'));
    appendSystemMessage(`已裝備${item.name}。`);
  };

  /** invalidatesOptions：改變狀態的系統動作，使之前 AI 的建議行動失效（O50）。 */
  const appendSystemMessage = (text: string, checkResults?: ActionCheckResult[], invalidatesOptions = false) => {
    setMessages((previous) => [...previous, {
      id: `${Date.now()}-${Math.random()}`,
      sender: 'system',
      text,
      checkResults,
      ...(invalidatesOptions ? { invalidatesOptions: true } : {}),
      timestamp: new Date().toLocaleTimeString()
    }]);
  };

  /** 開戰敘事：只採用 storyText，不套用 AI 提出的任何狀態變更；未設定 AI 時略過。 */
  const narrateCombatStart = async (actionText: string, combatPlayer: PlayerState) => {
    if (!apiKey) return;
    setLoading(true);
    try {
      const response = await sendPlayerAction(modelSettings, apiKey, combatPlayer, actionText, messages, characterHistory, undefined,
        '戰鬥已由遊戲開始，本回合只描述雙方對峙、拔出武器的開場；不要描述命中、傷害、擊倒或逃離，也不要提出任何狀態變更。');
      setMessages((previous) => [...previous, { id: `${Date.now()}-narration`, sender: 'ai', text: response.storyText, timestamp: new Date().toLocaleTimeString() }]);
    } catch (err: unknown) {
      appendSystemMessage(`❌ 開戰敘事失敗：${err instanceof Error ? err.message : '無法連線至 AI 服務'}（戰鬥照常進行）`);
    } finally {
      setLoading(false);
    }
  };

  /**
   * 開始戰鬥（O50）：選項列的「挑戰」與打字的「攻擊某某」都經此執行。
   * provoke 為 true（打字攻擊）時，對非敵對單位動手會先使其敵對。開戰後接一次只採用敘事的 AI 呼叫。
   */
  const executeStartCombat = (unitId: string, options: { provoke?: boolean; actionText?: string } = {}) => {
    const unit = getWorldUnitById(unitId, player);
    const userMessage = createUserMessage(options.actionText ?? `挑戰${unit?.name ?? ''}`);
    const block = getCombatStartBlock(player, unitId, options.provoke);
    if (block || !unit) {
      setMessages((previous) => [...previous, userMessage, { id: `${Date.now()}-combat`, sender: 'system', text: block ?? '目前地區或目標資料不存在。', timestamp: new Date().toLocaleTimeString() }]);
      return;
    }
    const provoked = getWorldUnitDisposition(player, unitId) !== 'hostile';
    // O35-1：依 SPD 排定行動順序，比玩家快的敵人與同伴先行動，結算到玩家回合。
    const started = startNormalCombat(player, unit, `你${provoked ? '激怒並與' : '與'}${unit.name}進入戰鬥！輪到你時，攻擊、技能及消耗品各消耗一個行動回合；同伴與敵人由規則依行動順序行動。`);
    updatePlayer(started.player, started.deathHints);
    setMessages((previous) => [...previous, userMessage, {
      id: `${Date.now()}-combat`, sender: 'system', timestamp: new Date().toLocaleTimeString(), text: started.text,
      checkResults: started.checks.length ? started.checks : undefined, invalidatesOptions: true
    }]);
    if (started.player.combat) void narrateCombatStart(userMessage.text, started.player);
  };

  /** 規則結算的開戰結果（伏擊、陷阱、強制開戰）：套用並顯示系統訊息與檢定。 */
  const commitCombatStep = (result: CombatStepResult, actionText?: string) => {
    updatePlayer(result.player, result.deathHints);
    setMessages((previous) => [...previous, ...(actionText ? [createUserMessage(actionText)] : []), {
      id: `${Date.now()}-combat`, sender: 'system', text: result.text, checkResults: result.checks.length ? result.checks : undefined,
      invalidatesOptions: true, timestamp: new Date().toLocaleTimeString()
    }]);
  };

  /**
   * 被發現（O45 D1、D9、D10）：玩家先發現的敵對遭遇，或在場的敵對居民，在玩家做其他行動時搶先出手；原本的行動不進行。
   * 移動、挑戰、伏擊不經此判定。回傳 true 表示已處理（呼叫端不再執行原本的行動）。
   */
  const preemptByEnemy = (actionText?: string): boolean => {
    if (player.combat || !canPlayerAct(player)) return false;
    const spotted = getSpottedHostileEncounter(player);
    if (spotted) {
      commitCombatStep(startNormalCombat(player, spotted, `⚠️ ${spotted.name}發現了你，戰鬥開始！你原本的行動沒有進行。`), actionText);
      return true;
    }
    const resident = findAggressiveResident(player);
    if (!resident) return false;
    const found = resolveFoundByEnemy(player, resident, `⚠️ 這裡的${resident.name}對你懷有敵意，你原本的行動沒有進行。\n`);
    commitCombatStep({ ...found, player: { ...found.player, residentAggro: { mapId: player.currentMapId, atMinutes: player.gameTimeMinutes } } }, actionText);
    return true;
  };

  /** 伏擊（O45 D3）：選項列、打字的「偷襲某某」與 AI 的 combatRequest 都依同一規則。 */
  const executeAmbush = (unitId: string, actionText?: string) => {
    const unit = getAmbushableUnit(player, unitId);
    if (!unit || !canPlayerAct(player)) {
      setMessages((previous) => [...previous, ...(actionText ? [createUserMessage(actionText)] : []),
        { id: `${Date.now()}-combat`, sender: 'system', text: '只能伏擊你先發現、而且還沒察覺你的對象。', timestamp: new Date().toLocaleTimeString() }]);
      return;
    }
    commitCombatStep(resolveAmbush(advanceGameTime(player, 'quick'), unit), actionText ?? `伏擊${unit.name}`);
  };

  /** 設陷阱等待（O45 D4）：非安全地區；選項列與打字共用。不呼叫 AI。 */
  const executeSetTrap = (minutes: number, actionText?: string) => {
    if (player.combat || !canPlayerAct(player)) return;
    const result = resolveTrapWait(player, minutes);
    if (!result) {
      setMessages((previous) => [...previous, ...(actionText ? [createUserMessage(actionText)] : []),
        { id: `${Date.now()}-trap`, sender: 'system', text: '這裡不能設陷阱（安全地區不會有敵人經過）。', timestamp: new Date().toLocaleTimeString() }]);
      return;
    }
    commitCombatStep(result, actionText ?? `設陷阱等待 ${formatDuration(minutes)}`);
  };

  /**
   * 等待（O50）：選項列與打字的等待都經此執行；非安全地區可能被敵人打斷。不呼叫 AI。
   * O45：被打斷時先擲察覺（D2）；沒有被打斷時遭遇清除（D5）。
   */
  const executeWait = (minutes: number, typed?: { actionText: string; hasFollowUp: boolean }) => {
    if (player.combat || !canPlayerAct(player)) return;
    const interruption = rollWaitInterruption(player, minutes);
    const waited = waitGameTime(player, interruption.elapsedMinutes);
    if (waited === player) return;
    const interruptUnit = interruption.unitId ? getWorldUnitById(interruption.unitId, player) : undefined;
    if (interruptUnit) {
      commitCombatStep(resolveFoundByEnemy(waited, interruptUnit,
        `⏳ 你等待了 ${formatDuration(interruption.elapsedMinutes)}，${interruptUnit.name}出現，等待被打斷！現在是 ${formatGameTime(waited.gameTimeMinutes)}。\n`), typed?.actionText);
      return;
    }
    const waitNext = clearEncounter(waited);
    const text = `⏳ 你原地等待了 ${formatDuration(minutes)}，現在是 ${formatGameTime(waitNext.gameTimeMinutes)}。等待不會恢復生命與魔力。${typed?.hasFollowUp ? '\n等待之後的行動請另外輸入。' : ''}`;
    updatePlayer(waitNext);
    setMessages((previous) => [...previous, ...(typed ? [createUserMessage(typed.actionText)] : []),
      { id: `${Date.now()}-wait`, sender: 'system', text, invalidatesOptions: true, timestamp: new Date().toLocaleTimeString() }]);
  };

  /**
   * 玩家的戰鬥行動（O35-1）：攻擊、技能、治療、道具、逃跑都經此執行；之後同伴與敵人自動結算到下次輪到玩家（D12）。
   */
  const executeCombatAction = (action: PlayerCombatAction) => {
    const block = getCombatActionBlock(player, action);
    if (block) { appendSystemMessage(block); return; }
    const result = resolvePlayerCombatAction(player, action);
    if (!result) return;
    updatePlayer(result.player, result.deathHints);
    appendSystemMessage(result.text, result.checks.length ? result.checks : undefined, !result.player.combat);
  };

  /** 逃跑（D17）：全隊一起逃，速度檢定；失敗浪費回合、敵人照常行動。 */
  const handleFleeCombat = () => executeCombatAction({ kind: 'flee' });

  const handleCombatAction = (skill?: SkillStatic) => {
    if (!player.combat || player.isDead) return;
    // 昏迷時正常流程會自動跳過回合；這裡是保險。
    executeCombatAction(isPlayerUnconscious(player) ? { kind: 'skip' } : { kind: 'attack', skill });
  };
  const handleAttack = () => handleCombatAction();

  /** 切換鎖定目標（D21）：不耗回合。 */
  const handleSwitchTarget = (enemyKey: string) => {
    const next = player.combat ? switchCombatTarget(player, enemyKey) : undefined;
    if (!next) return;
    setPlayer(next);
    playerRef.current = next;
  };

  /** 對象名稱：自己或隊伍同伴。 */
  const describeTarget = (targetKey: string) => targetKey === player.unitId ? '自己' : getWorldUnitById(targetKey, player)?.name ?? targetKey;

  /** 戰鬥外對同伴恢復（O35-1 D21）：技能或道具；回傳恢復量與新狀態，對象不是隊伍同伴時回傳 undefined。 */
  const restoreCompanionOutOfCombat = (source: PlayerState, unitId: string, hpRestore: number, mpRestore: number) => {
    const unit = getWorldUnitById(unitId, source);
    const instance = source.unitInstances[unitId];
    if (!unit || !instance || !source.party.includes(unitId)) return undefined;
    const resources = getCompanionResources(source, unit);
    const hp = Math.min(hpRestore, Math.max(0, resources.maxHp - resources.hp));
    const mp = Math.min(mpRestore, Math.max(0, resources.maxMp - resources.mp));
    return { hp, mp, player: { ...source, unitInstances: { ...source.unitInstances, [unitId]: { ...instance, currentHp: resources.hp + hp, currentMp: resources.mp + mp } } } };
  };

  const handleUseSkill = (skillId: string, targetKey: string = player.unitId) => {
    const skill = getUnlockedSkills(player.classId, player.level).find((entry) => entry.id === skillId);
    if (!skill || !canPlayerAct(player)) return;
    if (skill.effect.kind !== 'healing' && !player.combat) {
      appendSystemMessage(`${skill.name}只能在戰鬥中使用，沒有消耗 MP。`);
      return;
    }
    if (player.mp < skill.costMp) {
      appendSystemMessage(`${skill.name}需要 ${skill.costMp} MP，目前魔力不足，沒有施放。`);
      return;
    }
    // 戰鬥中：傷害技能打鎖定目標，治療技能可選我方任一人（D21），消耗一個行動回合。
    if (player.combat) {
      executeCombatAction(skill.effect.kind === 'healing' ? { kind: 'heal', skill, targetKey } : { kind: 'attack', skill });
      return;
    }
    if (skill.effect.kind !== 'healing') return;
    if (targetKey !== player.unitId) {
      const restored = restoreCompanionOutOfCombat(player, targetKey, skill.effect.hpRestore, 0);
      if (!restored || restored.hp <= 0) {
        appendSystemMessage(`${skill.name}目前無法恢復${describeTarget(targetKey)}的 HP，沒有消耗 MP。`);
        return;
      }
      updatePlayer(advanceGameTime({ ...restored.player, mp: player.mp - skill.costMp }, 'quick'));
      appendSystemMessage(`對${describeTarget(targetKey)}施放${skill.name}，HP +${restored.hp}、MP -${skill.costMp}。`);
      return;
    }
    const caps = getPlayerResourceCaps(player);
    const restored = Math.min(skill.effect.hpRestore, Math.max(0, caps.maxHp - player.hp));
    if (restored <= 0) {
      appendSystemMessage(`${skill.name}目前無法恢復 HP，沒有消耗 MP。`);
      return;
    }
    const nextPlayer = applyStateChanges(advanceGameTime(player, 'quick'), {
      storyText: '', suggestedActions: [],
      stateChanges: { hpChange: restored, mpChange: -skill.costMp }
    }, 'game');
    updatePlayer(nextPlayer);
    appendSystemMessage(`施放${skill.name}，HP +${restored}、MP -${skill.costMp}。`);
  };

  const handleUseItem = (itemId: string, targetKey: string = player.unitId) => {
    const item = getItemById(itemId);
    const inventoryEntry = player.inventory.find((entry) => entry.itemId === itemId);
    if (!item || item.type !== 'consumable' || !inventoryEntry || inventoryEntry.quantity <= 0 || !canPlayerAct(player) || (player.combat && !item.usableInCombat)) return;
    // 戰鬥中使用道具消耗一個行動回合，可對我方任一人使用（O35-1 D21）。
    if (player.combat) {
      executeCombatAction({ kind: 'item', item, targetKey });
      return;
    }
    if (item.effect.revive) {
      appendSystemMessage(`${item.name}只能在戰鬥中對倒地的同伴使用，沒有消耗道具。`);
      return;
    }
    if (targetKey !== player.unitId) {
      const restored = restoreCompanionOutOfCombat(player, targetKey, item.effect.hpRestore ?? 0, item.effect.mpRestore ?? 0);
      if (!restored || (restored.hp <= 0 && restored.mp <= 0)) {
        appendSystemMessage(`${item.name}目前無法恢復${describeTarget(targetKey)}的 HP 或 MP，沒有消耗道具。`);
        return;
      }
      updatePlayer(applyStateChanges(advanceGameTime(restored.player, 'quick'), { storyText: '', suggestedActions: [], stateChanges: { removeItems: [{ itemId, quantity: 1 }] } }, 'game'));
      appendSystemMessage(`對${describeTarget(targetKey)}使用${item.name}，${[restored.hp > 0 ? `HP +${restored.hp}` : '', restored.mp > 0 ? `MP +${restored.mp}` : ''].filter(Boolean).join('、')}。`);
      return;
    }
    const caps = getPlayerResourceCaps(player);
    const hpRestore = Math.min(item.effect.hpRestore ?? 0, Math.max(0, caps.maxHp - player.hp));
    const mpRestore = Math.min(item.effect.mpRestore ?? 0, Math.max(0, caps.maxMp - player.mp));
    if (hpRestore <= 0 && mpRestore <= 0) {
      appendSystemMessage(`${item.name}目前無法恢復任何 HP 或 MP，沒有消耗道具。`);
      return;
    }
    const next = applyStateChanges(advanceGameTime(player, 'quick'), {
      storyText: '', suggestedActions: [],
      stateChanges: { hpChange: hpRestore, mpChange: mpRestore, removeItems: [{ itemId, quantity: 1 }] }
    }, 'game');
    const details = [hpRestore > 0 ? `HP +${hpRestore}` : '', mpRestore > 0 ? `MP +${mpRestore}` : ''].filter(Boolean).join('、');
    updatePlayer(next);
    appendSystemMessage(`使用${item.name}，${details}。`);
  };

  /** 邀請同行（O35-1 D4、D30）：只由規則入隊，條件成立才出現在選項列；不呼叫 AI。入隊訊息由 commitWorldUpdate 統一產生。 */
  const handleInvite = (unitId: string) => {
    const unit = getWorldUnitById(unitId, player);
    const block = getInviteBlock(player, unitId);
    if (block || !unit) { appendSystemMessage(block ?? '找不到這個人物。'); return; }
    setMessages((previous) => [...previous, createUserMessage(`邀請${unit.name}同行`)]);
    updatePlayer(advanceGameTime(joinParty(player, unitId), 'dialogue'));
  };

  /** 請同伴離隊（D5）：同伴回到原居所，之後可再邀請。 */
  const handleDismiss = (unitId: string) => {
    if (!player.party.includes(unitId) || player.combat) return;
    setMessages((previous) => [...previous, createUserMessage(`請${getWorldUnitById(unitId, player)?.name ?? unitId}離隊`)]);
    updatePlayer(advanceGameTime(leaveParty(player, unitId), 'dialogue'));
  };

  const handleSendAction = async (actionText: string) => {
    // 角色決策進行中（O34 第 2 階段）不接受新行動；UI 已停用，這裡再擋一次，避免日後新入口繞過。
    if (agentThinking) return;
    const isQuestion = /(?:如何|怎麼|能否|可不可以|是否|請問|教我|詢問|不要|不想|無法|不能)/u.test(actionText);
    // 打字攻擊：原有關鍵字，加上「補上一劍」「結果了牠的性命」等說法（O45 D12，字詞在資料檔）。
    // 補充的說法只在有敵人可交戰時才視為攻擊，避免一般對話（例如提到「踢倒」）誤觸開戰。
    const attackIntent = !isQuestion && (/(?:攻擊|攻打|打倒|擊倒|砍向|砍|刺向|刺|揮擊|attack|strike|fight)/iu.test(actionText) || (isTypedCombatText(actionText) && hasEnemyNearby(player))) &&
      !/(?:攻擊自己|打自己|刺自己|砍自己)/u.test(actionText);
    if (!player.combat && canPlayerAct(player)) {
      // 打字伏擊（O45 D12）：對玩家先發現的對象直接走伏擊規則，不呼叫 AI。
      const ambushTarget = !isQuestion && isTypedAmbushText(actionText) ? getAmbushableUnit(player) : undefined;
      if (ambushTarget) {
        executeAmbush(ambushTarget.id, actionText);
        return;
      }
      // 被發現（O45 D1、D9）：攻擊與明確移動以外的行動，會讓敵人搶先出手。
      if (!attackIntent && resolveExplicitTravelIntent(actionText, player).kind !== 'resolved' && preemptByEnemy(actionText)) return;
      // 打字設陷阱（O45 D4）：有指定合法時長就照時長，否則用預設時長。
      if (!isQuestion && isTypedTrapText(actionText)) {
        const waitIntent = parseWaitIntent(actionText);
        executeSetTrap(waitIntent?.kind === 'duration' && isValidWaitMinutes(waitIntent.minutes) ? waitIntent.minutes : combatRules.defaultTrapWaitMinutes, actionText);
        return;
      }
    }
    const useVerb = /(?:使用|喝|飲用|服用|吃下|吃|use|consume)/iu.test(actionText);
    const requestedItemMatches = useVerb && !isQuestion
      ? itemsDatabase.filter((item) => item.type === 'consumable' && (actionText.includes(item.name) || actionText.includes(item.id)))
      : [];
    const ownedConsumables = player.inventory.flatMap((entry) => {
      const item = itemsDatabase.find((candidate) => candidate.id === entry.itemId && candidate.type === 'consumable');
      return item && entry.quantity > 0 ? [item] : [];
    });
    const requestedItem = requestedItemMatches[0] ?? (/(?:藥水|藥劑|potion)/iu.test(actionText) && ownedConsumables.length === 1 ? ownedConsumables[0] : undefined);
    const genericPotionIntent = useVerb && !isQuestion && /(?:藥水|藥劑|potion)/iu.test(actionText) && requestedItemMatches.length === 0;
    if (genericPotionIntent && !requestedItem) {
      const userMessage: StoryMessage = { id: `${Date.now()}-user`, sender: 'user', text: actionText, timestamp: new Date().toLocaleTimeString() };
      const prompt = ownedConsumables.length > 1
        ? `請指定要使用的消耗品：${ownedConsumables.map((item) => item.name).join('、')}。`
        : '背包中沒有可使用的藥水。';
      setMessages((prev) => [...prev, userMessage, { id: `${Date.now()}-item`, sender: 'system', text: prompt, timestamp: new Date().toLocaleTimeString() }]);
      return;
    }
    if (requestedItem) {
      const userMessage: StoryMessage = { id: `${Date.now()}-user`, sender: 'user', text: actionText, timestamp: new Date().toLocaleTimeString() };
      const owned = player.inventory.some((entry) => entry.itemId === requestedItem.id && entry.quantity > 0);
      if (!owned) {
        setMessages((prev) => [...prev, userMessage, { id: `${Date.now()}-item`, sender: 'system', text: `你沒有${requestedItem.name}，沒有使用道具。`, timestamp: new Date().toLocaleTimeString() }]);
        return;
      }
      if (!canPlayerAct(player) || (player.combat && !requestedItem.usableInCombat)) {
        setMessages((prev) => [...prev, userMessage, { id: `${Date.now()}-item`, sender: 'system', text: player.combat ? `${requestedItem.name}無法在戰鬥中使用。` : '角色目前無法採取行動。', timestamp: new Date().toLocaleTimeString() }]);
        return;
      }
      setMessages((prev) => [...prev, userMessage]);
      handleUseItem(requestedItem.id);
      return;
    }

    if (attackIntent && canPlayerAct(player)) {
      const map = getMapById(player.currentMapId);
      const available = getWorldUnitsAtMap(player.currentMapId, player).filter((unit) => unit.population || !player.unitInstances[unit.id]?.isDead);
      const matched = available.filter((unit) => actionText.includes(unit.name) || actionText.includes(unit.id) || (!!unit.enName && actionText.toLowerCase().includes(unit.enName.toLowerCase())));
      const encountered = player.encounteredUnitId ? getWorldUnitById(player.encounteredUnitId, player) : undefined;
      const target = matched.length === 1 ? matched[0] : matched.length === 0 ? encountered : undefined;
      const userMessage: StoryMessage = { id: `${Date.now()}-user`, sender: 'user', text: actionText, timestamp: new Date().toLocaleTimeString() };
      if (!player.combat && (!map || !target)) {
        const text = !map ? '目前地區資料不存在。' : matched.length > 1 ? `請指定攻擊對象：${matched.map((unit) => unit.name).join('、')}。` : '你目前尚未遭遇敵人，也沒有指定在場人物。請先探索或明確指定當前地區的目標。';
        setMessages((prev) => [...prev, userMessage, { id: `${Date.now()}-combat`, sender: 'system', text, timestamp: new Date().toLocaleTimeString() }]);
        return;
      }
      if (player.combat && matched.length === 1 && matched[0].id !== getCombatTarget(player.combat)?.unitId) {
        const current = getCombatTarget(player.combat);
        setMessages((prev) => [...prev, userMessage, { id: `${Date.now()}-combat`, sender: 'system', text: `目前鎖定${current?.label ?? '敵人'}；要換目標請從選項列的「目標」切換。`, timestamp: new Date().toLocaleTimeString() }]);
        return;
      }
      if (player.combat) {
        setMessages((prev) => [...prev, userMessage]);
        handleCombatAction();
        return;
      }
      // 與選項列的「挑戰」同一個執行函式（O50）；打字攻擊非敵對人物時會激怒對方。
      if (target) executeStartCombat(target.id, { provoke: true, actionText });
      return;
    }

    if (player.combat || !canPlayerAct(player)) {
      appendSystemMessage(player.isDead ? '角色已死亡，無法繼續行動。請讀取自動存檔（死亡前），或在存檔管理讀取手動存檔。'
        : isTimelineEnded(player) ? '這條時間線已經結束。請讀取自動存檔（結局前），或在存檔管理讀取手動存檔。' : '角色目前昏迷，無法採取行動。');
      return;
    }
    const explicitSelfDamage = parseExplicitSelfDamage(actionText);
    if (explicitSelfDamage !== undefined) {
      const actualDamage = Math.min(player.hp, explicitSelfDamage);
      const nextPlayer = applyStateChanges(advanceGameTime(player, 'quick'), {
        storyText: '', suggestedActions: [], stateChanges: { hpChange: -actualDamage }
      }, 'game');
      updatePlayer(nextPlayer, { [player.unitId]: { cause: 'self_inflicted' } });
      const now = Date.now();
      setMessages((prev) => [...prev,
        { id: `${now}-user`, sender: 'user', text: actionText, timestamp: new Date().toLocaleTimeString() },
        { id: `${now}-result`, sender: 'system', text: `🩸 你對自己造成 ${actualDamage} 點傷害。HP ${player.hp} → ${nextPlayer.hp}.${nextPlayer.isDead ? ' HP 歸零，你已死亡。' : ''}`, timestamp: new Date().toLocaleTimeString() }
      ]);
      return;
    }
    if (isSelfDamageIntent(actionText) && explicitSelfDamage === undefined) {
      setMessages((prev) => [...prev,
        { id: `${Date.now()}-user`, sender: 'user', text: actionText, timestamp: new Date().toLocaleTimeString() },
        { id: `${Date.now()}-clarify`, sender: 'system', text: '我理解你想讓角色受傷。請明確說明傷害點數，例如「對自己造成 3 點傷害」；在數值確認前不會改變 HP。', timestamp: new Date().toLocaleTimeString() }
      ]);
      return;
    }
    const waitIntent = parseWaitIntent(actionText);
    if (waitIntent) {
      const now = Date.now();
      // 合法時長與選項列的「等待」同一個執行函式（O50）；非安全地區的等待可能被敵人打斷。
      if (waitIntent.kind === 'duration' && isValidWaitMinutes(waitIntent.minutes)) {
        executeWait(waitIntent.minutes, { actionText, hasFollowUp: waitIntent.hasFollowUp });
        return;
      }
      const text = waitIntent.kind === 'duration'
          ? `⚠️ 你想等待${waitIntent.label ? `「${waitIntent.label}」` : ` ${formatDuration(waitIntent.minutes)}`}，但單次最多只能等待 ${formatDuration(MAX_WAIT_MINUTES)}，時間沒有推進（目前仍是 ${formatGameTime(player.gameTimeMinutes)}）。需要更久請分次等待，或到旅店休息。`
          : waitIntent.kind === 'time_of_day'
            ? `目前尚未支援「等到某個時段」，請改為指定時長，例如「等待 2 小時」（單次最多 ${formatDuration(MAX_WAIT_MINUTES)}）。`
            : `請說明要等待多久，例如「等待 2 小時」（單次最多 ${formatDuration(MAX_WAIT_MINUTES)}）。`;
      setMessages((prev) => [...prev,
        { id: `${now}-user`, sender: 'user', text: actionText, timestamp: new Date().toLocaleTimeString() },
        { id: `${now}-wait`, sender: 'system', text, timestamp: new Date().toLocaleTimeString() }
      ]);
      return;
    }
    const unsupportedItem = unsupportedInventoryItemRequested(actionText);
    if (unsupportedItem) {
      setMessages((prev) => [...prev,
        { id: `${Date.now()}-user`, sender: 'user', text: actionText, timestamp: new Date().toLocaleTimeString() },
        { id: `${Date.now()}-item`, sender: 'system', text: `世界物品資料中沒有「${unsupportedItem}」，角色不能憑空取出、使用或裝備。請先從商店或遊戲內容取得已存在的物品。`, timestamp: new Date().toLocaleTimeString() }
      ]);
      return;
    }
    const requestedSkill = getUnlockedSkills(player.classId, player.level).find((skill) =>
      (actionText.includes(skill.name) || actionText.includes(skill.id)) && /(?:施放|施展|使用|施法|發動)/u.test(actionText) &&
      !/(?:如何|怎麼|能否|可不可以|是否|請問|教我|詢問|不要|不想|無法|不能)/u.test(actionText)
    );
    if (requestedSkill && !player.combat) {
      setMessages((prev) => [...prev, createUserMessage(actionText)]);
      handleUseSkill(requestedSkill.id);
      return;
    }
    // 先移動、再敘事（O44）：玩家文字的移動意圖明確時，與選項列的「前往」同一個執行函式（O50）。
    const textTravelIntent = resolveExplicitTravelIntent(actionText, player);
    if (textTravelIntent.kind === 'resolved') {
      executeTravel(textTravelIntent.destination.id, { actionText, intent: textTravelIntent });
      return;
    }
    if (!apiKey) {
      setIsKeyModalOpen(true);
      return;
    }
    await runAiTurn(actionText, textTravelIntent);
  };

  /** 選項列的系統選項（O50）：一律呼叫與打字相同的執行函式。打開商店、告示板只在選項列內展開，不改變狀態。 */
  const runSystemAction = (action: SystemAction) => {
    if (loading || agentThinking) return;
    // 被發現（O45 D1、D9）：移動、挑戰、伏擊、戰鬥動作與只展開清單的選項以外，敵人會搶先出手。
    const exempt = ['travel', 'challenge', 'ambush', 'attack', 'flee', 'openShop', 'noticeBoard', 'switchTarget'].includes(action.kind) || (['useSkill', 'useItem'].includes(action.kind) && !!player.combat);
    if (!exempt && preemptByEnemy()) return;
    switch (action.kind) {
      case 'travel': executeTravel(action.mapId); break;
      case 'talk': executeTalk(action.unitId); break;
      case 'challenge': executeStartCombat(action.unitId); break;
      case 'ambush': executeAmbush(action.unitId); break;
      case 'trapWait': executeSetTrap(action.minutes); break;
      case 'acceptQuest': handleAcceptQuest(action.questId); break;
      case 'turnInQuest': handleTurnInQuest(action.questId); break;
      case 'buy': handleBuyItem(action.shopId, action.itemId); break;
      case 'sell': handleSellItem(action.shopId, action.itemId); break;
      case 'service': handleUseService(action.shopId, action.serviceId); break;
      case 'wait': executeWait(action.minutes); break;
      case 'useSkill': handleUseSkill(action.skillId, action.targetKey); break;
      case 'useItem': handleUseItem(action.itemId, action.targetKey); break;
      case 'switchTarget': handleSwitchTarget(action.enemyKey); break;
      case 'invite': handleInvite(action.unitId); break;
      case 'dismiss': handleDismiss(action.unitId); break;
      case 'attack': handleAttack(); break;
      case 'flee': handleFleeCombat(); break;
      case 'openShop': case 'noticeBoard': break;
    }
  };

  // 只有最新一則帶選項、且之後玩家尚未行動的訊息，其建議行動可以按（O50）。
  let activeMessage: StoryMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.sender === 'user' || message.invalidatesOptions) break;
    if (message.options?.length || message.travelOptions?.length) { activeMessage = message; break; }
  }
  const optionSet = buildSystemOptions(player);

  return (
    <div style={{ display: 'flex', height: '100vh', backgroundColor: '#1a1a1a', color: '#eaeaea', fontFamily: 'sans-serif' }}>
      <StoryLog
        messages={messages}
        loading={loading || agentThinking}
        busyText={agentThinking && !loading ? '⚖️ 各方正在盤算…' : undefined}
        onSendAction={handleSendAction}
        onOpenKeyModal={() => setIsKeyModalOpen(true)}
        hasApiKey={!!apiKey}
        selectedModel={modelSettings.model}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen((open) => !open)}
        combatActive={!!player.combat}
        inputDisabled={player.isDead || isPlayerUnconscious(player) || isTimelineEnded(player)}
        activeMessageId={activeMessage?.id}
        optionBar={<OptionBar player={player} optionSet={optionSet} busy={loading || agentThinking} busyNote={agentThinking ? '各方正在盤算…' : undefined}
          suggestions={activeMessage?.options ?? []} travelChoices={activeMessage?.travelOptions ?? []}
          onAction={runSystemAction} onSuggestion={handleSendAction} onTravel={(mapId) => runSystemAction({ kind: 'travel', mapId })} />}
        deathActions={player.isDead || isTimelineEnded(player)
          ? { reason: player.isDead ? 'death' : 'ending', onLoadAutoSave: handleLoadAutoSave, onOpenSaveManager: () => setIsSaveManagerOpen(true) } : undefined}
      />
      {isSidebarOpen && isNarrow && <div aria-hidden="true" onClick={() => setIsSidebarOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 20 }} />}
      {isSidebarOpen && <div style={isNarrow ? { position: 'fixed', top: 0, right: 0, bottom: 0, maxWidth: '85vw', zIndex: 21, display: 'flex' } : { display: 'flex', flexShrink: 0 }}>
        <PlayerHUD player={player} onOpenSaveManager={() => setIsSaveManagerOpen(true)} storageWarning={storageWarning || autosaveFailed} busy={loading || agentThinking} onUseItem={(itemId) => { if (!player.combat && preemptByEnemy()) return; handleUseItem(itemId); }}
          onEquipItem={(itemId) => { if (preemptByEnemy()) return; handleEquipItem(itemId); }} />
      </div>}
      {isKeyModalOpen && <ApiKeyModal
        isOpen={true}
        currentSettings={modelSettings}
        currentKeys={apiKeys}
        onSave={handleSaveAISettings}
        onClose={() => setIsKeyModalOpen(false)}
      />}
      {setupMode && !isSaveManagerOpen && <CharacterSetup onCreate={handleCreateCharacter}
        relatedOptionLabel={setupMode === 'continue' ? scenario.succession?.relatedLabel : undefined}
        onCancel={setupMode === 'continue'
        ? () => setSetupMode(null)
        // 建立新世界時若已有其他世界，可取消並回到存檔管理切換世界。
        : loadSaveIndex().worlds.length > 0 ? () => { setSetupMode(null); setIsSaveManagerOpen(true); } : undefined} />}
      {isSaveManagerOpen && <SaveManager activeWorldId={activeWorldId} busy={loading} saveBlockedReason={saveBlockedReason} onSaveManual={handleSaveManual} onLoad={handleLoadSlot}
        onDeleteSlot={handleDeleteSlot} onDeleteWorld={handleDeleteWorld} onExport={handleExportWorld} onImport={handleImportWorld}
        onNewWorld={handleNewWorld} onClose={() => {
          setIsSaveManagerOpen(false);
          // 沒有進行中的世界時不能直接遊玩，回到建立角色。
          if (!activeWorldId) setSetupMode('new-world');
        }} />}
    </div>
  );
}
