import type { PlayerState } from '../types/game';
import { getStoryEndingById } from '../data/staticData';

export function isPlayerUnconscious(player: PlayerState): boolean {
  return player.statusEffects.some((effect) => effect.id === 'unconscious' && effect.remainingTurns > 0);
}

/** 時間線已結束（O33）：達成的結局設定為 end，播放尾聲後不能再行動，只能讀檔。 */
export function isTimelineEnded(player: PlayerState): boolean {
  const ending = player.world.story.ending;
  return !!ending && getStoryEndingById(ending.id)?.afterEnding === 'end';
}

export function canPlayerAct(player: PlayerState): boolean {
  return !player.isDead && !isPlayerUnconscious(player) && !isTimelineEnded(player);
}
