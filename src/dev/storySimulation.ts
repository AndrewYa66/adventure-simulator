import type { PlayerState, StoryletStatic, WorldEvent } from '../types/game';
import { WORLD_STATE_KEYS } from '../types/game';
import {
  aiContextConfig,
  canPlayerEnterMap,
  eventsDatabase,
  getMapById,
  getQuestById,
  getStoryActById,
  getStoryEndingById,
  getStoryletById,
  getWorldUnitById,
  getWorldUnitsAtMap,
  mapsDatabase,
  PLAYER_UNIT_ID,
  questsDatabase,
  storyActs,
  storyEndingsDatabase,
  storyletsDatabase,
  unitTemplatesDatabase
} from '../data/staticData';
import { createInitialPlayer } from '../utils/playerInit';
import { finalizeWorld, getProposableEvents, applyEventProposals, type DeathHint } from '../utils/worldEvents';
import { isTimelineEnded } from '../utils/playerStatus';
import { getStoryletCandidates, isActStuck, meetsStoryletConditions, resolveEpilogueIndexes, resolveStoryletGiver, startStorylets } from '../utils/storylets';
import { advanceGameTime, waitGameTime } from '../utils/gameTime';
import { acceptQuest, canAcceptQuest, canTurnInQuest } from '../utils/questRules';
import { applyStateChanges } from '../utils/applyStateChanges';
import { splitPlayerState } from '../utils/saveStorage';
import { normalizePlayerState } from '../utils/playerStorage';
import { buildAIContext } from '../services/aiContext';

/**
 * 主線自動模擬（O33）：不呼叫 AI，以規則代替玩家與主持人 AI，大量重複遊玩同一份劇本資料，
 * 檢查是否存在卡死於某一幕的世界狀態、統計各結局可達性與保底觸發頻率，並量測長流程後的 AI 上下文大小。
 *
 * 行為模型（O34 重要角色決策完成前的替代）：
 * - 玩家：以「朝目標前進」為主（前往片段發生地點與目標、接取與交付任務、擊倒目標），夾雜隨機的搗亂行為
 *   （殺害在場居民、隨意移動、等待）；戰鬥一律視為玩家獲勝，不模擬戰鬥能力。
 * - 主持人 AI：給予者在場時開始候選片段、依機率提議目前可提議的事件（目標需要的旗標優先）。
 * - 世界：依機率讓某位具名居民死亡（死因不明），代替 O34 的角色行動與意外。
 * 所有狀態變更都經過 finalizeWorld，與實際遊戲走同一套世界規則。
 */

export interface SimulationPolicy {
  /** 每一步的搗亂機率：殺害在場居民、具名居民在別處死亡（死因不明）、隨意移動、原地等待 8 小時。 */
  killResident: number;
  worldDeath: number;
  wander: number;
  wait: number;
  /** 朝目標前進時：接取任務、開始候選片段、提議能設定目標旗標的事件、提議其他可提議事件的機率。 */
  acceptQuest: number;
  startStorylet: number;
  proposeGoalEvent: number;
  proposeOtherEvent: number;
}

export interface SimulationConfig {
  runs: number;
  seed: number;
  maxGameDays: number;
  maxSteps: number;
  /** 每隔幾步量測一次 AI 上下文大小（0 為只在結束時量測）。 */
  contextSampleEvery: number;
  /** 結局為 continue（世界繼續運作）時，結局後再模擬幾個遊戲日，確認主線結束後世界規則仍正常。 */
  continueAfterEndingDays: number;
  /** 壓力測試：在第一次模擬的最終狀態灌入多少件事件，檢查編年史壓縮與 AI 上下文預算。 */
  stressEvents: number;
  /** 玩家類型：依 share 比例分配模擬次數（例如專注推進主線的玩家、到處閒晃的玩家）。 */
  profiles: {
    name: string;
    share: number;
    /** 同一幕超過幾個遊戲日沒有進展、卡死偵測卻沒有判定卡死時，列為疑似漏報（走得慢的玩家類型應設得較長）。 */
    stallDays: number;
    /** 這類玩家在模擬天數內必須達成結局（放置型玩家不要求，只用來觸發幕期限）。 */
    requireEnding: boolean;
    policy: SimulationPolicy;
  }[];
}

export interface StallReport {
  profile: string;
  actId: string;
  signature: string;
}

export interface RunResult {
  seed: number;
  profile: string;
  endingId?: string;
  days: number;
  steps: number;
  /** 每一幕停留的遊戲日。 */
  actDays: Record<string, number>;
  stuckEventsFired: number;
  forcedCompletions: number;
  stalls: StallReport[];
  /** 每次被判定卡死（開始計時）時的狀態摘要，供寫手了解主要的卡死成因。 */
  stuckSignatures: string[];
  maxContextChars: number;
  contextOverBudget: boolean;
  finalEventCount: number;
  chronicleLines: number;
  /** 結局判定可重現：存讀檔後結局與尾聲段落一致，且以同一狀態重新判定得到相同段落。 */
  endingReproducible: boolean;
  errors: string[];
}

const MINUTES_PER_DAY = 24 * 60;
const WAIT_MINUTES = 8 * 60;

/** 可重現的亂數（mulberry32）。 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, items: readonly T[]): T | undefined => items.length ? items[Math.floor(rng() * items.length)] : undefined;

const isUnitAlive = (state: PlayerState, unitId: string) => {
  const instance = state.unitInstances[unitId];
  return !!instance && !instance.isDead && instance.currentHp !== 0 && !instance.isDormant;
};

/** 玩家可抵達的地圖與步數（沿相連地圖、遵守地圖前置任務）。 */
function getDistances(state: PlayerState): Map<string, { distance: number; firstStep?: string }> {
  const result = new Map<string, { distance: number; firstStep?: string }>([[state.currentMapId, { distance: 0 }]]);
  const queue = [state.currentMapId];
  while (queue.length) {
    const current = queue.shift()!;
    const entry = result.get(current)!;
    for (const nextId of getMapById(current)?.connectedMapIds ?? []) {
      const next = getMapById(nextId);
      if (!next || result.has(nextId) || !canPlayerEnterMap(state, next)) continue;
      result.set(nextId, { distance: entry.distance + 1, firstStep: entry.firstStep ?? nextId });
      queue.push(nextId);
    }
  }
  return result;
}

/** 玩家在目前地圖可以擊倒的單位：存活的居民，或可遭遇（前置任務進行中）的單位。 */
function getKillableUnitIds(state: PlayerState): string[] {
  return getWorldUnitsAtMap(state.currentMapId, state).filter((unit) => {
    if (!unit.requiresEncounter) return isUnitAlive(state, unit.id);
    if (unit.requiredQuestId && !state.activeQuests.some((quest) => quest.questId === unit.requiredQuestId && quest.status === 'in_progress')) return false;
    return unit.population ? true : isUnitAlive(state, unit.id);
  }).map((unit) => unit.id);
}

/** 擊倒單位：比照遊戲的擊倒流程（掉落、擊倒數、任務完成嘗試、唯一個體永久死亡），死因為玩家在戰鬥中殺死。 */
function killUnit(state: PlayerState, unitId: string, rng: () => number): PlayerState {
  const unit = getWorldUnitById(unitId, state);
  if (!unit) return state;
  const drops = (unit.loot?.dropItems ?? []).filter((drop) => rng() < drop.chance).map((drop) => ({ itemId: drop.itemId, quantity: 1 }));
  const questUpdates = state.activeQuests.filter((quest) => quest.status === 'in_progress').map((quest) => ({ questId: quest.questId, status: 'completed' as const }));
  let next = applyStateChanges(advanceGameTime(state, 'combatRound'), {
    storyText: '', suggestedActions: [],
    stateChanges: { expChange: unit.expReward, goldChange: unit.loot?.gold ?? 0, addItems: drops, defeatedUnits: [{ unitId, quantity: 1 }], questUpdates }
  }, 'game');
  if (!unit.population) {
    const instance = next.unitInstances[unitId];
    next = { ...next, unitInstances: { ...next.unitInstances, [unitId]: { ...instance, currentHp: 0, isDead: true } } };
  }
  return finalizeWorld(state, next, { [unitId]: { cause: 'combat', killerUnitId: PLAYER_UNIT_ID } });
}

/** 具名居民在別處死亡（死因不明），代替重要角色行動與意外。 */
function killElsewhere(state: PlayerState, unitId: string): PlayerState {
  const instance = state.unitInstances[unitId];
  const next = { ...state, unitInstances: { ...state.unitInstances, [unitId]: { ...instance, currentHp: 0, isDead: true } } };
  const hints: Record<string, DeathHint> = { [unitId]: { cause: 'unknown' } };
  return finalizeWorld(state, next, hints);
}

const travel = (state: PlayerState, mapId: string): PlayerState =>
  finalizeWorld(state, { ...advanceGameTime(state, 'travel'), previousMapId: state.currentMapId, currentMapId: mapId });

const wait = (state: PlayerState): PlayerState => finalizeWorld(state, waitGameTime(state, WAIT_MINUTES));

/** 片段目標需要的旗標（目標旗標與「或旗標成立」）。 */
const goalFlags = (storylet: StoryletStatic): string[] =>
  storylet.goal.type === 'flagSet' ? [storylet.goal.flag] : storylet.goal.orFlag ? [storylet.goal.orFlag] : [];

/** 目前想去的地圖與想擊倒的單位：進行中片段的目標、可開始片段的發生地點、進行中任務的需求與交付地點。 */
function getGoals(state: PlayerState): { mapIds: Set<string>; killIds: Set<string>; flags: Set<string> } {
  const mapIds = new Set<string>();
  const killIds = new Set<string>();
  const flags = new Set<string>();
  const story = state.world.story;
  const active = story.activeStorylets.flatMap((entry) => getStoryletById(entry.id) ?? []);
  const addUnitTarget = (unitId: string) => {
    const unit = getWorldUnitById(unitId, state);
    if (!unit || !isUnitAlive(state, unitId)) return;
    killIds.add(unitId);
    unit.mapIds.forEach((mapId) => mapIds.add(mapId));
    const questId = unit.requiredQuestId;
    if (questId && !state.activeQuests.some((quest) => quest.questId === questId)) {
      const quest = getQuestById(questId);
      if (quest) mapIds.add(quest.mapId);
      for (const prerequisiteId of quest?.prerequisiteQuestIds ?? []) {
        const prerequisite = getQuestById(prerequisiteId);
        if (prerequisite && !state.activeQuests.some((entry) => entry.questId === prerequisiteId)) mapIds.add(prerequisite.mapId);
      }
    }
  };
  for (const storylet of active) {
    const goal = storylet.goal;
    if (goal.type === 'locationReached') mapIds.add(goal.mapId);
    if (goal.type === 'threatRemoved') goal.unitIds.forEach(addUnitTarget);
    goalFlags(storylet).forEach((flag) => flags.add(flag));
  }
  if (!active.length) {
    for (const storylet of storyletsDatabase) {
      if (storylet.actId !== story.currentActId || story.completedStorylets.some((entry) => entry.id === storylet.id) ||
          !meetsStoryletConditions(state, storylet, false)) continue;
      const locations = storylet.requires?.mapIds?.length ? storylet.requires.mapIds : mapsDatabase.map((map) => map.id);
      locations.filter((mapId) => resolveStoryletGiver(state, storylet, mapId)).forEach((mapId) => mapIds.add(mapId));
    }
  }
  // 目標旗標可由事件設定時，前往事件的發生地點。
  for (const event of eventsDatabase) {
    if (event.trigger === 'aiProposal' && (event.effects.setFlags ?? []).some((flag) => flags.has(flag))) event.requires?.mapIds?.forEach((mapId) => mapIds.add(mapId));
  }
  for (const progress of state.activeQuests) {
    const quest = getQuestById(progress.questId);
    if (!quest || progress.status !== 'in_progress') continue;
    mapIds.add(quest.mapId);
    for (const requirement of quest.requirements.defeatUnits ?? []) {
      const unit = getWorldUnitById(requirement.unitId, state);
      if (unit && (progress.progress?.defeatedUnits[requirement.unitId] ?? 0) < requirement.quantity) {
        killIds.add(unit.id);
        unit.mapIds.forEach((mapId) => mapIds.add(mapId));
      }
    }
    // 需要收集的物品還不夠時，去擊倒會掉落該物品的單位。
    for (const requirement of quest.requirements.collectItems ?? []) {
      if ((state.inventory.find((item) => item.itemId === requirement.itemId)?.quantity ?? 0) >= requirement.quantity) continue;
      for (const template of unitTemplatesDatabase()) {
        if (!template.loot?.dropItems?.some((drop) => drop.itemId === requirement.itemId)) continue;
        const unit = getWorldUnitById(template.id, state);
        if (!unit || (!unit.population && !isUnitAlive(state, unit.id))) continue;
        killIds.add(unit.id);
        unit.mapIds.forEach((mapId) => mapIds.add(mapId));
      }
    }
  }
  return { mapIds, killIds, flags };
}

/** 朝目標前進的一步；沒有可做的事時原地等待。 */
function goalStep(state: PlayerState, policy: SimulationPolicy, rng: () => number): PlayerState {
  // 交付任務、接取任務
  for (const quest of questsDatabase) {
    if (canTurnInQuest(state, quest)) {
      return finalizeWorld(state, applyStateChanges(advanceGameTime(state, 'dialogue'), {
        storyText: '', suggestedActions: [], stateChanges: { questUpdates: [{ questId: quest.id, status: 'completed' }] }
      }, 'game'));
    }
  }
  const acceptable = questsDatabase.filter((quest) => canAcceptQuest(state, quest));
  if (acceptable.length && rng() < policy.acceptQuest) {
    const accepted = acceptQuest(advanceGameTime(state, 'dialogue'), acceptable[0]);
    if (accepted) return finalizeWorld(state, accepted);
  }
  // 主持人 AI：開始候選片段、提議事件
  const candidates = getStoryletCandidates(state);
  if (candidates.length && rng() < policy.startStorylet) {
    const started = startStorylets(state, advanceGameTime(state, 'dialogue'), [candidates[0].storylet.id]).state;
    return finalizeWorld(state, started);
  }
  const goals = getGoals(state);
  const proposable = getProposableEvents(state);
  const goalEvents = proposable.filter((event) => (event.effects.setFlags ?? []).some((flag) => goals.flags.has(flag)));
  const proposal = goalEvents.length && rng() < policy.proposeGoalEvent ? pick(rng, goalEvents)
    : rng() < policy.proposeOtherEvent ? pick(rng, proposable) : undefined;
  if (proposal) return finalizeWorld(state, applyEventProposals(advanceGameTime(state, 'dialogue'), [proposal.id]).state);
  // 擊倒目標
  const killTarget = getKillableUnitIds(state).find((unitId) => goals.killIds.has(unitId));
  if (killTarget) return killUnit(state, killTarget, rng);
  // 前往最近的目標地點
  const distances = getDistances(state);
  const targets = [...goals.mapIds].filter((mapId) => mapId !== state.currentMapId && distances.has(mapId))
    .sort((a, b) => distances.get(a)!.distance - distances.get(b)!.distance);
  const next = targets.length ? distances.get(targets[0])?.firstStep : undefined;
  return next ? travel(state, next) : wait(state);
}

/** 搗亂或朝目標前進的一步。 */
export function simulateStep(state: PlayerState, policy: SimulationPolicy, rng: () => number): PlayerState {
  const roll = rng();
  let threshold = policy.killResident;
  if (roll < threshold) {
    const residents = getKillableUnitIds(state).filter((unitId) => !getWorldUnitById(unitId)?.requiresEncounter);
    const victim = pick(rng, residents);
    if (victim) return killUnit(state, victim, rng);
  } else if (roll < (threshold += policy.worldDeath)) {
    const named = unitTemplatesDatabase().filter((unit) => !unit.requiresEncounter && !unit.population && isUnitAlive(state, unit.id) &&
      !getWorldUnitById(unit.id)?.mapIds.includes(state.currentMapId));
    const victim = pick(rng, named);
    if (victim) return killElsewhere(state, victim.id);
  } else if (roll < (threshold += policy.wander)) {
    const neighbors = (getMapById(state.currentMapId)?.connectedMapIds ?? []).filter((mapId) => { const map = getMapById(mapId); return !!map && canPlayerEnterMap(state, map); });
    const destination = pick(rng, neighbors);
    if (destination) return travel(state, destination);
  } else if (roll < threshold + policy.wait) {
    return wait(state);
  }
  return goalStep(state, policy, rng);
}

/** 卡住時的狀態摘要（用來把相同情況歸為一組）。 */
function describeStall(state: PlayerState): string {
  const story = state.world.story;
  const dead = unitTemplatesDatabase().filter((unit) => !unit.population && !isUnitAlive(state, unit.id) && !state.unitInstances[unit.id]?.isDormant).map((unit) => unit.id);
  const flags = Object.keys(state.storyFlags).filter((flag) => state.storyFlags[flag]).sort();
  const quests = state.activeQuests.map((quest) => `${quest.questId}:${quest.status}`).sort();
  return [
    `幕 ${story.currentActId}`,
    `進行中 [${story.activeStorylets.map((entry) => entry.id).join(', ')}]`,
    `已完成 [${story.completedStorylets.map((entry) => entry.id).join(', ')}]`,
    `旗標 [${flags.join(', ')}]`,
    `死亡 [${dead.join(', ')}]`,
    `任務 [${quests.join(', ')}]`
  ].join('｜');
}

/** 模擬存讀檔：拆成世界與角色兩層、序列化，再合併並驗證（與 saveStorage 的讀檔流程相同）。 */
function roundTrip(state: PlayerState): PlayerState | null {
  const { world, character } = JSON.parse(JSON.stringify(splitPlayerState(state, []))) as ReturnType<typeof splitPlayerState>;
  const merged: Record<string, unknown> = { ...character };
  for (const key of WORLD_STATE_KEYS) merged[key] = (world as unknown as Record<string, unknown>)[key];
  return normalizePlayerState(merged);
}

/** 執行一次模擬。 */
export function simulateRun(config: SimulationConfig, seed: number, profile: SimulationConfig['profiles'][number]): RunResult {
  const rng = createRng(seed);
  const errors: string[] = [];
  let state = createInitialPlayer(undefined, undefined, undefined, true);
  const startMinutes = state.gameTimeMinutes;
  const limitMinutes = startMinutes + config.maxGameDays * MINUTES_PER_DAY;
  const actDays: Record<string, number> = {};
  const stalls: StallReport[] = [];
  const stuckSignatures: string[] = [];
  let actId = state.world.story.currentActId;
  let actStart = startMinutes;
  let lastProgress = startMinutes;
  let completedCount = 0;
  let stallReported = false;
  let maxContextChars = 0;
  let contextOverBudget = false;
  const measureContext = () => {
    const report = buildAIContext(state, []).report;
    maxContextChars = Math.max(maxContextChars, report.totalChars);
    contextOverBudget ||= report.overBudget || report.totalChars > aiContextConfig.totalBudgetChars;
  };
  let steps = 0;
  let endingSnapshot: PlayerState | undefined;
  let afterEndingLimit = limitMinutes;
  for (; steps < config.maxSteps && state.gameTimeMinutes < Math.min(limitMinutes, afterEndingLimit) && !isTimelineEnded(state); steps += 1) {
    try {
      state = simulateStep(state, profile.policy, rng);
    } catch (error) {
      errors.push(`第 ${steps} 步發生例外：${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    const story = state.world.story;
    if (story.stuckSinceMinutes === state.gameTimeMinutes) stuckSignatures.push(describeStall(state));
    if (story.currentActId !== actId) {
      actDays[actId] = (state.gameTimeMinutes - actStart) / MINUTES_PER_DAY;
      actId = story.currentActId;
      actStart = state.gameTimeMinutes;
      stallReported = false;
    }
    if (story.ending && !endingSnapshot) {
      endingSnapshot = state;
      afterEndingLimit = state.gameTimeMinutes + config.continueAfterEndingDays * MINUTES_PER_DAY;
      if (story.ending.reachedAtMinutes !== state.gameTimeMinutes) errors.push('結局達成時間與狀態時間不一致');
    }
    if (endingSnapshot && JSON.stringify(story.ending) !== JSON.stringify(endingSnapshot.world.story.ending)) errors.push('結局在達成後被改變');
    if (endingSnapshot && (story.activeStorylets.length || story.completedStorylets.length !== endingSnapshot.world.story.completedStorylets.length)) errors.push('結局後主線仍在前進');
    if (story.completedStorylets.length !== completedCount || story.ending) {
      completedCount = story.completedStorylets.length;
      lastProgress = state.gameTimeMinutes;
    }
    if (!stallReported && !story.ending && state.gameTimeMinutes - lastProgress > profile.stallDays * MINUTES_PER_DAY && !isActStuck(state)) {
      stalls.push({ profile: profile.name, actId, signature: describeStall(state) });
      stallReported = true;
    }
    if (config.contextSampleEvery > 0 && steps % config.contextSampleEvery === 0) measureContext();
  }
  // 最後所在的幕算到達成結局為止（結局後的天數不算）。
  actDays[actId] = ((state.world.story.ending?.reachedAtMinutes ?? state.gameTimeMinutes) - actStart) / MINUTES_PER_DAY;
  measureContext();

  // 結局判定可重現：達成結局當下的狀態存讀檔後一致，以同一狀態重新判定得到相同段落；結局後的世界也要能通過存檔驗證。
  const story = state.world.story;
  let endingReproducible = true;
  if (endingSnapshot?.world.story.ending) {
    const reached = endingSnapshot.world.story.ending;
    const reloaded = roundTrip(endingSnapshot);
    const ending = getStoryEndingById(reached.id);
    endingReproducible = !!reloaded && !!ending && JSON.stringify(reloaded.world.story.ending) === JSON.stringify(reached) &&
      JSON.stringify(resolveEpilogueIndexes(reloaded, ending)) === JSON.stringify(reached.epilogueIndexes);
    if (!endingReproducible) errors.push('結局判定在存讀檔後不一致');
  }
  if (!roundTrip(state)) errors.push('模擬結束時的狀態無法通過存檔驗證');

  const stuckEventIds = new Set(storyActs.flatMap((act) => act.stuckEventId ?? []));
  return {
    seed,
    profile: profile.name,
    endingId: story.ending?.id,
    days: (state.gameTimeMinutes - startMinutes) / MINUTES_PER_DAY,
    steps,
    actDays,
    stuckEventsFired: state.world.firedEventIds.filter((id) => stuckEventIds.has(id)).length,
    forcedCompletions: story.completedStorylets.filter((entry) => entry.forced).length,
    stalls,
    stuckSignatures,
    maxContextChars,
    contextOverBudget,
    finalEventCount: state.world.events.length,
    chronicleLines: state.world.chronicle.length,
    endingReproducible,
    errors
  };
}

/**
 * 壓力測試：以實際事件為樣本灌入大量事件（含例行事件），經 finalizeWorld 壓縮後量測編年史與 AI 上下文。
 * 回傳壓縮後的事件數、編年史行數與上下文大小。
 */
export function stressEventLog(base: PlayerState, count: number): { events: number; chronicleLines: number; contextChars: number; overBudget: boolean } {
  const routineType = aiContextConfig.chronicle.routineEventTypes[0];
  const samples: WorldEvent[] = base.world.events.length ? base.world.events : [];
  const mapIds = mapsDatabase.map((map) => map.id);
  let state = base;
  let seq = state.world.nextEventSeq;
  const events: WorldEvent[] = [...state.world.events];
  for (let index = 0; index < count; index += 1) {
    const sample = samples[index % Math.max(1, samples.length)];
    const routine = index % 3 !== 0 && routineType;
    events.push({
      ...(sample ?? { knownBy: 'region', witnessUnitIds: [], awareFactionIds: [], cause: '壓力測試' }),
      id: `WE-${String(seq).padStart(5, '0')}`,
      type: routine ? routineType : sample?.type ?? 'scenario_event',
      mapId: mapIds[index % mapIds.length],
      gameTimeMinutes: state.gameTimeMinutes + index * 30,
      summary: routine ? '（壓力測試）例行事件。' : `（壓力測試）第 ${index + 1} 件重要事件。`
    } as WorldEvent);
    seq += 1;
  }
  state = { ...state, gameTimeMinutes: state.gameTimeMinutes + count * 30, world: { ...state.world, events, nextEventSeq: seq } };
  state = finalizeWorld(state, state);
  const report = buildAIContext(state, []).report;
  return { events: state.world.events.length, chronicleLines: state.world.chronicle.length, contextChars: report.totalChars, overBudget: report.overBudget || report.totalChars > aiContextConfig.totalBudgetChars };
}

export interface SimulationSummary {
  runs: number;
  /** 各玩家類型的結局分布。 */
  endings: Record<string, Record<string, number>>;
  /** 一次都沒有達成的結局（可能是資料問題，也可能是行為模型沒有走到）。 */
  unreachedEndingIds: string[];
  /** 要求達成結局的玩家類型中，沒有達成結局的次數。 */
  noEnding: number;
  timelineEnded: number;
  avgDays: number;
  actDays: Record<string, { avg: number; max: number }>;
  runsWithStuckEvent: number;
  runsWithForcedCompletion: number;
  /** 卡死時的狀態摘要分組（依次數排序）。 */
  stuckGroups: { signature: string; count: number; exampleSeed: number }[];
  stallGroups: { profile: string; actId: string; signature: string; count: number; exampleSeed: number }[];
  maxContextChars: number;
  contextOverBudgetRuns: number;
  maxFinalEvents: number;
  maxChronicleLines: number;
  irreproducibleEndings: number;
  errors: { seed: number; message: string }[];
  /** 同一種子重跑兩次結果相同（模擬本身可重現）。 */
  deterministic: boolean;
  stress?: ReturnType<typeof stressEventLog>;
}

function groupSignatures(results: RunResult[]) {
  const groups = new Map<string, { signature: string; count: number; exampleSeed: number }>();
  for (const result of results) {
    for (const signature of result.stuckSignatures) {
      const group = groups.get(signature) ?? { signature, count: 0, exampleSeed: result.seed };
      group.count += 1;
      groups.set(signature, group);
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** 執行多次模擬並彙整。 */
export function runSimulation(config: SimulationConfig, onProgress?: (done: number) => void): SimulationSummary {
  const results: RunResult[] = [];
  const totalShare = config.profiles.reduce((sum, profile) => sum + profile.share, 0);
  const profileFor = (index: number) => {
    let position = ((index + 0.5) / config.runs) * totalShare;
    return config.profiles.find((profile) => (position -= profile.share) < 0) ?? config.profiles[config.profiles.length - 1];
  };
  for (let index = 0; index < config.runs; index += 1) {
    results.push(simulateRun(config, config.seed + index, profileFor(index)));
    onProgress?.(index + 1);
  }
  const endings: Record<string, Record<string, number>> = {};
  const actDayLists: Record<string, number[]> = {};
  const stallGroups = new Map<string, { profile: string; actId: string; signature: string; count: number; exampleSeed: number }>();
  for (const result of results) {
    const key = result.endingId ?? '（未達成結局）';
    const byProfile = (endings[result.profile] ??= {});
    byProfile[key] = (byProfile[key] ?? 0) + 1;
    for (const [actId, days] of Object.entries(result.actDays)) (actDayLists[actId] ??= []).push(days);
    for (const stall of result.stalls) {
      const group = stallGroups.get(stall.signature) ?? { ...stall, count: 0, exampleSeed: result.seed };
      group.count += 1;
      stallGroups.set(stall.signature, group);
    }
  }
  const first = results[0];
  const rerun = first ? simulateRun(config, first.seed, profileFor(0)) : undefined;
  const stress = config.stressEvents > 0 ? stressEventLog(createInitialPlayer(undefined, undefined, undefined, true), config.stressEvents) : undefined;
  return {
    runs: results.length,
    endings,
    unreachedEndingIds: storyEndingsDatabase.map((ending) => ending.id).filter((id) => !results.some((result) => result.endingId === id)),
    noEnding: results.filter((result) => !result.endingId && config.profiles.find((profile) => profile.name === result.profile)?.requireEnding).length,
    timelineEnded: results.filter((result) => result.endingId && getStoryEndingById(result.endingId)?.afterEnding === 'end').length,
    avgDays: results.reduce((sum, result) => sum + result.days, 0) / Math.max(1, results.length),
    actDays: Object.fromEntries(Object.entries(actDayLists).map(([actId, list]) => [
      `${actId} ${getStoryActById(actId)?.title ?? ''}`.trim(),
      { avg: list.reduce((sum, days) => sum + days, 0) / list.length, max: Math.max(...list) }
    ])),
    runsWithStuckEvent: results.filter((result) => result.stuckEventsFired > 0).length,
    runsWithForcedCompletion: results.filter((result) => result.forcedCompletions > 0).length,
    stuckGroups: groupSignatures(results),
    stallGroups: [...stallGroups.values()].sort((a, b) => b.count - a.count),
    maxContextChars: Math.max(0, ...results.map((result) => result.maxContextChars)),
    contextOverBudgetRuns: results.filter((result) => result.contextOverBudget).length,
    maxFinalEvents: Math.max(0, ...results.map((result) => result.finalEventCount)),
    maxChronicleLines: Math.max(0, ...results.map((result) => result.chronicleLines)),
    irreproducibleEndings: results.filter((result) => !result.endingReproducible).length,
    errors: results.flatMap((result) => result.errors.map((message) => ({ seed: result.seed, message }))),
    deterministic: !first || JSON.stringify(rerun) === JSON.stringify(first),
    ...(stress ? { stress } : {})
  };
}
