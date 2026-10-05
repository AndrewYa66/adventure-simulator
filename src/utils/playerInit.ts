import type { CharacterAlignment, PlayerState } from '../types/game';
import { createDefaultNpcWorldState, getCharacterClassById, getPlayerResourceCaps, npcsDatabase, PLAYER_UNIT_ID } from '../data/staticData';
import { GAME_START_MINUTES } from './gameTime';

/** 建立預設新玩家存檔 */
export const createInitialPlayer = (
  playerName = '亞瑟',
  classId = 'adventurer',
  alignment: CharacterAlignment = '絕對中立',
  setupComplete = false
): PlayerState => {
  const characterClass = getCharacterClassById(classId) ?? getCharacterClassById('adventurer')!;
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
    gold: 50,
    npcStates: Object.fromEntries(npcsDatabase.map((npc) => [npc.id, createDefaultNpcWorldState(npc)])),
    transactionHistory: [],
    currentMapId: 'MAP-001',
    gameTimeMinutes: GAME_START_MINUTES,
    inventory: characterClass.startingItems.map((entry) => ({ ...entry })),
    equipped: { ...characterClass.startingEquipment },
    storyFlags: {},
    defeatedMonsters: {},
    unitDispositionOverrides: {},
    activeQuests: []
  };
};
