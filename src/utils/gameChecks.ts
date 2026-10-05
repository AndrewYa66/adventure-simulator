import type { ActionCheckResult, PlayerState } from '../types/game';
import { getCharacterClassById, getItemById, getPlayerBaseStats, getSpeciesById } from '../data/staticData';
import { computeCheckBonus } from './unitGrowth';

export const STAT_LABELS: Record<ActionCheckResult['stat'], string> = {
  atk: '攻擊',
  def: '防禦',
  spd: '速度',
  str: '力量',
  dex: '敏捷',
  con: '體質',
  int: '智力',
  wis: '感知',
  cha: '魅力'
};

export interface PlayerStatBreakdown {
  baseStat: number;
  equipmentBonus: number;
  statValue: number;
  /** 種族與職階資料定義的檢定加值，已計入 modifier。 */
  checkBonus: number;
  modifier: number;
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

export function getPlayerStatBreakdown(
  player: PlayerState,
  stat: ActionCheckResult['stat']
): PlayerStatBreakdown {
  const abilityStat = ['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(stat);
  // 戰鬥數值與 NPC/魔物同一公式（種族 × 職階 × 等級），玩家另加裝備。
  const baseStat = abilityStat
    ? player.abilities[stat as keyof PlayerState['abilities']]
    : getPlayerBaseStats(player)[stat as 'atk' | 'def' | 'spd'];
  const equipmentIds = [player.equipped.weaponItemId, player.equipped.armorItemId, player.equipped.accessoryItemId];
  const equipmentBonus = equipmentIds.reduce((total, itemId) => {
    const effect = itemId ? getItemById(itemId)?.effect : undefined;
    const value = stat === 'atk' ? effect?.atkBonus : stat === 'def' ? effect?.defBonus : stat === 'spd' ? effect?.spdBonus : 0;
    return total + (value ?? 0);
  }, 0);
  const statValue = baseStat + equipmentBonus;
  const checkBonus = computeCheckBonus(getSpeciesById(player.speciesId), getCharacterClassById(player.classId), stat);
  return { baseStat, equipmentBonus, statValue, checkBonus, modifier: Math.floor((statValue - 10) / 2) + checkBonus };
}

export function resolveActionCheck(
  player: PlayerState,
  stat: ActionCheckResult['stat'],
  dc: number
): Omit<ActionCheckResult, 'reason' | 'stat'> {
  const breakdown = getPlayerStatBreakdown(player, stat);
  const d20 = randomD20();
  const total = d20 + breakdown.modifier;
  return { ...breakdown, d20Rolls: [d20], total, dc, success: total >= dc };
}
