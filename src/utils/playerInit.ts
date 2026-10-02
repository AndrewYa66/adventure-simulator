import type { CharacterAlignment, PlayerState } from '../types/game';
import { getCharacterClassById, getPlayerResourceCaps, npcsDatabase } from '../data/staticData';

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
    npcStates: Object.fromEntries(npcsDatabase.map((npc) => [npc.id, {
      gold: npc.startingGold ?? 0,
      inventory: (npc.startingInventory ?? []).map((entry) => ({ ...entry }))
    }])),
    transactionHistory: [],
    currentMapId: 'MAP-001',
    inventory: characterClass.startingItems.map((entry) => ({ ...entry })),
    equipped: { ...characterClass.startingEquipment },
    storyFlags: {},
    defeatedMonsters: {},
    activeQuests: []
  };
};
