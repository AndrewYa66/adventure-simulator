import type { PlayerState, AIResponsePayload } from '../types/game';
import type { AIModelSettings } from './aiModels';
import { canPlayerEnterMap, getItemById, getMapById, getNpcCategoryById, getWorldUnitById, getWorldUnitDisposition, getWorldUnitsAtMap, itemsDatabase, questsDatabase, scenario } from '../data/staticData';
import { canAcceptQuest, canTurnInQuest } from '../utils/questRules';
import { getPlayerWorldUnit } from '../utils/worldUnits';
import { resolveExplicitTravelIntent, storyClaimsPlayerMoved } from '../utils/travelIntent';
import { formatGameTime } from '../utils/gameTime';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const FORMAT_FALLBACK = '模型回應格式不完整，請重新描述行動再試一次。';

function extractResponseText(data: unknown, provider: AIModelSettings['provider']): string {
  if (!isRecord(data)) return '';
  if (provider === 'openai') {
    if (typeof data.output_text === 'string') return data.output_text;
    if (!Array.isArray(data.output)) return '';
    return data.output.flatMap((item) => {
      if (!isRecord(item) || !Array.isArray(item.content)) return [];
      return item.content.flatMap((part) =>
        isRecord(part) && part.type === 'output_text' && typeof part.text === 'string' ? [part.text] : []
      );
    }).join('');
  }

  if (!Array.isArray(data.candidates) || !isRecord(data.candidates[0])) return '';
  const content = data.candidates[0].content;
  if (!isRecord(content) || !Array.isArray(content.parts)) return '';
  return content.parts.flatMap((part) => isRecord(part) && typeof part.text === 'string' ? [part.text] : []).join('');
}

function getReadableNarrative(text: string, depth = 0): string {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!cleaned) return FORMAT_FALLBACK;

  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (isRecord(parsed) && typeof parsed.storyText === 'string' && depth < 2) {
      return getReadableNarrative(parsed.storyText, depth + 1);
    }
    return FORMAT_FALLBACK;
  } catch {
    // Plain text is a useful fallback; JSON-like text is not suitable for the story log.
  }

  if (cleaned.startsWith('{') || cleaned.startsWith('[') || /"(?:storyText|suggestedActions|stateChanges)"\s*:/.test(cleaned)) {
    return FORMAT_FALLBACK;
  }
  return cleaned;
}

const isItemChangeList = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) =>
    isRecord(item) && typeof item.itemId === 'string' && Number.isInteger(item.quantity) && (item.quantity as number) > 0
  );

const isMonsterDefeatList = (value: unknown): boolean =>
  Array.isArray(value) && value.every((entry) =>
    isRecord(entry) && typeof entry.monsterId === 'string' && entry.quantity === 1
  );

const isUnitDispositionChangeList = (value: unknown): boolean =>
  Array.isArray(value) && value.every((entry) =>
    isRecord(entry) && typeof entry.unitId === 'string' && ['friendly', 'neutral', 'hostile'].includes(String(entry.disposition))
  );

function parseAIResponse(value: unknown): AIResponsePayload | null {
  if (!isRecord(value) || typeof value.storyText !== 'string' || !Array.isArray(value.suggestedActions) ||
      !value.suggestedActions.every((action) => typeof action === 'string')) return null;

  if (value.travelRequest !== undefined && value.travelRequest !== null &&
      (!isRecord(value.travelRequest) || typeof value.travelRequest.destinationMapId !== 'string')) return null;
  if (value.encounterRequest !== undefined && value.encounterRequest !== null &&
      (!isRecord(value.encounterRequest) || typeof value.encounterRequest.monsterId !== 'string')) return null;

  if (value.checkRequest !== undefined && value.checkRequest !== null) {
    const check = value.checkRequest;
    const outcomes = value.checkOutcomes;
    if (!isRecord(check) || !['atk', 'def', 'spd', 'str', 'dex', 'con', 'int', 'wis', 'cha'].includes(String(check.stat)) ||
        !Number.isInteger(check.dc) || (check.dc as number) < 5 || (check.dc as number) > 25 ||
        typeof check.reason !== 'string' || !isRecord(outcomes) ||
        typeof outcomes.successText !== 'string' || typeof outcomes.failureText !== 'string') return null;
  } else if (value.checkOutcomes !== undefined && value.checkOutcomes !== null) {
    return null;
  }

  const isValidStateChanges = (changes: unknown): boolean => {
    if (changes === undefined || changes === null) return true;
    if (!isRecord(changes)) return false;
    for (const field of ['hpChange', 'mpChange', 'expChange', 'goldChange']) {
      if (changes[field] !== undefined && (typeof changes[field] !== 'number' || !Number.isFinite(changes[field]))) return false;
    }
    if (changes.addItems !== undefined && !isItemChangeList(changes.addItems)) return false;
    if (changes.removeItems !== undefined && !isItemChangeList(changes.removeItems)) return false;
    if (changes.npcItemTransfers !== undefined && (!Array.isArray(changes.npcItemTransfers) || !changes.npcItemTransfers.every((transfer) =>
      isRecord(transfer) && typeof transfer.npcId === 'string' && typeof transfer.itemId === 'string' &&
      !!getItemById(transfer.itemId) && Number.isInteger(transfer.quantity) && (transfer.quantity as number) > 0 && (transfer.quantity as number) <= 99
    ))) return false;
    if (changes.defeatedMonsters !== undefined && !isMonsterDefeatList(changes.defeatedMonsters)) return false;
    if (changes.unitDispositionChanges !== undefined && !isUnitDispositionChangeList(changes.unitDispositionChanges)) return false;
    if (changes.newLocationId !== undefined && changes.newLocationId !== null && typeof changes.newLocationId !== 'string') return false;
    if (changes.setFlags !== undefined && (!isRecord(changes.setFlags) || !Object.values(changes.setFlags).every((flag) => typeof flag === 'boolean'))) return false;
    if (changes.questUpdates !== undefined && (!Array.isArray(changes.questUpdates) || !changes.questUpdates.every((quest) =>
      isRecord(quest) && typeof quest.questId === 'string' && quest.status === 'completed'
    ))) return false;
    return true;
  };
  if (!isValidStateChanges(value.stateChanges) || !isValidStateChanges(value.failureStateChanges)) return null;
  for (const changes of [value.stateChanges, value.failureStateChanges]) {
    if (isRecord(changes) && changes.questAcceptances !== undefined &&
        (!Array.isArray(changes.questAcceptances) || !changes.questAcceptances.every((questId) => typeof questId === 'string'))) return null;
  }
  if (isRecord(value.stateChanges) && value.stateChanges.defeatedMonsters !== undefined &&
      (!isRecord(value.checkRequest) || value.checkRequest.stat !== 'atk')) return null;
  if (isRecord(value.failureStateChanges) &&
      ['expChange', 'addItems', 'npcItemTransfers', 'defeatedMonsters', 'unitDispositionChanges', 'questUpdates', 'questAcceptances', 'newLocationId', 'setFlags'].some((field) => field in (value.failureStateChanges as Record<string, unknown>))) return null;

  const storyText = getReadableNarrative(value.storyText);
  if (storyText === FORMAT_FALLBACK) return null;
  const stateChanges = isRecord(value.stateChanges) ? { ...value.stateChanges } : value.stateChanges;
  const legacyTravelId = isRecord(stateChanges) && typeof stateChanges.newLocationId === 'string'
    ? stateChanges.newLocationId
    : undefined;
  if (isRecord(stateChanges)) delete stateChanges.newLocationId;
  const travelRequest = value.travelRequest ?? (legacyTravelId ? { destinationMapId: legacyTravelId } : null);
  return { ...value, storyText, stateChanges, travelRequest } as unknown as AIResponsePayload;
}

/**
 * 遇到 503 / 429 時自動重試的 Fetch 輔助函式
 */
async function fetchWithRetry(url: string, options: RequestInit, retries = 2, delay = 1000): Promise<Response> {
  try {
    const res = await fetch(url, options);
    if ((res.status === 503 || res.status === 429) && retries > 0) {
      console.warn(`[AI API] 伺服器忙碌 (${res.status})，${delay / 1000} 秒後重試...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, delay * 1.5);
    }
    return res;
  } catch (err) {
    if (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, delay * 1.5);
    }
    throw err;
  }
}

export async function sendPlayerAction(
  settings: AIModelSettings,
  apiKey: string,
  playerState: PlayerState,
  actionText: string,
  storyHistory: string[]
): Promise<AIResponsePayload> {
  const cleanApiKey = apiKey.trim();
  const currentMap = getMapById(playerState.currentMapId);
  const availableDestinations = currentMap?.connectedMapIds.flatMap((mapId) => {
    const map = getMapById(mapId);
    return map && canPlayerEnterMap(playerState, map)
      ? [{ id: map.id, name: map.name, aliases: map.aliases ?? [], tags: map.locationTags ?? [] }]
      : [];
  }) ?? [];
  const previousMap = playerState.previousMapId ? getMapById(playerState.previousMapId) : undefined;
  const currentUnits = getWorldUnitsAtMap(playerState.currentMapId);
  const presentNpcs = currentUnits.flatMap((unit) => unit.kind === 'npc' ? [{
    id: unit.id,
    name: unit.name,
    title: unit.title,
    category: getNpcCategoryById(unit.categoryId)?.name ?? unit.categoryId,
    stats: unit.stats,
    alignment: unit.alignment,
    disposition: getWorldUnitDisposition(playerState, unit.id),
    isDead: playerState.npcStates[unit.id]?.isDead ?? playerState.npcStates[unit.id]?.currentHp === 0,
    currentHp: playerState.npcStates[unit.id]?.currentHp ?? unit.stats.hp,
    holdings: playerState.npcStates[unit.id] ?? { gold: unit.source.startingGold ?? 0, inventory: unit.source.startingInventory ?? [] },
    description: unit.source.description
  }] : []);
  const availableQuests = questsDatabase.filter((quest) => canAcceptQuest(playerState, quest))
    .map((quest) => ({ id: quest.id, title: quest.title, giver: quest.questGiver, objective: quest.objective }));
  const turnInQuests = questsDatabase.filter((quest) => canTurnInQuest(playerState, quest))
    .map((quest) => ({ id: quest.id, title: quest.title, giver: quest.questGiver }));
  const encounterCandidates = currentUnits.flatMap((unit) => unit.kind === 'monster' &&
    (!unit.source.requiredQuestId || playerState.activeQuests.some((quest) =>
      quest.questId === unit.source.requiredQuestId && quest.status === 'in_progress'
    )) ? [{ id: unit.id, name: unit.name, disposition: getWorldUnitDisposition(playerState, unit.id) }] : []);
  const encounteredUnit = playerState.encounteredUnitId ? getWorldUnitById(playerState.encounteredUnitId) : undefined;
  const playerUnit = getPlayerWorldUnit(playerState);

  if (!cleanApiKey) {
    throw new Error('所選模型的 API Key 尚未設定。請開啟模型設定。');
  }

  const systemPrompt = `
${scenario.gmRole}
當前玩家狀態：
- 姓名: ${playerState.name} (Lv.${playerState.level})
- 玩家單位 ID: ${playerUnit.id} | 有效戰鬥數值: ${JSON.stringify(playerUnit.stats)}（玩家不是 NPC/魔物，不可出現在 unitDispositionChanges、encounterRequest 或戰鬥目標）
- 職業: ${playerState.classId} | 陣營: ${playerState.alignment}
- 能力值：${JSON.stringify(playerState.abilities)}（檢定須選最相關欄位）
- HP: ${playerState.hp} | MP: ${playerState.mp} | 金幣: ${playerState.gold}
- 生命狀態: ${playerState.isDead ? '死亡；冒險已結束' : playerState.statusEffects.some((effect) => effect.id === 'unconscious') ? '昏迷；無法採取行動' : '存活'}
- 遊戲時間: ${formatGameTime(playerState.gameTimeMinutes)}（本回合行動前；時間由遊戲依行動類型推進，敘事中的時刻與晝夜須與此一致，不可自行跳過時間）
- 當前地區: ${currentMap?.name ?? playerState.currentMapId} (${playerState.currentMapId})
- 可前往的相鄰地區（只可選這些 ID）: ${JSON.stringify(availableDestinations)}
- 當前地區在場 NPC 及數值: ${JSON.stringify(presentNpcs)}
- NPC isDead 為 true 或 currentHp 為 0 時代表角色已死亡，不可當成存活人物交談、提供任務、交易或持有可取得物品。
- NPC 持有物與金幣即為世界實際庫存，不能憑空贈送或生成；只能在持有量足夠且玩家明確取得時回報 npcItemTransfers。
- 陣營傾向描述價值觀；對玩家的目前關係是友善/中立/敵對，依單位預設關係及已記錄世界事件判定。不可由 NPC/魔物種類或九大陣營推斷關係。
- 只有目前關係為敵對的單位才會作為敵人主動攻擊；友善或中立單位即使是魔物也不可無故描述為敵人或發動戰鬥。玩家明確攻擊友善/中立單位時，遊戲會記錄挑釁造成的敵對關係。
- 當前可接取任務（僅可接取這些 ID）: ${JSON.stringify(availableQuests)}
- 當前可交付任務（需玩家回到任務給予者所在位置且需求齊備）: ${JSON.stringify(turnInQuests)}
- 上一個地區: ${previousMap ? `${previousMap.name} (${previousMap.id})，分類 ${JSON.stringify(previousMap.locationTags ?? [])}` : '無'}
- 當前戰鬥: ${playerState.combat ? JSON.stringify(playerState.combat) : '無'}
- 目前已遭遇單位: ${encounteredUnit?.name ?? '無'}
- 本地區可遭遇敵人（只可選這些 ID）: ${JSON.stringify(encounterCandidates)}
- 背包物品 ID 列表: ${JSON.stringify(playerState.inventory)}
- 世界靜態物品清單（只可使用這些 ID/名稱）: ${JSON.stringify(itemsDatabase.map((item) => ({ id: item.id, name: item.name, type: item.type })))}
- 裝備物品 ID: ${JSON.stringify(playerState.equipped)}
- 劇情旗標 (Flags): ${JSON.stringify(playerState.storyFlags || {})}
- 進行中任務: ${JSON.stringify(playerState.activeQuests)}
- 已擊敗怪物數量: ${JSON.stringify(playerState.defeatedMonsters)}

請根據玩家行動進行劇情描述，並按下列規則判斷地區移動意圖：
- 每次回應都必須包含 travelRequest；不移動時設為 null。storyText 不得宣稱玩家已抵達或切換地區，除非同一回應提供有效 travelRequest.destinationMapId。
- 只有玩家明確表達「前往、走到、離開目前地區去、移動到」某個可前往地區，才設定 travelRequest.destinationMapId。該 ID 必須完全符合上方相鄰地區清單。
- 詢問地點資訊、觀察遠方、談論某地或描述打算但尚未決定，都不算移動；travelRequest 設為 null。含糊的「去那裡看看」且目的地不明時，先在 storyText 詢問，不要猜測或切換。
- 玩家說「回到/前往」+「村莊/森林」等泛稱時，先從相鄰地區中依 aliases/tags 找候選；若上一個地區符合且可返回或前往，優先選上一個地區。若仍有多個合理候選，travelRequest 設為 null，並在 storyText 詢問具體目的地。
- 不要透過 stateChanges 修改地區；實際移動由遊戲驗證 travelRequest 後套用。不可前往清單以外的地區。
- 任務只能從「當前可接取任務」中接受。玩家明確表示接取/接受某任務時，才在 stateChanges.questAcceptances 填入對應 ID；不可因詢問細節、委託描述或含糊回覆而接取。不可自行建立任務、改寫需求或獎勵。
- 任務接取由遊戲端再次驗證所在地、任務給予者是否在場及任務是否已接取/完成；不可只在 storyText 宣稱已接取。
- 任務僅能在上列可交付清單內回報完成。交付道具由程式轉入 NPC 持有物，任務獎勵金幣與物品從任務給予者的實際持有物中發放，不足時只發可取得部分並明確說明短缺。
- 玩家不能取得物品資料庫或在場 NPC 持有物中不存在的道具；不得透過敘事生成不屬於本世界觀的物品（例如 ${scenario.anachronisticItemTerms.join('、')}）、裝備或消耗品。npcItemTransfers 僅能列出當前在場 NPC 與靜態物品 ID，且只在玩家明確偷取、拾取或接受贈與時使用。
- 任何會持續改變玩家或世界狀態的行動，都必須在同一回應填入對應的結構化欄位；若沒有合法狀態欄位可套用，只能描述尚未完成的嘗試或詢問玩家，不可在敘事中宣稱效果已生效。
- 玩家沒有劇情保護。合理危險、檢定失敗或敵方有效攻擊可以使 HP 降至 0；不得為避免死亡而竄改檢定結果、取消已成立的傷害或在 storyText 宣稱玩家倖存。HP 歸零就是死亡，不是昏迷；只有明確套用 unconscious 狀態才代表昏迷。
- 非戰鬥行動若有風險且失敗會造成實質後果，依最相關能力提出 checkRequest（atk/def/spd 或 str/dex/con/int/wis/cha），在成功/失敗分支填入相應 HP/MP 變化。玩家明確提出自我傷害等會直接改變資源的行動時，必須依其明確數值回報變化，並照常套用 HP 歸零死亡規則。
- 若玩家有自傷意圖但沒有說明傷害數值，先詢問數值，不要猜測或只用文字敘述扣血。
- 一般戰鬥由遊戲規則結算，不可敘事中自行宣告擊敗或扣除怪物。
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
6. 你必須【嚴格】以格式正確的 JSON 格式回答：

\`\`\`json
{
  "storyText": "精彩生動的情境描繪與戰況（約 100-200 字，繁體中文）",
  "suggestedActions": ["選項 1", "選項 2", "選項 3"],
  "encounterRequest": null,
  "travelRequest": null,
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
    "setFlags": {"<劇情旗標>": true},
    "questUpdates": [{"questId": "<任務 ID>", "status": "completed"}],
    "questAcceptances": [],
    "npcItemTransfers": [],
    "unitDispositionChanges": []
  },
  "failureStateChanges": null
}
\`\`\`
只可回報玩家已接取且客觀目標已完成的任務；不可自行接取任務或宣告未完成目標完成。
`;

  const recentHistory = storyHistory.slice(-4).join('\n');
  const userPrompt = `【近期劇情回顧】\n${recentHistory}\n\n【玩家行動】\n${actionText}`;

  const isOpenAI = settings.provider === 'openai';
  const availableDestinationIds = availableDestinations.map((destination) => destination.id);
  const presentNpcIds = presentNpcs.filter((npc) => !npc.isDead && npc.disposition !== 'hostile').map((npc) => npc.id);
  const dispositionUnitIds = currentUnits.filter((unit) => unit.kind !== 'npc' ||
    (!playerState.npcStates[unit.id]?.isDead && playerState.npcStates[unit.id]?.currentHp !== 0)).map((unit) => unit.id);
  const knownItemIds = itemsDatabase.map((item) => item.id);
  const jsonResponseSchema = {
    type: 'object',
    properties: {
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
      failureStateChanges: { type: ['object', 'null'], additionalProperties: true }
    },
    required: [
      'storyText', 'suggestedActions', 'encounterRequest', 'travelRequest', 'checkRequest', 'checkOutcomes', 'stateChanges', 'failureStateChanges'
    ],
    additionalProperties: false
  };
  const endpoint = isOpenAI
    ? 'https://api.openai.com/v1/responses'
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`;
  const createRequestBody = (input: string) => isOpenAI
    ? {
        model: settings.model,
        instructions: systemPrompt,
        input,
        text: { format: { type: 'json_object' } }
      }
    : {
        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${input}` }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: jsonResponseSchema }
      };
  const headers: Record<string, string> = isOpenAI
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${cleanApiKey}` }
    : { 'Content-Type': 'application/json', 'x-goog-api-key': cleanApiKey };
  const requestModelText = async (input: string) => {
    const response = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(createRequestBody(input))
    });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      const detail = errorBody ? JSON.stringify(errorBody) : response.statusText;
      throw new Error(`${settings.provider} ${settings.model} 回應 HTTP ${response.status}: ${detail}`);
    }
    return extractResponseText(await response.json() as unknown, settings.provider);
  };
  const parseResponseText = (text: string): AIResponsePayload | null => {
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    try {
      return parseAIResponse(JSON.parse(cleaned) as unknown);
    } catch {
      return null;
    }
  };

  try {
    const rawText = await requestModelText(userPrompt);
    let parsed = parseResponseText(rawText);
    if (parsed) {
      const requestedId = parsed.travelRequest?.destinationMapId;
      const requestIsValid = !!requestedId && availableDestinations.some((destination) => destination.id === requestedId);
      const localIntent = resolveExplicitTravelIntent(actionText, playerState);
      const narrativeClaimsTravel = storyClaimsPlayerMoved(parsed.storyText);

      const requestNeedsRepair = (!!requestedId && !requestIsValid) ||
        (!requestedId && (localIntent.kind === 'ambiguous' || narrativeClaimsTravel));
      if (requestNeedsRepair) {
        const repairPrompt = `${userPrompt}\n\n【移動回應一致性修正】\n上一份 JSON 的玩家行動為「${actionText}」，AI 敘事為「${parsed.storyText}」，但 travelRequest 缺漏或不是合法的相鄰地區 ID。請重新產生完整 JSON：如果玩家確實要求移動且目的地可唯一判斷，travelRequest.destinationMapId 必須使用可前往清單中的精確 ID；若目的地有多個可能，travelRequest 設為 null 並在 storyText 詢問玩家；若沒有實際移動，請改寫 storyText，不要描述玩家已抵達或切換地區。不要宣稱未執行的移動已完成。`;
        try {
          const repairedText = await requestModelText(repairPrompt);
          const repaired = parseResponseText(repairedText);
          if (repaired) {
            const repairedId = repaired.travelRequest?.destinationMapId;
            if (!repairedId || availableDestinations.some((destination) => destination.id === repairedId)) parsed = repaired;
          }
        } catch (repairError) {
          console.warn('AI 移動回應修正失敗，保留初始回應並由遊戲端驗證。', repairError);
        }
      }
      return parsed;
    }

    return {
      storyText: getReadableNarrative(rawText),
      suggestedActions: ['重新描述行動', '觀察周圍環境']
    };
  } catch (err: unknown) {
    throw new Error(err instanceof Error ? err.message : `${settings.provider} API 連線失敗。`, { cause: err });
  }
}
