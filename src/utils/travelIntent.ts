import type { MapStatic, PlayerState } from '../types/game';
import { canPlayerEnterMap, getMapById } from '../data/staticData';

export type TravelIntentResolution =
  | { kind: 'resolved'; destination: MapStatic }
  | { kind: 'ambiguous'; candidates: MapStatic[] }
  | { kind: 'none' };

const destinationCategoryPhrases: Record<string, string[]> = {
  village: ['村莊', '村庄', '村子', '村落', '村', '回村', '返村'],
  settlement: ['城鎮', '城镇', '城裡', '城里', '城內', '城内'],
  forest: ['森林', '樹林', '树林', '林地', '回森林', '回林子'],
  wilderness: ['野外', '荒野']
};
const returnPhrases = ['回到', '返回', '折返', '回村', '返村', '回森林', '回林子', '回去'];
const blockedPhrases = /(不想|不打算|不去|不前往|不要|先不|暫時不|暂时不|還不|还不|能不能|可不可以|是否|要不要|如何|怎麼|怎么|路線|路线|多遠|多远|多久|在哪|哪裡|哪里|位置|告訴我|告诉我)/;
const directionPhrases = /(前往|前去|走到|移動到|移动到|進入|进入|出發前往|出发前往|帶我去|带我去|我要去|我想去|我決定去|我决定去|去往|出發去|出发去|去|到|往|回到|返回|折返|回村|回森林|回去)/;

export function storyClaimsPlayerMoved(text: string): boolean {
  return /(?:你|玩家)(?:已經|已|終於|终于|順利|顺利)?(?:抵達|抵达|到達|到达|來到|来到|回到|返回|走進|走进|踏入|進入|进入|回到了|到了)/.test(text);
}

export function hasExplicitTravelIntent(actionText: string): boolean {
  const normalized = actionText.toLocaleLowerCase();
  return !blockedPhrases.test(normalized) && directionPhrases.test(normalized);
}

export function resolveExplicitTravelIntent(actionText: string, player: PlayerState): TravelIntentResolution {
  const normalized = actionText.toLocaleLowerCase();
  if (!hasExplicitTravelIntent(normalized)) return { kind: 'none' };

  const currentMap = getMapById(player.currentMapId);
  const candidates = currentMap?.connectedMapIds
    .map((mapId) => getMapById(mapId))
    .filter((map): map is MapStatic => !!map && canPlayerEnterMap(player, map)) ?? [];
  const namedMatches = candidates.filter((map) => [map.name, ...(map.aliases ?? [])]
    .some((label) => label && normalized.includes(label.toLocaleLowerCase())));
  let matches = namedMatches;
  const requestedTags = new Set<string>();

  if (matches.length === 0) {
    for (const [tag, phrases] of Object.entries(destinationCategoryPhrases)) {
      if (phrases.some((phrase) => normalized.includes(phrase.toLocaleLowerCase()))) requestedTags.add(tag);
    }
    matches = candidates.filter((map) => (map.locationTags ?? []).some((tag) => requestedTags.has(tag)));
  }

  const isReturning = returnPhrases.some((phrase) => normalized.includes(phrase));
  if (isReturning && player.previousMapId) {
    const previousDestination = candidates.find((map) => map.id === player.previousMapId);
    const previousMatchesIntent = matches.some((map) => map.id === player.previousMapId) ||
      (namedMatches.length === 0 && requestedTags.size === 0);
    if (previousDestination && previousMatchesIntent) return { kind: 'resolved', destination: previousDestination };
  }
  if (matches.length === 1) return { kind: 'resolved', destination: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches };
  return { kind: 'none' };
}
