import type {
  CharacterHistoryEntry,
  CharacterSave,
  PlayerState,
  SaveIndex,
  SaveSlotData,
  SaveSlotId,
  StoryMessage,
  UnitInstance,
  WorldExportFile,
  WorldIndexEntry,
  WorldSave
} from '../types/game';
import { WORLD_STATE_KEYS } from '../types/game';
import { createDefaultUnitInstance, getCharacterClassById, getItemById, getMapById, getSpeciesById, scenario, unitTemplatesDatabase } from '../data/staticData';
import { findLatestPlayerDeath } from './worldEvents';
import { isStoryMessage, normalizePlayerState } from './playerStorage';

/**
 * 存檔格式版本；開發階段每次變更存檔格式就加一，版本不符的存檔直接捨棄，不撰寫遷移程式。
 * 正式上線後才開始為舊版本提供遷移。
 */
export const SAVE_SCHEMA_VERSION = 14;

export const AUTO_SLOT_ID: SaveSlotId = 'auto';
export const MANUAL_SLOT_IDS: SaveSlotId[] = ['manual-1', 'manual-2', 'manual-3'];
const ALL_SLOT_IDS: SaveSlotId[] = [AUTO_SLOT_ID, ...MANUAL_SLOT_IDS];

const INDEX_KEY = 'TRPG_SAVE_INDEX';
const slotKey = (worldId: string, slotId: SaveSlotId) => `TRPG_WORLD_${worldId}_${slotId}`;
/** schemaVersion 2 以前的單一快照存檔；開發階段不遷移，載入時直接移除。 */
const LEGACY_KEYS = ['TRPG_GAME_SESSION', 'TRPG_PLAYER_STATE'];

const MAX_SAVED_MESSAGES = 100;
const MAX_CHARACTER_HISTORY = 50;
/** 多數瀏覽器 localStorage 約 5 MB（以 UTF-16 計）；超過警示比例時提示玩家清理。 */
export const STORAGE_LIMIT_BYTES = 5 * 1024 * 1024;
export const STORAGE_WARNING_RATIO = 0.8;

export interface LoadedSlot {
  player: PlayerState;
  messages: StoryMessage[];
  characterHistory: CharacterHistoryEntry[];
  savedAt: number;
}

// 最近一次寫入是否失敗（例如容量不足）；以外部 store 形式提供給 React（useSyncExternalStore）。
let lastWriteFailed = false;
const saveStatusListeners = new Set<() => void>();
export const subscribeSaveStatus = (listener: () => void) => {
  saveStatusListeners.add(listener);
  return () => { saveStatusListeners.delete(listener); };
};
export const getLastWriteFailed = () => lastWriteFailed;
function reportWrite(ok: boolean) {
  if (lastWriteFailed === !ok) return;
  lastWriteFailed = !ok;
  for (const listener of saveStatusListeners) listener();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ------------------------------------------
// 世界／角色兩層的拆分與合併
// ------------------------------------------

const canonicalInstance = (instance: UnitInstance) => JSON.stringify([instance.level, instance.exp, instance.gold, instance.inventory, instance.currentHp, instance.isDead ?? false, instance.diedAtMinutes, instance.isDormant ?? false]);

/** 存檔只保存與樣板預設不同的單位實例；讀檔時缺少的實例由樣板補上（靜態資料新增的單位也因此出現在舊存檔）。 */
export function compactUnitInstances(instances: Record<string, UnitInstance>): Record<string, UnitInstance> {
  const defaults = new Map(unitTemplatesDatabase().map((template) => [template.id, canonicalInstance(createDefaultUnitInstance(template))]));
  return Object.fromEntries(Object.entries(instances).filter(([unitId, instance]) => defaults.get(unitId) !== canonicalInstance(instance)));
}

/** 將執行期的合併狀態拆成世界存檔與角色存檔。 */
export function splitPlayerState(player: PlayerState, characterHistory: CharacterHistoryEntry[]): { world: WorldSave; character: CharacterSave } {
  const character = { ...player } as Partial<PlayerState>;
  for (const key of WORLD_STATE_KEYS) delete character[key];
  return {
    world: {
      gameTimeMinutes: player.gameTimeMinutes,
      unitInstances: compactUnitInstances(player.unitInstances),
      storyFlags: player.storyFlags,
      world: player.world,
      characterHistory: characterHistory.slice(-MAX_CHARACTER_HISTORY)
    },
    character: character as CharacterSave
  };
}

function normalizeCharacterHistory(value: unknown): CharacterHistoryEntry[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.characterSeq) || (entry.characterSeq as number) < 1 || typeof entry.name !== 'string' || typeof entry.speciesId !== 'string' || !getSpeciesById(entry.speciesId) ||
        typeof entry.classId !== 'string' || !getCharacterClassById(entry.classId) || typeof entry.alignment !== 'string' ||
        !Number.isInteger(entry.level) || !Number.isSafeInteger(entry.endedAtMinutes) || typeof entry.mapId !== 'string' ||
        !getMapById(entry.mapId) || entry.reason !== 'death' || !Number.isSafeInteger(entry.gold) || !Array.isArray(entry.inventory) ||
        (entry.deathEventId !== undefined && typeof entry.deathEventId !== 'string') || (entry.deathSummary !== undefined && typeof entry.deathSummary !== 'string')) return [];
    const inventory = entry.inventory.flatMap((item) => isRecord(item) && typeof item.itemId === 'string' && getItemById(item.itemId) &&
      Number.isInteger(item.quantity) && (item.quantity as number) > 0 ? [{ itemId: item.itemId, quantity: item.quantity as number }] : []);
    return [{ ...(entry as unknown as CharacterHistoryEntry), inventory }];
  }).slice(-MAX_CHARACTER_HISTORY);
}

/** 驗證並合併一個存檔欄位；任何部分無效即回傳 null，不部分載入。 */
function parseSlotData(value: unknown): LoadedSlot | null {
  if (!isRecord(value) || value.schemaVersion !== SAVE_SCHEMA_VERSION || !Number.isFinite(value.savedAt) ||
      !isRecord(value.world) || !isRecord(value.character) || !Array.isArray(value.messages) || !value.messages.every(isStoryMessage)) return null;
  const characterHistory = normalizeCharacterHistory(value.world.characterHistory);
  if (!characterHistory) return null;
  const merged: Record<string, unknown> = { ...value.character };
  for (const key of WORLD_STATE_KEYS) merged[key] = value.world[key];
  const player = normalizePlayerState(merged);
  if (!player) return null;
  return { player, messages: (value.messages as StoryMessage[]).slice(-MAX_SAVED_MESSAGES), characterHistory, savedAt: value.savedAt as number };
}

function createSlotData(player: PlayerState, messages: StoryMessage[], characterHistory: CharacterHistoryEntry[]): SaveSlotData {
  return { schemaVersion: SAVE_SCHEMA_VERSION, savedAt: Date.now(), ...splitPlayerState(player, characterHistory), messages: messages.slice(-MAX_SAVED_MESSAGES) };
}

// ------------------------------------------
// 存檔索引與欄位讀寫
// ------------------------------------------

export function loadSaveIndex(): SaveIndex {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(INDEX_KEY) ?? 'null');
    if (!isRecord(value) || value.schemaVersion !== SAVE_SCHEMA_VERSION || !Array.isArray(value.worlds)) return { schemaVersion: SAVE_SCHEMA_VERSION, worlds: [] };
    const worlds = value.worlds.filter((world): world is WorldIndexEntry => isRecord(world) && typeof world.id === 'string' &&
      typeof world.name === 'string' && typeof world.scenarioId === 'string' && Number.isFinite(world.createdAt) && Number.isFinite(world.updatedAt));
    const activeWorldId = typeof value.activeWorldId === 'string' && worlds.some((world) => world.id === value.activeWorldId) ? value.activeWorldId : undefined;
    return { schemaVersion: SAVE_SCHEMA_VERSION, worlds, ...(activeWorldId ? { activeWorldId } : {}) };
  } catch {
    return { schemaVersion: SAVE_SCHEMA_VERSION, worlds: [] };
  }
}

function writeSaveIndex(index: SaveIndex): boolean {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
    return true;
  } catch {
    return false;
  }
}

export function setActiveWorld(worldId: string | undefined): boolean {
  const index = loadSaveIndex();
  const next: SaveIndex = { schemaVersion: SAVE_SCHEMA_VERSION, worlds: index.worlds };
  if (worldId && index.worlds.some((world) => world.id === worldId)) next.activeWorldId = worldId;
  return writeSaveIndex(next);
}

const generateWorldId = () => `WLD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 建立新世界並寫入第一份自動存檔，成為目前世界。 */
export function createWorld(player: PlayerState, messages: StoryMessage[], name = `${scenario.title}・${player.name}`): WorldIndexEntry | null {
  const now = Date.now();
  const world: WorldIndexEntry = { id: generateWorldId(), name, scenarioId: scenario.id, createdAt: now, updatedAt: now };
  const index = loadSaveIndex();
  if (!writeSaveIndex({ schemaVersion: SAVE_SCHEMA_VERSION, worlds: [...index.worlds, world], activeWorldId: world.id })) return null;
  if (!writeSlot(world.id, AUTO_SLOT_ID, player, messages, [])) {
    deleteWorld(world.id);
    return null;
  }
  return world;
}

/** 寫入存檔欄位；容量不足等失敗回傳 false，不影響其他欄位。 */
export function writeSlot(worldId: string, slotId: SaveSlotId, player: PlayerState, messages: StoryMessage[], characterHistory: CharacterHistoryEntry[]): boolean {
  try {
    localStorage.setItem(slotKey(worldId, slotId), JSON.stringify(createSlotData(player, messages, characterHistory)));
  } catch {
    reportWrite(false);
    return false;
  }
  const index = loadSaveIndex();
  const ok = writeSaveIndex({ ...index, worlds: index.worlds.map((world) => world.id === worldId ? { ...world, updatedAt: Date.now() } : world) });
  reportWrite(ok);
  return ok;
}

export function readSlot(worldId: string, slotId: SaveSlotId): LoadedSlot | null {
  try {
    const raw = localStorage.getItem(slotKey(worldId, slotId));
    return raw ? parseSlotData(JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

export interface SlotSummary {
  savedAt: number;
  characterName: string;
  level: number;
  isDead: boolean;
  mapId: string;
  gameTimeMinutes: number;
}

/** 各欄位摘要；空欄位或已損壞的欄位為 null。 */
export function listSlotSummaries(worldId: string): Record<SaveSlotId, SlotSummary | null> {
  return Object.fromEntries(ALL_SLOT_IDS.map((slotId) => {
    const slot = readSlot(worldId, slotId);
    return [slotId, slot ? {
      savedAt: slot.savedAt, characterName: slot.player.name, level: slot.player.level, isDead: slot.player.isDead,
      mapId: slot.player.currentMapId, gameTimeMinutes: slot.player.gameTimeMinutes
    } : null];
  })) as Record<SaveSlotId, SlotSummary | null>;
}

export function deleteSlot(worldId: string, slotId: SaveSlotId): void {
  try {
    localStorage.removeItem(slotKey(worldId, slotId));
  } catch {
    // 儲存不可用時沒有可刪除的資料。
  }
}

export function deleteWorld(worldId: string): void {
  for (const slotId of ALL_SLOT_IDS) deleteSlot(worldId, slotId);
  const index = loadSaveIndex();
  writeSaveIndex({
    schemaVersion: SAVE_SCHEMA_VERSION,
    worlds: index.worlds.filter((world) => world.id !== worldId),
    ...(index.activeWorldId && index.activeWorldId !== worldId ? { activeWorldId: index.activeWorldId } : {})
  });
}

/** 移除舊版單一快照存檔（開發階段不遷移）。 */
export function clearLegacySaves(): void {
  try {
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  } catch {
    // 儲存不可用時忽略。
  }
}

// ------------------------------------------
// 匯出／匯入
// ------------------------------------------

export function exportWorld(worldId: string): WorldExportFile | null {
  const world = loadSaveIndex().worlds.find((entry) => entry.id === worldId);
  if (!world) return null;
  const slots: WorldExportFile['slots'] = {};
  for (const slotId of ALL_SLOT_IDS) {
    try {
      const raw = localStorage.getItem(slotKey(worldId, slotId));
      if (raw && parseSlotData(JSON.parse(raw) as unknown)) slots[slotId] = JSON.parse(raw) as SaveSlotData;
    } catch {
      // 損壞的欄位不匯出。
    }
  }
  if (!slots.auto) return null;
  return { format: 'adventure-simulator-world', schemaVersion: SAVE_SCHEMA_VERSION, exportedAt: Date.now(), world, slots };
}

export type ImportResult = { ok: true; world: WorldIndexEntry } | { ok: false; reason: string };

/**
 * 匯入世界檔案：完整驗證後才寫入，且一律以新世界 ID 匯入，不覆蓋任何現有存檔；
 * 寫入中途失敗（例如容量不足）會移除已寫入的欄位。
 */
export function importWorld(text: string): ImportResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: '檔案不是有效的 JSON。' };
  }
  if (!isRecord(value) || value.format !== 'adventure-simulator-world') return { ok: false, reason: '這不是本遊戲的世界存檔檔案。' };
  if (value.schemaVersion !== SAVE_SCHEMA_VERSION) return { ok: false, reason: `存檔版本不符（檔案 ${String(value.schemaVersion)}，目前 ${SAVE_SCHEMA_VERSION}），無法匯入。` };
  if (!isRecord(value.world) || typeof value.world.name !== 'string' || !isRecord(value.slots)) return { ok: false, reason: '檔案缺少世界資訊或存檔欄位。' };
  if (value.world.scenarioId !== scenario.id) return { ok: false, reason: '這個世界屬於不同的劇本，無法匯入。' };

  const slots: Partial<Record<SaveSlotId, SaveSlotData>> = {};
  for (const slotId of ALL_SLOT_IDS) {
    const slot = value.slots[slotId];
    if (slot === undefined) continue;
    if (!parseSlotData(slot)) return { ok: false, reason: `存檔欄位「${slotId}」內容無效或已損壞，未匯入任何資料。` };
    slots[slotId] = slot as SaveSlotData;
  }
  if (!slots.auto) return { ok: false, reason: '檔案缺少自動存檔，無法匯入。' };

  const now = Date.now();
  const world: WorldIndexEntry = { id: generateWorldId(), name: `${value.world.name}（匯入）`, scenarioId: scenario.id, createdAt: now, updatedAt: now };
  const written: SaveSlotId[] = [];
  try {
    for (const [slotId, slot] of Object.entries(slots) as [SaveSlotId, SaveSlotData][]) {
      localStorage.setItem(slotKey(world.id, slotId), JSON.stringify(slot));
      written.push(slotId);
    }
  } catch {
    for (const slotId of written) deleteSlot(world.id, slotId);
    return { ok: false, reason: '瀏覽器儲存空間不足，未匯入。請先刪除不需要的世界或存檔。' };
  }
  const index = loadSaveIndex();
  if (!writeSaveIndex({ ...index, worlds: [...index.worlds, world] })) {
    for (const slotId of written) deleteSlot(world.id, slotId);
    return { ok: false, reason: '無法更新存檔索引，未匯入。' };
  }
  return { ok: true, world };
}

// ------------------------------------------
// 容量管理
// ------------------------------------------

export interface StorageUsage {
  usedBytes: number;
  limitBytes: number;
  ratio: number;
}

/** 估算本遊戲在 localStorage 的用量（字串以 UTF-16 每字 2 bytes 計）。 */
export function getStorageUsage(): StorageUsage {
  let usedBytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith('TRPG_')) continue;
      usedBytes += (key.length + (localStorage.getItem(key)?.length ?? 0)) * 2;
    }
  } catch {
    // 儲存不可用時視為 0。
  }
  return { usedBytes, limitBytes: STORAGE_LIMIT_BYTES, ratio: usedBytes / STORAGE_LIMIT_BYTES };
}

// ------------------------------------------
// 新角色接續
// ------------------------------------------

/** 角色結束時的歷代紀錄。 */
export function createHistoryEntry(player: PlayerState): CharacterHistoryEntry {
  const death = player.isDead ? findLatestPlayerDeath(player) : undefined;
  return {
    characterSeq: player.characterSeq, name: player.name, speciesId: player.speciesId, classId: player.classId, alignment: player.alignment, level: player.level,
    endedAtMinutes: player.gameTimeMinutes, mapId: player.currentMapId, reason: 'death',
    ...(death ? { deathEventId: death.id, deathSummary: death.summary } : {}),
    inventory: player.inventory.map((entry) => ({ ...entry })), gold: player.gold
  };
}

/** 在同一世界接續新角色：保留世界層欄位，其餘取自新建角色。 */
export function continueWorldWithCharacter(previous: PlayerState, newCharacter: PlayerState): PlayerState {
  const next = { ...newCharacter, characterSeq: previous.characterSeq + 1 };
  for (const key of WORLD_STATE_KEYS) (next as Record<string, unknown>)[key] = previous[key];
  return next;
}
