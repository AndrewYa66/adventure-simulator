import type { PlayerState, StoryletGiverChannel, StoryletStatic, StoryState } from '../types/game';
import {
  getStoryActById,
  getStoryletById,
  getUnitDisplayName,
  getUnitTemplateById,
  getWorldUnitById,
  getWorldUnitDisposition,
  storyActs,
  storyData,
  storyletsDatabase,
  unitTemplatesDatabase
} from '../data/staticData';
import { matchesFactionConditions } from './factions';

/**
 * 主線：幕與劇情片段（O31）。
 * 規則篩出目前可開始的片段候選 → 主持人 AI 依劇情脈絡在回應的 storyletProposals 挑選 → 前端驗證後開始。
 * 目標以結果判定（由 finalizeWorld 每次狀態變更後檢查），由他人或事件達成時同樣推進；完成效果經事件入口套用。
 * 本模組只含判定與開始片段；完成與推進幕寫入事件紀錄，見 worldEvents.ts。
 */

export const createStoryState = (): StoryState => ({
  currentActId: storyActs[0]?.id ?? '',
  activeStorylets: [],
  completedStorylets: [],
  endingTraits: {}
});

export const CHANNEL_LABELS: Record<StoryletGiverChannel, string> = { notice_board: '告示板', letter: '書信', relic: '遺物', none: '無' };

/** 第一版可用的保底管道；遺物需 O26 死亡遺物。 */
const isUsableChannel = (channel: StoryletGiverChannel) => channel === 'notice_board' || channel === 'letter';

const hasDied = (state: Pick<PlayerState, 'unitInstances'>, unitId: string) => {
  const instance = state.unitInstances[unitId];
  return !!instance && (instance.isDead === true || instance.currentHp === 0) && !instance.isDormant;
};
const isAlive = (state: Pick<PlayerState, 'unitInstances'>, unitId: string) => {
  const instance = state.unitInstances[unitId];
  return !!instance && !instance.isDead && instance.currentHp !== 0 && !instance.isDormant;
};

const isStarted = (story: StoryState, storyletId: string) => story.activeStorylets.some((entry) => entry.id === storyletId);
const isCompleted = (story: StoryState, storyletId: string) => story.completedStorylets.some((entry) => entry.id === storyletId);

/** 進入條件：旗標、排除旗標、單位生死、聲望與勢力關係；includeLocation 時另檢查玩家在發生地點。 */
export function meetsStoryletConditions(state: PlayerState, storylet: StoryletStatic, includeLocation: boolean): boolean {
  const requires = storylet.requires ?? {};
  return (requires.flags ?? []).every((flag) => state.storyFlags[flag] === true) &&
    !(storylet.excludes?.flags ?? []).some((flag) => state.storyFlags[flag] === true) &&
    (requires.unitsAlive ?? []).every((unitId) => isAlive(state, unitId)) &&
    (requires.unitsDead ?? []).every((unitId) => hasDied(state, unitId)) &&
    (!includeLocation || !requires.mapIds?.length || requires.mapIds.includes(state.currentMapId)) &&
    matchesFactionConditions(state, requires);
}

/** 可擔任給予者：存活、非潛伏的地區居民，且對玩家非敵對。 */
const isUsableGiver = (state: PlayerState, unitId: string) =>
  getUnitTemplateById(unitId)?.requiresEncounter !== true && isAlive(state, unitId) && getWorldUnitDisposition(state, unitId) !== 'hostile';

/**
 * 接手人選：符合角色條件（職階、勢力、最低等級）、可擔任給予者的居民。
 * 範圍 map 為片段發生地點（未設定時為首選者居所）的居民，world 為全世界；與首選者同居所者優先。
 */
function getSuccessorIds(state: PlayerState, storylet: StoryletStatic): string[] {
  const { role, preferredUnitId, scope } = storylet.giver;
  if (!role) return [];
  const preferredHome = preferredUnitId ? getWorldUnitById(preferredUnitId)?.homeMapId : undefined;
  const scopeMapIds = scope === 'world' ? undefined
    : storylet.requires?.mapIds?.length ? storylet.requires.mapIds : preferredHome ? [preferredHome] : undefined;
  const successors = unitTemplatesDatabase().flatMap((template) => {
    if (template.id === preferredUnitId || !isUsableGiver(state, template.id)) return [];
    const unit = getWorldUnitById(template.id, state);
    if (!unit) return [];
    if (role.classIds?.length && (!unit.classId || !role.classIds.includes(unit.classId))) return [];
    if (role.factionIds?.length && (!unit.factionId || !role.factionIds.includes(unit.factionId))) return [];
    if (role.minLevel !== undefined && unit.level < role.minLevel) return [];
    if (scopeMapIds && !unit.mapIds.some((mapId) => scopeMapIds.includes(mapId))) return [];
    return [unit];
  });
  return [...successors].sort((a, b) => Number(b.homeMapId === preferredHome) - Number(a.homeMapId === preferredHome)).map((unit) => unit.id);
}

export type StoryletGiver = { kind: 'unit'; unitId: string; preferred: boolean } | { kind: 'channel'; channel: StoryletGiverChannel };

/**
 * 決定片段的給予者：首選者可用時只由首選者給予；首選者不可用（死亡、潛伏、敵對）或未指定時，由接手人選給予；
 * 都沒有時使用保底管道。指定 atMapId 時，單位給予者必須在該地圖，否則回傳 undefined（玩家需前往給予者所在處）。
 */
export function resolveStoryletGiver(state: PlayerState, storylet: StoryletStatic, atMapId?: string): StoryletGiver | undefined {
  const isHere = (unitId: string) => !atMapId || (getWorldUnitById(unitId)?.mapIds.includes(atMapId) ?? false);
  const preferredId = storylet.giver.preferredUnitId;
  if (preferredId && isUsableGiver(state, preferredId)) {
    return isHere(preferredId) ? { kind: 'unit', unitId: preferredId, preferred: true } : undefined;
  }
  const successors = getSuccessorIds(state, storylet);
  if (successors.length) {
    const here = successors.find(isHere);
    return here ? { kind: 'unit', unitId: here, preferred: false } : undefined;
  }
  return isUsableChannel(storylet.giver.fallback) ? { kind: 'channel', channel: storylet.giver.fallback } : undefined;
}

export const describeStoryletGiver = (giver: StoryletGiver | undefined): string =>
  !giver ? '（目前沒有人能給予）' : giver.kind === 'channel' ? CHANNEL_LABELS[giver.channel] : getUnitDisplayName(giver.unitId);

/** 尚未開始也未完成、屬於目前幕且符合進入條件的片段。 */
function getPendingStorylets(state: PlayerState, includeLocation: boolean): StoryletStatic[] {
  const story = state.world.story;
  return storyletsDatabase.filter((storylet) => storylet.actId === story.currentActId && !isStarted(story, storylet.id) &&
    !isCompleted(story, storylet.id) && meetsStoryletConditions(state, storylet, includeLocation));
}

/**
 * 目前可開始的片段候選（依優先度排序）：玩家在發生地點，且給予者在場（或使用保底管道）。
 * 預設片段只在本幕沒有其他進行中、也沒有其他可開始（任何地點）的片段時才成為候選。
 */
export function getStoryletCandidates(state: PlayerState): { storylet: StoryletStatic; giver: StoryletGiver }[] {
  const story = state.world.story;
  if (story.activeStorylets.length >= storyData.rules.maxActiveStorylets) return [];
  const otherPathOpen = story.activeStorylets.some((entry) => !getStoryletById(entry.id)?.isDefault) ||
    getPendingStorylets(state, false).some((storylet) => !storylet.isDefault && !!resolveStoryletGiver(state, storylet));
  return getPendingStorylets(state, true).flatMap((storylet) => {
    if (storylet.isDefault && otherPathOpen) return [];
    const giver = resolveStoryletGiver(state, storylet, state.currentMapId);
    return giver ? [{ storylet, giver }] : [];
  }).sort((a, b) => b.storylet.priority - a.storylet.priority);
}

/** 目標是否已達成（只看結果，不論由誰達成）。 */
export function isStoryletGoalMet(state: PlayerState, storylet: StoryletStatic): boolean {
  const goal = storylet.goal;
  if (goal.type === 'threatRemoved') return goal.unitIds.every((unitId) => hasDied(state, unitId));
  if (goal.type === 'locationReached') return state.currentMapId === goal.mapId;
  return state.storyFlags[goal.flag] === true;
}

/**
 * 目標已達成的片段：進行中的片段（開始後不再檢查進入條件），以及目前幕中符合進入條件但尚未開始的片段（目標先被他人或事件達成）。
 * 進行中的優先，其次依優先度。
 */
export function findCompletableStorylets(state: PlayerState): { storylet: StoryletStatic; wasActive: boolean }[] {
  const active = state.world.story.activeStorylets.flatMap((entry) => {
    const storylet = getStoryletById(entry.id);
    return storylet && isStoryletGoalMet(state, storylet) ? [{ storylet, wasActive: true }] : [];
  });
  const pending = getPendingStorylets(state, false).filter((storylet) => isStoryletGoalMet(state, storylet))
    .sort((a, b) => b.priority - a.priority).map((storylet) => ({ storylet, wasActive: false }));
  return [...active, ...pending];
}

/**
 * 開始 AI 提議的片段：只接受行動前（AI 看到的狀態）的候選，每回合最多 maxStartsPerTurn 個，
 * 進行中的片段數不超過上限。開始片段屬於例行變化，不寫入事件紀錄（完成時才寫入）。
 */
export function startStorylets<T extends PlayerState>(before: PlayerState, next: T, storyletIds: readonly string[] = []):
  { state: T; started: StoryletStatic[]; rejected: string[] } {
  const { maxStartsPerTurn, maxActiveStorylets } = storyData.rules;
  const candidates = getStoryletCandidates(before);
  let state = next;
  const started: StoryletStatic[] = [];
  const rejected: string[] = [];
  for (const storyletId of new Set(storyletIds)) {
    const title = getStoryletById(storyletId)?.title ?? storyletId;
    const candidate = candidates.find((entry) => entry.storylet.id === storyletId);
    const story = state.world.story;
    if (started.length >= maxStartsPerTurn) rejected.push(`「${title}」：每回合最多開始 ${maxStartsPerTurn} 個劇情片段`);
    else if (!candidate) rejected.push(`「${title}」：目前不是可開始的劇情片段`);
    else if (candidate.storylet.actId !== story.currentActId || isStarted(story, storyletId) || isCompleted(story, storyletId)) rejected.push(`「${title}」：已開始、已完成或不屬於目前的幕`);
    else if (story.activeStorylets.length >= maxActiveStorylets) rejected.push(`「${title}」：進行中的劇情片段已達上限`);
    else {
      const giver = candidate.giver;
      const entry = { id: storyletId, startedAtMinutes: state.gameTimeMinutes, ...(giver.kind === 'unit' ? { giverUnitId: giver.unitId } : { giverChannel: giver.channel }) };
      state = { ...state, world: { ...state.world, story: { ...story, activeStorylets: [...story.activeStorylets, entry] } } };
      started.push(candidate.storylet);
    }
  }
  return { state, started, rejected };
}

/** 狀態變更前後的主線進展（完成的片段與新的一幕），給玩家的系統訊息；沒有進展時回傳 undefined。 */
export function describeStoryProgress(before: PlayerState, after: PlayerState): string | undefined {
  const known = new Set(before.world.story.completedStorylets.map((entry) => entry.id));
  const lines = after.world.story.completedStorylets.filter((entry) => !known.has(entry.id)).flatMap((entry) => {
    const storylet = getStoryletById(entry.id);
    return storylet ? [`・「${storylet.title}」完成：${storylet.onComplete.summary}`] : [];
  });
  const act = after.world.story.currentActId !== before.world.story.currentActId ? getStoryActById(after.world.story.currentActId) : undefined;
  if (act) lines.push(`・進入新的一幕：「${act.title}」`);
  return lines.length ? `📖 主線進展：\n${lines.join('\n')}` : undefined;
}

/** 片段的演出要求；首選給予者不在時附上「給予者不在時」的演出方式。 */
function describeScene(storylet: StoryletStatic, giver: StoryletGiver | undefined) {
  const scene = storylet.scene;
  const giverAbsent = !giver || giver.kind === 'channel' || !giver.preferred;
  return {
    purpose: scene.purpose,
    mustConvey: scene.mustConvey,
    forbidden: scene.forbidden,
    ...(scene.tone ? { tone: scene.tone } : {}),
    ...(scene.keyLines?.length && !giverAbsent ? { keyLines: scene.keyLines } : {}),
    ...(scene.playerChoices?.length ? { playerChoices: scene.playerChoices } : {}),
    ...(giverAbsent && scene.giverAbsent && storylet.giver.preferredUnitId ? { giverAbsent: scene.giverAbsent } : {})
  };
}

/** AI 上下文的主線區段：目前幕、累積的結局特徵、進行中片段與可開始的候選（含演出要求）。 */
export function getStoryContextForAI(state: PlayerState) {
  const story = state.world.story;
  const act = getStoryActById(story.currentActId);
  const active = story.activeStorylets.flatMap((entry) => {
    const storylet = getStoryletById(entry.id);
    if (!storylet) return [];
    const giver = resolveStoryletGiver(state, storylet);
    return [{ id: storylet.id, title: storylet.title, goal: storylet.goal.summary, giver: describeStoryletGiver(giver), ...describeScene(storylet, giver) }];
  });
  const candidates = getStoryletCandidates(state).slice(0, storyData.rules.maxCandidatesForAI).map(({ storylet, giver }) => ({
    id: storylet.id,
    title: storylet.title,
    priority: storylet.priority,
    giver: describeStoryletGiver(giver),
    goal: storylet.goal.summary,
    ...describeScene(storylet, giver)
  }));
  return {
    act: act ? { title: act.title, goal: act.goal, ...(act.theme ? { theme: act.theme } : {}) } : undefined,
    endingTraits: story.endingTraits,
    active,
    candidates
  };
}
