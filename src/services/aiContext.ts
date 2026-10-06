import type { AIContextTrimmableSectionId, CharacterHistoryEntry, PlayerState } from '../types/game';
import { aiContextConfig, canPlayerEnterMap, describeUnitBuild, getFactionById, getMapById, getWorldUnitById, getWorldUnitDisposition, getWorldUnitsAtMap, itemsDatabase, scenario } from '../data/staticData';
import { canAcceptQuest, canTurnInQuest, getQuestGiverName, isGeneratedQuest, listVisibleQuests } from '../utils/questRules';
import { getQuestPostingOptions } from '../utils/generatedQuests';
import { getFactionContextForAI } from '../utils/factions';
import { getAvailableServices } from '../utils/tradeRules';
import { getPlayerWorldUnit } from '../utils/worldUnits';
import { formatGameTime } from '../utils/gameTime';
import { getCharacterLegacyForAI, getProposableEvents, getWorldContextForAI } from '../utils/worldEvents';

/**
 * AI 上下文組裝器（O39）：集中負責主持人 AI 每次呼叫的上下文。
 * 上下文分成具名區段；候選清單與規則區段不截斷（避免 AI 看不到合法選項），
 * 歷史類區段（歷代角色、事件、編年史、世界修正）依資料設定的上限與優先順序截斷。
 * 設定條目、角色卡與劇情片段區段待 O36／O31 補上。
 */

/** 目前的回應格式版本；Gemini JSON Schema 要求填入此值。 */
export const AI_RESPONSE_FORMAT_VERSION = 2;
/** 可解析的版本；沒有版本號的回應視為第 1 版（欄位與第 2 版相同）。 */
export const SUPPORTED_AI_RESPONSE_FORMAT_VERSIONS = [1, 2];

export type AIContextSectionId =
  | 'player' | 'legacy' | 'location' | 'npcs' | 'factions' | 'quests' | 'encounters' | 'items' | 'flags'
  | 'worldEvents' | 'chronicle' | 'modifiers' | 'proposableEvents' | 'rules';

export interface AIContextSectionReport {
  id: AIContextSectionId;
  chars: number;
  /** 可截斷區段的字元上限；不截斷的區段沒有此欄位。 */
  maxChars?: number;
  /** 因上限或整體預算省略的較舊項目或細節數。 */
  droppedEntries: number;
}

export interface AIContextReport {
  builtAt: number;
  totalChars: number;
  estimatedTokens: number;
  budgetChars: number;
  /** 截斷後仍超出整體預算（不截斷區段本身已超過預算）。 */
  overBudget: boolean;
  maxCallsPerTurn: number;
  sections: AIContextSectionReport[];
  systemPrompt: string;
  userPrompt: string;
}

/** 粗估 token 數：中日韓文字約 1 字 1 token，其餘約 4 字元 1 token。 */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/gu)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

// 最近一次組裝結果；以外部 store 形式提供給開發模式檢視與設定頁。
let lastReport: AIContextReport | null = null;
const reportListeners = new Set<() => void>();
export const subscribeAIContextReport = (listener: () => void) => {
  reportListeners.add(listener);
  return () => { reportListeners.delete(listener); };
};
export const getLastAIContextReport = () => lastReport;
export function recordAIContextReport(report: AIContextReport) {
  lastReport = report;
  for (const listener of reportListeners) listener();
}

interface Section {
  id: AIContextSectionId;
  /** 固定內容（不截斷）。 */
  text?: string;
  /**
   * 可截斷區段：標籤與依時間排序（舊→新）的項目，截斷時從最舊的開始省略。
   * shrink 可先縮減項目內容（例如省略較舊的事蹟），無可縮減時回傳 false，才省略整個項目。
   */
  list?: { label: string; entries: unknown[]; shrink?: () => boolean };
  /** 已省略的項目或細節數。 */
  dropped: number;
  /** 已省略的整個項目數（從 entries 開頭算起）。 */
  droppedEntries: number;
}

const renderList = (label: string, entries: unknown[], dropped: number) =>
  `- ${label}${dropped ? `（較舊的 ${dropped} 筆已省略）` : ''}: ${JSON.stringify(entries)}`;
const renderSection = (section: Section) => section.list
  ? renderList(section.list.label, section.list.entries.slice(section.droppedEntries), section.droppedEntries)
  : section.text ?? '';

/** 先縮減項目內容、再省略最舊的項目，直到區段不超過 maxChars（最多省略全部項目）。 */
function trimSection(section: Section, maxChars: number) {
  const list = section.list;
  if (!list) return;
  while (section.droppedEntries < list.entries.length && renderSection(section).length > maxChars) {
    if (!list.shrink?.()) section.droppedEntries += 1;
    section.dropped += 1;
  }
}

type LegacyEntry = ReturnType<typeof getCharacterLegacyForAI>[number] & { omittedDeeds?: number };

/** 歷代角色的縮減：從最早的角色開始省略較舊的事蹟，每位角色保留最新一件。 */
function shrinkLegacy(entries: LegacyEntry[]): boolean {
  const target = entries.find((entry) => entry.deeds.length > 1);
  if (!target) return false;
  target.deeds = target.deeds.slice(1);
  target.omittedDeeds = (target.omittedDeeds ?? 0) + 1;
  return true;
}

function buildRules(): string {
  return `請根據玩家行動進行劇情描述，並按下列規則判斷地區移動意圖：
- 每次回應都必須包含 travelRequest；不移動時設為 null。storyText 不得宣稱玩家已抵達或切換地區，除非同一回應提供有效 travelRequest.destinationMapId。
- 只有玩家明確表達「前往、走到、離開目前地區去、移動到」某個可前往地區，才設定 travelRequest.destinationMapId。該 ID 必須完全符合上方相鄰地區清單。
- 詢問地點資訊、觀察遠方、談論某地或描述打算但尚未決定，都不算移動；travelRequest 設為 null。含糊的「去那裡看看」且目的地不明時，先在 storyText 詢問，不要猜測或切換。
- 玩家說「回到/前往」+「村莊/森林」等泛稱時，先從相鄰地區中依 aliases/tags 找候選；若上一個地區符合且可返回或前往，優先選上一個地區。若仍有多個合理候選，travelRequest 設為 null，並在 storyText 詢問具體目的地。
- 不要透過 stateChanges 修改地區；實際移動由遊戲驗證 travelRequest 後套用。不可前往清單以外的地區。
- NPC isDead 為 true 或 currentHp 為 0 時代表角色已死亡，不可當成存活人物交談、提供任務、交易或持有可取得物品。
- NPC 持有物與金幣即為世界實際庫存，不能憑空贈送或生成；只能在持有量足夠且玩家明確取得時回報 npcItemTransfers。
- 陣營傾向描述價值觀；對玩家的目前關係是友善/中立/敵對，依「個人關係 → 所屬勢力對玩家的聲望 → 單位預設關係」判定，已計入上方 disposition。不可由 NPC/魔物種類或九大陣營推斷關係。
- 只有目前關係為敵對的單位才會作為敵人主動攻擊；友善或中立單位即使是魔物也不可無故描述為敵人或發動戰鬥。玩家明確攻擊友善/中立單位時，遊戲會記錄挑釁造成的敵對關係。
- 任務只能從「當前可接取任務」中接受。玩家明確表示接取/接受某任務時，才在 stateChanges.questAcceptances 填入對應 ID；不可因詢問細節、委託描述或含糊回覆而接取。不可自行建立任務、改寫需求或獎勵。
- 任務接取由遊戲端再次驗證所在地、任務給予者是否在場及任務是否已接取/完成；不可只在 storyText 宣稱已接取。
- 任務僅能在上列可交付清單內回報完成。交付道具由程式轉入 NPC 持有物，任務獎勵金幣與物品從任務給予者的實際持有物中發放，不足時只發可取得部分並明確說明短缺。
- 玩家不能取得物品資料庫或在場 NPC 持有物中不存在的道具；不得透過敘事生成不屬於本世界觀的物品（例如 ${scenario.anachronisticItemTerms.join('、')}）、裝備或消耗品。npcItemTransfers 僅能列出當前在場 NPC 與靜態物品 ID，且只在玩家明確偷取、拾取或接受贈與時使用。
- 任何會持續改變玩家或世界狀態的行動，都必須在同一回應填入對應的結構化欄位；若沒有合法狀態欄位可套用，只能描述尚未完成的嘗試或詢問玩家，不可在敘事中宣稱效果已生效。
- 玩家沒有劇情保護。合理危險、檢定失敗或敵方有效攻擊可以使 HP 降至 0；不得為避免死亡而竄改檢定結果、取消已成立的傷害或在 storyText 宣稱玩家倖存。HP 歸零就是死亡，不是昏迷；只有明確套用 unconscious 狀態才代表昏迷。
- 非戰鬥行動若有風險且失敗會造成實質後果，依最相關能力提出 checkRequest（atk/def/spd 或 str/dex/con/int/wis/cha），在成功/失敗分支填入相應 HP/MP 變化。玩家明確提出自我傷害等會直接改變資源的行動時，必須依其明確數值回報變化，並照常套用 HP 歸零死亡規則。
- 若玩家有自傷意圖但沒有說明傷害數值，先詢問數值，不要猜測或只用文字敘述扣血。
- 一般戰鬥由遊戲規則結算，不可敘事中自行宣告擊敗或扣除怪物。
- 每次回應都必須包含 serviceRequest；只有玩家明確要求使用、購買某項服務（例如住店、休息一晚）時，才從「當前可使用服務」清單填入 shopId 與 serviceId，否則設為 null。詢問價格或服務內容不算使用。服務的費用、恢復效果與耗時由遊戲端結算，不可同時用 hpChange/mpChange/goldChange 描述同一服務，也不可在 storyText 宣稱已付款或已恢復；若清單中沒有對應服務，只能說明目前無法使用。
- 遊戲時間由遊戲依行動類型推進；玩家要求原地等待時由遊戲處理，AI 不可在敘事中自行跳過時間。玩家要求等待、睡覺或停留數天等長時間時，本回合只經過一般回合時間：storyText 不得描述數小時以上的時間流逝，應說明單次等待上限為 8 小時，請玩家分次等待或使用旅店休息。
- 世界事件與死因只能依「世界事件紀錄」與「歷代角色」敘述，不可捏造未記錄的死亡、兇手或世界變化。NPC 只有出現在該事件 witnesses 中才知道 detail（誰下手、如何發生）；其他人只知道 summary 的公開結果，可以轉述傳聞或猜測，但不可斷定兇手或經過。目前玩家角色若不是當時在場的人，也只能從在場目擊者口中得知細節。
- 「歷代角色」的 death 與 deeds 是前任冒險者生前造成的既成事實（detail 中的人名就是該前任冒險者，不是目前玩家）。presentWitnesses 列出的是此刻在場、親眼目擊的 NPC：被問到前任冒險者或相關事件時，他們必須明確說出是哪一位前任冒險者（name）、做了什麼（依 detail）、何時何地，不可含糊帶過或推說不清楚；不在 witnesses 中的人只能轉述 summary 的公開結果或傳聞。前任冒險者不可復活，玩家也不可取得其物品。
- 每次回應都必須包含 eventProposals（陣列）；只有玩家行動確實促成「可提議的世界事件」所描述的情況（符合 when 說明）時，才填入該事件 ID，否則為空陣列。事件效果由遊戲驗證後套用，storyText 可描述促成事件的經過，但不可自行宣告超出事件描述的世界改變。
- 每次回應都必須包含 questProposals（陣列，最多一件）。只有玩家在本回合明確向在場人物詢問工作、委託或需要幫忙的事時，才從「可發布的支線委託」提議：templateId、giverId（玩家詢問的對象；若玩家未指定對象則選清單中的人）、targetUnitId（收集範本另填 itemId，討伐範本 itemId 為 null）、quantity（在範圍內）。閒聊、交易、詢問劇本任務或 NPC 自己想找人幫忙都不算，questProposals 必須為空陣列；不可讓 NPC 主動提出委託。報酬、標題、目標與經驗值由遊戲依範本與委託人持有物決定（約為 rewardValuePerQuantity × quantity 的價值），storyText 不可說出具體報酬數字，也不可宣稱玩家已接下委託；發布後玩家需另外表示接受。
- 只有玩家行動或明確世界事件確實改變了當前地區單位對玩家的關係時，才在 stateChanges.unitDispositionChanges 回報單位 ID 與 friendly/neutral/hostile；純對話、陣營傾向或臆測不能改變關係。單位關係變更須與 storyText 敘事一致。
- 每次回應都必須包含 encounterRequest；若玩家尚未實際看見或接觸敵人，設為 null。只有探索、搜索或情境中確實遇見敵人時，才指定本地區可遭遇清單中的 monsterId，並在敘事中描述遭遇。不可只因怪物存在於地圖資料，就宣稱玩家已遭遇；不可遭遇未列出的敵人。
- 玩家在對話中明確要求攻擊目前地區的敵人時，不可假裝攻擊已命中、敵人已受傷或已被擊敗；戰鬥與獎勵由遊戲端確定性規則處理，若無法由遊戲端執行，只能說明尚未發起戰鬥。
- 不可在敘事中宣稱玩家已使用消耗品、恢復 HP/MP 或已取得金幣/經驗/掉落物，除非對應狀態變更已由遊戲端結算。
注意事項：
1. 當給予或扣除玩家道具時，只可使用上方「世界靜態物品清單」中的 Item ID。
2. 只有結果不確定且失敗會有實質影響時才要求檢定；一般對話、觀察或無風險行動不擲骰。
3. 檢定使用 checkRequest {"stat":"atk|def|spd|str|dex|con|int|wis|cha","dc":5至25,"reason":"理由"}。不可在 storyText 中預先宣告檢定成功或失敗。
4. 有檢定時必須提供 checkOutcomes.successText 與 checkOutcomes.failureText。stateChanges 只會在檢定成功時套用；需要描述失敗時的代價可用 failureStateChanges。
5. 只有成功擊敗怪物後才回報 defeatedMonsters；完成任務時必須確認結構化需求均已滿足。
6. 你必須【嚴格】以格式正確的 JSON 格式回答，formatVersion 固定為 ${AI_RESPONSE_FORMAT_VERSION}：

\`\`\`json
{
  "formatVersion": ${AI_RESPONSE_FORMAT_VERSION},
  "storyText": "精彩生動的情境描繪與戰況（約 100-200 字，繁體中文）",
  "suggestedActions": ["選項 1", "選項 2", "選項 3"],
  "encounterRequest": null,
  "travelRequest": null,
  "serviceRequest": null,
  "checkRequest": null,
  "checkOutcomes": null,
  "stateChanges": {
    "hpChange": 0,
    "mpChange": 0,
    "expChange": 0,
    "goldChange": 0,
    "addItems": [{"itemId": "<物品 ID>", "quantity": 1}],
    "removeItems": [],
    "defeatedMonsters": [],
    "questUpdates": [{"questId": "<任務 ID>", "status": "completed"}],
    "questAcceptances": [],
    "npcItemTransfers": [],
    "unitDispositionChanges": []
  },
  "failureStateChanges": null,
  "eventProposals": [],
  "questProposals": []
}
\`\`\`
只可回報玩家已接取且客觀目標已完成的任務；不可自行接取任務或宣告未完成目標完成。`;
}

export interface AssembledAIContext {
  systemPrompt: string;
  report: Omit<AIContextReport, 'userPrompt' | 'builtAt'>;
  responseSchema: Record<string, unknown>;
  availableDestinationIds: string[];
}

/** 依目前狀態組裝主持人 AI 的系統提示、區段報告與 Gemini JSON Schema。 */
export function buildAIContext(playerState: PlayerState, characterHistory: CharacterHistoryEntry[]): AssembledAIContext {
  const currentMap = getMapById(playerState.currentMapId);
  const availableDestinations = currentMap?.connectedMapIds.flatMap((mapId) => {
    const map = getMapById(mapId);
    return map && canPlayerEnterMap(playerState, map)
      ? [{ id: map.id, name: map.name, aliases: map.aliases ?? [], tags: map.locationTags ?? [] }]
      : [];
  }) ?? [];
  const previousMap = playerState.previousMapId ? getMapById(playerState.previousMapId) : undefined;
  const currentUnits = getWorldUnitsAtMap(playerState.currentMapId, playerState);
  const presentNpcs = currentUnits.flatMap((unit) => unit.kind === 'npc' ? [{
    id: unit.id,
    name: unit.name,
    title: unit.title,
    build: describeUnitBuild(unit),
    stats: unit.stats,
    alignment: unit.alignment,
    ...(unit.factionId ? { faction: getFactionById(unit.factionId)?.name ?? unit.factionId } : {}),
    disposition: getWorldUnitDisposition(playerState, unit.id),
    isDead: playerState.unitInstances[unit.id]?.isDead ?? playerState.unitInstances[unit.id]?.currentHp === 0,
    currentHp: playerState.unitInstances[unit.id]?.currentHp ?? unit.stats.hp,
    holdings: playerState.unitInstances[unit.id] ?? { gold: unit.source.startingGold ?? 0, inventory: unit.source.startingInventory ?? [] },
    description: unit.source.description
  }] : []);
  const visibleQuests = listVisibleQuests(playerState);
  const availableQuests = visibleQuests.filter((quest) => canAcceptQuest(playerState, quest))
    .map((quest) => ({ id: quest.id, title: quest.title, giver: getQuestGiverName(playerState, quest), objective: quest.objective,
      ...(isGeneratedQuest(quest) ? { reward: { exp: quest.rewards.exp, gold: quest.rewards.gold, items: quest.rewards.items }, deadline: formatGameTime(quest.expiresAtMinutes) } : {}) }));
  const turnInQuests = visibleQuests.filter((quest) => canTurnInQuest(playerState, quest))
    .map((quest) => ({ id: quest.id, title: quest.title, giver: getQuestGiverName(playerState, quest) }));
  const factionContext = getFactionContextForAI(playerState);
  const encounterCandidates = currentUnits.flatMap((unit) => unit.kind === 'monster' &&
    (!unit.source.requiredQuestId || playerState.activeQuests.some((quest) =>
      quest.questId === unit.source.requiredQuestId && quest.status === 'in_progress'
    )) ? [{ id: unit.id, name: unit.name, build: describeUnitBuild(unit), disposition: getWorldUnitDisposition(playerState, unit.id) }] : []);
  const availableServices = getAvailableServices(playerState);
  const encounteredUnit = playerState.encounteredUnitId ? getWorldUnitById(playerState.encounteredUnitId, playerState) : undefined;
  const playerUnit = getPlayerWorldUnit(playerState);
  const worldContext = getWorldContextForAI(playerState);
  const legacy: LegacyEntry[] = getCharacterLegacyForAI(playerState, characterHistory, aiContextConfig.legacy.maxCharacters, aiContextConfig.legacy.maxDeedsPerCharacter);
  const questPostingOptions = getQuestPostingOptions(playerState);
  const openGeneratedQuests = playerState.world.generatedQuests.filter((quest) => quest.status === 'open')
    .map((quest) => ({ id: quest.id, title: quest.title, giver: quest.questGiver, objective: quest.objective, deadline: formatGameTime(quest.expiresAtMinutes),
      takenByPlayer: playerState.activeQuests.some((entry) => entry.questId === quest.id) }));
  const proposableEvents = getProposableEvents(playerState).map((event) => ({ id: event.id, title: event.title, summary: event.summary, when: event.aiHint }));

  const lines = (...entries: string[]) => entries.join('\n');
  // 區段依提示中的出現順序排列。
  const sections: Section[] = [
    { id: 'player', dropped: 0, droppedEntries: 0, text: lines(
      `- 姓名: ${playerState.name} (Lv.${playerState.level})`,
      `- 玩家單位 ID: ${playerUnit.id} | 有效戰鬥數值: ${JSON.stringify(playerUnit.stats)}（玩家不是 NPC/魔物，不可出現在 unitDispositionChanges、encounterRequest 或戰鬥目標）`,
      `- 種族/職業/等級: ${describeUnitBuild(playerState)} | 陣營: ${playerState.alignment}`,
      `- 能力值：${JSON.stringify(playerState.abilities)}（檢定須選最相關欄位）`,
      `- HP: ${playerState.hp} | MP: ${playerState.mp} | 金幣: ${playerState.gold}`,
      `- 生命狀態: ${playerState.isDead ? '死亡；冒險已結束' : playerState.statusEffects.some((effect) => effect.id === 'unconscious') ? '昏迷；無法採取行動' : '存活'}`,
      `- 遊戲時間: ${formatGameTime(playerState.gameTimeMinutes)}（本回合行動前；時間由遊戲依行動類型推進，敘事中的時刻與晝夜須與此一致，不可自行跳過時間）`,
      `- 背包物品 ID 列表: ${JSON.stringify(playerState.inventory)}`,
      `- 裝備物品 ID: ${JSON.stringify(playerState.equipped)}`,
      `- 已擊敗怪物數量: ${JSON.stringify(playerState.defeatedMonsters)}`
    ) },
    { id: 'legacy', dropped: 0, droppedEntries: 0, list: {
      shrink: () => shrinkLegacy(legacy),
      label: `歷代角色（同一世界中已故的前任冒險者，第 ${playerState.characterSeq} 代為目前玩家；generation 為代數，death 為其死因，deeds 為其生前造成的重大事件（omittedDeeds 為省略的較舊事蹟數），presentWitnesses 為此刻在場的目擊者）`,
      entries: legacy
    } },
    { id: 'location', dropped: 0, droppedEntries: 0, text: lines(
      `- 當前地區: ${currentMap?.name ?? playerState.currentMapId} (${playerState.currentMapId})`,
      `- 可前往的相鄰地區（只可選這些 ID）: ${JSON.stringify(availableDestinations)}`,
      `- 上一個地區: ${previousMap ? `${previousMap.name} (${previousMap.id})，分類 ${JSON.stringify(previousMap.locationTags ?? [])}` : '無'}`
    ) },
    { id: 'npcs', dropped: 0, droppedEntries: 0, text: `- 當前地區在場 NPC 及數值: ${JSON.stringify(presentNpcs)}` },
    { id: 'factions', dropped: 0, droppedEntries: 0, text: lines(
      `- 各勢力對玩家的聲望（遊戲依勢力得知的事件結算，AI 不可自行改變；可依此調整 NPC 語氣、價格談判與傳聞內容）: ${JSON.stringify(factionContext.reputation)}`,
      `- 勢力間關係（未列出者為中立）: ${JSON.stringify(factionContext.relations)}`,
      `- 本地區人物與魔物所屬勢力的公開簡介: ${JSON.stringify(factionContext.presentFactions)}`
    ) },
    { id: 'quests', dropped: 0, droppedEntries: 0, text: lines(
      `- 當前可接取任務（僅可接取這些 ID）: ${JSON.stringify(availableQuests)}`,
      `- 當前可交付任務（需玩家回到任務給予者所在位置且需求齊備）: ${JSON.stringify(turnInQuests)}`,
      `- 進行中任務: ${JSON.stringify(playerState.activeQuests)}`,
      `- 世界上開放中的支線委託（依任務範本生成，報酬已由委託人預先保留）: ${JSON.stringify(openGeneratedQuests)}`,
      `- 可發布的支線委託（questProposals 只可依此提議；沒有列出代表目前不能發布）: ${JSON.stringify(questPostingOptions)}`
    ) },
    { id: 'encounters', dropped: 0, droppedEntries: 0, text: lines(
      `- 當前戰鬥: ${playerState.combat ? JSON.stringify(playerState.combat) : '無'}`,
      `- 目前已遭遇單位: ${encounteredUnit?.name ?? '無'}`,
      `- 本地區可遭遇敵人（只可選這些 ID）: ${JSON.stringify(encounterCandidates)}`,
      `- 當前可使用服務（serviceRequest 只可選這些 shopId/serviceId）: ${JSON.stringify(availableServices)}`
    ) },
    { id: 'items', dropped: 0, droppedEntries: 0, text: `- 世界靜態物品清單（只可使用這些 ID/名稱）: ${JSON.stringify(itemsDatabase.map((item) => ({ id: item.id, name: item.name, type: item.type })))}` },
    { id: 'flags', dropped: 0, droppedEntries: 0, text: `- 劇情旗標 (Flags，只能經由世界事件成立，AI 不可直接設定): ${JSON.stringify(playerState.storyFlags || {})}` },
    { id: 'worldEvents', dropped: 0, droppedEntries: 0, list: {
      label: '世界事件紀錄（遊戲規則寫入的既成事實，依時間排序；summary 是公開消息，detail 是經過與兇手等細節，只有 witnesses 列出的單位親眼看見）',
      entries: worldContext.events
    } },
    { id: 'chronicle', dropped: 0, droppedEntries: 0, list: { label: '世界編年史（較舊事件的摘要）', entries: worldContext.chronicle } },
    { id: 'modifiers', dropped: 0, droppedEntries: 0, list: { label: '生效中的世界修正（已計入上方各單位數值）', entries: worldContext.modifiers } },
    { id: 'proposableEvents', dropped: 0, droppedEntries: 0, text: `- 可提議的世界事件（eventProposals 只可選這些 ID）: ${JSON.stringify(proposableEvents)}` },
    { id: 'rules', dropped: 0, droppedEntries: 0, text: buildRules() }
  ];

  // 1. 各可截斷區段先套用自身上限。
  const trimmable = aiContextConfig.trimmableSections;
  const limitOf = (section: Section) => section.list ? trimmable[section.id as AIContextTrimmableSectionId] : undefined;
  for (const section of sections) {
    const limit = limitOf(section);
    if (limit) trimSection(section, limit.maxChars);
  }
  // 2. 整體仍超出預算時，從優先順序最低的區段開始繼續省略。
  const header = `${scenario.gmRole}\n當前玩家狀態：`;
  const totalChars = () => header.length + sections.reduce((sum, section) => sum + renderSection(section).length + 1, 0);
  const byLowestPriority = sections.filter((section) => limitOf(section)).sort((a, b) => limitOf(b)!.priority - limitOf(a)!.priority);
  for (const section of byLowestPriority) {
    const overflow = totalChars() - aiContextConfig.totalBudgetChars;
    if (overflow <= 0) break;
    trimSection(section, Math.max(0, renderSection(section).length - overflow));
  }

  const systemPrompt = `${header}\n${sections.map(renderSection).join('\n')}\n`;
  const report = {
    totalChars: systemPrompt.length,
    estimatedTokens: estimateTokens(systemPrompt),
    budgetChars: aiContextConfig.totalBudgetChars,
    overBudget: systemPrompt.length > aiContextConfig.totalBudgetChars,
    maxCallsPerTurn: aiContextConfig.maxCallsPerTurn,
    sections: sections.map((section) => ({
      id: section.id,
      chars: renderSection(section).length,
      ...(limitOf(section) ? { maxChars: limitOf(section)!.maxChars } : {}),
      droppedEntries: section.dropped
    })),
    systemPrompt
  };

  const availableDestinationIds = availableDestinations.map((destination) => destination.id);
  const presentNpcIds = presentNpcs.filter((npc) => !npc.isDead && npc.disposition !== 'hostile').map((npc) => npc.id);
  const dispositionUnitIds = currentUnits.filter((unit) => unit.kind !== 'npc' ||
    (!playerState.unitInstances[unit.id]?.isDead && playerState.unitInstances[unit.id]?.currentHp !== 0)).map((unit) => unit.id);
  const knownItemIds = itemsDatabase.map((item) => item.id);
  const postingGivers = questPostingOptions.flatMap((option) => option.givers);
  const postingTargets = postingGivers.flatMap((giver) => giver.targets);
  const postingItemIds = [...new Set(postingTargets.flatMap((target) => target.itemId ? [target.itemId] : []))];
  const responseSchema = {
    type: 'object',
    properties: {
      formatVersion: { type: 'integer', enum: [AI_RESPONSE_FORMAT_VERSION] },
      storyText: { type: 'string' },
      suggestedActions: { type: 'array', items: { type: 'string' } },
      encounterRequest: {
        type: ['object', 'null'],
        properties: {
          monsterId: { type: 'string', enum: encounterCandidates.length ? encounterCandidates.map((monster) => monster.id) : ['__NO_AVAILABLE_MONSTER__'] }
        },
        required: ['monsterId'],
        additionalProperties: false
      },
      // 沒有可用服務時只允許 null，避免模型被迫選擇佔位 ID。
      serviceRequest: availableServices.length ? {
        type: ['object', 'null'],
        properties: {
          shopId: { type: 'string', enum: [...new Set(availableServices.map((service) => service.shopId))] },
          serviceId: { type: 'string', enum: availableServices.map((service) => service.serviceId) }
        },
        required: ['shopId', 'serviceId'],
        additionalProperties: false
      } : { type: 'null' },
      travelRequest: {
        type: ['object', 'null'],
        properties: {
          destinationMapId: {
            type: 'string',
            enum: availableDestinationIds.length > 0 ? availableDestinationIds : ['__NO_AVAILABLE_DESTINATION__']
          }
        },
        required: ['destinationMapId'],
        additionalProperties: false
      },
      checkRequest: { type: ['object', 'null'] },
      checkOutcomes: { type: ['object', 'null'] },
      stateChanges: {
        type: ['object', 'null'],
        properties: {
          questAcceptances: {
            type: 'array',
            items: { type: 'string', enum: availableQuests.length ? availableQuests.map((quest) => quest.id) : ['__NO_AVAILABLE_QUEST__'] }
          },
          npcItemTransfers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                npcId: { type: 'string', enum: presentNpcIds.length ? presentNpcIds : ['__NO_PRESENT_NPC__'] },
                itemId: { type: 'string', enum: knownItemIds },
                quantity: { type: 'integer', minimum: 1, maximum: 99 }
              },
              required: ['npcId', 'itemId', 'quantity'],
              additionalProperties: false
            }
          },
          unitDispositionChanges: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                unitId: { type: 'string', enum: dispositionUnitIds.length ? dispositionUnitIds : ['__NO_CURRENT_UNIT__'] },
                disposition: { type: 'string', enum: ['friendly', 'neutral', 'hostile'] }
              },
              required: ['unitId', 'disposition'],
              additionalProperties: false
            }
          }
        },
        additionalProperties: true
      },
      failureStateChanges: { type: ['object', 'null'], additionalProperties: true },
      // 沒有可提議事件時只允許空陣列。
      eventProposals: proposableEvents.length
        ? { type: 'array', items: { type: 'string', enum: proposableEvents.map((event) => event.id) } }
        : { type: 'array', items: { type: 'string' }, maxItems: 0 },
      // 沒有可發布的委託時只允許空陣列。
      questProposals: questPostingOptions.length
        ? {
          type: 'array',
          maxItems: 1,
          items: {
            type: 'object',
            properties: {
              templateId: { type: 'string', enum: questPostingOptions.map((option) => option.templateId) },
              giverId: { type: 'string', enum: [...new Set(postingGivers.map((giver) => giver.giverId))] },
              targetUnitId: { type: 'string', enum: [...new Set(postingTargets.map((target) => target.targetUnitId))] },
              itemId: postingItemIds.length ? { type: ['string', 'null'], enum: [...postingItemIds, null] } : { type: 'null' },
              quantity: { type: 'integer', minimum: 1, maximum: Math.max(...questPostingOptions.flatMap((option) => option.givers.flatMap((giver) => giver.targets.map((target) => target.quantity.max)))) }
            },
            required: ['templateId', 'giverId', 'targetUnitId', 'itemId', 'quantity'],
            additionalProperties: false
          }
        }
        : { type: 'array', items: { type: 'object' }, maxItems: 0 }
    },
    required: [
      'formatVersion', 'storyText', 'suggestedActions', 'encounterRequest', 'travelRequest', 'serviceRequest', 'checkRequest', 'checkOutcomes', 'stateChanges', 'failureStateChanges', 'eventProposals', 'questProposals'
    ],
    additionalProperties: false
  };

  return { systemPrompt, report, responseSchema, availableDestinationIds };
}
