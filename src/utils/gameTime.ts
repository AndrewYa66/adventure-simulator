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
