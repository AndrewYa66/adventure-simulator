import type { AIResponsePayload, PlayerState, UnitMemoryNote } from '../types/game';
import { aiContextConfig, getWorldUnitsAtMap } from '../data/staticData';

/**
 * 人物記憶（O39 第二版）：主持人 AI 以 memoryNotes 提出在場人物值得記住的一句話，
 * 前端驗證人物在場且存活後寫入世界層，每人只保留最新的幾則；不增加 AI 呼叫次數。
 */

/** 可以記下記憶的人物：目前地區的居民（非遭遇型單位）且存活。 */
export function getMemoryEligibleUnitIds(state: PlayerState): string[] {
  return getWorldUnitsAtMap(state.currentMapId, state).filter((unit) => {
    const instance = state.unitInstances[unit.id];
    return !unit.requiresEncounter && !instance?.isDead && instance?.currentHp !== 0;
  }).map((unit) => unit.id);
}

/** 只回傳目前角色代數的記憶文字（舊→新），供 AI 上下文使用。 */
export function getUnitMemoriesForAI(state: PlayerState, unitId: string): string[] {
  return (state.world.unitMemories[unitId] ?? []).filter((entry) => entry.characterSeq === state.characterSeq).map((entry) => entry.note);
}

const normalizeNote = (note: string) => note.replace(/\s+/g, ' ').trim().slice(0, aiContextConfig.memory.maxNoteChars);

/**
 * 驗證並寫入 memoryNotes：人物須在 eligibleUnitIds 中（以行動前的在場人物判斷）；
 * 空白或與既有記憶重複的內容略過；每次回應最多 maxNotesPerResponse 則，每人超過 maxNotesPerUnit 則時捨棄最舊的。
 */
export function applyMemoryNotes(state: PlayerState, notes: AIResponsePayload['memoryNotes'], eligibleUnitIds: string[]): { state: PlayerState; accepted: number } {
  const { maxNotesPerResponse, maxNotesPerUnit } = aiContextConfig.memory;
  const unitMemories = { ...state.world.unitMemories };
  let accepted = 0;
  for (const entry of (notes ?? []).slice(0, maxNotesPerResponse)) {
    const note = normalizeNote(entry.note);
    if (!note || !eligibleUnitIds.includes(entry.unitId)) continue;
    const existing = unitMemories[entry.unitId] ?? [];
    if (existing.some((memory) => memory.characterSeq === state.characterSeq && memory.note === note)) continue;
    const memory: UnitMemoryNote = { note, gameTimeMinutes: state.gameTimeMinutes, characterSeq: state.characterSeq };
    unitMemories[entry.unitId] = [...existing, memory].slice(-maxNotesPerUnit);
    accepted += 1;
  }
  return accepted ? { state: { ...state, world: { ...state.world, unitMemories } }, accepted } : { state, accepted };
}
