import type { PlayerState, WorldUnitStatic } from '../types/game';
import { getFactionReputation, getReputationTierIndex, getReputationTier, getUnitTemplateById, getWorldUnitById, getWorldUnitDisposition, isUnitAtMap, partyRules } from '../data/staticData';

/**
 * 隊伍（O35-1）：同伴只由規則入隊（選項列邀請、劇情片段或事件效果），AI 敘事不能宣布入隊或離隊。
 * 隊伍成員記在角色層（party），所在地永遠等於玩家所在地；HP、MP、狀態記在世界層的單位實例。
 */

/** 隊伍成員的單位視圖（依入隊順序）。 */
export function getPartyMembers(state: PlayerState): WorldUnitStatic[] {
  return state.party.flatMap((unitId) => {
    const unit = getWorldUnitById(unitId, state);
    return unit ? [unit] : [];
  });
}

/** 同伴的目前 HP、MP（實例未記錄時為全滿）。 */
export function getCompanionResources(state: PlayerState, unit: WorldUnitStatic): { hp: number; maxHp: number; mp: number; maxMp: number; downed: boolean } {
  const instance = state.unitInstances[unit.id];
  return {
    hp: instance?.currentHp ?? unit.stats.hp,
    maxHp: unit.stats.hp,
    mp: Math.min(instance?.currentMp ?? unit.stats.mp, unit.stats.mp),
    maxMp: unit.stats.mp,
    downed: instance?.downed === true
  };
}

const isAlive = (state: PlayerState, unitId: string) => {
  const instance = state.unitInstances[unitId];
  return !!instance && !instance.isDead && !instance.isDormant && (instance.currentHp !== 0 || instance.downed === true);
};

/** 入隊條件（資料的 joinConditions）；不成立時回傳原因。 */
function getJoinConditionBlock(state: PlayerState, unit: WorldUnitStatic): string | undefined {
  const conditions = unit.companion?.joinConditions ?? {};
  if (conditions.notHostile && getWorldUnitDisposition(state, unit.id) === 'hostile') return `${unit.name}對你懷有敵意。`;
  if ((conditions.flags ?? []).some((flag) => !state.storyFlags[flag]) || (conditions.excludesFlags ?? []).some((flag) => state.storyFlags[flag])) {
    return `${unit.name}目前不願同行。`;
  }
  for (const requirement of conditions.reputation ?? []) {
    const index = getReputationTierIndex(getReputationTier(getFactionReputation(state, requirement.factionId)).id);
    const min = requirement.minTier ? getReputationTierIndex(requirement.minTier) : -Infinity;
    const max = requirement.maxTier ? getReputationTierIndex(requirement.maxTier) : Infinity;
    if (index < min || index > max) return `${unit.name}還不夠信任你。`;
  }
  return undefined;
}

/** 選項列邀請同行的條件（D4、D30）：可招募、在場、存活、條件成立、隊伍未滿、不在戰鬥中。不能邀請時回傳原因。 */
export function getInviteBlock(state: PlayerState, unitId: string): string | undefined {
  const unit = getWorldUnitById(unitId, state);
  if (!unit?.companion?.recruitable) return '這個人物不會加入隊伍。';
  if (state.combat) return '戰鬥中無法邀請同伴。';
  if (state.party.includes(unitId)) return `${unit.name}已經在隊伍中。`;
  if (!isUnitAtMap(state, unitId, state.currentMapId) || !isAlive(state, unitId)) return `${unit.name}不在這裡。`;
  if (state.party.length >= partyRules.maxCompanions) return `隊伍已滿（最多 ${partyRules.maxCompanions} 位同伴）。`;
  return getJoinConditionBlock(state, unit);
}

/** 加入隊伍（不檢查條件；呼叫端負責驗證）。 */
export function joinParty(state: PlayerState, unitId: string): PlayerState {
  return state.party.includes(unitId) ? state : { ...state, party: [...state.party, unitId] };
}

/** 離開隊伍：同伴回到原居所（所在地由規則推導，移出隊伍即回到居所）；戰鬥狀態不帶走。 */
export function leaveParty(state: PlayerState, unitId: string): PlayerState {
  if (!state.party.includes(unitId)) return state;
  const instance = state.unitInstances[unitId];
  const unitInstances = instance?.statusEffects?.length || instance?.downed
    ? { ...state.unitInstances, [unitId]: { ...instance, statusEffects: [], downed: false } } : state.unitInstances;
  return { ...state, party: state.party.filter((id) => id !== unitId), unitInstances };
}

/**
 * 劇情片段或事件的入隊、離隊效果（D4）：只接受可招募的存活單位；入隊不檢查資料的入隊條件，但隊伍已滿時略過。
 * 回傳實際入隊、離隊的單位，供事件紀錄與訊息使用。
 */
export function applyPartyEffects(state: PlayerState, effects: { partyJoin?: string[]; partyLeave?: string[] }): { state: PlayerState; joined: string[]; left: string[] } {
  let next = state;
  const joined: string[] = [];
  const left: string[] = [];
  for (const unitId of effects.partyLeave ?? []) {
    if (!next.party.includes(unitId)) continue;
    next = leaveParty(next, unitId);
    left.push(unitId);
  }
  for (const unitId of effects.partyJoin ?? []) {
    if (!getUnitTemplateById(unitId)?.companion?.recruitable || !isAlive(next, unitId) || next.party.includes(unitId) ||
        next.party.length >= partyRules.maxCompanions) continue;
    next = joinParty(next, unitId);
    joined.push(unitId);
  }
  return { state: next, joined, left };
}

/**
 * 自動離隊（D30）：同伴死亡、或同伴（含所屬勢力）對玩家轉為敵對時離開隊伍，回到原居所。戰鬥中不處理。
 * 回傳離隊者與原因，呼叫端以系統訊息告知。
 */
export function removeInvalidPartyMembers(state: PlayerState): { state: PlayerState; notices: string[] } {
  if (state.combat || !state.party.length) return { state, notices: [] };
  let next = state;
  const notices: string[] = [];
  for (const unitId of state.party) {
    const name = getWorldUnitById(unitId)?.name ?? unitId;
    const dead = !isAlive(next, unitId);
    const hostile = !dead && getWorldUnitDisposition(next, unitId) === 'hostile';
    if (!dead && !hostile) continue;
    next = dead ? { ...next, party: next.party.filter((id) => id !== unitId) } : leaveParty(next, unitId);
    notices.push(dead ? `${name}已經不在人世，離開了隊伍。` : `${name}對你轉為敵對，離開隊伍回到了原處。`);
  }
  return { state: next, notices };
}

/** 玩家恢復資源時隊伍一起恢復（D16）：同伴 HP、MP 補滿，解除倒地與狀態。 */
export function restorePartyResources(state: PlayerState): PlayerState {
  if (!state.party.length) return state;
  const unitInstances = { ...state.unitInstances };
  for (const unit of getPartyMembers(state)) {
    const instance = unitInstances[unit.id];
    if (!instance || instance.isDead) continue;
    unitInstances[unit.id] = { ...instance, currentHp: unit.stats.hp, currentMp: unit.stats.mp, downed: false, statusEffects: [] };
  }
  return { ...state, unitInstances };
}

/** 隊伍中是否有人（含玩家）HP 或 MP 未滿；休息服務用。 */
export function partyNeedsRest(state: PlayerState): boolean {
  return getPartyMembers(state).some((unit) => {
    const resources = getCompanionResources(state, unit);
    return resources.hp < resources.maxHp || resources.mp < resources.maxMp;
  });
}
