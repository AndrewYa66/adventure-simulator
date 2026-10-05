import type { PlayerState, PlayerWorldUnit, WorldUnitView } from '../types/game';
import { getCharacterClassById, getPlayerResourceCaps, getUnitExpReward, getWorldUnitById, PLAYER_UNIT_ID } from '../data/staticData';
import { getPlayerStatBreakdown } from './gameChecks';

export const isPlayerUnitId = (unitId: string): boolean => unitId === PLAYER_UNIT_ID;

/** 將玩家存檔轉為共用單位視圖；玩家專屬欄位仍透過 source 讀取，不寫回 NPC/魔物資料。 */
export function getPlayerWorldUnit(player: PlayerState): PlayerWorldUnit {
  const characterClass = getCharacterClassById(player.classId);
  return {
    kind: 'player',
    id: player.unitId,
    name: player.name,
    title: characterClass?.name,
    speciesId: player.speciesId,
    classId: player.classId,
    level: player.level,
    alignment: player.alignment,
    stats: {
      hp: getPlayerResourceCaps(player).maxHp,
      mp: getPlayerResourceCaps(player).maxMp,
      atk: getPlayerStatBreakdown(player, 'atk').statValue,
      def: getPlayerStatBreakdown(player, 'def').statValue,
      spd: getPlayerStatBreakdown(player, 'spd').statValue
    },
    expReward: getUnitExpReward(player),
    mapIds: [player.currentMapId],
    source: player
  };
}

/** 依單位 ID 辨識玩家、NPC 或魔物；NPC/魔物專屬規則仍以 kind 與 source 區分。 */
export function resolveWorldUnit(player: PlayerState, unitId: string): WorldUnitView | undefined {
  return unitId === player.unitId ? getPlayerWorldUnit(player) : getWorldUnitById(unitId, player.unitInstances);
}
