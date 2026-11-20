import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ActionCheckResult, CharacterHistoryEntry, SaveSlotId, SkillStatic, PlayerState, StoryMessage, WorldUnitStatic } from './types/game';
import { AUTO_SLOT_ID, clearLegacySaves, continueWorldWithCharacter, createHistoryEntry, createWorld, deleteSlot, deleteWorld, exportWorld, getLastWriteFailed, importWorld, loadSaveIndex, readSlot, setActiveWorld, subscribeSaveStatus, writeSlot, type LoadedSlot } from './utils/saveStorage';
import { SaveManager } from './components/SaveManager';
import { applyStateChanges } from './utils/applyStateChanges';
import { applyMemoryNotes, getMemoryEligibleUnitIds } from './utils/unitMemory';
import { canPlayerEnterMap, getCharacterClassById, getItemById, getMapById, getPlayerResourceCaps, getShopById, getUnlockedSkills, getWorldUnitById, getWorldUnitDisposition, getWorldUnitsAtMap, itemsDatabase, scenario } from './data/staticData';
import { getPlayerStatBreakdown, resolveActionCheck } from './utils/gameChecks';
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
import { loadAIModelSettings, saveAIModelSettings, type AIModelSettings } from './services/aiModels';
import { PlayerHUD } from './components/PlayerHUD';
import { StoryLog } from './components/StoryLog';
import { ApiKeyModal } from './components/ApiKeyModal';
import { CharacterSetup } from './components/CharacterSetup';
import { createInitialPlayer } from './utils/playerInit';
import { isSelfDamageIntent, parseExplicitSelfDamage, parseWaitIntent, unsupportedInventoryItemRequested } from './utils/playerActionIntent';
import { buyItem, getAvailableServices, purchaseService, sellItem } from './utils/tradeRules';
import { ACTION_DURATIONS, advanceGameTime, formatDuration, formatGameTime, isValidWaitMinutes, MAX_WAIT_MINUTES, waitGameTime } from './utils/gameTime';
import { grantUnitExp } from './utils/unitProgress';
import { createCombat, getCombatTarget, setEnemyHp } from './utils/combatState';
import { getPlayerWorldUnit } from './utils/worldUnits';
import { applyEventProposals, finalizeWorld, type DeathHint } from './utils/worldEvents';
import { createSuccessorReputation, describeReputationChanges } from './utils/factions';
import { rollWaitInterruption } from './utils/waitRules';
import type { CharacterAlignment } from './types/game';

function withUnitHp(player: PlayerState, unitId: string, currentHp: number, isDead = false): PlayerState {
  const state = player.unitInstances[unitId];
  return { ...player, unitInstances: { ...player.unitInstances, [unitId]: { ...state, currentHp, isDead } } };
}

/** 擊倒單位時取得其全部持有物與金幣（世界實際庫存）；掉落表與經驗另行結算。 */
function takeHoldings(player: PlayerState, unitId: string, unitName: string) {
  const state = player.unitInstances[unitId];
  if (!state || (state.gold <= 0 && state.inventory.length === 0)) return { player, loot: [] as { itemId: string; quantity: number }[], gold: 0 };
  const inventory = player.inventory.map((entry) => ({ ...entry }));
  for (const item of state.inventory) {
    const owned = inventory.find((entry) => entry.itemId === item.itemId);
    if (owned) owned.quantity += item.quantity;
    else inventory.push({ ...item });
  }
  const itemText = state.inventory.map((item) => `${getItemById(item.itemId)?.name ?? item.itemId} ×${item.quantity}`).join('、');
  const record = {
    id: `${Date.now()}-${Math.random()}`,
    type: 'unit_transfer' as const,
    description: `從 ${unitName} 身上取得${[state.gold > 0 ? `${state.gold} 金幣` : '', itemText].filter(Boolean).join('、')}`,
    goldChange: state.gold,
    timestamp: Date.now()
  };
  return {
    player: {
      ...player,
      gold: player.gold + state.gold,
      inventory,
      unitInstances: { ...player.unitInstances, [unitId]: { ...state, gold: 0, inventory: [] } },
      transactionHistory: [record, ...player.transactionHistory].slice(0, 100)
    },
    loot: state.inventory,
    gold: state.gold
  };
}

function resolveEnemyTurn(player: PlayerState, combat: NonNullable<PlayerState['combat']>, unit: WorldUnitStatic) {
  const special = unit.specialAbilities?.find((ability) => ability.combatAction && combat.round % ability.combatAction.triggerEveryRounds === 0);
  const action = special?.combatAction;
  const checkStat = action?.checkStat ?? 'def';
  const dc = action?.dc ?? 10 + Math.floor(unit.stats.atk / 2);
  const check = {
    ...resolveActionCheck(player, checkStat, dc),
    stat: checkStat,
    reason: action ? `${unit.name}施放${special?.name}：玩家進行${checkStat === 'dex' ? '閃避' : '抵抗'}檢定` : `${unit.name}反擊：玩家進行閃避檢定`,
    label: action ? `${special?.name}檢定` : '玩家閃避檢定'
  } satisfies ActionCheckResult;
  const damage = check.success ? 0 : Math.max(1, Math.floor(unit.stats.atk * (action?.damageMultiplier ?? 1)) - Math.floor(getPlayerStatBreakdown(player, 'def').statValue / 4));
  const hp = Math.max(0, player.hp - damage);
  const isDead = hp <= 0;
  const unconsciousTurns = !isDead && !check.success ? action?.applyUnconsciousTurnsOnFailure ?? 0 : 0;
  const statusEffects = player.statusEffects.filter((effect) => effect.id !== 'unconscious');
  if (unconsciousTurns > 0) statusEffects.push({ id: 'unconscious', remainingTurns: unconsciousTurns });
  // 擊倒玩家的單位依同一規則獲得玩家的擊倒經驗，並可能升級。
  const victorGrowth = isDead ? grantUnitExp(player.unitInstances, unit.id, getPlayerWorldUnit(player).expReward, player.world) : undefined;
  const deathHints: Record<string, DeathHint> = isDead ? { [player.unitId]: { cause: 'combat', killerUnitId: unit.id } } : {};
  const nextPlayer: PlayerState = {
    ...player, hp, isDead, statusEffects,
    ...(victorGrowth ? { unitInstances: victorGrowth.instances } : {}),
    ...(isDead ? { encounteredUnitId: undefined } : {}),
    ...(isDead ? { combat: undefined } : { combat: { ...combat, round: combat.round + 1 } })
  };
  const result = check.success
    ? action ? `你成功閃過${special?.name}。` : `你成功閃避${unit.name}的反擊。`
    : `${action ? `${special?.name}命中` : `${unit.name}反擊命中`}，你受到 ${damage} 點傷害。${unconsciousTurns ? `你陷入昏迷 ${unconsciousTurns} 回合。` : ''}`;
  const victorLevelText = victorGrowth && victorGrowth.level > victorGrowth.previousLevel ? `\n📈 ${unit.name}升至 Lv.${victorGrowth.level}。` : '';
  return { player: nextPlayer, check, deathHints, text: `${result}${isDead ? `\n☠️ HP 歸零，你已死亡。${victorLevelText}` : `\n第 ${combat.round + 1} 回合開始。`}` };
}

/** 多段移動的結果說明（O44）：途經地區、耗時，以及途中遭遇或未抵達的原因。 */
function describeRouteTravel(travel: RouteTravelResult, player: PlayerState): string {
  const via = travel.passed.length ? `途經${travel.passed.map((map) => map.name).join('、')}，` : '';
  const unit = travel.interruptedByUnitId ? getWorldUnitById(travel.interruptedByUnitId, player) : undefined;
  if (unit) {
    return `📍 你從${travel.origin.name}出發前往${travel.destination.name}，${via}在${travel.arrived.name}遇到${unit.name}，移動被打斷（耗時 ${formatDuration(travel.elapsedMinutes)}）。\n👁️ 遭遇：${unit.name}。可從下方選項列挑戰。`;
  }
  if (travel.stoppedBySegmentLimit) {
    return `📍 你從${travel.origin.name}出發前往${travel.destination.name}，${via}走了 ${formatDuration(travel.elapsedMinutes)}，目前停在${travel.arrived.name}，尚未抵達。單次行動最多移動 ${travel.passed.length + 1} 段，請繼續前往。`;
  }
  const time = travel.passed.length ? `耗時 ${formatDuration(travel.elapsedMinutes)}，` : '';
  return `📍 你${travel.passed.length ? `從${travel.origin.name}出發，` : ''}${via}${time}抵達${travel.arrived.name}。${travel.arrived.description}`;
}

function createRestoreNotice(player: PlayerState, savedAt: number, messageCount: number): StoryMessage {
  const map = getMapById(player.currentMapId);
  const combatUnit = player.combat ? getWorldUnitById(player.combat.targetUnitId, player) : undefined;
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
  if (combatUnit && player.combat) lines.push(`戰鬥恢復：第 ${player.combat.round} 回合，${combatUnit.name} HP ${getCombatTarget(player.combat)?.currentHp ?? 0}/${combatUnit.stats.hp}`);
  else if (player.encounteredUnitId) lines.push(`已遭遇單位：${getWorldUnitById(player.encounteredUnitId)?.name ?? player.encounteredUnitId}（可從選項列挑戰）`);
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

  /**
   * 行動造成的狀態變更一律經此套用：先執行世界規則（死亡紀錄、地區結算、自動事件），
   * 新寫入的世界事件以系統訊息附在本次行動結果之後。讀檔與換角色不是行動，直接 setPlayer。
   */
  const updatePlayer = (nextPlayer: PlayerState, deathHints?: Record<string, DeathHint>) => {
    const finalized = finalizeWorld(player, nextPlayer, deathHints);
    setPlayer(finalized);
    const knownIds = new Set(player.world.events.map((event) => event.id));
    const newEvents = finalized.world.events.filter((event) => !knownIds.has(event.id));
    // 劇情片段完成與推進幕另以主線訊息呈現，不重複列在世界變化中。
    const storyNotice = describeStoryProgress(player, finalized);
    if (storyNotice) setTimeout(() => appendSystemMessage(storyNotice), 0);
    // 重要角色在別處的決策（O34）不直接告訴玩家，之後經由傳聞與現場結果得知。
    const worldChanges = newEvents.filter((event) => event.type !== 'story_progress' &&
      (!event.agent || event.mapId === finalized.currentMapId || event.knownBy === 'world'));
    if (worldChanges.length) {
      // 劇情事件附帶的聲望變化另外列出（玩家行動造成的聲望事件已寫在描述中）。
      const describe = (event: typeof newEvents[number]) => event.type === 'scenario_event' && event.reputationChanges?.length
        ? `${event.summary}（聲望變化：${describeReputationChanges(player, event.reputationChanges)}）` : event.summary;
      setTimeout(() => appendSystemMessage(`🌍 世界變化：\n${worldChanges.map((event) => `・${describe(event)}`).join('\n')}`), 0);
    }
  };

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
    const nextPlayer = advanceGameTime({ ...sourcePlayer, previousMapId: sourcePlayer.currentMapId, currentMapId: destination.id, encounteredUnitId: undefined }, 'travel');
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
    const turnPlayer = resolvedTravel?.player ?? player;

    try {
      const aiResponse = await sendPlayerAction(modelSettings, apiKey, turnPlayer, actionText, messages, characterHistory, resolvedTravel);
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
      // 人物記憶：對話已發生，不論檢定結果都記下；以行動前的在場人物驗證。
      nextPlayer = applyMemoryNotes(nextPlayer, aiResponse.memoryNotes, getMemoryEligibleUnitIds(turnPlayer)).state;
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
      if (nextPlayer.isDead) nextPlayer = { ...nextPlayer, encounteredUnitId: undefined };
      const requestedEncounter = aiResponse.encounterRequest?.unitId;
      const requestedUnit = requestedEncounter ? getWorldUnitById(requestedEncounter) : undefined;
      const encounterUnit = requestedUnit?.requiresEncounter ? requestedUnit : undefined;
      const currentMap = getMapById(turnPlayer.currentMapId);
      const encounterAllowed = !nextPlayer.combat && !nextPlayer.isDead && canPlayerAct(nextPlayer) && !!currentMap && !currentMap.isSafeZone &&
        !!encounterUnit && encounterUnit.mapIds.includes(currentMap.id) && currentMap.unitsPresent.includes(encounterUnit.id) &&
        (!encounterUnit.requiredQuestId || nextPlayer.activeQuests.some((quest) => quest.questId === encounterUnit.requiredQuestId && quest.status === 'in_progress'));
      // 移動途中的遭遇已在移動說明中列出，AI 重複提出同一單位時不再提示。
      const encounterNotice = encounterAllowed && encounterUnit && encounterUnit.id !== turnPlayer.encounteredUnitId
        ?`\n\n👁️ 遭遇：${encounterUnit.name}。可從下方選項列挑戰。`
        : '';
      if (encounterAllowed && encounterUnit) nextPlayer = { ...nextPlayer, encounteredUnitId: encounterUnit.id };
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
        ? { [player.unitId]: { cause: isSelfDamageIntent(actionText) ? 'self_inflicted' : 'misadventure', note: checkResult?.reason } }
        : undefined);

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
          text: `${storyText}${storyletNotice}${postedQuestNotice}${questNotice}${questCompletionNotice}${unitTransferNotice}${unitDispositionNotice}${encounterNotice}${serviceNotice}${locationNotice}${deathNotice}`,
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
      // 已由規則結算的移動（O44／O50）不因 AI 失敗而取消：照常套用移動與途中遭遇，只略過敘事。
      if (resolvedTravel) {
        updatePlayer(resolvedTravel.player);
        setMessages((prev) => [...prev, {
          id: `${Date.now()}-travel`, sender: 'system', invalidatesOptions: true, timestamp: new Date().toLocaleTimeString(),
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
    if (!apiKey) {
      updatePlayer(travel.player);
      setMessages((previous) => [...previous, createUserMessage(actionText), {
        id: `${Date.now()}-travel`, sender: 'system', text: `${describeRouteTravel(travel, travel.player)}\n（尚未設定 AI，略過敘事。）`, invalidatesOptions: true, timestamp: new Date().toLocaleTimeString()
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
    const provoked = getWorldUnitDisposition(player, unitId) === 'hostile'
      ? player
      : applyStateChanges(player, { storyText: '', suggestedActions: [], stateChanges: { unitDispositionChanges: [{ unitId, disposition: 'hostile' }] } }, 'game');
    const unitState = unit.population ? undefined : provoked.unitInstances[unit.id];
    // 地區居民的戰鬥 HP 會保留；需遭遇的單位每次戰鬥以完整 HP 開始。
    const currentHp = unit.requiresEncounter ? unit.stats.hp : unitState?.currentHp ?? unit.stats.hp;
    const combatPlayer: PlayerState = { ...provoked, encounteredUnitId: unitId, combat: createCombat([provoked.unitId], [{ unitId, currentHp }]) };
    updatePlayer(combatPlayer);
    setMessages((previous) => [...previous, userMessage, {
      id: `${Date.now()}-combat`, sender: 'system', timestamp: new Date().toLocaleTimeString(),
      text: `你${provoked === player ? '與' : '激怒並與'}${unit.name}進入戰鬥！攻擊、已解鎖技能及消耗品各自消耗一個行動回合；敵人存活時會反擊並進行閃避檢定。`
    }]);
    void narrateCombatStart(userMessage.text, combatPlayer);
  };

  /** 等待（O50）：選項列與打字的等待都經此執行；非安全地區可能被敵人打斷。不呼叫 AI。 */
  const executeWait = (minutes: number, typed?: { actionText: string; hasFollowUp: boolean }) => {
    if (player.combat || !canPlayerAct(player)) return;
    const interruption = rollWaitInterruption(player, minutes);
    const waited = waitGameTime(player, interruption.elapsedMinutes);
    if (waited === player) return;
    const interruptUnit = interruption.unitId ? getWorldUnitById(interruption.unitId, player) : undefined;
    const waitNext = interruptUnit ? { ...waited, encounteredUnitId: interruptUnit.id } : waited;
    const text = interruptUnit
      ? `⏳ 你等待了 ${formatDuration(interruption.elapsedMinutes)}，${interruptUnit.name}出現，等待被打斷！現在是 ${formatGameTime(waitNext.gameTimeMinutes)}。\n👁️ 遭遇：${interruptUnit.name}。可從下方選項列挑戰。`
      : `⏳ 你原地等待了 ${formatDuration(minutes)}，現在是 ${formatGameTime(waitNext.gameTimeMinutes)}。等待不會恢復生命與魔力。${typed?.hasFollowUp ? '\n等待之後的行動請另外輸入。' : ''}`;
    updatePlayer(waitNext);
    setMessages((previous) => [...previous, ...(typed ? [createUserMessage(typed.actionText)] : []),
      { id: `${Date.now()}-wait`, sender: 'system', text, invalidatesOptions: true, timestamp: new Date().toLocaleTimeString() }]);
  };

  const handleFleeCombat = () => {
    if (!player.combat || !canPlayerAct(player)) return;
    const combatUnit = getWorldUnitById(player.combat.targetUnitId, player);
    const outOfCombat = { ...player };
    delete outOfCombat.combat;
    delete outOfCombat.encounteredUnitId;
    updatePlayer(advanceGameTime(outOfCombat, 'combatRound'));
    appendSystemMessage(`你與${combatUnit?.name ?? '敵人'}拉開距離，戰鬥結束。`, undefined, true);
  };

  const handleCombatAction = (skill?: SkillStatic, sourcePlayer: PlayerState = player) => {
    const combat = sourcePlayer.combat;
    const target = combat ? getCombatTarget(combat) : undefined;
    const unit = target ? getWorldUnitById(target.unitId, sourcePlayer) : undefined;
    if (!combat || !target || !unit || sourcePlayer.isDead) return;
    if (isPlayerUnconscious(sourcePlayer)) {
      const recovered = { ...advanceGameTime(sourcePlayer, 'combatRound'), statusEffects: sourcePlayer.statusEffects.filter((effect) => effect.id !== 'unconscious'), combat: { ...combat } };
      const enemyTurn = resolveEnemyTurn(recovered, combat, unit);
      updatePlayer(enemyTurn.player, enemyTurn.deathHints);
      appendSystemMessage(`你仍昏迷，失去本回合行動。\n${enemyTurn.text}`, [enemyTurn.check]);
      return;
    }
    if (skill && sourcePlayer.mp < skill.costMp) return;

    const attackCheck = {
      ...resolveActionCheck(sourcePlayer, 'atk', 10 + unit.stats.def),
      stat: 'atk' as const,
      reason: `第 ${combat.round} 回合：${skill?.name ?? '攻擊'}${unit.name}`,
      label: '玩家攻擊檢定'
    };
    const checks: ActionCheckResult[] = [attackCheck];
    const playerAttack = getPlayerStatBreakdown(sourcePlayer, 'atk').statValue;
    const skillMultiplier = skill?.effect.kind === 'damage_multiplier' ? skill.effect.multiplier : 1;
    const damage = attackCheck.success
      ? Math.max(1, Math.floor(playerAttack * skillMultiplier) - unit.stats.def)
      : 0;
    const targetHp = attackCheck.success
      ? Math.max(0, target.currentHp - damage)
      : target.currentHp;
    const attackText = attackCheck.success
      ? `${skill?.name ?? '攻擊'}命中，對${unit.name}造成 ${damage} 點傷害。`
      : `${skill?.name ?? '攻擊'}未命中${unit.name}。`;
    const timedPlayer = advanceGameTime(sourcePlayer, 'combatRound');
    const actionPlayer = skill ? { ...timedPlayer, mp: timedPlayer.mp - skill.costMp } : timedPlayer;
    const combatActionPlayer = unit.requiresEncounter ? actionPlayer : withUnitHp(actionPlayer, unit.id, targetHp, targetHp <= 0);

    if (targetHp <= 0) {
      // 單位一致：擊倒任何單位都走同一流程。取得其持有物、依掉落表擲骰、依公式給予經驗
      // （地區居民的經驗可由劇本關閉，殺害的後果由勢力聲望承擔），並記入擊倒數與任務進度。
      const looted = takeHoldings(combatActionPlayer, unit.id, unit.name);
      const dropItems = (unit.loot?.dropItems ?? []).flatMap((drop) => {
        if (!globalThis.crypto?.getRandomValues) return [];
        const roll = new Uint32Array(1);
        globalThis.crypto.getRandomValues(roll);
        return roll[0] / 0x1_0000_0000 < drop.chance ? [{ itemId: drop.itemId, quantity: 1 }] : [];
      });
      const lootGold = unit.loot?.gold ?? 0;
      const expGain = unit.requiresEncounter || scenario.rules.residentKillGrantsExp ? unit.expReward : 0;
      const questUpdates = sourcePlayer.activeQuests.filter((quest) => quest.status === 'in_progress')
        .map((quest) => ({ questId: quest.questId, status: 'completed' as const }));
      const nextPlayer = applyStateChanges(looted.player, {
        storyText: '', suggestedActions: [],
        stateChanges: {
          expChange: expGain,
          goldChange: lootGold,
          addItems: dropItems,
          defeatedUnits: [{ unitId: unit.id, quantity: 1 }],
          questUpdates
        }
      }, 'game');
      const completedQuests = nextPlayer.activeQuests.filter((quest) => quest.status === 'completed' &&
        sourcePlayer.activeQuests.some((previous) => previous.questId === quest.questId && previous.status === 'in_progress'));
      // 唯一個體擊倒即永久死亡（寫入死亡事件）；族群樣板代表一群個體，不會因單次擊倒而消失。
      const victoryState = unit.population ? { ...nextPlayer } : withUnitHp(nextPlayer, unit.id, 0, true);
      delete victoryState.combat;
      delete victoryState.encounteredUnitId;
      updatePlayer(victoryState, { [unit.id]: { cause: 'combat', killerUnitId: sourcePlayer.unitId } });
      const gains = [
        expGain > 0 ? `${expGain} EXP` : '',
        lootGold + looted.gold > 0 ? `${lootGold + looted.gold} 金幣` : '',
        ...[...looted.loot, ...dropItems].map((item) => `${getItemById(item.itemId)?.name ?? item.itemId} ×${item.quantity}`)
      ].filter(Boolean);
      const levelText = nextPlayer.level > looted.player.level ? ` 📈 升至 Lv.${nextPlayer.level}！` : '';
      const questText = completedQuests.map((quest) => `任務「${findQuest(sourcePlayer, quest.questId)?.title ?? quest.questId}」完成，需求道具已交付並領取獎勵。`).join('\n');
      appendSystemMessage(`${unit.isBoss ? '🏆' : '⚔️'} ${attackText}\n${unit.name}已被擊倒！${gains.length ? `獲得 ${gains.join('、')}。` : '沒有獲得任何東西。'}${expGain > 0 ? '' : '（不會獲得經驗）'}${levelText}${questText ? `\n${questText}` : ''}`, checks, true);
      return;
    }

    const nextCombat = setEnemyHp(combat, unit.id, targetHp);
    const enemyTurn = resolveEnemyTurn({ ...combatActionPlayer, combat: nextCombat }, nextCombat, unit);
    updatePlayer(enemyTurn.player, enemyTurn.deathHints);
    appendSystemMessage(`${attackText}\n${enemyTurn.text}`, [...checks, enemyTurn.check]);
  };

  const handleAttack = () => handleCombatAction();

  const handleUseSkill = (skillId: string) => {
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
    if (skill.effect.kind === 'healing') {
      if (player.combat) return;
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
      return;
    }
    if (!player.combat) return;
    handleCombatAction(skill);
  };

  const handleUseItem = (itemId: string) => {
    const item = getItemById(itemId);
    const inventoryEntry = player.inventory.find((entry) => entry.itemId === itemId);
    if (!item || item.type !== 'consumable' || !inventoryEntry || inventoryEntry.quantity <= 0 || !canPlayerAct(player) || (player.combat && !item.usableInCombat)) return;
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
    if (!player.combat) {
      updatePlayer(next);
      appendSystemMessage(`使用${item.name}，${details}。`);
      return;
    }

    const combatUnit = getWorldUnitById(player.combat.targetUnitId, player);
    if (!combatUnit) return;
    const combatNext = combatUnit.requiresEncounter ? next : withUnitHp(next, combatUnit.id, getCombatTarget(player.combat)?.currentHp ?? 0);
    const enemyTurn = resolveEnemyTurn({ ...combatNext, combat: player.combat }, player.combat, combatUnit);
    updatePlayer(enemyTurn.player, enemyTurn.deathHints);
    appendSystemMessage(`使用${item.name}，${details}。\n${enemyTurn.text}`, [enemyTurn.check]);
  };

  const handleSendAction = async (actionText: string) => {
    const isQuestion = /(?:如何|怎麼|能否|可不可以|是否|請問|教我|詢問|不要|不想|無法|不能)/u.test(actionText);
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

    const attackIntent = !isQuestion && /(?:攻擊|攻打|打倒|擊倒|砍向|砍|刺向|刺|揮擊|attack|strike|fight)/iu.test(actionText) && !/(?:攻擊自己|打自己|刺自己|砍自己)/u.test(actionText);
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
      if (player.combat && matched.length === 1 && matched[0].id !== player.combat.targetUnitId) {
        const currentUnit = getWorldUnitById(player.combat.targetUnitId);
        setMessages((prev) => [...prev, userMessage, { id: `${Date.now()}-combat`, sender: 'system', text: `目前正在與${currentUnit?.name ?? '敵人'}戰鬥，無法切換目標。`, timestamp: new Date().toLocaleTimeString() }]);
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
    if (loading) return;
    switch (action.kind) {
      case 'travel': executeTravel(action.mapId); break;
      case 'talk': executeTalk(action.unitId); break;
      case 'challenge': executeStartCombat(action.unitId); break;
      case 'acceptQuest': handleAcceptQuest(action.questId); break;
      case 'turnInQuest': handleTurnInQuest(action.questId); break;
      case 'buy': handleBuyItem(action.shopId, action.itemId); break;
      case 'sell': handleSellItem(action.shopId, action.itemId); break;
      case 'service': handleUseService(action.shopId, action.serviceId); break;
      case 'wait': executeWait(action.minutes); break;
      case 'useSkill': handleUseSkill(action.skillId); break;
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
        loading={loading}
        onSendAction={handleSendAction}
        onOpenKeyModal={() => setIsKeyModalOpen(true)}
        hasApiKey={!!apiKey}
        selectedModel={modelSettings.model}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen((open) => !open)}
        combatActive={!!player.combat}
        inputDisabled={player.isDead || isPlayerUnconscious(player) || isTimelineEnded(player)}
        activeMessageId={activeMessage?.id}
        optionBar={<OptionBar player={player} optionSet={optionSet} busy={loading}
          suggestions={activeMessage?.options ?? []} travelChoices={activeMessage?.travelOptions ?? []}
          onAction={runSystemAction} onSuggestion={handleSendAction} onTravel={(mapId) => runSystemAction({ kind: 'travel', mapId })} />}
        deathActions={player.isDead || isTimelineEnded(player)
          ? { reason: player.isDead ? 'death' : 'ending', onLoadAutoSave: handleLoadAutoSave, onOpenSaveManager: () => setIsSaveManagerOpen(true) } : undefined}
      />
      {isSidebarOpen && isNarrow && <div aria-hidden="true" onClick={() => setIsSidebarOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 20 }} />}
      {isSidebarOpen && <div style={isNarrow ? { position: 'fixed', top: 0, right: 0, bottom: 0, maxWidth: '85vw', zIndex: 21, display: 'flex' } : { display: 'flex', flexShrink: 0 }}>
        <PlayerHUD player={player} onOpenSaveManager={() => setIsSaveManagerOpen(true)} storageWarning={storageWarning || autosaveFailed} busy={loading} onUseItem={handleUseItem} onEquipItem={handleEquipItem} />
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
