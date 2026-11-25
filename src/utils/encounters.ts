import type { ActionCheckResult, PlayerState, WorldUnitStatic } from '../types/game';
import { combatRules, getMapById, getUnitAbilities, getWorldUnitById, getWorldUnitDisposition, getWorldUnitsAtMap } from '../data/staticData';
import { resolveActionCheck } from './gameChecks';
import { STAT_LABELS } from './gameChecks';

/**
 * 遭遇狀態（O45）：遭遇的對象、發生時間，以及是否由玩家先發現。
 * encounteredUnitId 與 encounterInfo 一律經由這裡設定與清除。
 */

type Ability = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

export function setEncounter(player: PlayerState, unitId: string, playerSpottedFirst: boolean): PlayerState {
  return { ...player, encounteredUnitId: unitId, encounterInfo: { startedAtMinutes: player.gameTimeMinutes, playerSpottedFirst } };
}

export function clearEncounter(player: PlayerState): PlayerState {
  if (player.encounteredUnitId === undefined && player.encounterInfo === undefined) return player;
  const next = { ...player };
  delete next.encounteredUnitId;
  delete next.encounterInfo;
  return next;
}

/** 單位的能力值修正（依種族與職階推導；沒有資料時為 0）。 */
export function getUnitAbilityModifier(unit: WorldUnitStatic, ability: Ability): number {
  const score = getUnitAbilities(unit.source)?.[ability];
  return score === undefined ? 0 : Math.floor((score - 10) / 2);
}

/** 以玩家能力值對抗敵方能力值的檢定：DC = dcBase ＋ 敵方能力值修正。 */
export function rollOpposedCheck(player: PlayerState, unit: WorldUnitStatic, ability: Ability, dcBase: number, opponentAbility: Ability, reason: string, label: string): ActionCheckResult {
  const dc = dcBase + getUnitAbilityModifier(unit, opponentAbility);
  return { ...resolveActionCheck(player, ability, dc), stat: ability, reason, label };
}

/** 被找上時的察覺檢定（感知對抗敵方敏捷，可調）。 */
export function rollPerception(player: PlayerState, unit: WorldUnitStatic): ActionCheckResult {
  const rule = combatRules.perception;
  return rollOpposedCheck(player, unit, rule.ability, rule.dcBase, rule.opponentAbility,
    `察覺${unit.name}的接近（${STAT_LABELS[rule.ability]}）`, '察覺檢定');
}

/** 目前遭遇的單位仍在場、存活。 */
export function getEncounteredUnit(player: PlayerState): WorldUnitStatic | undefined {
  if (!player.encounteredUnitId) return undefined;
  const unit = getWorldUnitById(player.encounteredUnitId, player);
  const map = getMapById(player.currentMapId);
  // 與 getCombatStartBlock 的「在場」一致：出現在此地區、列在 unitsPresent、非休眠、存活（review 第 1 輪建議 8）。
  if (!unit || !map || !unit.mapIds.includes(map.id) || !map.unitsPresent.includes(unit.id)) return undefined;
  const state = unit.population ? undefined : player.unitInstances[unit.id];
  if (state?.isDead || state?.currentHp === 0 || state?.isDormant) return undefined;
  return unit;
}

/** 玩家先發現、且對玩家敵對的遭遇：做其他行動時會被強制開戰（D1）。 */
export function getSpottedHostileEncounter(player: PlayerState): WorldUnitStatic | undefined {
  if (player.combat || !player.encounterInfo?.playerSpottedFirst) return undefined;
  const unit = getEncounteredUnit(player);
  return unit && getWorldUnitDisposition(player, unit.id) === 'hostile' ? unit : undefined;
}

/** 可以對其伏擊的遭遇：玩家先發現的對象（D3）。 */
export function getAmbushableUnit(player: PlayerState, unitId?: string): WorldUnitStatic | undefined {
  if (player.combat || !player.encounterInfo?.playerSpottedFirst) return undefined;
  const unit = getEncounteredUnit(player);
  return unit && (!unitId || unit.id === unitId) ? unit : undefined;
}

/**
 * 遭遇失效（D5）：遭遇經過 encounterExpiryMinutes（可調）後清除；戰鬥中不處理。
 * 回傳失效的單位名稱以便提示。
 */
export function expireEncounter(player: PlayerState): { player: PlayerState; expiredUnitName?: string } {
  if (player.combat || !player.encounteredUnitId) return { player };
  const startedAt = player.encounterInfo?.startedAtMinutes;
  const expired = startedAt === undefined || player.gameTimeMinutes - startedAt >= combatRules.encounterExpiryMinutes;
  if (!expired) return { player };
  return { player: clearEncounter(player), expiredUnitName: getWorldUnitById(player.encounteredUnitId, player)?.name ?? player.encounteredUnitId };
}

/**
 * 會主動攻擊的敵對居民（D9、D10）：目前地區在場、存活、非休眠、對玩家敵對的居民（非需遭遇單位）。
 * 同一次停留中已強制開戰過，未滿 residentReaggroMinutes（可調）時不再強制。
 */
export function findAggressiveResident(player: PlayerState): WorldUnitStatic | undefined {
  if (player.combat || player.isDead) return undefined;
  const map = getMapById(player.currentMapId);
  if (!map) return undefined;
  const record = player.residentAggro;
  if (record && record.mapId === map.id && player.gameTimeMinutes - record.atMinutes < combatRules.residentReaggroMinutes) return undefined;
  return getWorldUnitsAtMap(map.id, player).find((unit) => {
    if (unit.requiresEncounter || !map.unitsPresent.includes(unit.id)) return false;
    const state = unit.population ? undefined : player.unitInstances[unit.id];
    if (state?.isDead || state?.currentHp === 0 || state?.isDormant) return false;
    return getWorldUnitDisposition(player, unit.id) === 'hostile';
  });
}

const includesAny = (text: string, patterns: string[]) => patterns.some((pattern) => text.includes(pattern));

/** 打字的戰鬥說法（「補上一劍」「結果了牠的性命」等）。 */
export const isTypedCombatText = (text: string) => includesAny(text, combatRules.typedCombatPatterns);
/** 打字伏擊（「偷襲」「伏擊」等）。 */
export const isTypedAmbushText = (text: string) => includesAny(text, combatRules.ambushPatterns);
/** 打字設陷阱。 */
export const isTypedTrapText = (text: string) => includesAny(text, combatRules.trapPatterns);

/** 敘事中宣稱攻防結果（命中、擊殺、閃避等）的字詞（D14）。 */
export const hasCombatClaim = (storyText: string) => includesAny(storyText, combatRules.claimPatterns);

/** 有遭遇時過濾掉打字戰鬥的建議行動（D15）。 */
export function filterCombatSuggestions(suggestions: string[]): string[] {
  return suggestions.filter((text) => !isTypedCombatText(text) && !isTypedAmbushText(text) &&
    !includesAny(text, combatRules.suggestionFilterPatterns));
}

/** 目前是否有敵人可交戰（遭遇中，或在場有敵對單位）：只在此時偵測攻防宣稱，降低誤判。 */
export function hasEnemyNearby(player: PlayerState): boolean {
  if (getEncounteredUnit(player)) return true;
  const map = getMapById(player.currentMapId);
  if (!map) return false;
  return getWorldUnitsAtMap(map.id, player).some((unit) => {
    if (unit.requiresEncounter) return false;
    const state = unit.population ? undefined : player.unitInstances[unit.id];
    return !state?.isDead && state?.currentHp !== 0 && getWorldUnitDisposition(player, unit.id) === 'hostile';
  });
}
