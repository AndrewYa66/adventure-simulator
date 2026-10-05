import type { PlayerState } from '../types/game';

const MINUTES_PER_DAY = 24 * 60;

/** 依「已確認的設計決策」：每種行動固定耗時（分鐘），不由 AI 決定。 */
export const ACTION_DURATIONS = {
  dialogue: 10,
  trade: 10,
  travel: 120,
  rest: 480,
  combatRound: 1,
  quick: 1
} as const;

export type TimedAction = keyof typeof ACTION_DURATIONS;

export function isValidGameTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function advanceGameTime(player: PlayerState, action: TimedAction): PlayerState {
  return { ...player, gameTimeMinutes: player.gameTimeMinutes + ACTION_DURATIONS[action] };
}

export function getGameDay(minutes: number): number {
  return Math.floor(minutes / MINUTES_PER_DAY) + 1;
}

/** 例如「第 1 天 08:00」。 */
export function formatGameTime(minutes: number): string {
  const minuteOfDay = minutes % MINUTES_PER_DAY;
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const mm = String(minuteOfDay % 60).padStart(2, '0');
  return `第 ${getGameDay(minutes)} 天 ${hh}:${mm}`;
}

/** 原地等待：唯一可變時長的行動，由玩家明確指定，單次上限 8 小時；只推進時間，不回復資源。 */
export const MAX_WAIT_MINUTES = 8 * 60;

export function isValidWaitMinutes(minutes: number): boolean {
  return Number.isSafeInteger(minutes) && minutes > 0 && minutes <= MAX_WAIT_MINUTES;
}

export function waitGameTime(player: PlayerState, minutes: number): PlayerState {
  if (!isValidWaitMinutes(minutes)) return player;
  return { ...player, gameTimeMinutes: player.gameTimeMinutes + minutes };
}

/** 例如「2 小時 30 分鐘」。 */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} 小時` : '', rest ? `${rest} 分鐘` : ''].filter(Boolean).join(' ') || '0 分鐘';
}
