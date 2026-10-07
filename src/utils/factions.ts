import type { EventKnownBy, FactionConditions, FactionEffects, PlayerState, WorldRuntimeState } from '../types/game';
import {
  clampReputation,
  createInitialReputation,
  factionData,
  factionRelationKey,
  factionsDatabase,
  getFactionById,
  getFactionRelation,
  getFactionReputation,
  getMapById,
  getReputationTier,
  getReputationTierIndex,
  getUnitFactionId
} from '../data/staticData';

/**
 * 勢力聲望與勢力間關係（O38）。
 * 聲望只經由事件改變，而且只影響得知該事件的勢力；勢力資料全部來自 factions.json，程式不寫死任何勢力。
 */

const unique = (ids: (string | undefined)[]): string[] => [...new Set(ids.filter((id): id is string => !!id))];

/** 一組單位所屬的勢力。 */
export const getFactionsOfUnits = (unitIds: readonly string[]): string[] => unique(unitIds.map(getUnitFactionId));

/** 在某地區有存活成員（不含潛伏單位）的勢力。 */
function getFactionsPresentAt(state: Pick<PlayerState, 'unitInstances'>, mapId: string): string[] {
  const map = getMapById(mapId);
  if (!map) return [];
  return getFactionsOfUnits(map.unitsPresent.filter((unitId) => {
    const instance = state.unitInstances[unitId];
    return !!instance && !instance.isDead && instance.currentHp !== 0;
  }));
}

/**
 * 依傳播範圍決定哪些勢力得知事件（至少公開結果）：
 * 目擊者 → 目擊者所屬勢力；同勢力 → 指定勢力與目擊者勢力；本地區 → 另加在該地區有成員的勢力；全世界 → 所有勢力。
 */
export function getAwareFactionIds(
  state: Pick<PlayerState, 'unitInstances'>,
  scope: { knownBy: EventKnownBy; mapId: string; witnessUnitIds: readonly string[]; knownByFactions?: readonly string[] }
): string[] {
  if (scope.knownBy === 'world') return factionsDatabase.map((faction) => faction.id);
  const witnesses = getFactionsOfUnits(scope.witnessUnitIds);
  if (scope.knownBy === 'faction') return unique([...(scope.knownByFactions ?? []), ...witnesses]);
  if (scope.knownBy === 'region') return unique([...witnesses, ...getFactionsPresentAt(state, scope.mapId)]);
  return witnesses;
}

/** 勢力條件是否成立（聲望等級區間、勢力間關係）；事件與日後的劇情片段、任務範本共用。 */
export function matchesFactionConditions(state: Pick<PlayerState, 'factionReputation' | 'world'>, conditions: FactionConditions): boolean {
  const reputationMet = (conditions.reputation ?? []).every((condition) => {
    const tierIndex = getReputationTierIndex(getReputationTier(getFactionReputation(state, condition.factionId)).id);
    return (condition.minTier === undefined || tierIndex >= getReputationTierIndex(condition.minTier)) &&
      (condition.maxTier === undefined || tierIndex <= getReputationTierIndex(condition.maxTier));
  });
  return reputationMet && (conditions.factionRelations ?? []).every((condition) =>
    condition.status.includes(getFactionRelation(state.world, ...condition.factionIds).status));
}

/** 合併同一勢力的多筆變化並去除 0。 */
export function mergeReputationChanges(changes: readonly { factionId: string; change: number }[]): { factionId: string; change: number }[] {
  const totals = new Map<string, number>();
  for (const { factionId, change } of changes) {
    if (getFactionById(factionId)) totals.set(factionId, (totals.get(factionId) ?? 0) + change);
  }
  return [...totals].filter(([, change]) => change !== 0).map(([factionId, change]) => ({ factionId, change }));
}

/** 套用聲望變化（夾在聲望上下限內）。 */
export function applyReputationChanges<T extends Pick<PlayerState, 'factionReputation'>>(state: T, changes: readonly { factionId: string; change: number }[]): T {
  if (!changes.length) return state;
  const factionReputation = { ...state.factionReputation };
  for (const { factionId, change } of changes) {
    factionReputation[factionId] = clampReputation(getFactionReputation(state, factionId) + change);
  }
  return { ...state, factionReputation };
}

/** 套用勢力間關係變化；與 factions.json 初始值相同的組合不保存（存檔只保存差異）。 */
export function applyFactionRelationChanges(world: WorldRuntimeState, changes: FactionEffects['factionRelations'] = []): WorldRuntimeState {
  if (!changes.length) return world;
  const factionRelations = { ...world.factionRelations };
  for (const change of changes) {
    const [a, b] = change.factionIds;
    const current = getFactionRelation({ factionRelations }, a, b);
    const tags = unique([...current.tags.filter((tag) => !(change.removeTags ?? []).includes(tag)), ...(change.addTags ?? [])]);
    const next = { status: change.status ?? current.status, tags };
    const key = factionRelationKey(a, b);
    delete factionRelations[key];
    const initial = getFactionRelation({ factionRelations }, a, b);
    if (initial.status !== next.status || initial.tags.slice().sort().join() !== next.tags.slice().sort().join()) factionRelations[key] = next;
  }
  return { ...world, factionRelations };
}

/** 例如「某勢力 −40（中立→冷淡）」。 */
export function describeReputationChanges(before: Pick<PlayerState, 'factionReputation'>, changes: readonly { factionId: string; change: number }[]): string {
  return changes.map(({ factionId, change }) => {
    const previous = getFactionReputation(before, factionId);
    const next = clampReputation(previous + change);
    const fromTier = getReputationTier(previous).name;
    const toTier = getReputationTier(next).name;
    return `${getFactionById(factionId)?.name ?? factionId} ${change > 0 ? '+' : '−'}${Math.abs(change)}${fromTier !== toTier ? `（${fromTier}→${toTier}）` : ''}`;
  }).join('、');
}

/**
 * 新角色的初始聲望：預設重置為各勢力初始值；劇本允許且玩家選擇與前角色有關聯時，
 * 繼承前角色聲望變化量的一部分（新 = 初始 + 比例 ×（前角色 − 初始））。
 */
export function createSuccessorReputation(previous: Pick<PlayerState, 'factionReputation'> | undefined, ratio = 0): Record<string, number> {
  const initial = createInitialReputation();
  if (!previous || !(ratio > 0)) return initial;
  return Object.fromEntries(Object.entries(initial).map(([factionId, value]) =>
    [factionId, clampReputation(value + ratio * (getFactionReputation(previous, factionId) - value))]));
}

/** 勢力關係的顯示名稱。 */
export const RELATION_NAMES = { war: '交戰', hostile: '敵對', tense: '緊張', neutral: '中立', friendly: '友好', alliance: '同盟' } as const;

/** 提供給主持人 AI 的勢力資訊：各勢力對玩家的聲望、非中立的勢力關係，以及在場人物所屬勢力的公開簡介。 */
export function getFactionContextForAI(state: Pick<PlayerState, 'factionReputation' | 'world' | 'currentMapId' | 'unitInstances'>) {
  const tagName = (tag: string) => factionData.relationTags.find((entry) => entry.id === tag)?.name ?? tag;
  const relations = factionsDatabase.flatMap((a, index) => factionsDatabase.slice(index + 1).flatMap((b) => {
    const relation = getFactionRelation(state.world, a.id, b.id);
    return relation.status !== 'neutral' || relation.tags.length
      ? [{ between: [a.name, b.name], status: RELATION_NAMES[relation.status], ...(relation.tags.length ? { tags: relation.tags.map(tagName) } : {}) }]
      : [];
  }));
  return {
    reputation: factionsDatabase.map((faction) => {
      const value = getFactionReputation(state, faction.id);
      return { id: faction.id, name: faction.name, reputation: value, tier: getReputationTier(value).name };
    }),
    relations,
    presentFactions: getFactionsPresentAt(state, state.currentMapId).map((factionId) => ({ name: getFactionById(factionId)?.name ?? factionId, summary: getFactionById(factionId)?.summary ?? '' }))
  };
}

/** 聲望規則（factions.json）。 */
export const reputationRules = factionData.reputation.rules;
