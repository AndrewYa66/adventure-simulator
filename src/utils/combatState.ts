import type { CombatOpening, CombatParticipant, CombatState, PlayerState } from '../types/game';
import { getWorldUnitById, PLAYER_UNIT_ID } from '../data/staticData';
import { getPlayerStatBreakdown } from './gameChecks';

export type EnemyParticipant = Extract<CombatParticipant, { side: 'enemy' }>;
export type PartyParticipant = Extract<CombatParticipant, { side: 'party' }>;

/** 開戰時的敵方個體：key 為戰鬥內編號，label 為顯示名稱（成群時附序號）。 */
export interface CombatEnemySeed { key: string; unitId: string; label: string; currentHp: number }

/** 參與者的速度：玩家含裝備，其他單位取單位視圖（含世界修正）。 */
export function getParticipantSpd(player: PlayerState, participant: CombatParticipant): number {
  if (participant.unitId === PLAYER_UNIT_ID) return getPlayerStatBreakdown(player, 'spd').statValue;
  return getWorldUnitById(participant.unitId, player)?.stats.spd ?? 0;
}

/**
 * 行動順序（O35-1 D11）：開戰時依 SPD 由高到低排一次，整場固定；同速時我方優先、我方內玩家優先，其餘依參與者順序。不擲骰。
 */
export function buildTurnOrder(player: PlayerState, participants: CombatParticipant[]): string[] {
  return participants
    .map((participant, index) => ({ participant, index, spd: getParticipantSpd(player, participant) }))
    .sort((a, b) => b.spd - a.spd
      || Number(b.participant.side === 'party') - Number(a.participant.side === 'party')
      || Number(b.participant.unitId === PLAYER_UNIT_ID) - Number(a.participant.unitId === PLAYER_UNIT_ID)
      || a.index - b.index)
    .map((entry) => entry.participant.key);
}

/**
 * 建立戰鬥：我方為玩家與隊伍同伴，敵方為開戰時的個體。預設鎖定第一個敵人。
 * 一般、伏擊、陷阱從第 1 回合開始；敵方偷襲以第 0 回合表示先攻一擊。turnIndex 為 -1 代表尚未有人行動。
 */
export function createCombat(player: PlayerState, enemies: CombatEnemySeed[], opening: CombatOpening): CombatState {
  const participants: CombatParticipant[] = [
    { key: PLAYER_UNIT_ID, unitId: PLAYER_UNIT_ID, side: 'party' },
    ...player.party.map((unitId): CombatParticipant => ({ key: unitId, unitId, side: 'party' })),
    ...enemies.map((enemy): CombatParticipant => ({ key: enemy.key, unitId: enemy.unitId, side: 'enemy', label: enemy.label, currentHp: enemy.currentHp }))
  ];
  return {
    round: opening === 'enemy_ambush' ? 0 : 1,
    participants,
    turnOrder: buildTurnOrder(player, participants),
    turnIndex: -1,
    targetKey: enemies[0]?.key ?? '',
    opening
  };
}

export const getEnemyParticipants = (combat: CombatState): EnemyParticipant[] =>
  combat.participants.filter((participant): participant is EnemyParticipant => participant.side === 'enemy');

/** 還站著（HP 大於 0）的敵人。 */
export const getStandingEnemies = (combat: CombatState): EnemyParticipant[] =>
  getEnemyParticipants(combat).filter((enemy) => enemy.currentHp > 0);

export const getParticipant = (combat: CombatState, key: string): CombatParticipant | undefined =>
  combat.participants.find((participant) => participant.key === key);

/** 玩家目前鎖定的敵人；鎖定的已倒下時退回第一個站著的敵人。 */
export function getCombatTarget(combat: CombatState): EnemyParticipant | undefined {
  const standing = getStandingEnemies(combat);
  return standing.find((enemy) => enemy.key === combat.targetKey) ?? standing[0];
}

export function setEnemyHp(combat: CombatState, key: string, currentHp: number): CombatState {
  return {
    ...combat,
    participants: combat.participants.map((participant) =>
      participant.side === 'enemy' && participant.key === key ? { ...participant, currentHp } : participant)
  };
}

/** 目前行動者的 key；尚未有人行動時為 undefined。 */
export const getCurrentActorKey = (combat: CombatState): string | undefined => combat.turnOrder[combat.turnIndex];
