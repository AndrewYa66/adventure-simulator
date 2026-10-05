import type { PlayerState } from '../types/game';
import { getMapById, getWorldUnitById, getWorldUnitDisposition } from '../data/staticData';

/** 非安全地區每等待一小時被敵人打斷的機率；防止以等待安穩推進時間刷補貨與重生。 */
export const WAIT_INTERRUPT_CHANCE_PER_HOUR = 0.15;

function randomUnit(): number {
  if (!globalThis.crypto?.getRandomValues) return Math.random();
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return values[0] / 0x1_0000_0000;
}

/** 等待時可能出現的敵人：所在地區、存活、對玩家敵對且符合任務前置條件的魔物。 */
export function getWaitInterruptCandidates(player: PlayerState): string[] {
  const map = getMapById(player.currentMapId);
  if (!map || map.isSafeZone) return [];
  return map.monstersPresent.filter((unitId) => {
    const unit = getWorldUnitById(unitId);
    const instance = player.unitInstances[unitId];
    return unit?.kind === 'monster' && !instance?.isDead && instance?.currentHp !== 0 && getWorldUnitDisposition(player, unitId) === 'hostile' &&
      (!unit.source.requiredQuestId || player.activeQuests.some((quest) => quest.questId === unit.source.requiredQuestId && quest.status === 'in_progress'));
  });
}

/**
 * 決定等待是否被打斷：每滿一小時擲骰一次，打斷時只經過到該小時為止的時間，並遭遇一名候選敵人。
 * 安全地區不會被打斷。
 */
export function rollWaitInterruption(player: PlayerState, minutes: number, random: () => number = randomUnit): { elapsedMinutes: number; monsterId?: string } {
  const candidates = getWaitInterruptCandidates(player);
  if (!candidates.length) return { elapsedMinutes: minutes };
  for (let hour = 1; hour * 60 <= minutes; hour += 1) {
    if (random() < WAIT_INTERRUPT_CHANCE_PER_HOUR) {
      return { elapsedMinutes: hour * 60, monsterId: candidates[Math.floor(random() * candidates.length) % candidates.length] };
    }
  }
  return { elapsedMinutes: minutes };
}
