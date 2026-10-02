import type { PlayerState, QuestStatic } from '../types/game';
import { getMapById, getNpcById } from '../data/staticData';

export function canAcceptQuest(player: PlayerState, quest: QuestStatic): boolean {
  if (player.activeQuests.some((entry) => entry.questId === quest.id)) return false;
  if (player.currentMapId !== quest.mapId) return false;
  if (!(quest.prerequisiteQuestIds ?? []).every((requiredId) =>
    player.activeQuests.some((entry) => entry.questId === requiredId && entry.status === 'completed')
  )) return false;

  const map = getMapById(player.currentMapId);
  const giver = getNpcById(quest.questGiverId);
  return !!map && !!giver && giver.mapId === map.id && map.npcsPresent.includes(giver.id);
}

export function canTurnInQuest(player: PlayerState, quest: QuestStatic): boolean {
  const active = player.activeQuests.find((entry) => entry.questId === quest.id && entry.status === 'in_progress');
  const map = getMapById(player.currentMapId);
  if (!active || !map || map.id !== quest.mapId || !map.npcsPresent.includes(quest.questGiverId)) return false;
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
