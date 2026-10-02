import type { PlayerState, QuestStatic } from '../types/game';
import { getMapById, getNpcById } from '../data/staticData';

export function canAcceptQuest(player: PlayerState, quest: QuestStatic): boolean {
  if (player.activeQuests.some((entry) => entry.questId === quest.id)) return false;
  if (player.currentMapId !== quest.mapId) return false;

  const map = getMapById(player.currentMapId);
  const giver = getNpcById(quest.questGiverId);
  return !!map && !!giver && giver.mapId === map.id && map.npcsPresent.includes(giver.id);
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
