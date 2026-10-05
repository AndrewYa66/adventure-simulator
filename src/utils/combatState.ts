import type { CombatParticipant, CombatState } from '../types/game';

export type EnemyParticipant = Extract<CombatParticipant, { side: 'enemy' }>;

/** 建立戰鬥：我方參與者 + 敵方清單（含各自目前 HP），預設鎖定第一個敵人。 */
export function createCombat(partyUnitIds: string[], enemies: { unitId: string; currentHp: number }[]): CombatState {
  return {
    round: 1,
    participants: [
      ...partyUnitIds.map((unitId) => ({ unitId, side: 'party' as const })),
      ...enemies.map((enemy) => ({ unitId: enemy.unitId, side: 'enemy' as const, currentHp: enemy.currentHp }))
    ],
    targetUnitId: enemies[0]?.unitId ?? ''
  };
}

export const getEnemyParticipants = (combat: CombatState): EnemyParticipant[] =>
  combat.participants.filter((participant): participant is EnemyParticipant => participant.side === 'enemy');

/** 玩家目前鎖定的敵人；目標失效時退回第一個敵人。 */
export function getCombatTarget(combat: CombatState): EnemyParticipant | undefined {
  const enemies = getEnemyParticipants(combat);
  return enemies.find((enemy) => enemy.unitId === combat.targetUnitId) ?? enemies[0];
}

export function setEnemyHp(combat: CombatState, unitId: string, currentHp: number): CombatState {
  return {
    ...combat,
    participants: combat.participants.map((participant) =>
      participant.side === 'enemy' && participant.unitId === unitId ? { ...participant, currentHp } : participant)
  };
}
