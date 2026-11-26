import type { ActionCheckResult, CombatOpening, CombatStatusEffect, ItemStatic, PlayerState, SkillStatic, WorldUnitStatic } from '../types/game';
import { combatRules, getActionMethod, getItemById, getMapById, getPlayerResourceCaps, getUnlockedSkills, getWorldUnitById, getWorldUnitDisposition, partyRules, PLAYER_UNIT_ID, scenario } from '../data/staticData';
import { getPlayerStatBreakdown, resolveActionCheck, resolveUnitCheck } from './gameChecks';
import { applyStateChanges } from './applyStateChanges';
import { grantUnitExp } from './unitProgress';
import { getPlayerWorldUnit } from './worldUnits';
import { createCombat, getCombatTarget, getCurrentActorKey, getEnemyParticipants, getParticipant, getStandingEnemies, setEnemyHp, type CombatEnemySeed, type EnemyParticipant } from './combatState';
import { advanceGameTime, waitGameTime, formatDuration, formatGameTime } from './gameTime';
import { findQuest } from './questRules';
import { clearEncounter, expireEncounter, findAggressiveResident, getAmbushableUnit, rollOpposedCheck, rollPerception, setEncounter } from './encounters';
import { canPlayerAct } from './playerStatus';
import type { AIResponsePayload } from '../types/game';
import { rollWaitInterruption } from './waitRules';
import type { DeathHint } from './worldEvents';
import { pickWeighted, randomFloat, randomInt } from './random';
import { getCompanionResources } from './party';

/**
 * 戰鬥結算（O45 從 App 移出；O35-1 改為多對多）：
 * 開戰時依 SPD 排定行動順序；輪到玩家時才等待輸入，同伴與敵人的行動由規則自動結算到下次輪到玩家（D11、D12）。
 * 全部是純函式，回傳結算後的狀態、檢定與給玩家看的文字（每個行動者一行）；套用與訊息由呼叫端處理。
 */
export interface CombatStepResult {
  player: PlayerState;
  checks: ActionCheckResult[];
  text: string;
  deathHints?: Record<string, DeathHint>;
  /** 敵人全部倒下（戰鬥結束）。 */
  victory?: boolean;
}

export const OPENING_LABELS: Record<CombatOpening, string> = {
  normal: '一般開戰（依速度決定行動順序）',
  player_ambush: '伏擊成功（我方先手）',
  trap: '陷阱命中（我方先手）',
  enemy_ambush: '遭到偷襲（敵方先攻）'
};

/** 一次結算到底的安全上限（行動者步數），避免任何情況下無限循環（驗收 14）。 */
const MAX_AUTO_STEPS = 400;

export function withUnitHp(player: PlayerState, unitId: string, currentHp: number, isDead = false): PlayerState {
  const state = player.unitInstances[unitId];
  return { ...player, unitInstances: { ...player.unitInstances, [unitId]: { ...state, currentHp, isDead } } };
}

/** 結算過程的累積：狀態、檢定、每行文字與死因。 */
interface Ctx {
  state: PlayerState;
  checks: ActionCheckResult[];
  lines: string[];
  deathHints: Record<string, DeathHint>;
  victory?: boolean;
  /** 戰鬥已結束（勝利、逃跑或玩家死亡）。 */
  ended?: boolean;
}

const newCtx = (state: PlayerState, lines: string[] = [], checks: ActionCheckResult[] = []): Ctx => ({ state, checks: [...checks], lines: [...lines], deathHints: {} });
const toResult = (ctx: Ctx): CombatStepResult => ({
  player: ctx.state, checks: ctx.checks, text: ctx.lines.filter(Boolean).join('\n'),
  ...(Object.keys(ctx.deathHints).length ? { deathHints: ctx.deathHints } : {}), ...(ctx.victory ? { victory: true } : {})
});

// ---------------------------------------------------------------------------
// 我方（玩家、同伴）的資源與狀態
// ---------------------------------------------------------------------------

const isPlayerKey = (key: string) => key === PLAYER_UNIT_ID;

function partyName(state: PlayerState, key: string): string {
  return isPlayerKey(key) ? '你' : getWorldUnitById(key, state)?.name ?? key;
}

function partyHp(state: PlayerState, key: string): { hp: number; maxHp: number } {
  if (isPlayerKey(key)) return { hp: state.hp, maxHp: getPlayerResourceCaps(state).maxHp };
  const unit = getWorldUnitById(key, state);
  return unit ? getCompanionResources(state, unit) : { hp: 0, maxHp: 1 };
}

/** 我方成員站著（玩家存活；同伴沒有倒地）。 */
function isPartyStanding(state: PlayerState, key: string): boolean {
  if (isPlayerKey(key)) return !state.isDead && state.hp > 0;
  const instance = state.unitInstances[key];
  return !!instance && !instance.isDead && instance.downed !== true && (instance.currentHp ?? 1) > 0;
}

function getStatuses(state: PlayerState, key: string): CombatStatusEffect[] {
  if (isPlayerKey(key)) return state.statusEffects;
  const participant = state.combat ? getParticipant(state.combat, key) : undefined;
  if (participant?.side === 'enemy') return participant.statusEffects ?? [];
  return state.unitInstances[key]?.statusEffects ?? [];
}

function setStatuses(state: PlayerState, key: string, statusEffects: CombatStatusEffect[]): PlayerState {
  if (isPlayerKey(key)) return { ...state, statusEffects };
  const participant = state.combat ? getParticipant(state.combat, key) : undefined;
  if (participant?.side === 'enemy' && state.combat) {
    return { ...state, combat: { ...state.combat, participants: state.combat.participants.map((entry) => entry.key === key ? { ...entry, statusEffects } : entry) } };
  }
  const instance = state.unitInstances[key];
  return instance ? { ...state, unitInstances: { ...state.unitInstances, [key]: { ...instance, statusEffects } } } : state;
}

const hasStatus = (state: PlayerState, key: string, id: CombatStatusEffect['id']) =>
  getStatuses(state, key).some((effect) => effect.id === id && effect.remainingTurns > 0);

/** 回合開始時該狀態的剩餘回合減一（歸零即解除）。 */
function tickStatus(state: PlayerState, key: string, id: CombatStatusEffect['id']): PlayerState {
  const effects = getStatuses(state, key);
  if (!effects.some((effect) => effect.id === id)) return state;
  return setStatuses(state, key, effects.flatMap((effect) => effect.id !== id ? [effect]
    : effect.remainingTurns > 1 ? [{ ...effect, remainingTurns: effect.remainingTurns - 1 }] : []));
}

/** 套用狀態（同種狀態取較長的剩餘回合）；對所有單位一致（D22）。 */
export function applyStatus(state: PlayerState, key: string, effect: CombatStatusEffect): PlayerState {
  const effects = getStatuses(state, key);
  const existing = effects.find((entry) => entry.id === effect.id);
  return setStatuses(state, key, existing
    ? effects.map((entry) => entry.id === effect.id ? { ...entry, remainingTurns: Math.max(entry.remainingTurns, effect.remainingTurns) } : entry)
    : [...effects, effect]);
}

/** 同伴的 HP 變化（歸零即倒地，不是死亡，D9）。 */
function setCompanionHp(state: PlayerState, unitId: string, hp: number): PlayerState {
  const instance = state.unitInstances[unitId];
  if (!instance) return state;
  return { ...state, unitInstances: { ...state.unitInstances, [unitId]: { ...instance, currentHp: Math.max(0, hp), downed: hp <= 0 } } };
}

/** 戰鬥結束（勝利或逃跑成功）：倒地同伴以 reviveHp 起身，我方的戰鬥狀態效果解除。 */
function endCombatForParty(state: PlayerState): PlayerState {
  let next: PlayerState = { ...state, statusEffects: [] };
  delete next.combat;
  const unitInstances = { ...next.unitInstances };
  for (const unitId of next.party) {
    const instance = unitInstances[unitId];
    if (!instance) continue;
    unitInstances[unitId] = { ...instance, statusEffects: [], downed: false, ...(instance.downed || instance.currentHp === 0 ? { currentHp: partyRules.reviveHp } : {}) };
  }
  next = { ...next, unitInstances };
  return clearEncounter(next);
}

// ---------------------------------------------------------------------------
// 擊倒敵人的結算（每個敵人各自結算，D18、D19、D8、D32）
// ---------------------------------------------------------------------------

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
 * 一個敵人倒下：取得持有物、擲掉落、給經驗（玩家與每位同伴各拿完整經驗，D8）、記入擊倒數，
 * 只結算討伐目標與被擊倒單位吻合的任務（D19）。唯一個體擊倒即永久死亡；同伴出手時後果算在玩家頭上（D32）。
 * 回傳附在行動者那一行後面的說明。
 */
function settleEnemyDefeat(ctx: Ctx, enemy: EnemyParticipant, actorKey: string): string {
  const before = ctx.state;
  const unit = getWorldUnitById(enemy.unitId, before);
  if (!unit) return '';
  const looted = takeHoldings(before, unit.id, unit.name);
  const dropItems = (unit.loot?.dropItems ?? []).flatMap((drop) => randomFloat() < drop.chance ? [{ itemId: drop.itemId, quantity: 1 }] : []);
  const lootGold = unit.loot?.gold ?? 0;
  const expGain = unit.requiresEncounter || scenario.rules.residentKillGrantsExp ? unit.expReward : 0;
  const questUpdates = before.activeQuests.filter((quest) => quest.status === 'in_progress' &&
    (findQuest(before, quest.questId)?.requirements.defeatUnits ?? []).some((requirement) => requirement.unitId === unit.id))
    .map((quest) => ({ questId: quest.questId, status: 'completed' as const }));
  let next = applyStateChanges(looted.player, {
    storyText: '', suggestedActions: [],
    stateChanges: { expChange: expGain, goldChange: lootGold, addItems: dropItems, defeatedUnits: [{ unitId: unit.id, quantity: 1 }], questUpdates }
  }, 'game');
  const levelTexts: string[] = [];
  if (next.level > looted.player.level) levelTexts.push(`📈 你升至 Lv.${next.level}！`);
  // 隊伍中的每位同伴（含倒地者）各拿同額經驗，照單位成長規則升級。
  for (const companionId of next.party) {
    const growth = expGain > 0 ? grantUnitExp(next.unitInstances, companionId, expGain, next.world) : undefined;
    if (!growth) continue;
    next = { ...next, unitInstances: growth.instances };
    if (growth.level > growth.previousLevel) levelTexts.push(`📈 ${partyName(next, companionId)}升至 Lv.${growth.level}。`);
  }
  // 唯一個體擊倒即永久死亡（寫入死亡事件）；族群樣板代表一群個體，不會因單次擊倒而消失。
  if (!unit.population) {
    next = withUnitHp(next, unit.id, 0, true);
    ctx.deathHints[unit.id] = { cause: 'combat', killerUnitId: PLAYER_UNIT_ID, ...(isPlayerKey(actorKey) ? {} : { actorUnitId: actorKey }) };
  }
  ctx.state = next;
  const completed = next.activeQuests.filter((quest) => quest.status === 'completed' &&
    before.activeQuests.some((previous) => previous.questId === quest.questId && previous.status === 'in_progress'));
  const gains = [
    expGain > 0 ? `${expGain} EXP${next.party.length ? '（同伴各得相同經驗）' : ''}` : '',
    lootGold + looted.gold > 0 ? `${lootGold + looted.gold} 金幣` : '',
    ...[...looted.loot, ...dropItems].map((item) => `${getItemById(item.itemId)?.name ?? item.itemId} ×${item.quantity}`)
  ].filter(Boolean);
  const questText = completed.map((quest) => `任務「${findQuest(before, quest.questId)?.title ?? quest.questId}」完成，需求道具已交付並領取獎勵。`).join('');
  return `${unit.isBoss ? '🏆' : '💀'} ${enemy.label}倒下了！${gains.length ? `獲得 ${gains.join('、')}。` : '沒有獲得任何東西。'}${expGain > 0 ? '' : '（不會獲得經驗）'}${levelTexts.join('')}${questText}`;
}

/** 敵人受到傷害；唯一居民的戰鬥 HP 同步保留在實例。倒下時結算並回傳說明。 */
function damageEnemy(ctx: Ctx, enemyKey: string, damage: number, actorKey: string): string {
  const combat = ctx.state.combat!;
  const enemy = getParticipant(combat, enemyKey);
  if (enemy?.side !== 'enemy') return '';
  const unit = getWorldUnitById(enemy.unitId, ctx.state);
  const hp = Math.max(0, enemy.currentHp - damage);
  let next: PlayerState = { ...ctx.state, combat: setEnemyHp(combat, enemyKey, hp) };
  if (unit && !unit.requiresEncounter && hp > 0) next = withUnitHp(next, unit.id, hp);
  ctx.state = next;
  if (hp > 0) return '';
  const text = settleEnemyDefeat(ctx, { ...enemy, currentHp: 0 }, actorKey);
  // 鎖定的目標倒下時改鎖定下一個站著的敵人。
  const target = getCombatTarget(ctx.state.combat!);
  if (target && target.key !== ctx.state.combat!.targetKey) ctx.state = { ...ctx.state, combat: { ...ctx.state.combat!, targetKey: target.key } };
  return text;
}

/** 敵人全部倒下即勝利（D18）。 */
function checkVictory(ctx: Ctx): boolean {
  if (ctx.ended || !ctx.state.combat || getStandingEnemies(ctx.state.combat).length) return false;
  const bossDefeated = getEnemyParticipants(ctx.state.combat).some((enemy) => getWorldUnitById(enemy.unitId)?.isBoss);
  const downed = ctx.state.party.filter((unitId) => ctx.state.unitInstances[unitId]?.downed);
  ctx.state = endCombatForParty(ctx.state);
  ctx.lines.push(`${bossDefeated ? '🏆' : '⚔️'} 敵人全數倒下，戰鬥勝利！${downed.length ? `${downed.map((unitId) => partyName(ctx.state, unitId)).join('、')}以 ${partyRules.reviveHp} HP 起身。` : ''}`);
  ctx.victory = true;
  ctx.ended = true;
  return true;
}

// ---------------------------------------------------------------------------
// 攻擊：我方攻擊敵人、敵人攻擊我方（同一套公式，D15）
// ---------------------------------------------------------------------------

interface PartyAttackOptions {
  skill?: SkillStatic;
  /** 開場第一擊（伏擊、陷阱成功）：必中、傷害乘以倍率。 */
  firstStrikeMultiplier?: number;
}

/** 我方攻擊：命中檢定（攻擊 vs 10 ＋ 目標防禦）、傷害（攻擊 × 倍率 − 目標防禦，至少 1）。回傳一行文字。 */
function partyAttack(ctx: Ctx, attackerKey: string, enemyKey: string, options: PartyAttackOptions = {}): string {
  const combat = ctx.state.combat!;
  const enemy = getParticipant(combat, enemyKey);
  const unit = enemy?.side === 'enemy' ? getWorldUnitById(enemy.unitId, ctx.state) : undefined;
  if (enemy?.side !== 'enemy' || !unit) return '';
  const attacker = isPlayerKey(attackerKey) ? undefined : getWorldUnitById(attackerKey, ctx.state);
  const name = partyName(ctx.state, attackerKey);
  const firstStrike = options.firstStrikeMultiplier !== undefined;
  const actionName = firstStrike && isPlayerKey(attackerKey) ? '先手一擊' : options.skill?.name ?? '攻擊';
  let hit = true;
  if (!(firstStrike && isPlayerKey(attackerKey))) {
    const dc = 10 + unit.stats.def;
    const roll = attacker ? resolveUnitCheck(attacker, 'atk', dc) : resolveActionCheck(ctx.state, 'atk', dc);
    ctx.checks.push({ ...roll, stat: 'atk', reason: `第 ${combat.round} 回合：${name === '你' ? '' : name}${actionName}${enemy.label}`, label: `${name === '你' ? '玩家' : name}攻擊檢定` });
    hit = roll.success;
  }
  const attack = attacker ? attacker.stats.atk : getPlayerStatBreakdown(ctx.state, 'atk').statValue;
  const multiplier = options.skill?.effect.kind === 'damage_multiplier' ? options.skill.effect.multiplier : 1;
  const base = Math.max(1, Math.floor(attack * multiplier) - unit.stats.def);
  const damage = !hit ? 0 : firstStrike && isPlayerKey(attackerKey) ? Math.max(1, Math.floor(base * options.firstStrikeMultiplier!)) : base;
  const icon = isPlayerKey(attackerKey) ? '⚔️' : '🛡️';
  if (!hit) return `${icon} ${name}${actionName}${enemy.label}，未命中。`;
  const defeat = damageEnemy(ctx, enemyKey, damage, attackerKey);
  return `${icon} ${name}${actionName}${enemy.label}，造成 ${damage} 點傷害。${defeat}`;
}

/** 敵人選目標（D14）：只選站著的我方；有嘲諷狀態者時只選嘲諷者；否則依仇恨權重（玩家 2、同伴 1，可調）隨機。 */
export function pickEnemyTarget(state: PlayerState): string | undefined {
  const combat = state.combat;
  if (!combat) return undefined;
  const standing = combat.participants.filter((participant) => participant.side === 'party' && isPartyStanding(state, participant.key)).map((participant) => participant.key);
  const taunting = standing.filter((key) => hasStatus(state, key, 'taunt'));
  const pool = taunting.length ? taunting : standing;
  return pickWeighted(pool.map((key) => ({ item: key, weight: isPlayerKey(key) ? partyRules.aggroWeights.player : partyRules.aggroWeights.companion })));
}

/** 敵人一擊的傷害（一般公式）：敵方攻擊 × 倍率 − 防守方防禦的四分之一，至少 1。 */
export function getEnemyHitDamage(player: PlayerState, unit: WorldUnitStatic, multiplier = 1, targetKey: string = PLAYER_UNIT_ID): number {
  const defense = isPlayerKey(targetKey) ? getPlayerStatBreakdown(player, 'def').statValue : getWorldUnitById(targetKey, player)?.stats.def ?? 0;
  return Math.max(1, Math.floor(unit.stats.atk * multiplier) - Math.floor(defense / 4));
}

/**
 * 敵人行動：依仇恨選目標，防守方擲閃避（或抵抗特殊能力）。
 * openingStrike 為 true 時是敵方偷襲的先攻一擊（O45 D7）：一般攻擊、不觸發特殊能力。
 */
function enemyAttack(ctx: Ctx, enemyKey: string, openingStrike = false): void {
  const combat = ctx.state.combat!;
  const enemy = getParticipant(combat, enemyKey);
  const unit = enemy?.side === 'enemy' ? getWorldUnitById(enemy.unitId, ctx.state) : undefined;
  const targetKey = pickEnemyTarget(ctx.state);
  if (enemy?.side !== 'enemy' || !unit || !targetKey) return;
  const special = openingStrike ? undefined : unit.specialAbilities?.find((ability) => ability.combatAction && combat.round > 0 && combat.round % ability.combatAction.triggerEveryRounds === 0);
  const action = special?.combatAction;
  const checkStat = action?.checkStat ?? 'def';
  const dc = action?.dc ?? 10 + Math.floor(unit.stats.atk / 2);
  const defender = isPlayerKey(targetKey) ? undefined : getWorldUnitById(targetKey, ctx.state);
  const targetName = partyName(ctx.state, targetKey);
  const defenderLabel = targetName === '你' ? '玩家' : targetName;
  const roll = defender ? resolveUnitCheck(defender, checkStat, dc) : resolveActionCheck(ctx.state, checkStat, dc);
  const verb = openingStrike ? '偷襲' : action ? `施放${special?.name}，攻向` : '攻擊';
  ctx.checks.push({
    ...roll, stat: checkStat,
    reason: action ? `${enemy.label}施放${special?.name}：${defenderLabel}進行${checkStat === 'dex' ? '閃避' : '抵抗'}檢定` : `${enemy.label}${verb}${defenderLabel}：${defenderLabel}進行閃避檢定`,
    label: action ? `${special?.name}檢定` : `${defenderLabel}閃避檢定`
  });
  if (roll.success) {
    ctx.lines.push(`👹 ${enemy.label}${verb}${targetName}，${targetName === '你' ? '你' : targetName}閃開了。`);
    return;
  }
  const damage = getEnemyHitDamage(ctx.state, unit, action?.damageMultiplier ?? 1, targetKey);
  const unconsciousTurns = action?.applyUnconsciousTurnsOnFailure ?? 0;
  if (isPlayerKey(targetKey)) {
    const hp = Math.max(0, ctx.state.hp - damage);
    const isDead = hp <= 0;
    ctx.state = { ...ctx.state, hp, isDead };
    if (isDead) {
      // 擊倒玩家的單位依同一規則獲得玩家的擊倒經驗，並可能升級。
      const victorGrowth = grantUnitExp(ctx.state.unitInstances, unit.id, getPlayerWorldUnit(ctx.state).expReward, ctx.state.world);
      const died: PlayerState = { ...ctx.state, ...(victorGrowth ? { unitInstances: victorGrowth.instances } : {}) };
      // 戰鬥結束：倒地的同伴不留在倒地狀態（review 第 1 輪 S1）；之後照舊讀檔。
      ctx.state = endCombatForParty(died);
      ctx.deathHints[PLAYER_UNIT_ID] = { cause: 'combat', killerUnitId: unit.id };
      ctx.lines.push(`👹 ${enemy.label}${verb}你，命中造成 ${damage} 點傷害。\n☠️ HP 歸零，你已死亡。${victorGrowth && victorGrowth.level > victorGrowth.previousLevel ? `\n📈 ${unit.name}升至 Lv.${victorGrowth.level}。` : ''}`);
      ctx.ended = true;
      return;
    }
  } else {
    const resources = partyHp(ctx.state, targetKey);
    ctx.state = setCompanionHp(ctx.state, targetKey, resources.hp - damage);
  }
  const downed = !isPlayerKey(targetKey) && !isPartyStanding(ctx.state, targetKey);
  if (unconsciousTurns > 0 && !downed) ctx.state = applyStatus(ctx.state, targetKey, { id: 'unconscious', remainingTurns: unconsciousTurns });
  ctx.lines.push(`👹 ${enemy.label}${verb}${targetName}，命中造成 ${damage} 點傷害。${downed ? `${targetName}倒地了！` : unconsciousTurns > 0 ? `${targetName === '你' ? '你' : targetName}陷入昏迷 ${unconsciousTurns} 回合。` : ''}`);
}

// ---------------------------------------------------------------------------
// 同伴的規則行為（D13）與治療
// ---------------------------------------------------------------------------

/** 治療我方一人（技能或道具）。一般治療不能救起倒地的同伴（D9，只有復甦效果可以）。回傳實際恢復量。 */
function healPartyMember(ctx: Ctx, targetKey: string, hpRestore: number, mpRestore = 0): { hp: number; mp: number } {
  if (isPlayerKey(targetKey)) {
    const caps = getPlayerResourceCaps(ctx.state);
    const hp = Math.min(hpRestore, Math.max(0, caps.maxHp - ctx.state.hp));
    const mp = Math.min(mpRestore, Math.max(0, caps.maxMp - ctx.state.mp));
    ctx.state = { ...ctx.state, hp: ctx.state.hp + hp, mp: ctx.state.mp + mp };
    return { hp, mp };
  }
  const unit = getWorldUnitById(targetKey, ctx.state);
  const instance = ctx.state.unitInstances[targetKey];
  if (!unit || !instance) return { hp: 0, mp: 0 };
  const resources = getCompanionResources(ctx.state, unit);
  if (resources.downed) return { hp: 0, mp: 0 };
  const hp = Math.min(hpRestore, Math.max(0, resources.maxHp - resources.hp));
  const mp = Math.min(mpRestore, Math.max(0, resources.maxMp - resources.mp));
  ctx.state = { ...ctx.state, unitInstances: { ...ctx.state.unitInstances, [targetKey]: { ...instance, currentHp: resources.hp + hp, currentMp: resources.mp + mp } } };
  return { hp, mp };
}

/** 復甦起身的 HP（D35）：最大 HP × reviveRatio（捨去、至少 1）。 */
export const getReviveHp = (maxHp: number): number => Math.max(1, Math.floor(maxHp * partyRules.reviveRatio));

/** 以復甦效果救起倒地的同伴（D35）；下一次輪到他時才行動。回傳起身的 HP，對象不是倒地同伴時回傳 0。 */
function revivePartyMember(ctx: Ctx, targetKey: string): number {
  const unit = isPlayerKey(targetKey) ? undefined : getWorldUnitById(targetKey, ctx.state);
  const instance = ctx.state.unitInstances[targetKey];
  if (!unit || !instance || !getCompanionResources(ctx.state, unit).downed) return 0;
  const hp = getReviveHp(unit.stats.hp);
  ctx.state = { ...ctx.state, unitInstances: { ...ctx.state.unitInstances, [targetKey]: { ...instance, currentHp: hp, downed: false } } };
  return hp;
}

/** 我方 HP 比例最低、且低於門檻的成員；倒地的同伴不是一般治療的對象（D9）。 */
function findHealTarget(state: PlayerState): string | undefined {
  const combat = state.combat;
  if (!combat) return undefined;
  return combat.participants.filter((participant) => participant.side === 'party' && isPartyStanding(state, participant.key))
    .map((participant) => ({ key: participant.key, ...partyHp(state, participant.key) }))
    .filter((entry) => entry.hp / entry.maxHp < partyRules.companionHealThreshold)
    .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]?.key;
}

/**
 * 同伴行動（D13）：有治療技能、MP 足夠且我方有人 HP 低於門檻時，治療 HP 比例最低者；
 * 否則攻擊玩家鎖定的目標（已倒下則改打 HP 最低的敵人）。不開放指揮。
 */
function companionAct(ctx: Ctx, companionId: string): void {
  const unit = getWorldUnitById(companionId, ctx.state);
  if (!unit) return;
  const resources = getCompanionResources(ctx.state, unit);
  const healSkill = getUnlockedSkills(unit.classId ?? '', unit.level).find((skill) => skill.effect.kind === 'healing' && skill.costMp <= resources.mp);
  const healTarget = healSkill ? findHealTarget(ctx.state) : undefined;
  if (healSkill && healTarget && healSkill.effect.kind === 'healing') {
    const instance = ctx.state.unitInstances[companionId];
    ctx.state = { ...ctx.state, unitInstances: { ...ctx.state.unitInstances, [companionId]: { ...instance, currentMp: resources.mp - healSkill.costMp } } };
    const restored = healPartyMember(ctx, healTarget, healSkill.effect.hpRestore);
    ctx.lines.push(`✨ ${unit.name}對${partyName(ctx.state, healTarget) === unit.name ? '自己' : partyName(ctx.state, healTarget)}施放${healSkill.name}，HP +${restored.hp}。`);
    return;
  }
  const combat = ctx.state.combat!;
  const locked = getStandingEnemies(combat).find((enemy) => enemy.key === combat.targetKey);
  const target = locked ?? [...getStandingEnemies(combat)].sort((a, b) => a.currentHp - b.currentHp)[0];
  if (!target) return;
  ctx.lines.push(partyAttack(ctx, companionId, target.key));
}

// ---------------------------------------------------------------------------
// 回合推進
// ---------------------------------------------------------------------------

/** 非玩家的行動者行動一次（跳過倒下、倒地與昏迷者；昏迷剩餘回合減一）。 */
function actTurn(ctx: Ctx, key: string): void {
  const combat = ctx.state.combat!;
  const participant = getParticipant(combat, key);
  if (!participant) return;
  if (participant.side === 'enemy' && participant.currentHp <= 0) return;
  if (participant.side === 'party' && !isPartyStanding(ctx.state, key)) return;
  const label = participant.side === 'enemy' ? participant.label : partyName(ctx.state, key);
  if (hasStatus(ctx.state, key, 'unconscious')) {
    ctx.state = tickStatus(ctx.state, key, 'unconscious');
    ctx.lines.push(`💫 ${label}昏迷中，失去本回合行動。`);
    return;
  }
  ctx.state = tickStatus(ctx.state, key, 'taunt');
  if (participant.side === 'enemy') enemyAttack(ctx, key);
  else companionAct(ctx, key);
}

/**
 * 依行動順序自動結算，直到輪到玩家（玩家昏迷時自動跳過，D12）、或戰鬥結束。
 * 任何情況下最多 MAX_AUTO_STEPS 步；超過時直接回到玩家回合（驗收 14）。
 */
function runUntilPlayerTurn(ctx: Ctx): void {
  for (let step = 0; step < MAX_AUTO_STEPS; step += 1) {
    if (ctx.ended || !ctx.state.combat) return;
    const combat = ctx.state.combat;
    let index = combat.turnIndex + 1;
    let round = combat.round;
    if (index >= combat.turnOrder.length) {
      index = 0;
      round += 1;
      ctx.lines.push(`── 第 ${round} 回合 ──`);
    }
    ctx.state = { ...ctx.state, combat: { ...combat, turnIndex: index, round } };
    const key = combat.turnOrder[index];
    if (isPlayerKey(key)) {
      if (hasStatus(ctx.state, key, 'unconscious')) {
        // 自動跳過的玩家回合同樣經過一個戰鬥回合的時間（review 第 1 輪 R2）。
        ctx.state = tickStatus(advanceGameTime(ctx.state, 'combatRound'), key, 'unconscious');
        ctx.lines.push('💫 你仍昏迷，失去本回合行動。');
        continue;
      }
      ctx.state = tickStatus(ctx.state, key, 'taunt');
      return;
    }
    actTurn(ctx, key);
    if (checkVictory(ctx)) return;
  }
  // 安全網：回到玩家回合並解除玩家昏迷。
  const combat = ctx.state.combat;
  if (combat && !ctx.ended) {
    ctx.state = { ...ctx.state, statusEffects: ctx.state.statusEffects.filter((effect) => effect.id !== 'unconscious'), combat: { ...combat, turnIndex: combat.turnOrder.indexOf(PLAYER_UNIT_ID) } };
    ctx.lines.push('（自動結算達到上限，回到你的回合。）');
  }
}

/** 目前是否輪到玩家。 */
export const isPlayerTurn = (player: PlayerState): boolean => !!player.combat && getCurrentActorKey(player.combat) === PLAYER_UNIT_ID;

/** 我方第一輪（伏擊、陷阱成功，D20）：玩家必中一擊（倍率）、同伴一般攻擊；之後從第 2 回合依 SPD 進行。 */
function runPartyFirstRound(ctx: Ctx, firstStrikeMultiplier: number): void {
  const combat = ctx.state.combat!;
  for (const key of combat.turnOrder) {
    if (ctx.ended) return;
    const participant = getParticipant(ctx.state.combat!, key);
    if (participant?.side !== 'party' || !isPartyStanding(ctx.state, key)) continue;
    const target = getCombatTarget(ctx.state.combat!);
    if (!target) break;
    ctx.lines.push(isPlayerKey(key) ? partyAttack(ctx, key, target.key, { firstStrikeMultiplier }) : partyAttack(ctx, key, target.key));
    if (checkVictory(ctx)) return;
  }
  const after = ctx.state.combat!;
  ctx.state = { ...ctx.state, combat: { ...after, round: 2, turnIndex: -1 } };
  ctx.lines.push('敵人來不及反應。── 第 2 回合 ──');
  runUntilPlayerTurn(ctx);
}

/** 敵方偷襲的第 0 輪（D20）：每個敵人各一次一般攻擊（不觸發特殊能力、照仇恨選目標），之後第 1 回合依 SPD。 */
function runEnemyOpeningRound(ctx: Ctx): void {
  for (const enemy of getStandingEnemies(ctx.state.combat!)) {
    if (ctx.ended) return;
    enemyAttack(ctx, enemy.key, true);
  }
  if (ctx.ended) return;
  ctx.state = { ...ctx.state, combat: { ...ctx.state.combat!, round: 1, turnIndex: -1 } };
  ctx.lines.push('── 第 1 回合 ──');
  runUntilPlayerTurn(ctx);
}

// ---------------------------------------------------------------------------
// 玩家的戰鬥行動（選項列、打字、HUD 都呼叫這裡）
// ---------------------------------------------------------------------------

export type PlayerCombatAction =
  | { kind: 'attack'; skill?: SkillStatic }
  | { kind: 'heal'; skill: SkillStatic; targetKey: string }
  | { kind: 'item'; item: ItemStatic; targetKey: string }
  | { kind: 'flee' }
  /** 昏迷時跳過回合（正常流程中昏迷會自動跳過，這是保險）。 */
  | { kind: 'skip' };

/** 玩家行動是否合法；不合法時回傳原因。 */
export function getCombatActionBlock(player: PlayerState, action: PlayerCombatAction): string | undefined {
  const combat = player.combat;
  if (!combat || player.isDead) return '目前不在戰鬥中。';
  if (action.kind === 'skip') return undefined;
  if (!canPlayerAct(player)) return '你目前無法行動。';
  // 技能須已解鎖且類型相符（review 第 1 輪 S4）：攻擊用傷害技能、治療用治療技能。
  const skill = action.kind === 'attack' ? action.skill : action.kind === 'heal' ? action.skill : undefined;
  if (skill && !getUnlockedSkills(player.classId, player.level).some((entry) => entry.id === skill.id)) return `你尚未習得${skill.name}。`;
  if (action.kind === 'attack') {
    if (action.skill && action.skill.effect.kind !== 'damage_multiplier') return `${action.skill.name}不是攻擊技能。`;
    if (!getCombatTarget(combat)) return '沒有可攻擊的敵人。';
    if (action.skill && player.mp < action.skill.costMp) return `${action.skill.name}需要 ${action.skill.costMp} MP，目前魔力不足。`;
  }
  if (action.kind === 'heal' || action.kind === 'item') {
    const target = getParticipant(combat, action.targetKey);
    if (target?.side !== 'party') return '只能對我方成員使用。';
    if (action.kind === 'heal' && action.skill.effect.kind !== 'healing') return `${action.skill.name}不是治療技能。`;
    if (action.kind === 'heal' && player.mp < action.skill.costMp) return `${action.skill.name}需要 ${action.skill.costMp} MP，目前魔力不足。`;
    if (action.kind === 'item' && !player.inventory.some((entry) => entry.itemId === action.item.id && entry.quantity > 0)) return `你沒有${action.item.name}。`;
    if (action.kind === 'item' && !action.item.usableInCombat) return `${action.item.name}無法在戰鬥中使用。`;
    // 倒地的同伴只能用復甦效果救起；復甦效果只對倒地的同伴（D9、D35）。
    const downed = !isPlayerKey(action.targetKey) && player.unitInstances[action.targetKey]?.downed === true;
    const revive = action.kind === 'item' && action.item.effect.revive === true;
    if (downed && !revive) return `${partyName(player, action.targetKey)}倒地了，一般治療無法救起，需要復甦效果。`;
    if (revive && !downed) return `${action.item.name}只能對倒地的同伴使用。`;
  }
  return undefined;
}

/**
 * 玩家在自己的回合行動一次，之後同伴與敵人自動結算到下次輪到玩家（D12）。
 * 攻擊與技能打鎖定目標；治療技能與道具可選我方任一人（D21）；逃跑為全隊一起逃（D17）。
 */
export function resolvePlayerCombatAction(player: PlayerState, action: PlayerCombatAction): CombatStepResult | undefined {
  if (getCombatActionBlock(player, action)) return undefined;
  const ctx = newCtx(player);
  // 尚未輪到玩家（例如開戰後還沒結算）：先結算到玩家回合。
  if (!isPlayerTurn(ctx.state)) runUntilPlayerTurn(ctx);
  if (ctx.ended) return toResult(ctx);
  ctx.state = advanceGameTime(ctx.state, 'combatRound');
  if (action.kind === 'skip') {
    ctx.state = tickStatus(ctx.state, PLAYER_UNIT_ID, 'unconscious');
    ctx.lines.push('💫 你仍昏迷，失去本回合行動。');
  } else if (action.kind === 'attack') {
    if (action.skill) ctx.state = { ...ctx.state, mp: ctx.state.mp - action.skill.costMp };
    ctx.lines.push(partyAttack(ctx, PLAYER_UNIT_ID, getCombatTarget(ctx.state.combat!)!.key, { skill: action.skill }));
    if (checkVictory(ctx)) return toResult(ctx);
  } else if (action.kind === 'heal') {
    ctx.state = { ...ctx.state, mp: ctx.state.mp - action.skill.costMp };
    const restored = action.skill.effect.kind === 'healing' ? healPartyMember(ctx, action.targetKey, action.skill.effect.hpRestore) : { hp: 0, mp: 0 };
    ctx.lines.push(`✨ 你對${isPlayerKey(action.targetKey) ? '自己' : partyName(ctx.state, action.targetKey)}施放${action.skill.name}，HP +${restored.hp}、MP -${action.skill.costMp}。`);
  } else if (action.kind === 'item' && action.item.effect.revive) {
    const hp = revivePartyMember(ctx, action.targetKey);
    ctx.state = applyStateChanges(ctx.state, { storyText: '', suggestedActions: [], stateChanges: { removeItems: [{ itemId: action.item.id, quantity: 1 }] } }, 'game');
    ctx.lines.push(`🧪 你對${partyName(ctx.state, action.targetKey)}使用${action.item.name}，${partyName(ctx.state, action.targetKey)}以 ${hp} HP 起身，下一次輪到時才會行動。`);
  } else if (action.kind === 'item') {
    const restored = healPartyMember(ctx, action.targetKey, action.item.effect.hpRestore ?? 0, action.item.effect.mpRestore ?? 0);
    ctx.state = applyStateChanges(ctx.state, { storyText: '', suggestedActions: [], stateChanges: { removeItems: [{ itemId: action.item.id, quantity: 1 }] } }, 'game');
    const details = [restored.hp > 0 ? `HP +${restored.hp}` : '', restored.mp > 0 ? `MP +${restored.mp}` : ''].filter(Boolean).join('、') || '沒有恢復任何數值';
    ctx.lines.push(`🧪 你對${isPlayerKey(action.targetKey) ? '自己' : partyName(ctx.state, action.targetKey)}使用${action.item.name}，${details}。`);
  } else {
    const fled = resolveFleeCheck(ctx);
    if (fled) return toResult(ctx);
  }
  runUntilPlayerTurn(ctx);
  return toResult(ctx);
}

/** 全隊逃跑（D17）：玩家擲速度檢定，DC = dcBase ＋ 站著的敵人中最高 SPD ÷ divisor（捨去）。成功時倒地同伴一起帶走並起身。 */
function resolveFleeCheck(ctx: Ctx): boolean {
  const combat = ctx.state.combat!;
  const rule = combatRules.flee;
  const fastest = getStandingEnemies(combat).map((enemy) => ({ enemy, spd: getWorldUnitById(enemy.unitId, ctx.state)?.stats.spd ?? 0 }))
    .sort((a, b) => b.spd - a.spd)[0];
  const dc = rule.dcBase + Math.floor((fastest?.spd ?? 0) / rule.opponentSpdDivisor);
  const roll = resolveActionCheck(ctx.state, rule.stat, dc);
  ctx.checks.push({ ...roll, stat: rule.stat, reason: `全隊從${fastest?.enemy.label ?? '敵人'}${getStandingEnemies(combat).length > 1 ? '等人' : ''}身邊逃跑`, label: '逃跑檢定' });
  if (!roll.success) {
    ctx.lines.push(`🏃 逃跑失敗，${fastest?.enemy.label ?? '敵人'}擋住了去路。`);
    return false;
  }
  const downed = ctx.state.party.filter((unitId) => ctx.state.unitInstances[unitId]?.downed);
  ctx.state = endCombatForParty(ctx.state);
  ctx.lines.push(`🏃 全隊拉開距離，戰鬥結束。${downed.length ? `你們帶著${downed.map((unitId) => partyName(ctx.state, unitId)).join('、')}撤離，${downed.length > 1 ? '他們' : '對方'}以 ${partyRules.reviveHp} HP 起身。` : ''}`);
  ctx.ended = true;
  return true;
}

/** 切換鎖定目標（D21）：不耗回合。 */
export function switchCombatTarget(player: PlayerState, enemyKey: string): PlayerState | undefined {
  const combat = player.combat;
  if (!combat || !getStandingEnemies(combat).some((enemy) => enemy.key === enemyKey) || combat.targetKey === enemyKey) return undefined;
  return { ...player, combat: { ...combat, targetKey: enemyKey } };
}

// ---------------------------------------------------------------------------
// 開戰
// ---------------------------------------------------------------------------

/** 成群遭遇的數量（D10）：族群樣板依 groupSize 擲數量，唯一個體單獨出現。 */
export function rollGroupSize(unit: WorldUnitStatic): number {
  if (!unit.population || !unit.groupSize) return 1;
  return randomInt(unit.groupSize.min, unit.groupSize.max);
}

/**
 * 建立戰鬥狀態：對非敵對單位動手時先使其敵對（provoke）。地區居民的戰鬥 HP 會保留；需遭遇的單位每次以完整 HP 開始。
 * 族群樣板擲成群數量，每隻各有編號（D10）。遭遇對象設為此單位（玩家先發現與否沿用原本的遭遇）。
 */
export function buildCombatPlayer(player: PlayerState, unitId: string, opening: CombatOpening, groupSize?: number): PlayerState | undefined {
  const unit = getWorldUnitById(unitId, player);
  if (!unit) return undefined;
  const provoked = getWorldUnitDisposition(player, unitId) === 'hostile'
    ? player
    : applyStateChanges(player, { storyText: '', suggestedActions: [], stateChanges: { unitDispositionChanges: [{ unitId, disposition: 'hostile' }] } }, 'game');
  const unitState = unit.population ? undefined : provoked.unitInstances[unit.id];
  const currentHp = unit.requiresEncounter ? unit.stats.hp : unitState?.currentHp ?? unit.stats.hp;
  const count = groupSize ?? rollGroupSize(unit);
  const enemies: CombatEnemySeed[] = unit.population
    ? Array.from({ length: count }, (_, index) => ({ key: `${unit.id}#${index + 1}`, unitId: unit.id, label: count > 1 ? `${unit.name} ${index + 1}` : unit.name, currentHp }))
    : [{ key: unit.id, unitId: unit.id, label: unit.name, currentHp }];
  const encountered = provoked.encounteredUnitId === unitId ? provoked : setEncounter(provoked, unitId, false);
  return { ...encountered, combat: createCombat(encountered, enemies, opening) };
}

/** 開戰訊息開頭：對手（成群時附數量）與行動順序。 */
function describeCombatStart(state: PlayerState): string {
  const combat = state.combat!;
  const enemies = getEnemyParticipants(combat);
  const order = combat.turnOrder.map((key) => {
    const participant = getParticipant(combat, key);
    return participant?.side === 'enemy' ? participant.label : partyName(state, key);
  }).join(' → ');
  return `${enemies.length > 1 ? `對手共 ${enemies.length} 隻。` : ''}行動順序：${order}`;
}

/** 敵方偷襲（O45 D2、D3 失敗、D7；O35-1 D20）：開戰並由每個敵人各先攻一次。 */
export function startEnemyAmbush(player: PlayerState, unit: WorldUnitStatic, prefix: string, prefixChecks: ActionCheckResult[] = []): CombatStepResult {
  const combatPlayer = buildCombatPlayer(player, unit.id, 'enemy_ambush')!;
  const ctx = newCtx(combatPlayer, [`${prefix}⚠️ ${unit.name}搶先出手！${describeCombatStart(combatPlayer)}`], prefixChecks);
  runEnemyOpeningRound(ctx);
  return toResult(ctx);
}

/** 一般開戰（D20：照 SPD；比玩家快的敵人與同伴先行動，結算到玩家回合）。 */
export function startNormalCombat(player: PlayerState, unit: WorldUnitStatic, text: string, checks: ActionCheckResult[] = []): CombatStepResult {
  const combatPlayer = buildCombatPlayer(player, unit.id, 'normal')!;
  const ctx = newCtx(combatPlayer, [text, describeCombatStart(combatPlayer)], checks);
  runUntilPlayerTurn(ctx);
  return toResult(ctx);
}

/**
 * 被找上（O45 D2）：等待、移動途中、敵對居民。察覺成功時玩家先發現（可伏擊、挑戰或離開）；失敗為敵方偷襲。
 * prefix 是發現前的情境說明（例如「你等待了 1 小時，某某出現」）。成群的對抗檢定用敵方最高值（D31；同種個體數值相同）。
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

/** 伏擊（O45 D3；O35-1 D20）：只對玩家先發現的對象。敏捷對抗敵方感知；成功時第一輪只有我方行動，失敗敵方先攻。 */
export function resolveAmbush(player: PlayerState, unit: WorldUnitStatic): CombatStepResult {
  const method = getActionMethod('ambush')!;
  const check = rollOpposedCheck(player, unit, method.checkAbility ?? 'dex', method.dcBase ?? 10, method.dcOpponentAbility ?? 'wis', `伏擊${unit.name}`, '伏擊檢定');
  if (!check.success) return startEnemyAmbush(player, unit, `🗡️ 伏擊失敗，${unit.name}察覺了你的動靜。\n`, [check]);
  const combatPlayer = buildCombatPlayer(player, unit.id, method.onSuccess.opening)!;
  const ctx = newCtx(combatPlayer, [`🗡️ 伏擊成功！我方搶得先手。${describeCombatStart(combatPlayer)}`], [check]);
  runPartyFirstRound(ctx, method.onSuccess.firstStrikeMultiplier ?? 1);
  return toResult(ctx);
}

/**
 * 設陷阱等待（O45 D4）：非安全地區等待一段時間；期間有敵人出現時改擲陷阱檢定（智力對抗敵方感知）。
 * 成功：陷阱打在鎖定的那一隻（敵方最大 HP 的比例傷害），再接我方第一輪；失敗：被察覺，一般開戰。沒有敵人出現就只是等待。
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
  const ctx = newCtx(combatPlayer, [`${prefix}${describeCombatStart(combatPlayer)}`], [check]);
  const defeat = damageEnemy(ctx, target.key, trapDamage, PLAYER_UNIT_ID);
  ctx.lines.push(`${target.label}踩中陷阱，受到 ${trapDamage} 點傷害！${defeat}我方趁機搶得先手。`);
  if (checkVictory(ctx)) return toResult(ctx);
  runPartyFirstRound(ctx, method.onSuccess.firstStrikeMultiplier ?? 1);
  return toResult(ctx);
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
