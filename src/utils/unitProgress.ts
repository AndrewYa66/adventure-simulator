import type { UnitInstance } from '../types/game';
import { createDefaultUnitInstance, getUnitLevelCap, getWorldUnitById, levelBenchmarksDatabase, unitTemplatesDatabase } from '../data/staticData';
import { resolveLevelFromExp } from './unitGrowth';

export interface UnitExpResult {
  instances: Record<string, UnitInstance>;
  previousLevel: number;
  level: number;
}

/**
 * NPC/魔物實例獲得經驗並依等級基準表升級（與玩家同一升級規則）。
 * 魔物上限為出沒地區建議等級 +3；升級增加的 HP 上限同步補到目前 HP。死亡個體不再成長。
 */
export function grantUnitExp(instances: Record<string, UnitInstance>, unitId: string, amount: number): UnitExpResult | undefined {
  const template = unitTemplatesDatabase().find((entry) => entry.id === unitId);
  if (!template || !Number.isSafeInteger(amount) || amount <= 0) return undefined;
  const current = instances[unitId] ?? createDefaultUnitInstance(template);
  if (current.isDead) return undefined;

  const exp = current.exp + amount;
  const level = resolveLevelFromExp(levelBenchmarksDatabase, current.level, exp, getUnitLevelCap(unitId));
  const previousMaxHp = getWorldUnitById(unitId, instances)?.stats.hp ?? 1;
  const nextMaxHp = getWorldUnitById(unitId, { [unitId]: { level } })?.stats.hp ?? previousMaxHp;
  const currentHp = Math.min(nextMaxHp, (current.currentHp ?? previousMaxHp) + Math.max(0, nextMaxHp - previousMaxHp));
  return {
    instances: { ...instances, [unitId]: { ...current, exp, level, currentHp } },
    previousLevel: current.level,
    level
  };
}
