import type { GeneratedQuest, PlayerState, QuestStatic } from '../types/game';
import { getMapById, getQuestById, getUnitDisplayName, getWorldUnitById, getWorldUnitDisposition, questsDatabase } from '../data/staticData';

/** 依任務範本生成的委託（O30）。 */
export const isGeneratedQuest = (quest: QuestStatic | undefined): quest is GeneratedQuest => (quest as GeneratedQuest | undefined)?.generated === true;

/** 任務查詢：靜態任務資料優先，其次是世界中依範本生成的委託。 */
export const findQuest = (state: Pick<PlayerState, 'world'>, questId: string): QuestStatic | GeneratedQuest | undefined =>
  getQuestById(questId) ?? state.world.generatedQuests.find((quest) => quest.id === questId);

/** 玩家可看見的全部任務：靜態任務，加上仍開放或與目前角色有關的生成委託。 */
export const listVisibleQuests = (player: Pick<PlayerState, 'world' | 'activeQuests'>): (QuestStatic | GeneratedQuest)[] => [
  ...questsDatabase,
  ...player.world.generatedQuests.filter((quest) => quest.status === 'open' || player.activeQuests.some((entry) => entry.questId === quest.id))
];

type QuestGiverSource = Pick<PlayerState, 'currentMapId' | 'unitInstances' | 'unitDispositionOverrides' | 'factionReputation'>;

/** 目前負責某個進行中委託的人：接手者優先，否則為任務資料中的原委託人。 */
export const getActiveQuestGiverId = (active: PlayerState['activeQuests'][number] | undefined, questGiverId: string): string =>
  active?.giverUnitId ?? questGiverId;

/** 玩家目前這個委託的委託人 ID（尚未接取時為原委託人）。 */
export const getQuestGiverId = (player: Pick<PlayerState, 'activeQuests'>, quest: QuestStatic): string =>
  getActiveQuestGiverId(player.activeQuests.find((entry) => entry.questId === quest.id), quest.questGiverId);

/** 委託人顯示名稱；接手者以職稱 + 名字顯示。 */
export const getQuestGiverName = (player: Pick<PlayerState, 'activeQuests'>, quest: QuestStatic): string => {
  const giverId = getQuestGiverId(player, quest);
  return giverId === quest.questGiverId ? quest.questGiver : getUnitDisplayName(giverId);
};

/**
 * 委託人是否可在目前地區互動：在場、存活、非敵對。
 * 原委託人另需位於任務指定地圖；接手者則以其所在地為準。
 */
export function canReachQuestGiver(player: QuestGiverSource, quest: QuestStatic, giverId: string): boolean {
  const map = getMapById(player.currentMapId);
  const giver = getWorldUnitById(giverId);
  return !!map && giver?.kind === 'npc' && !player.unitInstances[giver.id]?.isDead && player.unitInstances[giver.id]?.currentHp !== 0 &&
    getWorldUnitDisposition(player, giver.id) !== 'hostile' && giver.mapIds.includes(map.id) && map.npcsPresent.includes(giver.id) &&
    (giverId !== quest.questGiverId || map.id === quest.mapId);
}

export function canAcceptQuest(player: PlayerState, quest: QuestStatic): boolean {
  if (player.activeQuests.some((entry) => entry.questId === quest.id)) return false;
  if (isGeneratedQuest(quest) && (quest.status !== 'open' || player.gameTimeMinutes >= quest.expiresAtMinutes)) return false;
  if (player.currentMapId !== quest.mapId) return false;
  if (!(quest.prerequisiteQuestIds ?? []).every((requiredId) =>
    player.activeQuests.some((entry) => entry.questId === requiredId && entry.status === 'completed')
  )) return false;
  return canReachQuestGiver(player, quest, quest.questGiverId);
}

export function canTurnInQuest(player: PlayerState, quest: QuestStatic): boolean {
  const active = player.activeQuests.find((entry) => entry.questId === quest.id && entry.status === 'in_progress');
  if (!active || !canReachQuestGiver(player, quest, getActiveQuestGiverId(active, quest.questGiverId))) return false;
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
