import type { PlayerState, QuestStatic } from '../types/game';
import { getMapById, getWorldUnitById, getWorldUnitDisposition } from '../data/staticData';

export function canAcceptQuest(player: PlayerState, quest: QuestStatic): boolean {
  if (player.activeQuests.some((entry) => entry.questId === quest.id)) return false;
  if (player.currentMapId !== quest.mapId) return false;
  if (!(quest.prerequisiteQuestIds ?? []).every((requiredId) =>
    player.activeQuests.some((entry) => entry.questId === requiredId && entry.status === 'completed')
  )) return false;

  const map = getMapById(player.currentMapId);
  const giver = getWorldUnitById(quest.questGiverId);
  return !!map && giver?.kind === 'npc' && !player.npcStates[giver.id]?.isDead && player.npcStates[giver.id]?.currentHp !== 0 && getWorldUnitDisposition(player, giver.id) !== 'hostile' &&
    giver.mapIds.includes(map.id) && map.npcsPresent.includes(giver.id);
}

export function canTurnInQuest(player: PlayerState, quest: QuestStatic): boolean {
  const active = player.activeQuests.find((entry) => entry.questId === quest.id && entry.status === 'in_progress');
  const map = getMapById(player.currentMapId);
  const giver = getWorldUnitById(quest.questGiverId);
  if (!active || !map || giver?.kind !== 'npc' || map.id !== quest.mapId ||
      player.npcStates[giver.id]?.isDead || player.npcStates[giver.id]?.currentHp === 0 || getWorldUnitDisposition(player, giver.id) === 'hostile' || !giver.mapIds.includes(map.id) || !map.npcsPresent.includes(giver.id)) return false;
  const defeatsMet = (quest.requirements.defeatMonsters ?? []).every((requirement) =>
    (active.progress?.defeatedMonsters[requirement.monsterId] ?? 0) >= requirement.quantity
  );
  const itemsMet = (quest.requirements.collectItems ?? []).every((requirement) =>
    (player.inventory.find((item) => item.itemId === requirement.itemId)?.quantity ?? 0) >= requirement.quantity
  );
  return defeatsMet && itemsMet;
}

export function acceptQuest(player: PlayerState, quest: QuestStatic): PlayerState | null {
  if (!canAcceptQuest(player, quest)) return null;
  return {
    ...player,
    activeQuests: [...player.activeQuests, {
      questId: quest.id,
      status: 'in_progress',
      progress: { defeatedMonsters: {} }
    }]
  };
}
