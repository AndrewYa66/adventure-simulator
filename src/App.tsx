import { useEffect, useState } from 'react';
import type { ActionCheckResult, PlayerGrowthStatic, PlayerState, StoryMessage, WorldUnitStatic } from './types/game';
import { loadGameSession, resetPlayerState, saveGameSession } from './utils/playerStorage';
import { applyStateChanges } from './utils/applyStateChanges';
import { canPlayerEnterMap, getCharacterClassById, getItemById, getMapById, getPlayerResourceCaps, getQuestById, getShopById, getUnlockedSkillsByLevel, getWorldUnitById, getWorldUnitDisposition, getWorldUnitsAtMap, itemsDatabase } from './data/staticData';
import { getPlayerStatBreakdown, resolveActionCheck } from './utils/gameChecks';
import { resolveExplicitTravelIntent, storyClaimsPlayerMoved } from './utils/travelIntent';
import { sendPlayerAction } from './services/aiService';
import { acceptQuest, canTurnInQuest } from './utils/questRules';
import { canPlayerAct, isPlayerUnconscious } from './utils/playerStatus';
import type { AIProvider } from './services/aiModels';
import { loadAIModelSettings, saveAIModelSettings, type AIModelSettings } from './services/aiModels';
import { PlayerHUD } from './components/PlayerHUD';
import { StoryLog } from './components/StoryLog';
import { ApiKeyModal } from './components/ApiKeyModal';
import { CharacterSetup } from './components/CharacterSetup';
import { createInitialPlayer } from './utils/playerInit';
import { isSelfDamageIntent, parseExplicitSelfDamage, unsupportedInventoryItemRequested } from './utils/playerActionIntent';
import { buyItem, purchaseService, sellItem } from './utils/tradeRules';
import type { CharacterAlignment } from './types/game';

function withNpcHp(player: PlayerState, npcId: string, currentHp: number, isDead = false): PlayerState {
  const state = player.npcStates[npcId];
  return { ...player, npcStates: { ...player.npcStates, [npcId]: { ...state, currentHp, isDead } } };
}

function resolveEnemyTurn(player: PlayerState, combat: NonNullable<PlayerState['combat']>, unit: WorldUnitStatic) {
  const monster = unit.kind === 'monster' ? unit.source : undefined;
  const special = monster?.specialAbilities.find((ability) => ability.combatAction && combat.round % ability.combatAction.triggerEveryRounds === 0);
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
  const nextPlayer: PlayerState = {
    ...player, hp, isDead, statusEffects,
    ...(isDead ? { encounteredUnitId: undefined, encounteredMonsterId: undefined } : {}),
    ...(isDead ? { combat: undefined } : { combat: { ...combat, round: combat.round + 1 } })
  };
  const result = check.success
    ? action ? `你成功閃過${special?.name}。` : `你成功閃避${unit.name}的反擊。`
    : `${action ? `${special?.name}命中` : `${unit.name}反擊命中`}，你受到 ${damage} 點傷害。${unconsciousTurns ? `你陷入昏迷 ${unconsciousTurns} 回合。` : ''}`;
  return { player: nextPlayer, check, text: `${result}${isDead ? '\n☠️ HP 歸零，你已死亡。' : `\n第 ${combat.round + 1} 回合開始。`}` };
}

function createRestoreNotice(player: PlayerState, savedAt: number, messageCount: number): StoryMessage {
  const map = getMapById(player.currentMapId);
  const combatUnit = player.combat ? getWorldUnitById(player.combat.unitId) : undefined;
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
  if (combatUnit && player.combat) lines.push(`戰鬥恢復：第 ${player.combat.round} 回合，${combatUnit.name} HP ${player.combat.currentHp}/${combatUnit.stats.hp}`);
  else if (player.encounteredUnitId) lines.push(`已遭遇單位：${getWorldUnitById(player.encounteredUnitId)?.name ?? player.encounteredUnitId}（可從 HUD 發起戰鬥）`);
  else lines.push('戰鬥狀態：目前沒有進行中的戰鬥，也尚未遭遇敵人。');
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
    const nextPlayer = { ...sourcePlayer, previousMapId: sourcePlayer.currentMapId, currentMapId: destination.id, encounteredMonsterId: undefined, encounteredUnitId: undefined };
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

  const handleTurnInQuest = (questId: string) => {
    const quest = getQuestById(questId);
    if (!quest || !canTurnInQuest(player, quest)) return;
    const nextPlayer = applyStateChanges(player, {
      storyText: '', suggestedActions: [], stateChanges: { questUpdates: [{ questId, status: 'completed' }] }
    }, 'game');
    updatePlayer(nextPlayer);
    const rewardRecord = nextPlayer.transactionHistory.find((record) => record.type === 'quest_reward' &&
      !player.transactionHistory.some((previous) => previous.id === record.id));
    appendSystemMessage(rewardRecord?.description ?? `已向${quest.questGiver}交付任務「${quest.title}」。`);
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
    updatePlayer(result.player);
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
    updatePlayer(result.player);
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
    appendSystemMessage(`使用${service?.name ?? '服務'}，支付 ${result.totalPrice} 金幣，生命與魔力已恢復。服務時間將於時間系統實作後納入處理。`);
  };

  const handleEquipItem = (itemId: string) => {
    const item = getItemById(itemId);
    const owned = player.inventory.some((entry) => entry.itemId === itemId && entry.quantity > 0);
    if (!item || !owned || !canPlayerAct(player) || player.combat) return;
    const slot = item.type === 'weapon' ? 'weaponItemId' : item.type === 'armor' ? 'armorItemId' : item.type === 'accessory' ? 'accessoryItemId' : undefined;
    if (!slot) return;
    updatePlayer({ ...player, equipped: { ...player.equipped, [slot]: itemId } });
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
    const unit = getWorldUnitById(unitId);
    const present = unit?.mapIds.includes(player.currentMapId) && (unit.kind === 'npc' ? map?.npcsPresent.includes(unitId) : map?.monstersPresent.includes(unitId));
    const monster = unit?.kind === 'monster' ? unit.source : undefined;
    const npcState = unit?.kind === 'npc' ? player.npcStates[unit.id] : undefined;
    if (player.combat || !canPlayerAct(player) || !map || !unit || !present || getWorldUnitDisposition(player, unitId) !== 'hostile' ||
        (unit.kind === 'monster' && (map.isSafeZone || player.encounteredUnitId !== unitId || (monster?.requiredQuestId && !player.activeQuests.some((quest) => quest.questId === monster.requiredQuestId && quest.status === 'in_progress')))) ||
        (unit.kind === 'npc' && (npcState?.isDead || npcState?.currentHp === 0))) return;
    const currentHp = unit.kind === 'npc' ? npcState?.currentHp ?? unit.stats.hp : unit.stats.hp;
    updatePlayer({ ...player, encounteredUnitId: unitId, combat: { unitId, currentHp, round: 1 } });
    appendSystemMessage(`你與${unit.name}進入戰鬥！攻擊、已解鎖技能及消耗品各自消耗一個行動回合；敵人存活時會反擊並進行閃避檢定。`);
  };

  const handleFleeCombat = () => {
    if (!player.combat || !canPlayerAct(player)) return;
    const combatUnit = getWorldUnitById(player.combat.unitId);
    const outOfCombat = { ...player };
    delete outOfCombat.combat;
    delete outOfCombat.encounteredMonsterId;
    delete outOfCombat.encounteredUnitId;
    updatePlayer(outOfCombat);
    appendSystemMessage(`你與${combatUnit?.name ?? '敵人'}拉開距離，戰鬥結束。`);
  };

  const handleCombatAction = (skill?: NonNullable<PlayerGrowthStatic['unlockedSkill']>, sourcePlayer: PlayerState = player) => {
    const combat = sourcePlayer.combat;
    const unit = combat ? getWorldUnitById(combat.unitId) : undefined;
    if (!combat || !unit || sourcePlayer.isDead) return;
    if (isPlayerUnconscious(sourcePlayer)) {
      const recovered = { ...sourcePlayer, statusEffects: sourcePlayer.statusEffects.filter((effect) => effect.id !== 'unconscious'), combat: { ...combat } };
      const enemyTurn = resolveEnemyTurn(recovered, combat, unit);
      updatePlayer(enemyTurn.player);
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
    const monsterHp = attackCheck.success
      ? Math.max(0, combat.currentHp - damage)
      : combat.currentHp;
    const attackText = attackCheck.success
      ? `${skill?.name ?? '攻擊'}命中，對${unit.name}造成 ${damage} 點傷害。`
      : `${skill?.name ?? '攻擊'}未命中${unit.name}。`;
    const actionPlayer = skill ? { ...sourcePlayer, mp: sourcePlayer.mp - skill.costMp } : sourcePlayer;
    const combatActionPlayer = unit.kind === 'npc' ? withNpcHp(actionPlayer, unit.id, monsterHp, monsterHp <= 0) : actionPlayer;

    if (monsterHp <= 0 && unit.kind === 'monster') {
      const monster = unit.source;
      const dropItems = monster.rewards.dropItems.flatMap((drop) => {
        if (!globalThis.crypto?.getRandomValues) return [];
        const roll = new Uint32Array(1);
        globalThis.crypto.getRandomValues(roll);
        return roll[0] / 0x1_0000_0000 < drop.chance ? [{ itemId: drop.itemId, quantity: 1 }] : [];
      });
      const questUpdates = sourcePlayer.activeQuests.filter((quest) => quest.status === 'in_progress')
        .map((quest) => ({ questId: quest.questId, status: 'completed' as const }));
      const nextPlayer = applyStateChanges(combatActionPlayer, {
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
        sourcePlayer.activeQuests.some((previous) => previous.questId === quest.questId && previous.status === 'in_progress'));
      const dropText = dropItems.length ? `取得掉落物：${dropItems.map((item) => `${getItemById(item.itemId)?.name ?? item.itemId} ×${item.quantity}`).join('、')}。` : '沒有掉落物。';
      const questText = completedQuests.map((quest) => `任務「${getQuestById(quest.questId)?.title ?? quest.questId}」完成，需求道具已交付並領取獎勵。`).join('\n');
      const victoryState = { ...nextPlayer };
      delete victoryState.combat;
      delete victoryState.encounteredMonsterId;
      delete victoryState.encounteredUnitId;
      updatePlayer(victoryState);
      appendSystemMessage(`🏆 ${attackText}\n${monster.name}已被擊敗！獲得 ${monster.rewards.exp} EXP、${monster.rewards.gold} 金幣。${dropText}${questText ? `\n${questText}` : ''}`, checks);
      return;
    }

    if (monsterHp <= 0 && unit.kind === 'npc') {
      const victoryState = { ...combatActionPlayer };
      delete victoryState.combat;
      delete victoryState.encounteredMonsterId;
      delete victoryState.encounteredUnitId;
      updatePlayer(victoryState);
      appendSystemMessage(`⚔️ ${attackText}\n${unit.name}已被擊倒，不會掉落經驗、金幣或道具。`, checks);
      return;
    }

    const enemyTurn = resolveEnemyTurn({ ...combatActionPlayer, combat: { ...combat, currentHp: monsterHp } }, { ...combat, currentHp: monsterHp }, unit);
    updatePlayer(enemyTurn.player);
    appendSystemMessage(`${attackText}\n${enemyTurn.text}`, [...checks, enemyTurn.check]);
  };

  const handleAttack = () => handleCombatAction();

  const handleUseSkill = (skillId: string) => {
    const skill = getUnlockedSkillsByLevel(player.level).find((entry) => entry.id === skillId);
    if (!skill || !canPlayerAct(player) || player.mp < skill.costMp) return;
    if (skill.effect.kind === 'healing') {
      if (player.combat) return;
      const caps = getPlayerResourceCaps(player.level, player.classId);
      const restored = Math.min(skill.effect.hpRestore, Math.max(0, caps.maxHp - player.hp));
      if (restored <= 0) {
        appendSystemMessage(`${skill.name}目前無法恢復 HP，沒有消耗 MP。`);
        return;
      }
      const nextPlayer = applyStateChanges(player, {
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

    const combatUnit = getWorldUnitById(player.combat.unitId);
    if (!combatUnit) return;
    const combatNext = combatUnit.kind === 'npc' ? withNpcHp(next, combatUnit.id, player.combat.currentHp) : next;
    const enemyTurn = resolveEnemyTurn({ ...combatNext, combat: player.combat }, player.combat, combatUnit);
    updatePlayer(enemyTurn.player);
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
      const available = getWorldUnitsAtMap(player.currentMapId).filter((unit) => unit.kind === 'monster' || !player.npcStates[unit.id]?.isDead);
      const matched = available.filter((unit) => actionText.includes(unit.name) || actionText.includes(unit.id) || (unit.kind === 'monster' && actionText.toLowerCase().includes(unit.source.enName.toLowerCase())));
      const encountered = player.encounteredUnitId ? getWorldUnitById(player.encounteredUnitId) : undefined;
      const target = matched.length === 1 ? matched[0] : matched.length === 0 ? encountered : undefined;
      const userMessage: StoryMessage = { id: `${Date.now()}-user`, sender: 'user', text: actionText, timestamp: new Date().toLocaleTimeString() };
      if (!player.combat && (!map || !target)) {
        const text = !map ? '目前地區資料不存在。' : matched.length > 1 ? `請指定攻擊對象：${matched.map((unit) => unit.name).join('、')}。` : '你目前尚未遭遇敵人，也沒有指定在場人物。請先探索或明確指定當前地區的目標。';
        setMessages((prev) => [...prev, userMessage, { id: `${Date.now()}-combat`, sender: 'system', text, timestamp: new Date().toLocaleTimeString() }]);
        return;
      }
      if (!player.combat && target?.kind === 'monster' && map?.isSafeZone) {
        setMessages((prev) => [...prev, userMessage, { id: `${Date.now()}-combat`, sender: 'system', text: '安全地區不會發生魔物戰鬥。', timestamp: new Date().toLocaleTimeString() }]);
        return;
      }
      if (player.combat && matched.length === 1 && matched[0].id !== player.combat.unitId) {
        const currentUnit = getWorldUnitById(player.combat.unitId);
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
        if (target.kind === 'monster' && player.encounteredUnitId !== target.id) {
          appendSystemMessage(`你尚未遭遇${target.name}；請先探索，等實際遭遇後再攻擊。`);
          return;
        }
        const currentHp = target.kind === 'npc' ? provokedPlayer.npcStates[target.id]?.currentHp ?? target.stats.hp : target.stats.hp;
        const combatPlayer: PlayerState = { ...provokedPlayer, encounteredUnitId: target.id, combat: { unitId: target.id, currentHp, round: 1 } };
        appendSystemMessage(`你${provokedPlayer === player ? '與' : '激怒並與'}已遭遇的${target.name}進入戰鬥！`);
        handleCombatAction(undefined, combatPlayer);
      } else if (player.combat) handleCombatAction();
      return;
    }

    if (player.combat || !canPlayerAct(player)) {
      appendSystemMessage(player.isDead ? '角色已死亡，無法繼續行動。請重設角色開始新的冒險。' : '角色目前昏迷，無法採取行動。');
      return;
    }
    const explicitSelfDamage = parseExplicitSelfDamage(actionText);
    if (explicitSelfDamage !== undefined) {
      const actualDamage = Math.min(player.hp, explicitSelfDamage);
      const nextPlayer = applyStateChanges(player, {
        storyText: '', suggestedActions: [], stateChanges: { hpChange: -actualDamage }
      }, 'game');
      updatePlayer(nextPlayer);
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
    const unsupportedItem = unsupportedInventoryItemRequested(actionText);
    if (unsupportedItem) {
      setMessages((prev) => [...prev,
        { id: `${Date.now()}-user`, sender: 'user', text: actionText, timestamp: new Date().toLocaleTimeString() },
        { id: `${Date.now()}-item`, sender: 'system', text: `世界物品資料中沒有「${unsupportedItem}」，角色不能憑空取出、使用或裝備。請先從商店或遊戲內容取得已存在的物品。`, timestamp: new Date().toLocaleTimeString() }
      ]);
      return;
    }
    const requestedSkill = getUnlockedSkillsByLevel(player.level).find((skill) =>
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
      const caps = getPlayerResourceCaps(player.level, player.classId);
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
      updatePlayer(applyStateChanges(player, {
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
      }
      if (nextPlayer.isDead) nextPlayer = { ...nextPlayer, encounteredMonsterId: undefined, encounteredUnitId: undefined };
      const requestedEncounter = aiResponse.encounterRequest?.monsterId;
      const requestedUnit = requestedEncounter ? getWorldUnitById(requestedEncounter) : undefined;
      const requestedMonster = requestedUnit?.kind === 'monster' ? requestedUnit : undefined;
      const currentMap = getMapById(player.currentMapId);
      const encounterAllowed = !nextPlayer.combat && !nextPlayer.isDead && canPlayerAct(nextPlayer) && !!currentMap && !currentMap.isSafeZone &&
        !!requestedMonster && requestedMonster.mapIds.includes(currentMap.id) && currentMap.monstersPresent.includes(requestedMonster.id) &&
        (!requestedMonster.source.requiredQuestId || nextPlayer.activeQuests.some((quest) => quest.questId === requestedMonster.source.requiredQuestId && quest.status === 'in_progress'));
      const encounterNotice = encounterAllowed && requestedMonster
        ? `\n\n👁️ 遭遇：${requestedMonster.name}。已加入 HUD，可從右側開始戰鬥。`
        : '';
      if (encounterAllowed && requestedMonster) nextPlayer = { ...nextPlayer, encounteredUnitId: requestedMonster.id };
      const deathNotice = !player.isDead && nextPlayer.isDead
        ? '\n\n☠️ 你的生命值降至 0，角色死亡。這段冒險已結束。'
        : '';
      const acceptedQuests = nextPlayer.activeQuests.filter((entry) => entry.status === 'in_progress' &&
        !player.activeQuests.some((previous) => previous.questId === entry.questId));
      const questNotice = acceptedQuests.length
        ? `\n\n📜 已接取任務「${acceptedQuests.map((entry) => getQuestById(entry.questId)?.title ?? entry.questId).join('、')}」。`
        : '';
      const completedQuests = nextPlayer.activeQuests.filter((entry) => entry.status === 'completed' &&
        player.activeQuests.some((previous) => previous.questId === entry.questId && previous.status === 'in_progress'));
      const rewardRecords = nextPlayer.transactionHistory.filter((record) =>
        record.type === 'quest_reward' && !player.transactionHistory.some((previous) => previous.id === record.id));
      const questCompletionNotice = completedQuests.length
        ? `\n\n✅ ${completedQuests.map((entry) => {
          const title = getQuestById(entry.questId)?.title ?? entry.questId;
          const reward = rewardRecords.find((record) => record.description.includes(title));
          return reward?.description ?? `任務「${title}」已完成。`;
        }).join('\n')}`
        : '';
      const newNpcTransfers = nextPlayer.transactionHistory.filter((record) => record.type === 'npc_transfer' &&
        !player.transactionHistory.some((previous) => previous.id === record.id));
      const requestedNpcTransfers = resultToApply.stateChanges?.npcItemTransfers?.length ?? 0;
      const successfulNpcTransfers = newNpcTransfers.filter((record) => record.description.startsWith('從 '));
      const npcTransferNotice = successfulNpcTransfers.length || successfulNpcTransfers.length < requestedNpcTransfers
        ? `\n\n📦 ${[
          ...successfulNpcTransfers.map((record) => record.description),
          ...(successfulNpcTransfers.length < requestedNpcTransfers ? ['NPC 不在場或持有物不足，未能取得敘事中提及的全部物品。'] : [])
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
      if (travel) nextPlayer = travel.player;
      updatePlayer(nextPlayer);

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
          text: `${storyText}${questNotice}${questCompletionNotice}${npcTransferNotice}${unitDispositionNotice}${encounterNotice}${locationNotice}${deathNotice}`,
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
      {isSidebarOpen && <PlayerHUD player={player} onReset={handleResetPlayer} storageWarning={storageWarning} onTravel={handleTravel} onAcceptQuest={handleAcceptQuest} onTurnInQuest={handleTurnInQuest} onStartCombat={handleStartCombat} onFleeCombat={handleFleeCombat} onAttack={handleAttack} onUseSkill={handleUseSkill} onUseItem={handleUseItem} onBuyItem={handleBuyItem} onSellItem={handleSellItem} onEquipItem={handleEquipItem} onUseService={handleUseService} />}
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
