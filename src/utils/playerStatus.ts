import type { PlayerState } from '../types/game';

export function isPlayerUnconscious(player: PlayerState): boolean {
  return player.statusEffects.some((effect) => effect.id === 'unconscious' && effect.remainingTurns > 0);
}

export function canPlayerAct(player: PlayerState): boolean {
  return !player.isDead && !isPlayerUnconscious(player);
}
