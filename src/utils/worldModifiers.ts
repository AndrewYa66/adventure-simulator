import type { UnitStatBlock, WorldModifier, WorldModifierScope } from '../types/game';
import { UNIT_STAT_KEYS } from './unitGrowth';

/** 世界修正的作用對象描述：單位 ID、種族與所在地區。 */
export interface ModifierTarget {
  unitId: string;
  speciesId: string;
  mapIds: string[];
}

export function parseModifierScope(scope: string): { kind: 'unit' | 'species' | 'map'; id: string } | undefined {
  const match = /^(unit|species|map):(.+)$/.exec(scope);
  return match ? { kind: match[1] as 'unit' | 'species' | 'map', id: match[2] } : undefined;
}

export function modifierAppliesTo(scope: WorldModifierScope, target: ModifierTarget): boolean {
  const parsed = parseModifierScope(scope);
  if (!parsed) return false;
  if (parsed.kind === 'unit') return parsed.id === target.unitId;
  if (parsed.kind === 'species') return parsed.id === target.speciesId;
  return target.mapIds.includes(parsed.id);
}

export const isModifierActive = (modifier: WorldModifier, nowMinutes?: number): boolean =>
  modifier.expiresAtMinutes === undefined || nowMinutes === undefined || nowMinutes < modifier.expiresAtMinutes;

/**
 * 將世界修正疊加到公式數值：同一數值先加總所有加減值，再乘上所有倍率，最後取整數。
 * 修正一律為相對值，靜態基礎數值調整後仍會正確疊加。
 */
export function applyWorldModifiers(stats: UnitStatBlock, target: ModifierTarget, modifiers: readonly WorldModifier[] = [], nowMinutes?: number): UnitStatBlock {
  const relevant = modifiers.filter((modifier) => isModifierActive(modifier, nowMinutes) && modifierAppliesTo(modifier.scope, target));
  if (!relevant.length) return stats;
  const next = { ...stats };
  for (const key of UNIT_STAT_KEYS) {
    const added = relevant.filter((modifier) => modifier.stat === key && modifier.op === 'add').reduce((total, modifier) => total + modifier.value, 0);
    const multiplier = relevant.filter((modifier) => modifier.stat === key && modifier.op === 'multiply').reduce((total, modifier) => total * modifier.value, 1);
    next[key] = Math.max(key === 'hp' ? 1 : 0, Math.round((stats[key] + added) * multiplier));
  }
  return next;
}
