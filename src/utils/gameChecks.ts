import type { PlayerState } from '../types/game';
import { getItemById, getPlayerGrowthByLevel } from '../data/staticData';

export interface CheckResult {
  die: number;
  modifier: number;
  total: number;
  dc: number;
  success: boolean;
}

function randomD20(): number {
  if (!globalThis.crypto?.getRandomValues) throw new Error('目前瀏覽器無法產生安全骰點，請更新瀏覽器後重試。');
  const range = 0x1_0000_0000;
  const limit = range - (range % 20);
  const values = new Uint32Array(1);
  do {
    globalThis.crypto.getRandomValues(values);
  } while (values[0] >= limit);
  return (values[0] % 20) + 1;
}

export function resolveActionCheck(
  player: PlayerState,
  stat: 'atk' | 'def' | 'spd',
  dc: number
): CheckResult {
  const growth = getPlayerGrowthByLevel(player.level);
  const base = stat === 'atk' ? growth?.baseAtk ?? 10 : stat === 'def' ? growth?.baseDef ?? 5 : growth?.spd ?? 10;
  const equipmentIds = [player.equipped.weaponItemId, player.equipped.armorItemId, player.equipped.accessoryItemId];
  const bonus = equipmentIds.reduce((total, itemId) => {
    const effect = itemId ? getItemById(itemId)?.effect : undefined;
    const value = stat === 'atk' ? effect?.atkBonus : stat === 'def' ? effect?.defBonus : effect?.spdBonus;
    return total + (value ?? 0);
  }, 0);
  const modifier = Math.floor((base + bonus - 10) / 2);
  const die = randomD20();
  const total = die + modifier;
  return { die, modifier, total, dc, success: total >= dc };
}
