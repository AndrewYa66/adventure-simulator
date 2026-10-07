import type { MapStatic, PlayerState } from '../types/game';
import { getMapById, mapsDatabase } from '../data/staticData';
import { getReachableRoutes } from './travelRoute';

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
/** 否定、詢問與過去經歷都不是明確的移動指令（例如「你上次去那裡是什麼時候？」）。 */
const blockedPhrases = /(不想|不打算|不去|不前往|不要|先不|暫時不|暂时不|還不|还不|能不能|可不可以|是否|要不要|如何|怎麼|怎么|路線|路线|多遠|多远|多久|在哪|哪裡|哪里|位置|告訴我|告诉我|嗎|吗|？|\?|什麼時候|什么时候|何時|何时|上次|以前|曾|安全|危險|危险)/;
const directionPhrases = /(前往|前去|走到|移動到|移动到|進入|进入|出發前往|出发前往|帶我去|带我去|我要去|我想去|我決定去|我决定去|去往|出發去|出发去|去|到|往|回到|返回|折返|回村|回森林|回去)/;

/** 移動動詞後多少字內出現其他地區名稱才算宣稱換區。 */
const MOVE_CLAIM_WINDOW = 16;
/** 移動動詞前多少字內檢查非實際移動的語氣。 */
const MOVE_CLAIM_LOOKBEHIND = 6;
/** 引號內的對話（人物的回憶、建議）不是敘事宣稱，比對前移除。 */
const quotedSpeech = /「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/gu;
/** 動詞前出現這些詞時，代表過去經歷、假設或打算，不是玩家此刻已移動。 */
const nonActualMovePrefix = /(曾|曾經|上次|以前|過去|当年|當年|打算|準備|准备|計劃|计划|想要|想|要|將|将|會|会|可以|能|若|如果|假如|等你|一旦|才能)\s*$/u;

/**
 * 敘事宣稱玩家已抵達的「其他地區」（O44）。只有移動動詞後緊接其他地圖的名稱、別名或分類詞才算；
 * 「你走進旅館」「你來到櫃檯前」這類同地區內的走動不算，避免誤觸移動修正請求與警示。
 * currentMapId 是玩家實際所在地；ignoreMapIds 是本回合合法經過的地區（例如多段移動的途經地區），提到它們不算宣稱。
 */
export function getClaimedArrivalMapIds(text: string, currentMapId: string, ignoreMapIds: readonly string[] = []): string[] {
  const currentTags = new Set(getMapById(currentMapId)?.locationTags ?? []);
  const others = mapsDatabase.filter((map) => map.id !== currentMapId && !ignoreMapIds.includes(map.id)).map((map) => ({
    id: map.id,
    labels: [
      map.name,
      ...(map.aliases ?? []),
      ...(map.locationTags ?? []).filter((tag) => !currentTags.has(tag)).flatMap((tag) => destinationCategoryPhrases[tag] ?? [])
    ].filter((label) => label.length >= 2)
  }));
  const moveVerb = /(?:抵達|抵达|到達|到达|來到|来到|回到|返回|走進|走进|踏入|進入|进入|回到了|到了)/gu;
  const narration = text.replace(quotedSpeech, (speech) => ' '.repeat(speech.length));
  const claimed = new Set<string>();
  for (const match of narration.matchAll(moveVerb)) {
    if (nonActualMovePrefix.test(narration.slice(Math.max(0, match.index - MOVE_CLAIM_LOOKBEHIND), match.index))) continue;
    const following = narration.slice(match.index + match[0].length, match.index + match[0].length + MOVE_CLAIM_WINDOW);
    for (const map of others) if (map.labels.some((label) => following.includes(label))) claimed.add(map.id);
  }
  return [...claimed];
}

/** 敘事是否宣稱玩家已移動到「其他地區」。 */
export const storyClaimsPlayerMoved = (text: string, currentMapId: string): boolean =>
  getClaimedArrivalMapIds(text, currentMapId).length > 0;

export function hasExplicitTravelIntent(actionText: string): boolean {
  const normalized = actionText.toLocaleLowerCase();
  return !blockedPhrases.test(normalized) && directionPhrases.test(normalized);
}

export function resolveExplicitTravelIntent(actionText: string, player: PlayerState): TravelIntentResolution {
  const normalized = actionText.toLocaleLowerCase();
  if (!hasExplicitTravelIntent(normalized)) return { kind: 'none' };

  // 候選是所有可抵達的地區（O44：不相鄰者由規則沿最短路徑逐段移動）。
  const routes = getReachableRoutes(player);
  const candidates = [...routes.keys()].map((mapId) => getMapById(mapId)).filter((map): map is MapStatic => !!map);
  const namedMatches = candidates.filter((map) => [map.name, ...(map.aliases ?? [])]
    .some((label) => label && normalized.includes(label.toLocaleLowerCase())));
  let matches = namedMatches;
  const requestedTags = new Set<string>();

  if (matches.length === 0) {
    for (const [tag, phrases] of Object.entries(destinationCategoryPhrases)) {
      if (phrases.some((phrase) => normalized.includes(phrase.toLocaleLowerCase()))) requestedTags.add(tag);
    }
    // 泛稱（例如「回村」）只取最近的符合地區；同樣近的有多個時才請玩家選擇。
    const tagged = candidates.filter((map) => (map.locationTags ?? []).some((tag) => requestedTags.has(tag)));
    const nearest = Math.min(...tagged.map((map) => routes.get(map.id)!.length));
    matches = tagged.filter((map) => routes.get(map.id)!.length === nearest);
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
