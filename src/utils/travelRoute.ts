import type { MapStatic, PlayerState } from '../types/game';
import { canPlayerEnterMap, getMapById, scenario } from '../data/staticData';
import { ACTION_DURATIONS, advanceGameTime } from './gameTime';
import { rollWaitInterruption } from './waitRules';

/**
 * 多段移動（O44）：前往不相鄰但可抵達的地區時，由規則沿最短路徑逐段移動，每段照常耗時；
 * 途經的中間地區若不安全，比照等待擲遭遇，被打斷就停在該地區。
 */

/** 從目前地區到各可抵達地區的最短路徑（不含起點），遵守地圖前置任務。 */
export function getReachableRoutes(player: PlayerState): Map<string, string[]> {
  const routes = new Map<string, string[]>([[player.currentMapId, []]]);
  const queue = [player.currentMapId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const nextId of getMapById(current)?.connectedMapIds ?? []) {
      const next = getMapById(nextId);
      if (!next || routes.has(nextId) || !canPlayerEnterMap(player, next)) continue;
      routes.set(nextId, [...routes.get(current)!, nextId]);
      queue.push(nextId);
    }
  }
  routes.delete(player.currentMapId);
  return routes;
}

export const findTravelRoute = (player: PlayerState, destinationMapId: string): string[] | undefined =>
  getReachableRoutes(player).get(destinationMapId);

export interface RouteTravelResult {
  player: PlayerState;
  /** 出發的地區。 */
  origin: MapStatic;
  /** 原本要前往的地區。 */
  destination: MapStatic;
  /** 實際停下的地區（抵達、被打斷或超過單次段數時為中途地區）。 */
  arrived: MapStatic;
  /** 途經（已走過、未停留）的地區，不含出發地與停下的地區。 */
  passed: MapStatic[];
  elapsedMinutes: number;
  /** 途中遭遇而停下時的單位。 */
  interruptedByUnitId?: string;
  /** 因單次段數上限而未抵達。 */
  stoppedBySegmentLimit: boolean;
}

/**
 * 沿最短路徑移動到目的地；目的地無法抵達時回傳 null。呼叫端負責檢查戰鬥與行動能力。
 * 抵達最後一段不擲遭遇（與單段移動一致），只有途經的中間地區會擲。
 */
export function travelAlongRoute(player: PlayerState, destinationMapId: string, random?: () => number): RouteTravelResult | null {
  const route = findTravelRoute(player, destinationMapId);
  const origin = getMapById(player.currentMapId);
  const destination = getMapById(destinationMapId);
  if (!route?.length || !origin || !destination) return null;
  const steps = route.slice(0, Math.max(1, scenario.rules.routeTravel.maxSegmentsPerAction));
  let current = player;
  let interruptedByUnitId: string | undefined;
  for (const [index, mapId] of steps.entries()) {
    current = advanceGameTime({ ...current, previousMapId: current.currentMapId, currentMapId: mapId, encounteredUnitId: undefined }, 'travel');
    if (index === route.length - 1) break;
    const roll = rollWaitInterruption(current, ACTION_DURATIONS.travel, random);
    if (roll.unitId) {
      interruptedByUnitId = roll.unitId;
      current = { ...current, encounteredUnitId: roll.unitId };
      break;
    }
  }
  const traveled = route.slice(0, route.indexOf(current.currentMapId) + 1);
  return {
    player: current,
    origin,
    destination,
    arrived: getMapById(current.currentMapId)!,
    passed: traveled.slice(0, -1).map((mapId) => getMapById(mapId)!),
    elapsedMinutes: current.gameTimeMinutes - player.gameTimeMinutes,
    interruptedByUnitId,
    stoppedBySegmentLimit: !interruptedByUnitId && current.currentMapId !== destinationMapId
  };
}
