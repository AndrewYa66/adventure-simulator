import type { ActionCheckResult, CombatOpening, PlayerState, SkillStatic, WorldUnitStatic } from '../types/game';
import { combatRules, getActionMethod, getItemById, getMapById, getWorldUnitById, getWorldUnitDisposition, scenario } from '../data/staticData';
import { getPlayerStatBreakdown, resolveActionCheck } from './gameChecks';
import { applyStateChanges } from './applyStateChanges';
import { grantUnitExp } from './unitProgress';
import { getPlayerWorldUnit } from './worldUnits';
import { createCombat, getCombatTarget, setEnemyHp } from './combatState';
import { advanceGameTime, waitGameTime, formatDuration, formatGameTime } from './gameTime';
import { findQuest } from './questRules';
import { clearEncounter, expireEncounter, findAggressiveResident, getAmbushableUnit, rollOpposedCheck, rollPerception, setEncounter } from './encounters';
import { canPlayerAct } from './playerStatus';
import type { AIResponsePayload } from '../types/game';
import { rollWaitInterruption } from './waitRules';
import type { DeathHint } from './worldEvents';

/**
 * 戰鬥結算（O45 從 App 移出）：玩家攻擊、敵方回合、逃跑，以及開戰方式（一般、伏擊、陷阱、敵方偷襲）。
 * 全部是純函式，回傳結算後的狀態、檢定與給玩家看的文字；套用與訊息由呼叫端處理。
 */
export interface CombatStepResult {
  player: PlayerState;
  checks: ActionCheckResult[];
  text: string;
  deathHints?: Record<string, DeathHint>;
  /** 擊倒對手（戰鬥結束）。 */
  victory?: boolean;
}

export const OPENING_LABELS: Record<CombatOpening, string> = {
  normal: '一般開戰（你先攻）',
  player_ambush: '伏擊成功（你先手）',
  trap: '陷阱命中（你先手）',
  enemy_ambush: '遭到偷襲（敵方先攻）'
};

export function withUnitHp(player: PlayerState, unitId: string, currentHp: number, isDead = false): PlayerState {
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

/**
 * 敵方回合：敵人攻擊，玩家閃避（或抵抗特殊能力）。
 * openingStrike 為 true 時是敵方偷襲的先攻一擊（D7）：一般反擊公式、不觸發特殊能力，回合數不增加。
 */
export function resolveEnemyTurn(player: PlayerState, combat: NonNullable<PlayerState['combat']>, unit: WorldUnitStatic, openingStrike = false): CombatStepResult {
  const special = openingStrike ? undefined : unit.specialAbilities?.find((ability) => ability.combatAction && combat.round % ability.combatAction.triggerEveryRounds === 0);
  const action = special?.combatAction;
  const checkStat = action?.checkStat ?? 'def';
  const dc = action?.dc ?? 10 + Math.floor(unit.stats.atk / 2);
  const check = {
    ...resolveActionCheck(player, checkStat, dc),
    stat: checkStat,
    reason: action ? `${unit.name}施放${special?.name}：玩家進行${checkStat === 'dex' ? '閃避' : '抵抗'}檢定` : openingStrike ? `${unit.name}偷襲：玩家進行閃避檢定` : `${unit.name}反擊：玩家進行閃避檢定`,
    label: action ? `${special?.name}檢定` : '玩家閃避檢定'
  } satisfies ActionCheckResult;
  const damage = check.success ? 0 : getEnemyHitDamage(player, unit, action?.damageMultiplier ?? 1);
  const hp = Math.max(0, player.hp - damage);
  const isDead = hp <= 0;
  const unconsciousTurns = !isDead && !check.success ? action?.applyUnconsciousTurnsOnFailure ?? 0 : 0;
  const statusEffects = player.statusEffects.filter((effect) => effect.id !== 'unconscious');
  if (unconsciousTurns > 0) statusEffects.push({ id: 'unconscious', remainingTurns: unconsciousTurns });
  // 擊倒玩家的單位依同一規則獲得玩家的擊倒經驗，並可能升級。
  const victorGrowth = isDead ? grantUnitExp(player.unitInstances, unit.id, getPlayerWorldUnit(player).expReward, player.world) : undefined;
  const deathHints: Record<string, DeathHint> = isDead ? { [player.unitId]: { cause: 'combat', killerUnitId: unit.id } } : {};
  // 敵方偷襲以第 0 回合表示先攻一擊，結算後同樣進入下一回合（第 1 回合）。
  const nextRound = combat.round + 1;
  const base: PlayerState = {
    ...player, hp, isDead, statusEffects,
    ...(victorGrowth ? { unitInstances: victorGrowth.instances } : {}),
    ...(isDead ? { combat: undefined } : { combat: { ...combat, round: nextRound } })
  };
  const nextPlayer = isDead ? clearEncounter(base) : base;
  const verb = openingStrike ? '偷襲' : '反擊';
  const result = check.success
    ? action ? `你成功閃過${special?.name}。` : `你成功閃避${unit.name}的${verb}。`
    : `${action ? `${special?.name}命中` : `${unit.name}${verb}命中`}，你受到 ${damage} 點傷害。${unconsciousTurns ? `你陷入昏迷 ${unconsciousTurns} 回合。` : ''}`;
  const victorLevelText = victorGrowth && victorGrowth.level > victorGrowth.previousLevel ? `\n📈 ${unit.name}升至 Lv.${victorGrowth.level}。` : '';
  return { player: nextPlayer, checks: [check], deathHints, text: `${result}${isDead ? `\n☠️ HP 歸零，你已死亡。${victorLevelText}` : `\n第 ${nextRound} 回合開始。`}` };
}

/** 敵方一擊的傷害（一般公式）：敵方攻擊 × 倍率 − 玩家防禦的四分之一，至少 1。 */
export function getEnemyHitDamage(player: PlayerState, unit: WorldUnitStatic, multiplier = 1): number {
  return Math.max(1, Math.floor(unit.stats.atk * multiplier) - Math.floor(getPlayerStatBreakdown(player, 'def').statValue / 4));
}

/** 擊倒對手：取得持有物、擲掉落、給經驗、記入擊倒數與任務進度，戰鬥與遭遇結束。 */
function resolveVictory(sourcePlayer: PlayerState, actionPlayer: PlayerState, unit: WorldUnitStatic, attackText: string, checks: ActionCheckResult[], prefix: string): CombatStepResult {
  const looted = takeHoldings(actionPlayer, unit.id, unit.name);
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
    stateChanges: { expChange: expGain, goldChange: lootGold, addItems: dropItems, defeatedUnits: [{ unitId: unit.id, quantity: 1 }], questUpdates }
  }, 'game');
  const completedQuests = nextPlayer.activeQuests.filter((quest) => quest.status === 'completed' &&
    sourcePlayer.activeQuests.some((previous) => previous.questId === quest.questId && previous.status === 'in_progress'));
  // 唯一個體擊倒即永久死亡（寫入死亡事件）；族群樣板代表一群個體，不會因單次擊倒而消失。
  const victoryState = clearEncounter(unit.population ? { ...nextPlayer } : withUnitHp(nextPlayer, unit.id, 0, true));
  delete victoryState.combat;
  const gains = [
    expGain > 0 ? `${expGain} EXP` : '',
    lootGold + looted.gold > 0 ? `${lootGold + looted.gold} 金幣` : '',
    ...[...looted.loot, ...dropItems].map((item) => `${getItemById(item.itemId)?.name ?? item.itemId} ×${item.quantity}`)
  ].filter(Boolean);
  const levelText = nextPlayer.level > looted.player.level ? ` 📈 升至 Lv.${nextPlayer.level}！` : '';
  const questText = completedQuests.map((quest) => `任務「${findQuest(sourcePlayer, quest.questId)?.title ?? quest.questId}」完成，需求道具已交付並領取獎勵。`).join('\n');
  return {
    player: victoryState,
    checks,
    victory: true,
    deathHints: { [unit.id]: { cause: 'combat', killerUnitId: sourcePlayer.unitId } },
    text: `${prefix}${unit.isBoss ? '🏆' : '⚔️'} ${attackText}\n${unit.name}已被擊倒！${gains.length ? `獲得 ${gains.join('、')}。` : '沒有獲得任何東西。'}${expGain > 0 ? '' : '（不會獲得經驗）'}${levelText}${questText ? `\n${questText}` : ''}`
  };
}

export interface PlayerAttackOptions {
  skill?: SkillStatic;
  /** 開場第一擊（伏擊、陷阱成功）：必中、傷害乘以倍率、敵人本回合不反擊。 */
  firstStrikeMultiplier?: number;
  /** 附在結果前的文字（例如伏擊檢定說明）。 */
  prefix?: string;
  /** 附在結果前的檢定（例如伏擊檢定）。 */
  prefixChecks?: ActionCheckResult[];
}

/** 玩家攻擊（含技能）：命中檢定、傷害、擊倒結算；未擊倒時敵人反擊（開場第一擊除外）。 */
export function resolvePlayerAttack(sourcePlayer: PlayerState, options: PlayerAttackOptions = {}): CombatStepResult | undefined {
  const combat = sourcePlayer.combat;
  const target = combat ? getCombatTarget(combat) : undefined;
  const unit = target ? getWorldUnitById(target.unitId, sourcePlayer) : undefined;
  if (!combat || !target || !unit || sourcePlayer.isDead) return undefined;
  const { skill, firstStrikeMultiplier } = options;
  const prefix = options.prefix ?? '';
  const prefixChecks = options.prefixChecks ?? [];
  const firstStrike = firstStrikeMultiplier !== undefined;
  const checks: ActionCheckResult[] = [...prefixChecks];
  let hit = true;
  if (!firstStrike) {
    const attackCheck = {
      ...resolveActionCheck(sourcePlayer, 'atk', 10 + unit.stats.def),
      stat: 'atk' as const,
      reason: `第 ${combat.round} 回合：${skill?.name ?? '攻擊'}${unit.name}`,
      label: '玩家攻擊檢定'
    };
    checks.push(attackCheck);
    hit = attackCheck.success;
  }
  const playerAttack = getPlayerStatBreakdown(sourcePlayer, 'atk').statValue;
  const skillMultiplier = skill?.effect.kind === 'damage_multiplier' ? skill.effect.multiplier : 1;
  const baseDamage = Math.max(1, Math.floor(playerAttack * skillMultiplier) - unit.stats.def);
  const damage = hit ? (firstStrike ? Math.max(1, Math.floor(baseDamage * firstStrikeMultiplier)) : baseDamage) : 0;
  const targetHp = hit ? Math.max(0, target.currentHp - damage) : target.currentHp;
  const attackName = firstStrike ? '先手一擊' : skill?.name ?? '攻擊';
  const attackText = hit ? `${attackName}命中，對${unit.name}造成 ${damage} 點傷害。` : `${attackName}未命中${unit.name}。`;
  // 開場第一擊不另計時間（開戰行動本身已計時）。
  const timedPlayer = firstStrike ? sourcePlayer : advanceGameTime(sourcePlayer, 'combatRound');
  const actionPlayer = skill ? { ...timedPlayer, mp: timedPlayer.mp - skill.costMp } : timedPlayer;
  const combatActionPlayer = unit.requiresEncounter ? actionPlayer : withUnitHp(actionPlayer, unit.id, targetHp, targetHp <= 0);

  if (targetHp <= 0) return resolveVictory(sourcePlayer, combatActionPlayer, unit, attackText, checks, prefix);

  const nextCombat = setEnemyHp(combat, unit.id, targetHp);
  if (firstStrike) {
    return { player: { ...combatActionPlayer, combat: nextCombat }, checks, text: `${prefix}${attackText}\n${unit.name}來不及反擊。第 ${combat.round} 回合開始。` };
  }
  const enemyTurn = resolveEnemyTurn({ ...combatActionPlayer, combat: nextCombat }, nextCombat, unit);
  return { ...enemyTurn, checks: [...checks, ...enemyTurn.checks], text: `${prefix}${attackText}\n${enemyTurn.text}` };
}

/** 逃跑（D8）：速度檢定，DC = dcBase ＋ 敵方 SPD ÷ divisor（捨去）；失敗浪費回合、敵人反擊。 */
export function resolveFlee(player: PlayerState): CombatStepResult | undefined {
  const combat = player.combat;
  const target = combat ? getCombatTarget(combat) : undefined;
  const unit = target ? getWorldUnitById(target.unitId, player) : undefined;
  if (!combat || !unit) return undefined;
  const rule = combatRules.flee;
  const dc = rule.dcBase + Math.floor(unit.stats.spd / rule.opponentSpdDivisor);
  const check: ActionCheckResult = { ...resolveActionCheck(player, rule.stat, dc), stat: rule.stat, reason: `從${unit.name}身邊逃跑`, label: '逃跑檢定' };
  const timed = advanceGameTime(player, 'combatRound');
  if (check.success) {
    const outOfCombat = clearEncounter({ ...timed });
    delete outOfCombat.combat;
    return { player: outOfCombat, checks: [check], text: `你與${unit.name}拉開距離，戰鬥結束。` };
  }
  const enemyTurn = resolveEnemyTurn(timed, combat, unit);
  return { ...enemyTurn, checks: [check, ...enemyTurn.checks], text: `逃跑失敗，${unit.name}擋住了去路。\n${enemyTurn.text}` };
}

/**
 * 建立戰鬥狀態：對非敵對單位動手時先使其敵對（provoke）。地區居民的戰鬥 HP 會保留；需遭遇的單位每次以完整 HP 開始。
 * 遭遇對象設為此單位（玩家先發現與否沿用原本的遭遇）。
 */
export function buildCombatPlayer(player: PlayerState, unitId: string, opening: CombatOpening): PlayerState | undefined {
  const unit = getWorldUnitById(unitId, player);
  if (!unit) return undefined;
  const provoked = getWorldUnitDisposition(player, unitId) === 'hostile'
    ? player
    : applyStateChanges(player, { storyText: '', suggestedActions: [], stateChanges: { unitDispositionChanges: [{ unitId, disposition: 'hostile' }] } }, 'game');
  const unitState = unit.population ? undefined : provoked.unitInstances[unit.id];
  const currentHp = unit.requiresEncounter ? unit.stats.hp : unitState?.currentHp ?? unit.stats.hp;
  const encountered = provoked.encounteredUnitId === unitId ? provoked : setEncounter(provoked, unitId, false);
  // 敵方偷襲以第 0 回合表示先攻一擊，結算後進入第 1 回合。
  const combat = { ...createCombat([provoked.unitId], [{ unitId, currentHp }]), opening, ...(opening === 'enemy_ambush' ? { round: 0 } : {}) };
  return { ...encountered, combat };
}

/** 敵方偷襲（D2、D3 失敗、D7）：開戰並由敵方先攻一擊。 */
export function startEnemyAmbush(player: PlayerState, unit: WorldUnitStatic, prefix: string, prefixChecks: ActionCheckResult[] = []): CombatStepResult {
  const combatPlayer = buildCombatPlayer(player, unit.id, 'enemy_ambush')!;
  const enemyTurn = resolveEnemyTurn(combatPlayer, combatPlayer.combat!, unit, true);
  return { ...enemyTurn, checks: [...prefixChecks, ...enemyTurn.checks], text: `${prefix}⚠️ ${unit.name}搶先出手！\n${enemyTurn.text}` };
}

/** 一般開戰（D6：玩家先攻）。 */
export function startNormalCombat(player: PlayerState, unit: WorldUnitStatic, text: string, checks: ActionCheckResult[] = []): CombatStepResult {
  return { player: buildCombatPlayer(player, unit.id, 'normal')!, checks, text };
}

/**
 * 被找上（D2）：等待、移動途中、敵對居民。察覺成功時玩家先發現（可伏擊、挑戰或離開）；失敗為敵方偷襲。
 * prefix 是發現前的情境說明（例如「你等待了 1 小時，某某出現」）。
 */
export function resolveFoundByEnemy(player: PlayerState, unit: WorldUnitStatic, prefix: string): CombatStepResult {
  const perception = rollPerception(player, unit);
  if (perception.success) {
    return {
      player: setEncounter(player, unit.id, true),
      checks: [perception],
      text: `${prefix}👁️ 你先察覺了${unit.name}，對方還沒發現你。可從下方選項列伏擊、挑戰，或移動離開；做其他事會被發現並開戰。`
    };
  }
  return startEnemyAmbush(player, unit, `${prefix}你沒能及早察覺${unit.name}。\n`, [perception]);
}

/**
 * 伏擊（D3）：只對玩家先發現的對象。敏捷對抗敵方感知；成功先手一擊（必中、倍率），失敗敵方先攻。
 */
export function resolveAmbush(player: PlayerState, unit: WorldUnitStatic): CombatStepResult {
  const method = getActionMethod('ambush')!;
  const check = rollOpposedCheck(player, unit, method.checkAbility ?? 'dex', method.dcBase ?? 10, method.dcOpponentAbility ?? 'wis', `伏擊${unit.name}`, '伏擊檢定');
  if (!check.success) return startEnemyAmbush(player, unit, `🗡️ 伏擊失敗，${unit.name}察覺了你的動靜。\n`, [check]);
  const combatPlayer = buildCombatPlayer(player, unit.id, method.onSuccess.opening)!;
  return resolvePlayerAttack(combatPlayer, {
    firstStrikeMultiplier: method.onSuccess.firstStrikeMultiplier ?? 1,
    prefix: `🗡️ 伏擊成功！你搶得先手。\n`,
    prefixChecks: [check]
  })!;
}

/**
 * 設陷阱等待（D4）：非安全地區等待一段時間；期間有敵人出現時改擲陷阱檢定（智力對抗敵方感知）。
 * 成功：陷阱造成敵方最大 HP 的比例傷害，再接先手一擊；失敗：被察覺，一般開戰。沒有敵人出現就只是等待（遭遇清除）。
 */
export function resolveTrapWait(player: PlayerState, minutes: number, random?: () => number): CombatStepResult | undefined {
  const map = getMapById(player.currentMapId);
  if (!map || map.isSafeZone || player.combat) return undefined;
  const interruption = rollWaitInterruption(player, minutes, random);
  const waited = waitGameTime(player, interruption.elapsedMinutes);
  const unit = interruption.unitId ? getWorldUnitById(interruption.unitId, player) : undefined;
  if (!unit) {
    return { player: clearEncounter(waited), checks: [], text: `🪤 你設好陷阱等待了 ${formatDuration(minutes)}，沒有敵人經過。現在是 ${formatGameTime(waited.gameTimeMinutes)}。等待不會恢復生命與魔力。` };
  }
  const method = getActionMethod('trap')!;
  const prefix = `🪤 你設好陷阱等待了 ${formatDuration(interruption.elapsedMinutes)}，${unit.name}出現了！現在是 ${formatGameTime(waited.gameTimeMinutes)}。\n`;
  const check = rollOpposedCheck(waited, unit, method.checkAbility ?? 'int', method.dcBase ?? 10, method.dcOpponentAbility ?? 'wis', `${unit.name}是否踩中陷阱`, '陷阱檢定');
  if (!check.success) return startNormalCombat(waited, unit, `${prefix}${unit.name}識破了陷阱並發現了你，戰鬥開始！`, [check]);
  const combatPlayer = buildCombatPlayer(waited, unit.id, method.onSuccess.opening)!;
  const target = getCombatTarget(combatPlayer.combat!)!;
  const trapDamage = Math.max(1, Math.floor(unit.stats.hp * (method.onSuccess.trapDamageRatio ?? 0)));
  const afterTrapHp = Math.max(0, target.currentHp - trapDamage);
  const trapped = { ...combatPlayer, combat: setEnemyHp(combatPlayer.combat!, unit.id, afterTrapHp) };
  return resolvePlayerAttack(unit.requiresEncounter ? trapped : withUnitHp(trapped, unit.id, afterTrapHp, afterTrapHp <= 0), {
    firstStrikeMultiplier: method.onSuccess.firstStrikeMultiplier ?? 1,
    prefix: `${prefix}${unit.name}踩中陷阱，受到 ${trapDamage} 點傷害！你趁機搶得先手。\n`,
    prefixChecks: [check]
  })!;
}

/**
 * 每次行動套用前的共用規則（O45）：
 * - 離開地區時清除敵對居民的強制開戰紀錄；
 * - 遭遇超過時限失效（D5）；
 * - 進入新地區時，敵對居民主動攻擊（D9，先擲察覺）。
 */
export function applyPostActionRules(before: PlayerState, next: PlayerState): { player: PlayerState; notices: { text: string; checks: ActionCheckResult[] }[]; deathHints?: Record<string, DeathHint> } {
  let player = next;
  const notices: { text: string; checks: ActionCheckResult[] }[] = [];
  const moved = next.currentMapId !== before.currentMapId;
  if (moved && player.residentAggro) {
    player = { ...player };
    delete player.residentAggro;
  }
  const expired = expireEncounter(player);
  if (expired.expiredUnitName) {
    player = expired.player;
    notices.push({ text: `👁️ ${expired.expiredUnitName}已經不在附近，遭遇結束。`, checks: [] });
  }
  // D10：戰鬥結束或逃跑成功時，再次強制的 30 分鐘從此刻起算（review 第 1 輪建議 5）。
  if (before.combat && !player.combat && player.residentAggro?.mapId === player.currentMapId) {
    player = { ...player, residentAggro: { ...player.residentAggro, atMinutes: player.gameTimeMinutes } };
  }
  // 本次行動已設定遭遇（例如移動途中被找上、AI 在抵達回合提出遭遇）時不再判定居民，避免蓋掉遭遇；
  // 下一個行動再由 preemptByEnemy 處理（review 第 1 輪應修 1）。
  if (moved && !player.combat && !player.encounteredUnitId && canPlayerAct(player)) {
    const resident = findAggressiveResident(player);
    if (resident) {
      const found = resolveFoundByEnemy(player, resident, `⚠️ 這裡的${resident.name}對你懷有敵意。\n`);
      return { player: { ...found.player, residentAggro: { mapId: player.currentMapId, atMinutes: player.gameTimeMinutes } }, notices: [...notices, { text: found.text, checks: found.checks }], deathHints: found.deathHints };
    }
  }
  return { player, notices };
}

/** AI 的 combatRequest 驗證結果（D11）：合法時回傳手段與目標，不合法時回傳給玩家看的原因。 */
export type CombatRequestPlan =
  | { ok: true; method: 'attack' | 'ambush'; unit: WorldUnitStatic }
  | { ok: true; method: 'trap' }
  | { ok: false; reason: string };

export function resolveCombatRequest(player: PlayerState, request: AIResponsePayload['combatRequest'], startBlock: (unitId: string) => string | undefined): CombatRequestPlan | undefined {
  if (!request) return undefined;
  if (!getActionMethod(request.method)) return { ok: false, reason: '不支援的開戰方式' };
  if (request.method === 'trap') {
    const map = getMapById(player.currentMapId);
    return map && !map.isSafeZone && !player.combat ? { ok: true, method: 'trap' } : { ok: false, reason: '這裡不能設陷阱' };
  }
  const unit = getWorldUnitById(request.unitId, player);
  if (!unit) return { ok: false, reason: '找不到對象' };
  if (request.method === 'ambush') {
    return getAmbushableUnit(player, unit.id) ? { ok: true, method: 'ambush', unit } : { ok: false, reason: `只能伏擊你先發現的對象，${unit.name}不符合` };
  }
  const block = startBlock(unit.id);
  return block ? { ok: false, reason: block } : { ok: true, method: 'attack', unit };
}

/** 依 combatRequest 開戰：攻擊為一般開戰、伏擊擲伏擊檢定、陷阱為預設時長的設陷阱等待。 */
export function startCombatByPlan(player: PlayerState, plan: Extract<CombatRequestPlan, { ok: true }>): CombatStepResult | undefined {
  if (plan.method === 'trap') return resolveTrapWait(player, combatRules.defaultTrapWaitMinutes);
  if (plan.method === 'ambush') return resolveAmbush(player, plan.unit);
  const provoked = getWorldUnitDisposition(player, plan.unit.id) !== 'hostile';
  return startNormalCombat(player, plan.unit, `⚔️ 你${provoked ? '激怒並與' : '與'}${plan.unit.name}進入戰鬥！${OPENING_LABELS.normal}。`);
}
