import type { PlayerState } from '../types/game';
import { getPlayerGrowthByLevel } from '../data/staticData';

/** 建立預設新玩家存檔 */
export const createInitialPlayer = (playerName: string = '亞瑟'): PlayerState => {
  // 自動向靜態資料庫查詢 Level 1 的血量與魔力上限
  const lv1Stats = getPlayerGrowthByLevel(1);

  return {
    name: playerName,
    level: 1,
    exp: 0,
    hp: lv1Stats?.maxHp ?? 100,
    mp: lv1Stats?.maxMp ?? 30,
    gold: 50,
    currentMapId: 'MAP-001',
    inventory: [
      { itemId: 'ITEM-001', quantity: 2 },
      { itemId: 'ITEM-002', quantity: 1 }
    ],
    equipped: {
      weaponItemId: 'ITEM-101',
      armorItemId: 'ITEM-201'
    },
    storyFlags: {},
    activeQuests: []
  };
};