import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ActionCheckResult, CharacterHistoryEntry, SaveSlotId, SkillStatic, PlayerState, StoryMessage, WorldUnitStatic } from './types/game';
import { AUTO_SLOT_ID, clearLegacySaves, continueWorldWithCharacter, createHistoryEntry, createWorld, deleteSlot, deleteWorld, exportWorld, getLastWriteFailed, importWorld, loadSaveIndex, readSlot, setActiveWorld, subscribeSaveStatus, writeSlot, type LoadedSlot } from './utils/saveStorage';
import { SaveManager } from './components/SaveManager';
import { applyStateChanges } from './utils/applyStateChanges';
import { applyMemoryNotes, getMemoryEligibleUnitIds } from './utils/unitMemory';
import { canPlayerEnterMap, getCharacterClassById, getItemById, getMapById, getPlayerResourceCaps, getShopById, getUnlockedSkills, getWorldUnitById, getWorldUnitDisposition, getWorldUnitsAtMap, itemsDatabase, scenario } from './data/staticData';
import { getPlayerStatBreakdown, resolveActionCheck } from './utils/gameChecks';
import { resolveExplicitTravelIntent, storyClaimsPlayerMoved } from './utils/travelIntent';
import { sendPlayerAction } from './services/aiService';
import { acceptQuest, canTurnInQuest, findQuest, getQuestGiverName } from './utils/questRules';
import { postQuestProposals } from './utils/generatedQuests';
import { describeStoryProgress, startStorylets } from './utils/storylets';
import { canPlayerAct, isPlayerUnconscious } from './utils/playerStatus';
import type { AIProvider } from './services/aiModels';
import { loadAIModelSettings, saveAIModelSettings, type AIModelSettings } from './services/aiModels';
import { PlayerHUD } from './components/PlayerHUD';
import { StoryLog } from './components/StoryLog';
import { ApiKeyModal } from './components/ApiKeyModal';
import { CharacterSetup } from './components/CharacterSetup';
import { createInitialPlayer } from './utils/playerInit';
import { isSelfDamageIntent, parseExplicitSelfDamage, parseWaitIntent, unsupportedInventoryItemRequested } from './utils/playerActionIntent';
import { buyItem, getAvailableServices, purchaseService, sellItem } from './utils/tradeRules';
import { ACTION_DURATIONS, advanceGameTime, formatDuration, formatGameTime, MAX_WAIT_MINUTES, waitGameTime } from './utils/gameTime';
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
  else if (player.encounteredUnitId) lines.push(`已遭遇單位：${getWorldUnitById(player.encounteredUnitId)?.name ?? player.encounteredUnitId}（可從 HUD 發起戰鬥）`);
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
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
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
    const worldChanges = newEvents.filter((event) => event.type !== 'story_progress');
    if (worldChanges.length) {
      // 劇情事件附帶的聲望變化另外列出（玩家行動造成的聲望事件已寫在描述中）。
      const describe = (event: typeof newEvents[number]) => event.type === 'scenario_event' && event.reputationChanges?.length
        ? `${event.summary}（聲望變化：${describeReputationChanges(player, event.reputationChanges)}）` : event.summary;
      setTimeout(() => appendSystemMessage(`🌍 世界變化：\n${worldChanges.map((event) => `・${describe(event)}`).join('\n')}`), 0);
    }
  };

  // 自動存檔：每次狀態變更（且非 AI 回合進行中）覆寫目前世界的自動存檔欄位。
  // 死亡與戰鬥中不寫入：自動存檔停在致命行動或該場戰鬥開始之前，死亡後讀檔不會落入無法脫身的戰鬥。
  useEffect(() => {
    if (loading || !activeWorldId || player.isDead || player.combat) return;
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

  const handleTravel = (mapId: string) => {
    const travel = movePlayerTo(mapId);
    if (!travel) return;
    updatePlayer(travel.player);
    setMessages((previous) => [...previous, {
      id: Date.now().toString(),
      sender: 'system',
      text: `你已抵達${travel.destination.name}。${travel.destination.description}`,
      timestamp: new Date().toLocaleTimeString()
    }]);
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
    appendSystemMessage(rewardRecord?.description ?? `已向${getQuestGiverName(player, quest)}交付任務「${quest.title}」。`);
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
    appendSystemMessage(`使用${service?.name ?? '服務'}，支付 ${result.totalPrice} 金幣，休息 ${formatDuration(ACTION_DURATIONS.rest)}後生命與魔力已恢復。`);
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

  const appendSystemMessage = (text: string, checkResults?: ActionCheckResult[]) => {
    setMessages((previous) => [...previous, {
      id: `${Date.now()}-${Math.random()}`,
      sender: 'system',
      text,
      checkResults,
      timestamp: new Date().toLocaleTimeString()
    }]);
  };

  const handleStartCombat = (unitId: string) => {
    const map = getMapById(player.currentMapId);
    const unit = getWorldUnitById(unitId, player);
    const present = unit?.mapIds.includes(player.currentMapId) && map?.unitsPresent.includes(unitId);
    const unitState = unit && !unit.population ? player.unitInstances[unit.id] : undefined;
    if (player.combat || !canPlayerAct(player) || !map || !unit || !present || getWorldUnitDisposition(player, unitId) !== 'hostile' ||
        (unit.requiresEncounter && (map.isSafeZone || player.encounteredUnitId !== unitId || (unit.requiredQuestId && !player.activeQuests.some((quest) => quest.questId === unit.requiredQuestId && quest.status === 'in_progress')))) ||
        unitState?.isDead || unitState?.currentHp === 0) return;
    // 地區居民的戰鬥 HP 會保留；需遭遇的單位每次戰鬥以完整 HP 開始。
    const currentHp = unit.requiresEncounter ? unit.stats.hp : unitState?.currentHp ?? unit.stats.hp;
    updatePlayer({ ...player, encounteredUnitId: unitId, combat: createCombat([player.unitId], [{ unitId, currentHp }]) });
    appendSystemMessage(`你與${unit.name}進入戰鬥！攻擊、已解鎖技能及消耗品各自消耗一個行動回合；敵人存活時會反擊並進行閃避檢定。`);
  };

  const handleFleeCombat = () => {
    if (!player.combat || !canPlayerAct(player)) return;
    const combatUnit = getWorldUnitById(player.combat.targetUnitId, player);
    const outOfCombat = { ...player };
    delete outOfCombat.combat;
    delete outOfCombat.encounteredUnitId;
    updatePlayer(advanceGameTime(outOfCombat, 'combatRound'));
    appendSystemMessage(`你與${combatUnit?.name ?? '敵人'}拉開距離，戰鬥結束。`);
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
      appendSystemMessage(`${unit.isBoss ? '🏆' : '⚔️'} ${attackText}\n${unit.name}已被擊倒！${gains.length ? `獲得 ${gains.join('、')}。` : '沒有獲得任何東西。'}${expGain > 0 ? '' : '（不會獲得經驗）'}${levelText}${questText ? `\n${questText}` : ''}`, checks);
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
    if (!skill || !canPlayerAct(player) || player.mp < skill.costMp) return;
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
      if (!player.combat && target?.requiresEncounter && map?.isSafeZone) {
        setMessages((prev) => [...prev, userMessage, { id: `${Date.now()}-combat`, sender: 'system', text: '安全地區不會遭遇敵人。', timestamp: new Date().toLocaleTimeString() }]);
        return;
      }
      if (player.combat && matched.length === 1 && matched[0].id !== player.combat.targetUnitId) {
        const currentUnit = getWorldUnitById(player.combat.targetUnitId);
        setMessages((prev) => [...prev, userMessage, { id: `${Date.now()}-combat`, sender: 'system', text: `目前正在與${currentUnit?.name ?? '敵人'}戰鬥，無法切換目標。`, timestamp: new Date().toLocaleTimeString() }]);
        return;
      }
      setMessages((prev) => [...prev, userMessage]);
      if (!player.combat && target) {
        const provokedPlayer = getWorldUnitDisposition(player, target.id) === 'hostile'
          ? player
          : applyStateChanges(player, {
            storyText: '', suggestedActions: [], stateChanges: { unitDispositionChanges: [{ unitId: target.id, disposition: 'hostile' }] }
          }, 'game');
        if (target.requiresEncounter && player.encounteredUnitId !== target.id) {
          appendSystemMessage(`你尚未遭遇${target.name}；請先探索，等實際遭遇後再攻擊。`);
          return;
        }
        const currentHp = target.requiresEncounter ? target.stats.hp : provokedPlayer.unitInstances[target.id]?.currentHp ?? target.stats.hp;
        const combatPlayer: PlayerState = { ...provokedPlayer, encounteredUnitId: target.id, combat: createCombat([provokedPlayer.unitId], [{ unitId: target.id, currentHp }]) };
        appendSystemMessage(`你${provokedPlayer === player ? '與' : '激怒並與'}已遭遇的${target.name}進入戰鬥！`);
        handleCombatAction(undefined, combatPlayer);
      } else if (player.combat) handleCombatAction();
      return;
    }

    if (player.combat || !canPlayerAct(player)) {
      appendSystemMessage(player.isDead ? '角色已死亡，無法繼續行動。請讀取自動存檔（死亡前），或在存檔管理讀取手動存檔。' : '角色目前昏迷，無法採取行動。');
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
      // 非安全地區的等待可能被敵人打斷，只經過到打斷為止的時間。
      const interruption = waitIntent.kind === 'duration' && waitIntent.minutes <= MAX_WAIT_MINUTES ? rollWaitInterruption(player, waitIntent.minutes) : undefined;
      const waited = waitIntent.kind === 'duration' ? waitGameTime(player, interruption?.elapsedMinutes ?? waitIntent.minutes) : player;
      const interruptUnit = interruption?.unitId ? getWorldUnitById(interruption.unitId, player) : undefined;
      const waitNext = interruptUnit && waited !== player ? { ...waited, encounteredUnitId: interruptUnit.id } : waited;
      const text = interruptUnit && interruption && waitNext !== player
        ? `⏳ 你等待了 ${formatDuration(interruption.elapsedMinutes)}，${interruptUnit.name}出現，等待被打斷！現在是 ${formatGameTime(waitNext.gameTimeMinutes)}。\n👁️ 遭遇：${interruptUnit.name}。已加入 HUD，可從右側開始戰鬥。`
        : waitIntent.kind === 'duration' && waitNext !== player
        ? `⏳ 你原地等待了 ${formatDuration(waitIntent.minutes)}，現在是 ${formatGameTime(waitNext.gameTimeMinutes)}。等待不會恢復生命與魔力。${waitIntent.hasFollowUp ? '\n等待之後的行動請另外輸入。' : ''}`
        : waitIntent.kind === 'duration'
          ? `⚠️ 你想等待${waitIntent.label ? `「${waitIntent.label}」` : ` ${formatDuration(waitIntent.minutes)}`}，但單次最多只能等待 ${formatDuration(MAX_WAIT_MINUTES)}，時間沒有推進（目前仍是 ${formatGameTime(player.gameTimeMinutes)}）。需要更久請分次等待，或到旅店休息。`
          : waitIntent.kind === 'time_of_day'
            ? `目前尚未支援「等到某個時段」，請改為指定時長，例如「等待 2 小時」（單次最多 ${formatDuration(MAX_WAIT_MINUTES)}）。`
            : `請說明要等待多久，例如「等待 2 小時」（單次最多 ${formatDuration(MAX_WAIT_MINUTES)}）。`;
      if (waitNext !== player) updatePlayer(waitNext);
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
      const userMessage: StoryMessage = { id: `${Date.now()}-user`, sender: 'user', text: actionText, timestamp: new Date().toLocaleTimeString() };
      if (requestedSkill.effect.kind !== 'healing') {
        setMessages((prev) => [...prev, userMessage, {
          id: `${Date.now()}-skill`, sender: 'system', text: `${requestedSkill.name}只能在戰鬥中使用，沒有消耗 MP。`, timestamp: new Date().toLocaleTimeString()
        }]);
        return;
      }
      const caps = getPlayerResourceCaps(player);
      const restored = Math.min(requestedSkill.effect.hpRestore, Math.max(0, caps.maxHp - player.hp));
      if (player.mp < requestedSkill.costMp || restored <= 0) {
        setMessages((prev) => [...prev, userMessage, {
          id: `${Date.now()}-skill`, sender: 'system', text: player.mp < requestedSkill.costMp
            ? `${requestedSkill.name}需要 ${requestedSkill.costMp} MP，目前魔力不足，沒有施放。`
            : `${requestedSkill.name}目前無法恢復 HP，沒有消耗 MP。`,
          timestamp: new Date().toLocaleTimeString()
        }]);
        return;
      }
      updatePlayer(applyStateChanges(advanceGameTime(player, 'quick'), {
        storyText: '', suggestedActions: [],
        stateChanges: { hpChange: restored, mpChange: -requestedSkill.costMp }
      }, 'game'));
      setMessages((prev) => [...prev, userMessage, {
        id: `${Date.now()}-skill`, sender: 'system', text: `施放${requestedSkill.name}，HP +${restored}、MP -${requestedSkill.costMp}。`, timestamp: new Date().toLocaleTimeString()
      }]);
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
      const aiResponse = await sendPlayerAction(modelSettings, apiKey, player, actionText, messages, characterHistory);
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
      }
      // AI 提議的世界事件：只在沒有檢定或檢定成功時考慮，條件由遊戲再驗證；劇情旗標只能經由事件設定。
      if (!checkResult || checkResult.success) nextPlayer = applyEventProposals(nextPlayer, aiResponse.eventProposals).state;
      // AI 依任務範本提議的支線委託：同樣只在沒有檢定或檢定成功時考慮，由遊戲驗證後發布並預扣報酬。
      const questPosting = !checkResult || checkResult.success ? postQuestProposals(nextPlayer, aiResponse.questProposals) : undefined;
      if (questPosting) nextPlayer = questPosting.state;
      // 人物記憶：對話已發生，不論檢定結果都記下；以行動前的在場人物驗證。
      nextPlayer = applyMemoryNotes(nextPlayer, aiResponse.memoryNotes, getMemoryEligibleUnitIds(player)).state;
      // 劇情片段：只在沒有檢定或檢定成功時考慮，以行動前（AI 看到的狀態）的候選驗證。
      const storyStart = !checkResult || checkResult.success ? startStorylets(player, nextPlayer, aiResponse.storyletProposals) : undefined;
      if (storyStart) nextPlayer = storyStart.state;
      if (storyStart?.rejected.length) console.info('劇情片段提議未採用：', storyStart.rejected.join('；'));
      const storyletNotice = storyStart?.started.length
        ? `\n\n📖 主線開始：${storyStart.started.map((storylet) => `「${storylet.title}」——${storylet.goal.summary}`).join('；')}。`
        : '';
      const postedQuestNotice = questPosting?.posted.length
        ? `

📌 新委託「${questPosting.posted.map((quest) => `${quest.title}」（${quest.questGiver}）：${quest.objective}。報酬 ${quest.rewards.exp} EXP、${quest.rewards.gold} 金幣${(quest.rewards.items ?? []).map((item) => `、${getItemById(item.itemId)?.name ?? item.itemId} ×${item.quantity}`).join('')}，期限至${formatGameTime(quest.expiresAtMinutes)}`).join('')}。可在右側任務欄或對話中表示接受。`
        : questPosting?.rejected.length ? `

⚠️ 委託未成立：${questPosting.rejected.join('；')}。` : '';
      if (nextPlayer.isDead) nextPlayer = { ...nextPlayer, encounteredUnitId: undefined };
      const requestedEncounter = aiResponse.encounterRequest?.unitId;
      const requestedUnit = requestedEncounter ? getWorldUnitById(requestedEncounter) : undefined;
      const encounterUnit = requestedUnit?.requiresEncounter ? requestedUnit : undefined;
      const currentMap = getMapById(player.currentMapId);
      const encounterAllowed = !nextPlayer.combat && !nextPlayer.isDead && canPlayerAct(nextPlayer) && !!currentMap && !currentMap.isSafeZone &&
        !!encounterUnit && encounterUnit.mapIds.includes(currentMap.id) && currentMap.unitsPresent.includes(encounterUnit.id) &&
        (!encounterUnit.requiredQuestId || nextPlayer.activeQuests.some((quest) => quest.questId === encounterUnit.requiredQuestId && quest.status === 'in_progress'));
      const encounterNotice = encounterAllowed && encounterUnit
        ? `\n\n👁️ 遭遇：${encounterUnit.name}。已加入 HUD，可從右側開始戰鬥。`
        : '';
      if (encounterAllowed && encounterUnit) nextPlayer = { ...nextPlayer, encounteredUnitId: encounterUnit.id };
      const deathNotice = !player.isDead && nextPlayer.isDead
        ? '\n\n☠️ 你的生命值降至 0，角色死亡。可讀取死亡前的自動存檔重新嘗試。'
        : '';
      const acceptedQuests = nextPlayer.activeQuests.filter((entry) => entry.status === 'in_progress' &&
        !player.activeQuests.some((previous) => previous.questId === entry.questId));
      const questNotice = acceptedQuests.length
        ? `\n\n📜 已接取任務「${acceptedQuests.map((entry) => findQuest(nextPlayer, entry.questId)?.title ?? entry.questId).join('、')}」。`
        : '';
      const completedQuests = nextPlayer.activeQuests.filter((entry) => entry.status === 'completed' &&
        player.activeQuests.some((previous) => previous.questId === entry.questId && previous.status === 'in_progress'));
      const rewardRecords = nextPlayer.transactionHistory.filter((record) =>
        record.type === 'quest_reward' && !player.transactionHistory.some((previous) => previous.id === record.id));
      const questCompletionNotice = completedQuests.length
        ? `\n\n✅ ${completedQuests.map((entry) => {
          const title = findQuest(nextPlayer, entry.questId)?.title ?? entry.questId;
          const reward = rewardRecords.find((record) => record.description.includes(title));
          return reward?.description ?? `任務「${title}」已完成。`;
        }).join('\n')}`
        : '';
      const newUnitTransfers = nextPlayer.transactionHistory.filter((record) => record.type === 'unit_transfer' &&
        !player.transactionHistory.some((previous) => previous.id === record.id));
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
        getWorldUnitDisposition(player, change.unitId) !== change.disposition
      );
      const unitDispositionNotice = appliedRelationChanges.length
        ? `\n\n🤝 關係變化：${appliedRelationChanges.map((change) => `${getWorldUnitById(change.unitId)?.name ?? change.unitId} 對你的態度變為${relationLabels[change.disposition]}。`).join('')}`
        : '';

      const textTravelIntent = resolveExplicitTravelIntent(actionText, player);
      const requestedDestinationId = textTravelIntent.kind === 'resolved'
        ? textTravelIntent.destination.id
        : textTravelIntent.kind === 'ambiguous'
          ? undefined
          : aiResponse.travelRequest?.destinationMapId;
      const travel = requestedDestinationId ? movePlayerTo(requestedDestinationId, nextPlayer) : null;
      // 服務請求以與 HUD 相同的規則結算（含扣款轉帳、恢復與固定耗時）；同回合移動時不處理服務。
      // 只處理指向目前地區實際服務的請求；佔位或不存在的 ID 視為沒有請求，不顯示失敗訊息。
      const requestedService = !travel && aiResponse.serviceRequest && getAvailableServices(player).some((service) =>
        service.shopId === aiResponse.serviceRequest?.shopId && service.serviceId === aiResponse.serviceRequest?.serviceId)
        ? aiResponse.serviceRequest : undefined;
      const requestedShop = requestedService ? getShopById(requestedService.shopId) : undefined;
      const serviceResult = requestedService && requestedShop ? purchaseService(nextPlayer, requestedShop, requestedService.serviceId, nextPlayer.currentMapId) : undefined;
      const serviceName = requestedShop?.services?.find((service) => service.id === requestedService?.serviceId)?.name ?? '服務';
      nextPlayer = travel ? travel.player : serviceResult?.ok ? serviceResult.player : advanceGameTime(nextPlayer, 'dialogue');
      const serviceNotice = !requestedService ? ''
        : serviceResult?.ok
          ? `\n\n🛏️ 使用${serviceName}，支付 ${serviceResult.totalPrice} 金幣，經過 ${formatDuration(ACTION_DURATIONS.rest)}，生命與魔力已恢復。`
          : `\n\n⚠️ ${serviceName}未完成：${serviceResult && !serviceResult.ok ? serviceResult.reason : '找不到這項服務。'}`;
      updatePlayer(nextPlayer, nextPlayer.isDead && !player.isDead
        ? { [player.unitId]: { cause: isSelfDamageIntent(actionText) ? 'self_inflicted' : 'misadventure', note: checkResult?.reason } }
        : undefined);

      const previousMap = getMapById(player.currentMapId);
      const nextMap = getMapById(nextPlayer.currentMapId);
      const locationNotice = travel
        ? `\n\n📍 你已抵達${travel.destination.name}。${travel.destination.description}`
        : textTravelIntent.kind === 'ambiguous'
          ? `\n\n📍 你想前往的地區有多個可能地點，請選擇目的地：`
          : requestedDestinationId
          ? `\n\n⚠️ 目前無法前往「${getMapById(requestedDestinationId)?.name ?? requestedDestinationId}」，所在地區未變更。請選擇右側「鄰近地點」中的可前往區域。`
          : storyClaimsPlayerMoved(storyText, player.currentMapId)
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
        deathActions={player.isDead ? { onLoadAutoSave: handleLoadAutoSave, onOpenSaveManager: () => setIsSaveManagerOpen(true) } : undefined}
      />
      {isSidebarOpen && <PlayerHUD player={player} onOpenSaveManager={() => setIsSaveManagerOpen(true)} storageWarning={storageWarning || autosaveFailed} onTravel={handleTravel} onAcceptQuest={handleAcceptQuest} onTurnInQuest={handleTurnInQuest} onStartCombat={handleStartCombat} onFleeCombat={handleFleeCombat} onAttack={handleAttack} onUseSkill={handleUseSkill} onUseItem={handleUseItem} onBuyItem={handleBuyItem} onSellItem={handleSellItem} onEquipItem={handleEquipItem} onUseService={handleUseService} />}
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
