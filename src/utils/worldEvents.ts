import type { CharacterHistoryEntry, DeathCause, EventStatic, PlayerState, UnitInstance, WorldEvent, WorldModifier, WorldRuntimeState } from '../types/game';
import {
  aiContextConfig,
  createDefaultUnitInstance,
  describeUnitBuild,
  eventsDatabase,
  getCharacterClassById,
  getEventById,
  getFactionById,
  getFactionRelation,
  getMapById,
  getResidentUnitIds,
  getShopForUnit,
  getSpeciesById,
  getUnitDisplayName,
  getUnitFactionId,
  getWorldUnitById,
  getWorldUnitDisposition,
  PLAYER_UNIT_ID,
  unitTemplatesDatabase
} from '../data/staticData';
import { formatGameTime, getGameDay } from './gameTime';
import { isModifierActive } from './worldModifiers';
import { findQuest, getActiveQuestGiverId, isGeneratedQuest } from './questRules';
import { closeGeneratedQuest, expireGeneratedQuests, pruneGeneratedQuests } from './generatedQuests';
import {
  applyFactionRelationChanges,
  applyReputationChanges,
  describeReputationChanges,
  getAwareFactionIds,
  getFactionsOfUnits,
  matchesFactionConditions,
  mergeReputationChanges,
  reputationRules
} from './factions';

/**
 * 世界事件與世界規則（O29）。
 * 世界的永久變動（死亡、重生、劇情事件、世界修正、旗標）只經由本模組的事件入口套用並寫入事件紀錄；
 * 商人補貨等例行結算記錄在地區狀態，不寫入事件紀錄，避免紀錄被例行變化淹沒。
 */

/** 事件紀錄上限；超過時最舊的事件壓縮成編年史一行。 */
export const MAX_WORLD_EVENTS = 200;
export const MAX_CHRONICLE_LINES = 100;
const MINUTES_PER_DAY = 24 * 60;

export function createWorldState(): WorldRuntimeState {
  return { events: [], chronicle: [], nextEventSeq: 1, modifiers: [], firedEventIds: [], regions: {}, factionRelations: {}, generatedQuests: [], nextGeneratedQuestSeq: 1, unitMemories: {} };
}

export interface DeathHint {
  cause: DeathCause;
  killerUnitId?: string;
  /** 死因補充，例如檢定理由。 */
  note?: string;
}

const isUnitDead = (instance: UnitInstance | undefined) => !!instance && (instance.isDead === true || instance.currentHp === 0);
const isUnitAlive = (state: PlayerState, unitId: string) => !!state.unitInstances[unitId] && !isUnitDead(state.unitInstances[unitId]);
/** 確實死亡過（潛伏單位雖不在場，但沒有死亡）。 */
const hasUnitDied = (instance: UnitInstance | undefined) => isUnitDead(instance) && !instance?.isDormant;

/** 玩家角色的顯示名稱，例如「冒險者亞瑟」。 */
export const getCharacterDisplayName = (player: Pick<PlayerState, 'name' | 'classId'>) =>
  `${getCharacterClassById(player.classId)?.name ?? ''}${player.name}`;

/** 具名且唯一的單位（非族群樣板）死亡後不會重生。 */
function isUniqueUnit(unitId: string): boolean {
  const unit = getWorldUnitById(unitId);
  return !!unit && !unit.population;
}

/** 事件寫入的唯一入口：配發序號、依傳播範圍決定得知事件的勢力，並附加到紀錄。 */
function appendEvent(state: PlayerState, event: Omit<WorldEvent, 'id' | 'awareFactionIds'> & { knownByFactions?: string[] }): { state: PlayerState; event: WorldEvent } {
  const world = state.world;
  const { knownByFactions, ...fields } = event;
  const awareFactionIds = getAwareFactionIds(state, { knownBy: event.knownBy, mapId: event.mapId, witnessUnitIds: event.witnessUnitIds, knownByFactions });
  const created: WorldEvent = { id: `WE-${String(world.nextEventSeq).padStart(5, '0')}`, ...fields, awareFactionIds, characterSeq: state.characterSeq };
  return { state: { ...state, world: { ...world, events: [...world.events, created], nextEventSeq: world.nextEventSeq + 1 } }, event: created };
}

/**
 * 事件發生時的目擊者：該地區在場且存活的居民，以及戰鬥中或已遭遇的單位。
 * 位置與戰鬥取自事件前的狀態，存活與否取自事件後的狀態。
 */
function getWitnesses(before: PlayerState, after: PlayerState, mapId: string, exclude: string[]): string[] {
  const map = getMapById(mapId);
  if (!map) return [];
  const engaged = [
    ...(before.combat?.participants.filter((participant) => participant.side === 'enemy').map((participant) => participant.unitId) ?? []),
    ...(before.encounteredUnitId ? [before.encounteredUnitId] : [])
  ].filter((unitId) => map.unitsPresent.includes(unitId) && !isUnitDead(after.unitInstances[unitId]));
  const residents = getResidentUnitIds(map).filter((unitId) => isUnitAlive(after, unitId));
  return [...new Set([...residents, ...engaged])].filter((unitId) => !exclude.includes(unitId));
}

function describeDeath(victimName: string, mapName: string, hint: DeathHint, killerName?: string) {
  const summary = `${victimName}在${mapName}死亡。`;
  const detail = hint.cause === 'combat' && killerName ? `${killerName}在戰鬥中殺死了${victimName}。`
    : hint.cause === 'self_inflicted' ? `${victimName}自我了斷${hint.note ? `（${hint.note}）` : ''}。`
      : hint.cause === 'misadventure' ? `${victimName}在${hint.note ? `「${hint.note}」時` : '一場意外中'}喪命。`
        : undefined;
  return { summary, detail };
}

/** 由事件前的戰鬥狀態推斷死因；呼叫端未提供死因時使用。 */
function inferDeathHint(before: PlayerState, victimUnitId: string): DeathHint {
  const enemies = before.combat?.participants.filter((participant) => participant.side === 'enemy').map((participant) => participant.unitId) ?? [];
  if (victimUnitId === PLAYER_UNIT_ID) return before.combat ? { cause: 'combat', killerUnitId: before.combat.targetUnitId } : { cause: 'misadventure' };
  return enemies.includes(victimUnitId) ? { cause: 'combat', killerUnitId: PLAYER_UNIT_ID } : { cause: 'unknown' };
}

function recordDeath(before: PlayerState, state: PlayerState, victimUnitId: string, hint: DeathHint): PlayerState {
  const mapId = before.currentMapId;
  const mapName = getMapById(mapId)?.name ?? mapId;
  const victimName = victimUnitId === PLAYER_UNIT_ID ? getCharacterDisplayName(state) : getUnitDisplayName(victimUnitId);
  const killerName = hint.killerUnitId === PLAYER_UNIT_ID ? getCharacterDisplayName(state) : hint.killerUnitId ? getUnitDisplayName(hint.killerUnitId) : undefined;
  const { summary, detail } = describeDeath(victimName, mapName, hint, killerName);
  const witnesses = getWitnesses(before, state, mapId, [victimUnitId]);
  const appended = appendEvent(state, {
    type: 'unit_death', gameTimeMinutes: state.gameTimeMinutes, mapId, summary, ...(detail ? { detail } : {}),
    knownBy: 'region', witnessUnitIds: witnesses,
    cause: hint.cause === 'combat' ? '戰鬥' : hint.cause === 'self_inflicted' ? '自我了斷' : hint.cause === 'misadventure' ? '意外' : '不明',
    death: { victimUnitId, victimName, cause: hint.cause, ...(hint.killerUnitId ? { killerUnitId: hint.killerUnitId, killerName } : {}) },
    changes: { unitIds: [victimUnitId] }
  });
  if (victimUnitId === PLAYER_UNIT_ID) return appended.state;
  const instance = appended.state.unitInstances[victimUnitId];
  return { ...appended.state, unitInstances: { ...appended.state.unitInstances, [victimUnitId]: { ...instance, currentHp: 0, isDead: true, diedAtMinutes: state.gameTimeMinutes } } };
}

/** 接手委託的人選：與原委託人同勢力、同職階且存活的地區居民，優先選同一地區的人。 */
export function findQuestSuccessor(state: PlayerState, giverUnitId: string): string | undefined {
  const giver = getWorldUnitById(giverUnitId);
  if (!giver || giver.requiresEncounter || !giver.factionId || !giver.classId) return undefined;
  const candidates = unitTemplatesDatabase().filter((template) => !template.requiresEncounter && template.id !== giverUnitId &&
    template.factionId === giver.factionId && template.classId === giver.classId && isUnitAlive(state, template.id));
  return (candidates.find((template) => getWorldUnitById(template.id)?.homeMapId === giver.homeMapId) ?? candidates[0])?.id;
}

/**
 * 委託人死亡時，由同勢力、同職階的存活居民接手；沒有人選時委託失敗。玩家進行中的委託兩者都寫入事件。
 * 尚未被接取的生成委託同樣改由接手者負責（不寫事件）；失敗的生成委託退回預扣報酬。
 */
function resolveOrphanedQuests(state: PlayerState): PlayerState {
  let next = state;
  for (const quest of state.world.generatedQuests) {
    if (quest.status !== 'open' || state.activeQuests.some((entry) => entry.questId === quest.id) || !isUnitDead(next.unitInstances[quest.questGiverId])) continue;
    const successor = findQuestSuccessor(next, quest.questGiverId);
    const successorUnit = successor ? getWorldUnitById(successor) : undefined;
    next = successorUnit
      ? { ...next, world: { ...next.world, generatedQuests: next.world.generatedQuests.map((entry) => entry.id === quest.id
        ? { ...entry, questGiverId: successorUnit.id, questGiver: getUnitDisplayName(successorUnit.id), mapId: successorUnit.homeMapId } : entry) } }
      : closeGeneratedQuest(next, quest.id, 'failed', quest.questGiverId);
  }
  for (const active of state.activeQuests) {
    const quest = findQuest(next, active.questId);
    if (active.status !== 'in_progress' || !quest) continue;
    const giverId = getActiveQuestGiverId(active, quest.questGiverId);
    if (!isUnitDead(next.unitInstances[giverId])) continue;
    const successorId = findQuestSuccessor(next, giverId);
    const successor = successorId ? getWorldUnitById(successorId) : undefined;
    next = {
      ...next,
      activeQuests: next.activeQuests.map((entry) => entry.questId !== quest.id || entry.status !== 'in_progress' ? entry
        : successorId ? { ...entry, giverUnitId: successorId } : { ...entry, status: 'failed' as const })
    };
    if (!successorId && isGeneratedQuest(quest)) next = closeGeneratedQuest(next, quest.id, 'failed', giverId);
    next = successor?.factionId
      ? appendEvent(next, {
        type: 'quest_transferred', gameTimeMinutes: next.gameTimeMinutes, mapId: successor.homeMapId,
        summary: `因${getUnitDisplayName(giverId)}身亡，委託「${quest.title}」改由${getUnitDisplayName(successor.id)}接手。`,
        knownBy: 'faction', knownByFactions: [successor.factionId], witnessUnitIds: [], cause: '委託人死亡，同勢力同職階接手',
        changes: { questIds: [quest.id], unitIds: [giverId, successor.id] }
      }).state
      : appendEvent(next, {
        type: 'quest_failed', gameTimeMinutes: next.gameTimeMinutes, mapId: quest.mapId,
        summary: `因${getUnitDisplayName(giverId)}身亡，委託「${quest.title}」已無法完成。`,
        knownBy: 'witnesses', witnessUnitIds: [], cause: '委託人死亡', changes: { questIds: [quest.id] }
      }).state;
  }
  return next;
}

/** 地區延後結算：只結算玩家所在地區，依經過的遊戲日補貨（每日最多一次）與重生非唯一單位。 */
function settleRegion(state: PlayerState, mapId: string): PlayerState {
  const map = getMapById(mapId);
  if (!map) return state;
  const day = getGameDay(state.gameTimeMinutes);
  const region = state.world.regions[mapId];
  let next = state;
  if (!region || day > region.lastRestockDay) {
    const unitInstances = { ...next.unitInstances };
    // 第一次結算只建立紀錄；之後每跨一個遊戲日補貨一次，不因多次等待累積。
    if (region) {
      for (const unitId of map.unitsPresent) {
        const unit = getWorldUnitById(unitId);
        const shop = unit ? getShopForUnit(unit.source) : undefined;
        const instance = unitInstances[unitId];
        if (!unit || !shop || !instance || isUnitDead(instance)) continue;
        const inventory = instance.inventory.map((entry) => ({ ...entry }));
        for (const listing of shop.items) {
          const target = unit.source.startingInventory?.find((entry) => entry.itemId === listing.itemId)?.quantity ?? 0;
          const owned = inventory.find((entry) => entry.itemId === listing.itemId);
          if (owned && owned.quantity < target) owned.quantity = target;
          else if (!owned && target > 0) inventory.push({ itemId: listing.itemId, quantity: target });
        }
        unitInstances[unitId] = { ...instance, inventory };
      }
    }
    next = { ...next, unitInstances, world: { ...next.world, regions: { ...next.world.regions, [mapId]: { lastRestockDay: day } } } };
  }

  for (const unitId of map.unitsPresent) {
    const instance = next.unitInstances[unitId];
    const template = unitTemplatesDatabase().find((entry) => entry.id === unitId);
    // 他方佔領：設有 occupation 的單位死亡滿指定天數後不重生，改由潛伏中的佔領單位出現。
    if (template?.occupation) {
      const occupier = unitTemplatesDatabase().find((entry) => entry.id === template.occupation!.byUnitId);
      if (!occupier || !hasUnitDied(instance) || instance.diedAtMinutes === undefined || !next.unitInstances[occupier.id]?.isDormant ||
          next.gameTimeMinutes < instance.diedAtMinutes + template.occupation.afterDays * MINUTES_PER_DAY) continue;
      next = { ...next, unitInstances: { ...next.unitInstances, [occupier.id]: createDefaultUnitInstance(occupier, { awake: true }) } };
      const occupierFaction = occupier.factionId ? getFactionById(occupier.factionId)?.name : undefined;
      next = appendEvent(next, {
        type: 'unit_occupation', gameTimeMinutes: next.gameTimeMinutes, mapId,
        summary: `${template.name}消失後，${occupierFaction ? `${occupierFaction}的` : ''}${getUnitDisplayName(occupier.id)}佔據了${map.name}。`, knownBy: 'region',
        witnessUnitIds: getResidentUnitIds(map).filter((residentId) => isUnitAlive(next, residentId)), cause: '他方佔領', changes: { unitIds: [unitId, occupier.id] }
      }).state;
      continue;
    }
    const respawnDays = template ? getSpeciesById(template.speciesId)?.respawnDays : undefined;
    if (!template || !isUnitDead(instance) || isUniqueUnit(unitId) || !respawnDays || instance.diedAtMinutes === undefined ||
        next.gameTimeMinutes < instance.diedAtMinutes + respawnDays * MINUTES_PER_DAY) continue;
    next = { ...next, unitInstances: { ...next.unitInstances, [unitId]: createDefaultUnitInstance(template) } };
    next = appendEvent(next, {
      type: 'unit_respawn', gameTimeMinutes: next.gameTimeMinutes, mapId,
      summary: `${map.name}又出現了新的${template.name}。`, knownBy: 'region',
      witnessUnitIds: getResidentUnitIds(map).filter((residentId) => isUnitAlive(next, residentId)), cause: '重生規則', changes: { unitIds: [unitId] }
    }).state;
  }
  return next;
}

/** 靜態事件的條件是否成立（尚未觸發、旗標、單位生死、玩家所在地區、聲望與勢力關係）。 */
export function canTriggerEvent(state: PlayerState, event: EventStatic): boolean {
  if (state.world.firedEventIds.includes(event.id)) return false;
  const requires = event.requires ?? {};
  return (requires.flags ?? []).every((flag) => state.storyFlags[flag] === true) &&
    !(event.excludes?.flags ?? []).some((flag) => state.storyFlags[flag] === true) &&
    (requires.unitsAlive ?? []).every((unitId) => isUnitAlive(state, unitId)) &&
    (requires.unitsDead ?? []).every((unitId) => hasUnitDied(state.unitInstances[unitId])) &&
    (!requires.mapIds?.length || requires.mapIds.includes(state.currentMapId)) &&
    matchesFactionConditions(state, requires);
}

/** 事件發生地：玩家所在的條件地區，其次是條件中居民的所在地，最後為玩家所在地。 */
function resolveEventMapId(state: PlayerState, event: EventStatic): string {
  const mapIds = event.requires?.mapIds ?? [];
  if (mapIds.includes(state.currentMapId)) return state.currentMapId;
  if (mapIds.length) return mapIds[0];
  for (const unitId of [...(event.requires?.unitsDead ?? []), ...(event.requires?.unitsAlive ?? [])]) {
    const unit = getWorldUnitById(unitId);
    if (unit && !unit.requiresEncounter) return unit.homeMapId;
  }
  return state.currentMapId;
}

/** 套用靜態事件：設定/清除旗標、建立世界修正、改變聲望與勢力關係，並寫入事件紀錄。條件不成立時不改動狀態。 */
export function applyScenarioEvent(state: PlayerState, event: EventStatic, cause: string): PlayerState {
  if (!canTriggerEvent(state, event)) return state;
  const mapId = resolveEventMapId(state, event);
  const eventMap = getMapById(mapId);
  const storyFlags = { ...state.storyFlags };
  for (const flag of event.effects.setFlags ?? []) storyFlags[flag] = true;
  for (const flag of event.effects.clearFlags ?? []) delete storyFlags[flag];
  const eventId = `WE-${String(state.world.nextEventSeq).padStart(5, '0')}`;
  const modifiers: WorldModifier[] = (event.effects.worldModifiers ?? []).map((modifier, index) => ({
    id: `${eventId}-M${index + 1}`, scope: modifier.scope, stat: modifier.stat, op: modifier.op, value: modifier.value, sourceEventId: eventId,
    ...(modifier.durationMinutes ? { expiresAtMinutes: state.gameTimeMinutes + modifier.durationMinutes } : {})
  }));
  // 事件資料指定的聲望變化直接套用（由寫手決定哪些勢力受影響），並記錄在事件中。
  const reputationChanges = mergeReputationChanges(event.effects.reputation ?? []);
  const relationFactionIds = [...new Set((event.effects.factionRelations ?? []).flatMap((change) => change.factionIds))];
  const world = applyFactionRelationChanges(
    { ...state.world, modifiers: [...state.world.modifiers, ...modifiers], firedEventIds: [...state.world.firedEventIds, event.id] },
    event.effects.factionRelations
  );
  const withEffects: PlayerState = applyReputationChanges({ ...state, storyFlags, world }, reputationChanges);
  return appendEvent(withEffects, {
    type: 'scenario_event', gameTimeMinutes: state.gameTimeMinutes, mapId, summary: event.summary, knownBy: event.knownBy,
    ...(event.knownByFactions?.length ? { knownByFactions: event.knownByFactions } : {}),
    witnessUnitIds: eventMap ? getResidentUnitIds(eventMap).filter((unitId) => isUnitAlive(state, unitId)) : [], cause, eventId: event.id,
    changes: {
      ...(event.effects.setFlags?.length ? { setFlags: event.effects.setFlags } : {}),
      ...(event.effects.clearFlags?.length ? { clearFlags: event.effects.clearFlags } : {}),
      ...(modifiers.length ? { modifierIds: modifiers.map((modifier) => modifier.id) } : {}),
      ...(relationFactionIds.length ? { factionIds: relationFactionIds } : {})
    },
    ...(reputationChanges.length ? { reputationChanges } : {})
  }).state;
}

/** AI 提議（玩家行動促成）的事件原因；歷代角色事蹟以此辨識。 */
export const AI_PROPOSAL_CAUSE = 'AI 提議';

/** AI 目前可提議的事件：觸發方式為 aiProposal 且條件成立。 */
export const getProposableEvents = (state: PlayerState): EventStatic[] =>
  eventsDatabase.filter((event) => event.trigger === 'aiProposal' && canTriggerEvent(state, event));

/** 套用 AI 提議的事件；不存在、非提議事件或條件不成立的 ID 一律忽略。 */
export function applyEventProposals(state: PlayerState, eventIds: readonly string[] = []): { state: PlayerState; applied: EventStatic[] } {
  let next = state;
  const applied: EventStatic[] = [];
  for (const eventId of new Set(eventIds)) {
    const event = getEventById(eventId);
    if (event?.trigger !== 'aiProposal') continue;
    const result = applyScenarioEvent(next, event, AI_PROPOSAL_CAUSE);
    if (result !== next) applied.push(event);
    next = result;
  }
  return { state: next, applied };
}

function runAutoEvents(state: PlayerState): PlayerState {
  let next = state;
  // 事件可能使其他事件的條件成立；最多迭代事件數量次，避免循環。
  for (let pass = 0; pass < eventsDatabase.length; pass += 1) {
    const before = next;
    for (const event of eventsDatabase) {
      if (event.trigger === 'auto') next = applyScenarioEvent(next, event, '條件成立自動觸發');
    }
    if (next === before) break;
  }
  return next;
}

function compressEvents(world: WorldRuntimeState): WorldRuntimeState {
  if (world.events.length <= MAX_WORLD_EVENTS) return world;
  const overflow = world.events.slice(0, world.events.length - MAX_WORLD_EVENTS);
  const lines = overflow.map((event) => `${formatGameTime(event.gameTimeMinutes)}｜${getMapById(event.mapId)?.name ?? event.mapId}｜${event.summary}`);
  return { ...world, events: world.events.slice(-MAX_WORLD_EVENTS), chronicle: [...world.chronicle, ...lines].slice(-MAX_CHRONICLE_LINES) };
}

/**
 * 每次狀態變更後執行的世界規則：記錄新死亡、處理委託人死亡、結算所在地區、觸發自動事件、移除過期修正並壓縮紀錄。
 * 讀檔與換角色不是行動，不經過此函式。
 */
export function finalizeWorld(previous: PlayerState, next: PlayerState, hints: Record<string, DeathHint> = {}): PlayerState {
  let state = next;
  const firstNewEventSeq = state.world.nextEventSeq;
  for (const template of unitTemplatesDatabase()) {
    if (!isUnitDead(previous.unitInstances[template.id]) && isUnitDead(state.unitInstances[template.id])) {
      state = recordDeath(previous, state, template.id, hints[template.id] ?? inferDeathHint(previous, template.id));
    }
  }
  if (!previous.isDead && state.isDead && previous.name === state.name) {
    state = recordDeath(previous, state, PLAYER_UNIT_ID, hints[PLAYER_UNIT_ID] ?? inferDeathHint(previous, PLAYER_UNIT_ID));
  }
  const newDeaths = state.world.events.filter((event) => event.type === 'unit_death' && Number(event.id.slice(3)) >= firstNewEventSeq);
  state = applyActionReputation(previous, state, newDeaths);
  state = resolveOrphanedQuests(state);
  state = settleRegion(state, state.currentMapId);
  state = runAutoEvents(state);
  state = pruneGeneratedQuests(expireGeneratedQuests(state));
  const modifiers = state.world.modifiers.filter((modifier) => isModifierActive(modifier, state.gameTimeMinutes));
  const world = compressEvents(modifiers.length === state.world.modifiers.length ? state.world : { ...state.world, modifiers });
  return world === state.world ? state : { ...state, world };
}

/** 寫入一筆玩家聲望變化事件；只有得知此事的勢力列在 changes 中。 */
function recordReputationChange(previous: PlayerState, state: PlayerState, reason: string, changes: { factionId: string; change: number }[], witnessUnitIds: string[], sourceEventId?: string): PlayerState {
  const merged = mergeReputationChanges(changes);
  if (!merged.length) return state;
  const applied = applyReputationChanges(state, merged);
  return appendEvent(applied, {
    type: 'reputation_change', gameTimeMinutes: state.gameTimeMinutes, mapId: previous.currentMapId,
    summary: `${reason}；聲望變化：${describeReputationChanges(state, merged)}。`,
    knownBy: 'faction', knownByFactions: merged.map((change) => change.factionId), witnessUnitIds, cause: '玩家行動',
    changes: { factionIds: merged.map((change) => change.factionId) }, reputationChanges: merged, ...(sourceEventId ? { sourceEventId } : {})
  }).state;
}

/**
 * 玩家行動造成的聲望變化（只影響得知該事件的勢力）：
 * - 主動攻擊原本非敵對的成員：該勢力得知（被攻擊者本人或在場目擊者）時扣分。
 * - 殺害成員：只有目擊者所屬勢力知道兇手；被害者勢力得知時扣分，與被害者勢力敵對/交戰的勢力得知時加分。
 * - 完成委託：委託人所屬勢力加分。
 */
function applyActionReputation(previous: PlayerState, current: PlayerState, newDeaths: WorldEvent[]): PlayerState {
  let state = current;
  const playerName = getCharacterDisplayName(previous);
  const killedByPlayer = newDeaths.filter((event) => event.death?.killerUnitId === PLAYER_UNIT_ID && event.death.victimUnitId !== PLAYER_UNIT_ID);
  // 本次行動開戰的對象（含一擊斃命、戰鬥已結束的情況）。
  const attackedIds = previous.combat ? [] : [...new Set([
    ...(state.combat ? [state.combat.targetUnitId] : []),
    ...killedByPlayer.map((event) => event.death!.victimUnitId)
  ])];
  const provokedIds = attackedIds.filter((unitId) => getUnitFactionId(unitId) && getWorldUnitDisposition(previous, unitId) !== 'hostile');

  for (const unitId of provokedIds) {
    if (killedByPlayer.some((event) => event.death?.victimUnitId === unitId)) continue;
    const factionId = getUnitFactionId(unitId)!;
    const witnesses = getWitnesses(previous, state, previous.currentMapId, [unitId]);
    // 被攻擊者本人存活，所屬勢力必定得知。
    state = recordReputationChange(previous, state, `${playerName}攻擊了${getUnitDisplayName(unitId)}`,
      [{ factionId, change: reputationRules.memberAttacked }], [unitId, ...witnesses]);
  }

  for (const death of killedByPlayer) {
    const victimId = death.death!.victimUnitId;
    const victimFaction = getUnitFactionId(victimId);
    if (!victimFaction) continue;
    const culpritAware = getFactionsOfUnits(death.witnessUnitIds);
    const changes: { factionId: string; change: number }[] = [];
    if (culpritAware.includes(victimFaction)) {
      changes.push({ factionId: victimFaction, change: reputationRules.memberKilled });
      if (provokedIds.includes(victimId)) changes.push({ factionId: victimFaction, change: reputationRules.memberAttacked });
    }
    for (const factionId of culpritAware) {
      if (factionId !== victimFaction && ['hostile', 'war'].includes(getFactionRelation(state.world, factionId, victimFaction).status)) {
        changes.push({ factionId, change: reputationRules.enemyMemberKilled });
      }
    }
    state = recordReputationChange(previous, state, `${playerName}殺害了${death.death!.victimName}`, changes, death.witnessUnitIds, death.id);
  }

  for (const active of state.activeQuests) {
    const before = previous.activeQuests.find((entry) => entry.questId === active.questId);
    const quest = findQuest(state, active.questId);
    if (active.status !== 'completed' || before?.status !== 'in_progress' || !quest) continue;
    const giverId = getActiveQuestGiverId(active, quest.questGiverId);
    const factionId = getUnitFactionId(giverId);
    if (!factionId) continue;
    state = recordReputationChange(previous, state, `${playerName}完成了${getUnitDisplayName(giverId)}的委託「${quest.title}」`,
      [{ factionId, change: reputationRules.questCompleted }], [giverId]);
  }
  return state;
}

/** 最近一次玩家角色死亡事件；供歷代角色紀錄引用。 */
export const findLatestPlayerDeath = (state: PlayerState): WorldEvent | undefined =>
  [...state.world.events].reverse().find((event) => event.type === 'unit_death' && event.death?.victimUnitId === PLAYER_UNIT_ID);

/** 在場且存活的居民（會說話、可被打聽的人）。 */
const getPresentResidentIds = (state: PlayerState) => {
  const map = getMapById(state.currentMapId);
  return map ? getResidentUnitIds(map).filter((unitId) => isUnitAlive(state, unitId)) : [];
};

/**
 * 某個單位對事件的認知層級（O39）；undefined 代表不知道。
 * - witnessed 親眼目擊：事件的目擊者，知道經過與兇手，不會淡化成傳說。
 * - rumor 傳聞：與目擊者同勢力但未在場，聽說了兇手或死因，不知道經過。
 * - public 公開消息：得知事件的勢力成員、全世界周知事件、或住在事件地區的無勢力居民，只知道結果。
 * - legend 傳說：傳聞或公開消息超過設定天數後，只剩模糊的往事。
 */
export type EventKnowledgeLevel = 'witnessed' | 'rumor' | 'public' | 'legend';

const KNOWLEDGE_LABELS: Record<EventKnowledgeLevel, string> = { witnessed: '親眼目擊', rumor: '傳聞', public: '公開消息', legend: '傳說' };
const KNOWLEDGE_ORDER: EventKnowledgeLevel[] = ['witnessed', 'rumor', 'public', 'legend'];

/** 與目擊者同勢力、未在場的單位是否聽說了經過（只有帶細節的事件才有傳聞）。 */
const hearsDetail = (event: WorldEvent, factionId: string | undefined) =>
  !!event.detail && !!factionId && getFactionsOfUnits(event.witnessUnitIds).includes(factionId);

export function getEventKnowledgeLevel(state: PlayerState, event: WorldEvent, unitId: string): EventKnowledgeLevel | undefined {
  if (event.witnessUnitIds.includes(unitId)) return 'witnessed';
  const factionId = getUnitFactionId(unitId);
  const unit = getWorldUnitById(unitId);
  const heard = hearsDetail(event, factionId);
  const knowsResult = heard || event.knownBy === 'world' || (!!factionId && event.awareFactionIds.includes(factionId)) ||
    (!factionId && event.knownBy === 'region' && !!unit && !unit.requiresEncounter && unit.homeMapId === event.mapId);
  if (!knowsResult) return undefined;
  if (state.gameTimeMinutes - event.gameTimeMinutes >= aiContextConfig.knowledge.legendAfterDays * MINUTES_PER_DAY) return 'legend';
  return heard ? 'rumor' : 'public';
}

/** 各認知層級能說出的內容；經過（detail）只交給親眼目擊者。 */
function describeKnowledge(event: WorldEvent, level: EventKnowledgeLevel): string {
  if (level === 'witnessed') return event.detail ?? event.summary;
  if (level === 'legend') return `很久以前的事：${event.summary}細節已經模糊。`;
  if (level === 'public') return event.summary;
  const hearsay = event.death?.killerName ? `聽說是${event.death.killerName}下的手` : `聽說死因是${event.cause}`;
  return `${event.summary}${hearsay}，但不清楚經過。`;
}

/** 事件的 AI 描述：公開結果，加上在場居民依認知層級分組能說的內容；沒有在場目擊者時不提供經過。 */
function describeEventForAI(state: PlayerState, event: WorldEvent, presentResidentIds: string[]) {
  const groups = new Map<EventKnowledgeLevel, string[]>();
  for (const unitId of presentResidentIds) {
    const level = getEventKnowledgeLevel(state, event, unitId);
    if (level) groups.set(level, [...(groups.get(level) ?? []), getUnitDisplayName(unitId)]);
  }
  const presentKnowledge = KNOWLEDGE_ORDER.flatMap((level) => groups.has(level) ? [{
    level: KNOWLEDGE_LABELS[level],
    who: groups.get(level)!,
    knows: describeKnowledge(event, level),
    ...(level === 'rumor' ? { heardFrom: event.witnessUnitIds.filter((unitId) => getWorldUnitById(unitId)?.requiresEncounter !== true).map(getUnitDisplayName) } : {})
  }] : []);
  return {
    id: event.id,
    time: formatGameTime(event.gameTimeMinutes),
    place: getMapById(event.mapId)?.name ?? event.mapId,
    summary: event.summary,
    ...(presentKnowledge.length ? { presentKnowledge } : {})
  };
}

/**
 * 提供給 AI 的世界事件：所在地區、全世界周知、或與在場居民相關（目擊、同勢力得知或死者原屬此地）的近期事件。
 * 每件事附上在場居民的認知層級；excludeEventIds（已在歷代角色區段列出的事件）不重複列出。
 */
export function getWorldContextForAI(state: PlayerState, excludeEventIds: readonly string[] = []) {
  const presentResidentIds = getPresentResidentIds(state);
  const presentFactions = getFactionsOfUnits(presentResidentIds);
  const relevant = state.world.events.filter((event) => !excludeEventIds.includes(event.id) && (event.mapId === state.currentMapId || event.knownBy === 'world' ||
    event.witnessUnitIds.some((unitId) => presentResidentIds.includes(unitId)) ||
    (event.knownBy === 'faction' && event.awareFactionIds.some((factionId) => presentFactions.includes(factionId))) ||
    (event.death && getWorldUnitById(event.death.victimUnitId)?.mapIds.includes(state.currentMapId))));
  return {
    events: relevant.slice(-aiContextConfig.worldEvents.maxEvents).map((event) => describeEventForAI(state, event, presentResidentIds)),
    chronicle: state.world.chronicle.slice(-aiContextConfig.chronicle.maxLines),
    modifiers: state.world.modifiers.map((modifier) => ({
      scope: modifier.scope, stat: modifier.stat, change: modifier.op === 'add' ? `${modifier.value >= 0 ? '+' : ''}${modifier.value}` : `×${modifier.value}`,
      ...(modifier.expiresAtMinutes !== undefined ? { until: formatGameTime(modifier.expiresAtMinutes) } : {})
    }))
  };
}

/** 歷代角色的事蹟：該角色任內殺害具名人物或頭目、聲望事件（含完成委託）、玩家行動促成的劇本事件；一般魔物擊殺不列入。 */
function isCharacterDeed(event: WorldEvent): boolean {
  if (event.type === 'unit_death') return event.death?.killerUnitId === PLAYER_UNIT_ID && event.death.victimUnitId !== PLAYER_UNIT_ID && isUniqueUnit(event.death.victimUnitId);
  // 殺害造成的聲望事件併入死亡事件的 consequence，不重複列出。
  if (event.type === 'reputation_change') return !event.sourceEventId;
  return event.type === 'scenario_event' && event.cause === AI_PROPOSAL_CAUSE;
}

/**
 * 提供給 AI 的歷代角色紀錄：每位角色附上其死亡事件與事蹟（最新 maxDeeds 件），
 * 每件事附上在場居民的認知層級，讓 AI 能把前任冒險者與其造成的事件連起來，又不讓未目擊者說出經過。
 * 已壓縮進編年史的舊事件不再列出。
 */
export function getCharacterLegacyForAI(state: PlayerState, history: CharacterHistoryEntry[], maxCharacters: number, maxDeeds: number) {
  const presentResidentIds = getPresentResidentIds(state);
  const describeEvent = (event: WorldEvent) => {
    const consequence = event.type === 'unit_death'
      ? state.world.events.find((entry) => entry.sourceEventId === event.id && entry.type === 'reputation_change')?.summary
      : undefined;
    return { ...describeEventForAI(state, event, presentResidentIds), ...(consequence ? { consequence } : {}) };
  };
  return history.slice(-maxCharacters).map((entry) => {
    const death = entry.deathEventId ? state.world.events.find((event) => event.id === entry.deathEventId) : undefined;
    const deeds = state.world.events.filter((event) => event.characterSeq === entry.characterSeq && isCharacterDeed(event)).slice(-maxDeeds);
    return {
      generation: entry.characterSeq,
      name: getCharacterDisplayName(entry),
      build: describeUnitBuild(entry),
      alignment: entry.alignment,
      endedAt: formatGameTime(entry.endedAtMinutes),
      place: getMapById(entry.mapId)?.name ?? entry.mapId,
      death: death ? describeEvent(death) : entry.deathSummary ? { summary: entry.deathSummary } : undefined,
      deeds: deeds.map(describeEvent)
    };
  });
}
