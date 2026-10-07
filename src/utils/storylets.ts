import type { EndingEpilogueCondition, EventStatic, PlayerState, StoryEndingStatic, StoryletGiverChannel, StoryletStatic, StoryState } from '../types/game';
import {
  eventsDatabase,
  getMapById,
  getQuestById,
  getStoryActById,
  getStoryEndingById,
  getStoryletById,
  getUnitDisplayName,
  getUnitTemplateById,
  getWorldUnitById,
  getWorldUnitDisposition,
  mapsDatabase,
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
 * 本模組只含判定與開始片段；完成、推進幕與進入結局寫入事件紀錄，見 worldEvents.ts。
 */

export const createStoryState = (startMinutes: number): StoryState => ({
  currentActId: storyActs[0]?.id ?? '',
  activeStorylets: [],
  completedStorylets: [],
  endingTraits: {},
  actStartedAtMinutes: startMinutes
});

const MINUTES_PER_DAY = 24 * 60;

// ---------- 結局（O33）----------

/** 已達成的結局；尚未達成時為 undefined。 */
export const getReachedEnding = (state: PlayerState): StoryEndingStatic | undefined =>
  state.world.story.ending ? getStoryEndingById(state.world.story.ending.id) : undefined;


/** 目前幕的期限：到期時間與期限結局；沒有期限或已達成結局時為 undefined。 */
export function getActDeadline(state: PlayerState): { dueAtMinutes: number; endingId: string } | undefined {
  const story = state.world.story;
  const deadline = getStoryActById(story.currentActId)?.deadline;
  if (!deadline || story.ending) return undefined;
  return { dueAtMinutes: story.actStartedAtMinutes + deadline.days * MINUTES_PER_DAY, endingId: deadline.endingId };
}

/** 尾聲段落的條件：結局特徵、旗標、排除旗標、單位生死全部成立（省略的項目不檢查）。 */
function matchesEpilogueCondition(state: PlayerState, when: EndingEpilogueCondition | undefined): boolean {
  if (!when) return true;
  const traits = state.world.story.endingTraits;
  return Object.entries(when.traits ?? {}).every(([key, value]) => traits[key] === value) &&
    (when.flags ?? []).every((flag) => state.storyFlags[flag] === true) &&
    !(when.excludesFlags ?? []).some((flag) => state.storyFlags[flag] === true) &&
    (when.unitsAlive ?? []).every((unitId) => isAlive(state, unitId)) &&
    (when.unitsDead ?? []).every((unitId) => hasDied(state, unitId));
}

/** 結局判定：依進入結局當下的世界狀態，挑出所有符合條件的尾聲段落（依資料順序）。相同狀態一定得到相同結果。 */
export const resolveEpilogueIndexes = (state: PlayerState, ending: StoryEndingStatic): number[] =>
  ending.epilogues.flatMap((epilogue, index) => matchesEpilogueCondition(state, epilogue.when) ? [index] : []);

/** 已達成結局的尾聲文字（依存檔記錄的段落）。 */
export function getEndingEpilogue(state: PlayerState): { ending: StoryEndingStatic; texts: string[] } | undefined {
  const reached = state.world.story.ending;
  const ending = getReachedEnding(state);
  if (!reached || !ending) return undefined;
  return { ending, texts: reached.epilogueIndexes.flatMap((index) => ending.epilogues[index]?.text ?? []) };
}

export const CHANNEL_LABELS: Record<StoryletGiverChannel, string> = { notice_board: '告示板', letter: '書信', relic: '遺物', none: '無' };

/** 卡死保底的事件原因（O32）。 */
export const STUCK_RESCUE_CAUSE = '主線保底';

/** 目前可用的保底管道；遺物需 O26 死亡遺物。 */
const isUsableChannel = (channel: StoryletGiverChannel) => channel === 'notice_board' || channel === 'letter';

/** 地點有告示板（地點設施，O32）。 */
export const hasNoticeBoard = (mapId: string) => getMapById(mapId)?.facilities?.includes('notice_board') ?? false;

/** 片段的發生地點；未設定時為全世界。 */
const getStoryletMapIds = (storylet: StoryletStatic): string[] =>
  storylet.requires?.mapIds?.length ? storylet.requires.mapIds : mapsDatabase.map((map) => map.id);

/** 保底管道在此地點（未指定時為任一發生地點）可用：書信到處可用，告示板需要地點有告示板。 */
const isChannelAvailable = (storylet: StoryletStatic, channel: StoryletGiverChannel, atMapId?: string) =>
  channel === 'letter' || (channel === 'notice_board' && (atMapId ? hasNoticeBoard(atMapId) : getStoryletMapIds(storylet).some(hasNoticeBoard)));

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
  const options = getGiverOptions(state, storylet);
  if (!options) return undefined;
  if ('channel' in options) return isChannelAvailable(storylet, options.channel, atMapId) ? { kind: 'channel', channel: options.channel } : undefined;
  const unitId = options.unitIds.find((id) => !atMapId || (getWorldUnitById(id)?.mapIds.includes(atMapId) ?? false));
  return unitId ? { kind: 'unit', unitId, preferred: options.preferred } : undefined;
}

/** 給予者人選：可用的首選者；否則接手人選；都沒有時為可用的保底管道。 */
function getGiverOptions(state: PlayerState, storylet: StoryletStatic): { unitIds: string[]; preferred: boolean } | { channel: StoryletGiverChannel } | undefined {
  const preferredId = storylet.giver.preferredUnitId;
  if (preferredId && isUsableGiver(state, preferredId)) return { unitIds: [preferredId], preferred: true };
  const successors = getSuccessorIds(state, storylet);
  if (successors.length) return { unitIds: successors, preferred: false };
  return isUsableChannel(storylet.giver.fallback) ? { channel: storylet.giver.fallback } : undefined;
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
 * 預設片段只在本幕沒有其他進行中、也沒有其他可開始（任何地點）的片段時才成為候選；
 * 目標已無法達成的進行中片段、給予者或發生地點到不了的片段不算「其他路」（O32）。
 */
export function getStoryletCandidates(state: PlayerState): { storylet: StoryletStatic; giver: StoryletGiver }[] {
  const story = state.world.story;
  if (story.ending || story.activeStorylets.length >= storyData.rules.maxActiveStorylets) return [];
  const progress = createProgressContext(state);
  const otherPathOpen = story.activeStorylets.some((entry) => {
    const storylet = getStoryletById(entry.id);
    return !!storylet && !storylet.isDefault && isGoalAchievable(progress, storylet);
  }) || getPendingStorylets(state, false).some((storylet) => !storylet.isDefault && isPendingOpen(progress, storylet));
  return getPendingStorylets(state, true).flatMap((storylet) => {
    if (storylet.isDefault && otherPathOpen) return [];
    const giver = resolveStoryletGiver(state, storylet, state.currentMapId);
    return giver ? [{ storylet, giver }] : [];
  }).sort((a, b) => b.storylet.priority - a.storylet.priority);
}

/** 目標是否已達成（只看結果，不論由誰達成）；威脅消除與抵達地點另可由 orFlag 旗標成立而完成。 */
export function isStoryletGoalMet(state: PlayerState, storylet: StoryletStatic): boolean {
  const goal = storylet.goal;
  if (goal.type !== 'flagSet' && goal.orFlag && state.storyFlags[goal.orFlag] === true) return true;
  if (goal.type === 'threatRemoved') return goal.unitIds.every((unitId) => hasDied(state, unitId));
  if (goal.type === 'locationReached') return state.currentMapId === goal.mapId;
  return state.storyFlags[goal.flag] === true;
}

// ---------- 可前進判定與卡死偵測（O32）----------
// 判斷「日後仍可能達成」而不是「現在就能達成」。寧可高估（漏報卡死）也不誤判，避免提早觸發保底；
// 無法由規則判定的條件（尚未成立但有來源的旗標、聲望與勢力關係）一律視為可能。

interface ProgressContext {
  state: PlayerState;
  /** 玩家日後可抵達的地圖：從目前地點沿相連地圖走，前置任務已接取、已完成或仍可接取。 */
  reachable: Set<string>;
}

/** 劇本任務已接取、已完成，或仍可接取（委託人可擔任給予者，前置任務也都可接取）。 */
function isQuestObtainable(state: PlayerState, questId: string, visited = new Set<string>()): boolean {
  const progress = state.activeQuests.find((entry) => entry.questId === questId);
  if (progress) return progress.status !== 'failed';
  const quest = getQuestById(questId);
  if (!quest || visited.has(questId)) return false;
  visited.add(questId);
  return isUsableGiver(state, quest.questGiverId) && (quest.prerequisiteQuestIds ?? []).every((id) => isQuestObtainable(state, id, visited));
}

function createProgressContext(state: PlayerState): ProgressContext {
  const reachable = new Set([state.currentMapId]);
  const queue = [state.currentMapId];
  while (queue.length) {
    for (const nextId of getMapById(queue.shift()!)?.connectedMapIds ?? []) {
      const next = getMapById(nextId);
      if (!next || reachable.has(nextId) || (next.requiredQuestId && !isQuestObtainable(state, next.requiredQuestId))) continue;
      reachable.add(nextId);
      queue.push(nextId);
    }
  }
  return { state, reachable };
}

/** 唯一單位已死亡，或日後仍可擊倒：未潛伏、所在地可抵達，需要的前置任務進行中或仍可接取。 */
function canStillDefeat({ state, reachable }: ProgressContext, unitId: string): boolean {
  if (hasDied(state, unitId)) return true;
  const instance = state.unitInstances[unitId];
  const template = getUnitTemplateById(unitId);
  if (!instance || !template || instance.isDead || instance.isDormant) return false;
  const questId = template.requiredQuestId;
  const questProgress = questId ? state.activeQuests.find((entry) => entry.questId === questId) : undefined;
  if (questId && (questProgress ? questProgress.status !== 'in_progress' : !isQuestObtainable(state, questId))) return false;
  return getWorldUnitById(unitId, state)?.mapIds.some((mapId) => reachable.has(mapId)) ?? false;
}

/** 本幕尚未完成的片段（完成時可設定旗標、觸發完成事件）。 */
const getOpenActStorylets = (state: PlayerState) =>
  storyletsDatabase.filter((storylet) => storylet.actId === state.world.story.currentActId && !isCompleted(state.world.story, storylet.id));

/** 事件日後仍可能觸發：尚未觸發、未被排除、需要存活的單位未死、需要死亡的單位可擊倒、發生地點可抵達；完成事件需本幕尚未完成的片段引用。 */
function canEventStillFire(progress: ProgressContext, event: EventStatic): boolean {
  const { state, reachable } = progress;
  const requires = event.requires ?? {};
  return !state.world.firedEventIds.includes(event.id) &&
    !(event.excludes?.flags ?? []).some((flag) => state.storyFlags[flag] === true) &&
    (requires.unitsAlive ?? []).every((unitId) => { const instance = state.unitInstances[unitId]; return !!instance && !instance.isDead && instance.currentHp !== 0; }) &&
    (requires.unitsDead ?? []).every((unitId) => canStillDefeat(progress, unitId)) &&
    (!requires.mapIds?.length || requires.mapIds.some((mapId) => reachable.has(mapId))) &&
    (event.trigger !== 'storylet' || getOpenActStorylets(state).some((storylet) => storylet.onComplete.eventIds?.includes(event.id)));
}

/** 旗標已成立，或日後仍可能由事件（不含卡死保底事件）或本幕尚未完成的片段設定。 */
function canStillSetFlag(progress: ProgressContext, flag: string): boolean {
  const { state } = progress;
  if (state.storyFlags[flag] === true) return true;
  return eventsDatabase.some((event) => event.trigger !== 'stuck' && (event.effects.setFlags ?? []).includes(flag) && canEventStillFire(progress, event)) ||
    getOpenActStorylets(state).some((storylet) => (storylet.onComplete.setFlags ?? []).includes(flag));
}

/** 目標已達成或日後仍可能達成（含「或旗標成立」）。 */
function isGoalAchievable(progress: ProgressContext, storylet: StoryletStatic): boolean {
  if (isStoryletGoalMet(progress.state, storylet)) return true;
  const goal = storylet.goal;
  if (goal.type !== 'flagSet' && goal.orFlag && canStillSetFlag(progress, goal.orFlag)) return true;
  if (goal.type === 'threatRemoved') return goal.unitIds.every((unitId) => canStillDefeat(progress, unitId));
  if (goal.type === 'locationReached') return progress.reachable.has(goal.mapId);
  return canStillSetFlag(progress, goal.flag);
}

/** 尚未開始的片段仍有路可走：給予者在可抵達的發生地點（書信到處可用、告示板需該地有告示板），且目標可能達成。進入條件另行判斷。 */
function isPendingOpen(progress: ProgressContext, storylet: StoryletStatic): boolean {
  const locations = getStoryletMapIds(storylet).filter((mapId) => progress.reachable.has(mapId));
  const options = getGiverOptions(progress.state, storylet);
  if (!options || !locations.length) return false;
  const giverReachable = 'channel' in options
    ? options.channel === 'letter' || (options.channel === 'notice_board' && locations.some(hasNoticeBoard))
    : options.unitIds.some((unitId) => getWorldUnitById(unitId, progress.state)?.mapIds.some((mapId) => locations.includes(mapId)));
  return giverReachable && isGoalAchievable(progress, storylet);
}

/** 進入條件日後仍可能成立：需要的旗標有來源、排除旗標未成立、需要存活的單位未死、需要死亡的單位可擊倒（聲望與勢力關係視為可能）。 */
function couldMeetConditions(progress: ProgressContext, storylet: StoryletStatic): boolean {
  const { state } = progress;
  const requires = storylet.requires ?? {};
  return (requires.flags ?? []).every((flag) => canStillSetFlag(progress, flag)) &&
    !(storylet.excludes?.flags ?? []).some((flag) => state.storyFlags[flag] === true) &&
    (requires.unitsAlive ?? []).every((unitId) => isAlive(state, unitId)) &&
    (requires.unitsDead ?? []).every((unitId) => canStillDefeat(progress, unitId));
}

/**
 * 目前幕是否卡死：沒有目標仍可達成的進行中片段，且（進行中已滿，或）沒有進入條件可能成立、給予者與發生地點可抵達、目標可能達成的未開始片段。
 * 最後一幕同樣判定（預設片段通往結局，O33）；已達成結局後不再判定。
 */
export function isActStuck(state: PlayerState): boolean {
  const story = state.world.story;
  if (story.ending) return false;
  const progress = createProgressContext(state);
  const active = story.activeStorylets.flatMap((entry) => getStoryletById(entry.id) ?? []);
  if (active.some((storylet) => isGoalAchievable(progress, storylet))) return false;
  if (active.length >= storyData.rules.maxActiveStorylets) return true;
  return !getOpenActStorylets(state).some((storylet) => !isStarted(story, storylet.id) &&
    couldMeetConditions(progress, storylet) && isPendingOpen(progress, storylet));
}

/**
 * 目標已達成的片段：進行中的片段（開始後不再檢查進入條件），以及目前幕中符合進入條件但尚未開始的片段（目標先被他人或事件達成）。
 * 進行中的優先，其次依優先度。
 */
export function findCompletableStorylets(state: PlayerState): { storylet: StoryletStatic; wasActive: boolean }[] {
  if (state.world.story.ending) return [];
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

/** 狀態變更前後的主線進展（完成的片段、新的一幕與結局），給玩家的系統訊息；沒有進展時回傳 undefined。 */
export function describeStoryProgress(before: PlayerState, after: PlayerState): string | undefined {
  const known = new Set(before.world.story.completedStorylets.map((entry) => entry.id));
  const lines = after.world.story.completedStorylets.filter((entry) => !known.has(entry.id)).flatMap((entry) => {
    const storylet = getStoryletById(entry.id);
    return storylet ? [`・${entry.forced ? `（${STUCK_RESCUE_CAUSE}）` : ''}「${storylet.title}」完成：${storylet.onComplete.summary}`] : [];
  });
  const act = after.world.story.currentActId !== before.world.story.currentActId ? getStoryActById(after.world.story.currentActId) : undefined;
  if (act) lines.push(`・進入新的一幕：「${act.title}」`);
  const epilogue = !before.world.story.ending ? getEndingEpilogue(after) : undefined;
  if (epilogue) {
    const afterText = epilogue.ending.afterEnding === 'end'
      ? '這條時間線到此結束。可以讀取自動存檔（結局前）或手動存檔，嘗試其他走向。'
      : '世界會繼續運作，你可以用現在的身分繼續活動；主線已經結束。';
    lines.push('', `🏁 結局「${epilogue.ending.title}」：${epilogue.ending.summary}`, '', ...epilogue.texts.flatMap((text) => [text, '']), afterText);
  }
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

/** AI 上下文的主線區段：目前幕、期限、累積的結局特徵、進行中片段與可開始的候選（含演出要求）；達成結局後附上結局與尾聲。 */
export function getStoryContextForAI(state: PlayerState) {
  const story = state.world.story;
  const act = getStoryActById(story.currentActId);
  const epilogue = getEndingEpilogue(state);
  const deadline = getActDeadline(state);
  // 達成結局後進行中片段已清空、也沒有候選（getStoryletCandidates 回傳空陣列）。
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
    act: act && !epilogue ? { title: act.title, goal: act.goal, ...(act.theme ? { theme: act.theme } : {}) } : undefined,
    ending: epilogue ? {
      title: epilogue.ending.title,
      summary: epilogue.ending.summary,
      epilogue: epilogue.texts,
      afterEnding: epilogue.ending.afterEnding === 'end' ? '時間線已結束' : '世界繼續運作，主線已結束'
    } : undefined,
    ...(deadline ? { deadline: { remainingDays: Math.max(0, Math.ceil((deadline.dueAtMinutes - state.gameTimeMinutes) / MINUTES_PER_DAY)) } } : {}),
    endingTraits: story.endingTraits,
    active,
    candidates
  };
}
