import type { DeathCause, EventStatic, PlayerState, UnitInstance, WorldEvent, WorldModifier, WorldRuntimeState } from '../types/game';
import {
  createDefaultUnitInstance,
  eventsDatabase,
  getCharacterClassById,
  getEventById,
  getMapById,
  getQuestById,
  getShopForNpc,
  getSpeciesById,
  getUnitDisplayName,
  getWorldUnitById,
  PLAYER_UNIT_ID,
  unitTemplatesDatabase
} from '../data/staticData';
import { formatGameTime, getGameDay } from './gameTime';
import { isModifierActive } from './worldModifiers';

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
  return { events: [], chronicle: [], nextEventSeq: 1, modifiers: [], firedEventIds: [], regions: {} };
}

export interface DeathHint {
  cause: DeathCause;
  killerUnitId?: string;
  /** 死因補充，例如檢定理由。 */
  note?: string;
}

const isUnitDead = (instance: UnitInstance | undefined) => !!instance && (instance.isDead === true || instance.currentHp === 0);
const isUnitAlive = (state: PlayerState, unitId: string) => !!state.unitInstances[unitId] && !isUnitDead(state.unitInstances[unitId]);

/** 玩家角色的顯示名稱，例如「冒險者亞瑟」。 */
export const getCharacterDisplayName = (player: Pick<PlayerState, 'name' | 'classId'>) =>
  `${getCharacterClassById(player.classId)?.name ?? ''}${player.name}`;

/** 具名且唯一的單位（NPC 與頭目）死亡後不會重生。 */
function isUniqueUnit(unitId: string): boolean {
  const unit = getWorldUnitById(unitId);
  return unit?.kind === 'npc' || (unit?.kind === 'monster' && unit.source.isBoss === true);
}

/** 事件寫入的唯一入口：配發序號並附加到紀錄。 */
function appendEvent(state: PlayerState, event: Omit<WorldEvent, 'id'>): { state: PlayerState; event: WorldEvent } {
  const world = state.world;
  const created: WorldEvent = { id: `WE-${String(world.nextEventSeq).padStart(5, '0')}`, ...event };
  return { state: { ...state, world: { ...world, events: [...world.events, created], nextEventSeq: world.nextEventSeq + 1 } }, event: created };
}

/**
 * 事件發生時的目擊者：該地區在場且存活的 NPC，以及戰鬥中或已遭遇的魔物。
 * 位置與戰鬥取自事件前的狀態，存活與否取自事件後的狀態。
 */
function getWitnesses(before: PlayerState, after: PlayerState, mapId: string, exclude: string[]): string[] {
  const map = getMapById(mapId);
  if (!map) return [];
  const engaged = [
    ...(before.combat?.participants.filter((participant) => participant.side === 'enemy').map((participant) => participant.unitId) ?? []),
    ...(before.encounteredUnitId ? [before.encounteredUnitId] : [])
  ].filter((unitId) => map.monstersPresent.includes(unitId) && !isUnitDead(after.unitInstances[unitId]));
  const npcs = map.npcsPresent.filter((unitId) => isUnitAlive(after, unitId));
  return [...new Set([...npcs, ...engaged])].filter((unitId) => !exclude.includes(unitId));
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

/** 委託人死亡時，進行中的委託失敗並寫入事件（同勢力接手待 O38 勢力資料）。 */
function failOrphanedQuests(state: PlayerState): PlayerState {
  let next = state;
  for (const active of state.activeQuests) {
    const quest = getQuestById(active.questId);
    if (active.status !== 'in_progress' || !quest || !isUnitDead(next.unitInstances[quest.questGiverId])) continue;
    next = {
      ...next,
      activeQuests: next.activeQuests.map((entry) => entry.questId === quest.id && entry.status === 'in_progress' ? { ...entry, status: 'failed' as const } : entry)
    };
    next = appendEvent(next, {
      type: 'quest_failed', gameTimeMinutes: next.gameTimeMinutes, mapId: quest.mapId,
      summary: `因${getUnitDisplayName(quest.questGiverId)}身亡，委託「${quest.title}」已無法完成。`,
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
      for (const npcId of map.npcsPresent) {
        const unit = getWorldUnitById(npcId);
        const shop = unit?.kind === 'npc' ? getShopForNpc(unit.source) : undefined;
        const instance = unitInstances[npcId];
        if (!shop || !instance || isUnitDead(instance) || unit?.kind !== 'npc') continue;
        const inventory = instance.inventory.map((entry) => ({ ...entry }));
        for (const listing of shop.items) {
          const target = unit.source.startingInventory?.find((entry) => entry.itemId === listing.itemId)?.quantity ?? 0;
          const owned = inventory.find((entry) => entry.itemId === listing.itemId);
          if (owned && owned.quantity < target) owned.quantity = target;
          else if (!owned && target > 0) inventory.push({ itemId: listing.itemId, quantity: target });
        }
        unitInstances[npcId] = { ...instance, inventory };
      }
    }
    next = { ...next, unitInstances, world: { ...next.world, regions: { ...next.world.regions, [mapId]: { lastRestockDay: day } } } };
  }

  for (const unitId of [...map.npcsPresent, ...map.monstersPresent]) {
    const instance = next.unitInstances[unitId];
    const template = unitTemplatesDatabase().find((entry) => entry.id === unitId);
    const respawnDays = template ? getSpeciesById(template.speciesId)?.respawnDays : undefined;
    if (!template || !isUnitDead(instance) || isUniqueUnit(unitId) || !respawnDays || instance.diedAtMinutes === undefined ||
        next.gameTimeMinutes < instance.diedAtMinutes + respawnDays * MINUTES_PER_DAY) continue;
    next = { ...next, unitInstances: { ...next.unitInstances, [unitId]: createDefaultUnitInstance(template) } };
    next = appendEvent(next, {
      type: 'unit_respawn', gameTimeMinutes: next.gameTimeMinutes, mapId,
      summary: `${map.name}又出現了新的${template.name}。`, knownBy: 'region',
      witnessUnitIds: map.npcsPresent.filter((npcId) => isUnitAlive(next, npcId)), cause: '重生規則', changes: { unitIds: [unitId] }
    }).state;
  }
  return next;
}

/** 靜態事件的條件是否成立（尚未觸發、旗標、單位生死、玩家所在地區）。 */
export function canTriggerEvent(state: PlayerState, event: EventStatic): boolean {
  if (state.world.firedEventIds.includes(event.id)) return false;
  const requires = event.requires ?? {};
  return (requires.flags ?? []).every((flag) => state.storyFlags[flag] === true) &&
    !(event.excludes?.flags ?? []).some((flag) => state.storyFlags[flag] === true) &&
    (requires.unitsAlive ?? []).every((unitId) => isUnitAlive(state, unitId)) &&
    (requires.unitsDead ?? []).every((unitId) => isUnitDead(state.unitInstances[unitId])) &&
    (!requires.mapIds?.length || requires.mapIds.includes(state.currentMapId));
}

/** 事件發生地：玩家所在的條件地區，其次是條件中 NPC 的所在地，最後為玩家所在地。 */
function resolveEventMapId(state: PlayerState, event: EventStatic): string {
  const mapIds = event.requires?.mapIds ?? [];
  if (mapIds.includes(state.currentMapId)) return state.currentMapId;
  if (mapIds.length) return mapIds[0];
  for (const unitId of [...(event.requires?.unitsDead ?? []), ...(event.requires?.unitsAlive ?? [])]) {
    const unit = getWorldUnitById(unitId);
    if (unit?.kind === 'npc') return unit.source.mapId;
  }
  return state.currentMapId;
}

/** 套用靜態事件：設定/清除旗標、建立世界修正，並寫入事件紀錄。條件不成立時不改動狀態。 */
export function applyScenarioEvent(state: PlayerState, event: EventStatic, cause: string): PlayerState {
  if (!canTriggerEvent(state, event)) return state;
  const mapId = resolveEventMapId(state, event);
  const storyFlags = { ...state.storyFlags };
  for (const flag of event.effects.setFlags ?? []) storyFlags[flag] = true;
  for (const flag of event.effects.clearFlags ?? []) delete storyFlags[flag];
  const eventId = `WE-${String(state.world.nextEventSeq).padStart(5, '0')}`;
  const modifiers: WorldModifier[] = (event.effects.worldModifiers ?? []).map((modifier, index) => ({
    id: `${eventId}-M${index + 1}`, scope: modifier.scope, stat: modifier.stat, op: modifier.op, value: modifier.value, sourceEventId: eventId,
    ...(modifier.durationMinutes ? { expiresAtMinutes: state.gameTimeMinutes + modifier.durationMinutes } : {})
  }));
  const withEffects: PlayerState = {
    ...state, storyFlags,
    world: { ...state.world, modifiers: [...state.world.modifiers, ...modifiers], firedEventIds: [...state.world.firedEventIds, event.id] }
  };
  return appendEvent(withEffects, {
    type: 'scenario_event', gameTimeMinutes: state.gameTimeMinutes, mapId, summary: event.summary, knownBy: event.knownBy,
    witnessUnitIds: (getMapById(mapId)?.npcsPresent ?? []).filter((unitId) => isUnitAlive(state, unitId)), cause, eventId: event.id,
    changes: {
      ...(event.effects.setFlags?.length ? { setFlags: event.effects.setFlags } : {}),
      ...(event.effects.clearFlags?.length ? { clearFlags: event.effects.clearFlags } : {}),
      ...(modifiers.length ? { modifierIds: modifiers.map((modifier) => modifier.id) } : {})
    }
  }).state;
}

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
    const result = applyScenarioEvent(next, event, 'AI 提議');
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
  for (const template of unitTemplatesDatabase()) {
    if (!isUnitDead(previous.unitInstances[template.id]) && isUnitDead(state.unitInstances[template.id])) {
      state = recordDeath(previous, state, template.id, hints[template.id] ?? inferDeathHint(previous, template.id));
    }
  }
  if (!previous.isDead && state.isDead && previous.name === state.name) {
    state = recordDeath(previous, state, PLAYER_UNIT_ID, hints[PLAYER_UNIT_ID] ?? inferDeathHint(previous, PLAYER_UNIT_ID));
  }
  state = failOrphanedQuests(state);
  state = settleRegion(state, state.currentMapId);
  state = runAutoEvents(state);
  const modifiers = state.world.modifiers.filter((modifier) => isModifierActive(modifier, state.gameTimeMinutes));
  const world = compressEvents(modifiers.length === state.world.modifiers.length ? state.world : { ...state.world, modifiers });
  return world === state.world ? state : { ...state, world };
}

/** 最近一次玩家角色死亡事件；供歷代角色紀錄引用。 */
export const findLatestPlayerDeath = (state: PlayerState): WorldEvent | undefined =>
  [...state.world.events].reverse().find((event) => event.type === 'unit_death' && event.death?.victimUnitId === PLAYER_UNIT_ID);

const EVENTS_FOR_AI = 12;

/**
 * 提供給 AI 的世界事件：所在地區、全世界周知、或與在場 NPC 相關（目擊或死者原屬此地）的近期事件。
 * 目擊者名單隨附，AI 依此區分「誰知道細節」。
 */
export function getWorldContextForAI(state: PlayerState) {
  const map = getMapById(state.currentMapId);
  const presentNpcIds = map?.npcsPresent ?? [];
  const relevant = state.world.events.filter((event) => event.mapId === state.currentMapId || event.knownBy === 'world' ||
    event.witnessUnitIds.some((unitId) => presentNpcIds.includes(unitId)) ||
    (event.death && getWorldUnitById(event.death.victimUnitId)?.mapIds.includes(state.currentMapId)));
  return {
    events: relevant.slice(-EVENTS_FOR_AI).map((event) => ({
      id: event.id,
      time: formatGameTime(event.gameTimeMinutes),
      place: getMapById(event.mapId)?.name ?? event.mapId,
      summary: event.summary,
      ...(event.detail ? { detail: event.detail } : {}),
      knownBy: event.knownBy,
      witnesses: event.witnessUnitIds.map((unitId) => ({ id: unitId, name: getUnitDisplayName(unitId) }))
    })),
    chronicle: state.world.chronicle.slice(-10),
    modifiers: state.world.modifiers.map((modifier) => ({
      scope: modifier.scope, stat: modifier.stat, change: modifier.op === 'add' ? `${modifier.value >= 0 ? '+' : ''}${modifier.value}` : `×${modifier.value}`,
      ...(modifier.expiresAtMinutes !== undefined ? { until: formatGameTime(modifier.expiresAtMinutes) } : {})
    }))
  };
}
