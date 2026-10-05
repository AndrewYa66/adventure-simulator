import type { CharacterAlignment, PlayerState } from '../types/game';
import { createWorldState } from './worldEvents';
import { createDefaultUnitInstances, createInitialReputation, getCharacterClassById, getPlayerResourceCaps, getUnitAbilities, PLAYER_UNIT_ID, scenario } from '../data/staticData';

/** 建立預設新玩家存檔；種族、能力值與資源上限與 NPC/魔物共用種族 × 職階公式。 */
export const createInitialPlayer = (
  playerName = scenario.defaultPlayer.name,
  classId = scenario.defaultPlayer.classId,
  alignment: CharacterAlignment = scenario.defaultPlayer.alignment,
  setupComplete = false
): PlayerState => {
  const requestedClass = getCharacterClassById(classId);
  const characterClass = requestedClass?.playerSelectable ? requestedClass : getCharacterClassById(scenario.defaultPlayer.classId)!;
  const speciesId = scenario.defaultPlayer.speciesId;
  const build = { speciesId, classId: characterClass.id, level: 1 };
  const caps = getPlayerResourceCaps(build);

  return {
    unitId: PLAYER_UNIT_ID,
    name: playerName,
    speciesId,
    classId: characterClass.id,
    alignment,
    setupComplete,
    abilities: getUnitAbilities(build)!,
    isDead: false,
    statusEffects: [],
    level: 1,
    exp: 0,
    hp: caps.maxHp,
    mp: caps.maxMp,
    gold: scenario.start.gold,
    unitInstances: createDefaultUnitInstances(),
    transactionHistory: [],
    currentMapId: scenario.start.mapId,
    gameTimeMinutes: scenario.start.gameTimeMinutes,
    inventory: (characterClass.startingItems ?? []).map((entry) => ({ ...entry })),
    equipped: { ...characterClass.startingEquipment },
    storyFlags: {},
    defeatedMonsters: {},
    unitDispositionOverrides: {},
    factionReputation: createInitialReputation(),
    activeQuests: [],
    world: createWorldState()
  };
};
