import type { CharacterAlignment, PlayerState } from '../types/game';
import { createDefaultNpcWorldState, getCharacterClassById, getPlayerResourceCaps, npcsDatabase, PLAYER_UNIT_ID, scenario } from '../data/staticData';

/** 建立預設新玩家存檔 */
export const createInitialPlayer = (
  playerName = scenario.defaultPlayer.name,
  classId = scenario.defaultPlayer.classId,
  alignment: CharacterAlignment = scenario.defaultPlayer.alignment,
  setupComplete = false
): PlayerState => {
  const characterClass = getCharacterClassById(classId) ?? getCharacterClassById(scenario.defaultPlayer.classId)!;
  const caps = getPlayerResourceCaps(1, characterClass.id);

  return {
    unitId: PLAYER_UNIT_ID,
    name: playerName,
    classId: characterClass.id,
    alignment,
    setupComplete,
    abilities: { ...characterClass.baseAbilities },
    isDead: false,
    statusEffects: [],
    level: 1,
    exp: 0,
    hp: caps.maxHp,
    mp: caps.maxMp,
    gold: scenario.start.gold,
    npcStates: Object.fromEntries(npcsDatabase.map((npc) => [npc.id, createDefaultNpcWorldState(npc)])),
    transactionHistory: [],
    currentMapId: scenario.start.mapId,
    gameTimeMinutes: scenario.start.gameTimeMinutes,
    inventory: characterClass.startingItems.map((entry) => ({ ...entry })),
    equipped: { ...characterClass.startingEquipment },
    storyFlags: {},
    defeatedMonsters: {},
    unitDispositionOverrides: {},
    activeQuests: []
  };
};
