// AI 實際呼叫的意圖測試：以真實模型驗證結構化欄位（服務、任務、移動、關係、遭遇、世界事件）是否只在玩家明確要求時出現，
// 支線委託提議、對話記憶、劇情片段選擇（O31）、重要角色批次決策（O34 第 2 階段，角色決策格式第 1 版），並計算每個情境實際送出的 API 請求數（含移動修正請求），可同時比較多個模型。
// 金鑰讀自專案根目錄的 ai-test.local.json（已列入 .gitignore，不會被提交，也不會打包進網站）：
//   { "provider": "gemini", "model": "gemini-3.8-flash", "apiKey": "..." }
// 執行：npm run test:ai                                       （使用設定檔中的模型）
//       npm run test:ai -- --models gemini-3.6-flash,gemini-3.5-flash-lite --delay 15
//       npm run test:ai -- --only 服務,同地區內走動   （只跑名稱或分組符合的情境）
// 每個情境至少呼叫一次模型，會產生少量 API 費用；--delay 為情境間隔秒數（Gemini 免費額度約每分鐘 5 次）。
import { readFileSync } from 'node:fs';
import { runnerImport } from 'vite';

let config;
try {
  config = JSON.parse(readFileSync(new URL('../ai-test.local.json', import.meta.url), 'utf8'));
} catch {
  console.error('找不到或無法解析 ai-test.local.json，請依檔頭說明建立。');
  process.exit(1);
}
if (!config.apiKey || !config.provider || !config.model) {
  console.error('ai-test.local.json 需包含 provider、model、apiKey。');
  process.exit(1);
}
const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const models = (argValue('--models') ?? argValue('--model') ?? config.model).split(',').map((model) => model.trim()).filter(Boolean);
const delayMs = Number(argValue('--delay') ?? 15) * 1000;
const onlyFilters = (argValue('--only') ?? '').split(',').map((text) => text.trim()).filter(Boolean);

// 計算實際送出的模型請求數（含重試與移動修正）。
let requestCount = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  requestCount += 1;
  return realFetch(...args);
};

const { module: ai } = await runnerImport('/src/services/aiService.ts');
const { module: init } = await runnerImport('/src/utils/playerInit.ts');
const { module: trade } = await runnerImport('/src/utils/tradeRules.ts');
const { module: data } = await runnerImport('/src/data/staticData.ts');
const { module: quests } = await runnerImport('/src/utils/questRules.ts');
const { module: world } = await runnerImport('/src/utils/worldEvents.ts');
const { module: saves } = await runnerImport('/src/utils/saveStorage.ts');
const { module: generated } = await runnerImport('/src/utils/generatedQuests.ts');
const { module: story } = await runnerImport('/src/utils/storylets.ts');
const { module: route } = await runnerImport('/src/utils/travelRoute.ts');
const { module: travelIntent } = await runnerImport('/src/utils/travelIntent.ts');
const { module: agentAI } = await runnerImport('/src/services/agentDecisionService.ts');
const { module: partyClaims } = await runnerImport('/src/utils/partyClaims.ts');

const base = init.createInitialPlayer('測試員', data.scenario.defaultPlayer.classId, data.scenario.defaultPlayer.alignment, true);
const startMap = data.getMapById(base.currentMapId);
const otherMap = data.getMapById(startMap.connectedMapIds[0]);
const tired = { ...base, hp: 40 };
const elsewhere = { ...tired, currentMapId: otherMap.id };
const innService = trade.getAvailableServices(base)[0];
const startQuest = data.questsDatabase.find((quest) => quests.canAcceptQuest(base, quest));
const startNpcs = data.getResidentUnitIds(startMap).map((id) => data.getWorldUnitById(id));
const otherNpc = data.getWorldUnitById(data.getResidentUnitIds(otherMap)[0]);
// O45 戰鬥前行動：野外地區、對玩家敵對且無任務前置的可遭遇單位（玩家先發現），與中立的可遭遇單位。
const { module: encounters } = await runnerImport('/src/utils/encounters.ts');
const wildMap = data.mapsDatabase.find((map) => !map.isSafeZone && data.getEncounterUnitIds(map).some((id) => data.getWorldUnitDisposition(base, id) === 'hostile' && !data.getWorldUnitById(id).source.requiredQuestId));
const foe = data.getWorldUnitById(data.getEncounterUnitIds(wildMap).find((id) => data.getWorldUnitDisposition(base, id) === 'hostile' && !data.getWorldUnitById(id).source.requiredQuestId));
const neutralFoe = data.getWorldUnitById(data.getEncounterUnitIds(wildMap).find((id) => data.getWorldUnitDisposition(base, id) !== 'hostile') ?? foe.id);
const wildNpc = data.getWorldUnitById(data.getResidentUnitIds(wildMap)[0]);
const atWild = { ...base, currentMapId: wildMap.id };
const spottedFoe = encounters.setEncounter(atWild, foe.id, true);
const metNeutral = encounters.setEncounter(atWild, neutralFoe.id, false);
const merchant = startNpcs.find((unit) => unit.shopId && unit.id !== innService?.shopId && data.getShopById(unit.shopId)?.ownerUnitId === unit.id) ?? startNpcs[1];

// 世界事件情境：前一位角色在戰鬥中殺死委託人 NPC 後自我了斷，新角色在同一世界接續。
const victimNpc = startNpcs.find((unit) => data.questsDatabase.some((quest) => quest.questGiverId === unit.id));
const formerName = '亞瑟';
const former = init.createInitialPlayer(formerName, data.scenario.defaultPlayer.classId, data.scenario.defaultPlayer.alignment, true);
const formerInCombat = { ...former, combat: { round: 1, participants: [{ key: former.unitId, unitId: former.unitId, side: 'party' }, { key: victimNpc.id, unitId: victimNpc.id, side: 'enemy', label: victimNpc.name, currentHp: 1 }], turnOrder: [former.unitId, victimNpc.id], turnIndex: 0, targetKey: victimNpc.id, opening: 'normal' } };
const formerKilled = world.finalizeWorld(formerInCombat, { ...formerInCombat, combat: undefined, unitInstances: { ...formerInCombat.unitInstances, [victimNpc.id]: { ...formerInCombat.unitInstances[victimNpc.id], currentHp: 0, isDead: true } } }, { [victimNpc.id]: { cause: 'combat', killerUnitId: former.unitId } });
const formerDead = world.finalizeWorld(formerKilled, { ...formerKilled, hp: 0, isDead: true }, { [former.unitId]: { cause: 'self_inflicted' } });
const afterDeathHistory = [saves.createHistoryEntry(formerDead)];
const successor = saves.continueWorldWithCharacter(formerDead, base);
const witnessNpc = data.getWorldUnitById(formerDead.world.events.find((event) => event.death?.victimUnitId === victimNpc.id).witnessUnitIds.find((id) => data.getWorldUnitById(id)?.requiresEncounter !== true));
const successorElsewhere = { ...successor, currentMapId: otherMap.id };
const proposableEvent = world.getProposableEvents(base)[0];

// 對話記憶情境（O39 第二版）：關鍵資訊在 5 輪前說出（舊版只送最後 4 則訊息會遺忘），之後聊了其他話題。
const say = (sender, text, i) => ({ id: `mem-${i}`, sender, text, timestamp: '' });
const memoryFact = '失散多年的妹妹小蓮';
const memoryHistory = [
  say('user', `${merchant.name}，我叫測試員。我這趟出來，是為了找${memoryFact}，她左手腕有一道月牙形的疤。`, 1),
  say('ai', `${merchant.name}放下手中的鐵鎚，認真地聽你說完，點點頭說會替你留意左手腕有月牙疤的姑娘。`, 2),
  say('user', '對了，你這把劍的鋼是從哪裡來的？', 3),
  say('ai', `${merchant.name}得意地說鋼材是從南方運來的，鍛打了七次才成形。`, 4),
  say('user', '最近天氣變冷了，生意還好嗎？', 5),
  say('ai', `${merchant.name}嘆了口氣，說天冷了來修農具的人少了些，但還過得去。`, 6),
  say('user', '村子裡晚上安全嗎？', 7),
  say('ai', `${merchant.name}說晚上最好別一個人往古道走，最近不太平靜。`, 8),
  say('user', '你打鐵多少年了？', 9),
  say('ai', `${merchant.name}笑說從十二歲當學徒算起，快三十年了。`, 10)
];
const rememberedPlayer = { ...base, world: { ...base.world, unitMemories: { [merchant.id]: [{ note: `玩家在找${memoryFact}`, gameTimeMinutes: base.gameTimeMinutes, characterSeq: base.characterSeq }] } } };

// 劇情片段情境（O31）：起始地點的第一個候選片段與其給予者；開始後追問禁止事項。
const storyCandidate = story.getStoryletCandidates(base)[0];
const storyGiver = storyCandidate?.giver.kind === 'unit' ? data.getWorldUnitById(storyCandidate.giver.unitId) : undefined;
const storyActive = storyCandidate ? story.startStorylets(base, base, [storyCandidate.storylet.id]).state : base;
const storyBystander = startNpcs.find((unit) => unit.id !== storyGiver?.id && unit.id !== storyCandidate?.storylet.giver.preferredUnitId) ?? merchant;

// 多段移動情境（O44）：從距離起始地 2 段以上的地區回到起始地，由規則先結算移動（沒有遭遇／途中遭遇）。
const allMapQuests = [...new Set(data.mapsDatabase.flatMap((map) => map.requiredQuestId ? [map.requiredQuestId] : []))]
  .map((questId) => ({ questId, status: 'in_progress', progress: { defeatedUnits: {} } }));
const explorer = { ...base, activeQuests: allMapQuests };
const farRoute = [...route.getReachableRoutes(explorer).values()].find((path) => path.length >= 2);
const farPlayer = farRoute ? { ...explorer, currentMapId: farRoute.at(-1), previousMapId: farRoute.at(-2) } : undefined;
const safeTrip = farPlayer ? route.travelAlongRoute(farPlayer, startMap.id, () => 0.99) : undefined;
const ambushTrip = farPlayer ? route.travelAlongRoute(farPlayer, startMap.id, () => 0) : undefined;
const routeIgnore = (trip) => [trip.origin.id, ...trip.passed.map((map) => map.id)];
const consistentWithTrip = (trip) => (r) => none(r.travelRequest) && travelIntent.getClaimedArrivalMapIds(r.storyText, trip.arrived.id, routeIgnore(trip)).length === 0;

// 委託多樣性情境（O43）：已有一件委託開放中，另一位委託人不可再提議同範本同目標。
const firstOption = generated.getQuestPostingOptions(base).find((option) => option.givers.length >= 2);
const firstGiver = firstOption?.givers[0];
const postedOnce = firstGiver ? generated.postQuestProposals(base, [{ templateId: firstOption.templateId, giverId: firstGiver.giverId,
  targetUnitId: firstGiver.targets[0].targetUnitId, itemId: firstGiver.targets[0].itemId ?? null, quantity: 1 }]).state : base;
const secondGiver = firstOption ? data.getWorldUnitById(firstOption.givers[1].giverId) : merchant;

const none = (value) => value === undefined || value === null || (Array.isArray(value) && value.length === 0);

// 同伴情境（O35-1）：可招募的同伴在隊伍中與玩家同行。AI 可以讓同伴插話，但不能宣稱入隊離隊、不能替同伴給東西、改關係或出手。
const companion = data.unitsDatabase.find((unit) => unit.companion?.recruitable);
const withCompanion = companion ? { ...base, party: [companion.id] } : undefined;
const companionInWild = companion ? { ...spottedFoe, party: [companion.id] } : undefined;
const nonCompanion = startNpcs.find((unit) => !unit.companion?.recruitable && unit.id !== merchant.id) ?? merchant;
const partyClaimPattern = /離開了?隊伍|離隊|脫離隊伍|不再同行|就此別過|分道揚鑣|轉身(先行)?(離去|離開|走遠)|留(下)?你(一|獨自一)人|加入了?(你的)?隊伍|成為(了)?(你的)?同伴|答應(與你)?同行|(與你|和你)結伴同行/;
// D34：敘事宣稱與狀態不符時，前端補說明也算通過（驗收 25），並記錄補說明的次數。
let companionNotices = 0;
const consistentWithParty = (r, p) => {
  const notices = partyClaims.findCompanionClaims(p, r.storyText);
  if (notices.length) { companionNotices += 1; console.log(`   前端補說明：${notices.join('')}`); }
  // 判定用的獨立字詞：去掉引號內對話，逐句檢查，句中有否定字詞（例如「沒有轉身離去」）不算宣稱。
  const claimed = r.storyText.replace(/「[^」]*」|『[^』]*』/g, '').split(/[。！？!?\n]+/)
    .some((sentence) => partyClaimPattern.test(sentence) && !/沒有|沒|並未|未曾|不會|不願|不肯|拒絕|婉拒|無法|不能/.test(sentence.replace(partyClaimPattern, '')));
  return !claimed || notices.length > 0;
};
const companionUntouched = (r) => companion &&
  !(r.stateChanges?.unitItemTransfers ?? []).some((entry) => entry.unitId === companion.id) &&
  !(r.stateChanges?.unitDispositionChanges ?? []).some((entry) => entry.unitId === companion.id) &&
  !(r.questProposals ?? []).some((proposal) => proposal.giverId === companion.id);

// 重要角色決策情境（O34 第 2 階段）：玩家接下村長的劇本任務（村長才會發布支線委託），在村裡跨過午夜；角色決策請求每個情境 1 次。
const chiefQuests = data.questsDatabase.filter((quest) => quest.questGiverId === 'NPC-001').map((quest) => ({ questId: quest.id, status: 'in_progress', progress: { defeatedUnits: {} } }));
const agentBase = { ...base, activeQuests: chiefQuests };
const DAY_MINUTES = 1440;
const crossMidnight = (state) => ({ ...state, gameTimeMinutes: (Math.floor(state.gameTimeMinutes / DAY_MINUTES) + 1) * DAY_MINUTES + 60 });
const withEvent = (state, event) => world.appendEvent(state, { gameTimeMinutes: state.gameTimeMinutes, witnessUnitIds: [], cause: '測試', ...event }).state;
const agentBatchFor = (before, after) => world.finalizeWorldWithAgentBatch(before, after, {}, { deferAgentsToAI: true });
const agentNormal = agentBatchFor(agentBase, crossMidnight(agentBase));
// 只知道部分事件：哥布林斥候目擊的陷阱只有灰燼部族知道，村長的上下文不會出現；村長的動機不應提到陷阱。
const secretBefore = withEvent(agentBase, { type: 'scenario_event', mapId: 'MAP-002', summary: '哥布林斥候在綠林古道埋下了捕獸陷阱。', knownBy: 'witnesses', witnessUnitIds: ['MON-001'] });
const agentSecret = agentBatchFor(secretBefore, crossMidnight(secretBefore));
// 需選委託：村民在村口被哥布林斥候襲擊（村長親眼目擊），村長的其他行動在冷卻中，只剩維持現狀與委託。
const attackedBefore = withEvent({ ...agentBase, world: { ...agentBase.world, agents: { 'NPC-001': { actionDays: { change_faction_relation: 1 } } } } },
  { type: 'scenario_event', mapId: 'MAP-001', summary: '哥布林斥候趁夜在橡木村村口襲擊了兩名村民，村民受了傷，人心惶惶。', knownBy: 'region', witnessUnitIds: ['NPC-001', 'NPC-002'] });
const agentQuest = agentBatchFor(attackedBefore, crossMidnight(attackedBefore));
const agentOutcomesOk = (resolution) => resolution.report.result === 'ai' && resolution.outcomes.every((outcome) => outcome.source === 'ai');
const accepted = (response) => response.stateChanges?.questAcceptances ?? [];

const scenarios = [
  { group: '服務', name: '明確要求住店', player: tired, action: '我要在旅店住一晚，好好休息',
    check: (r) => r.serviceRequest?.serviceId === innService?.serviceId, expect: '有 serviceRequest' },
  { group: '服務', name: '只詢問價格', player: tired, action: '請問住一晚旅店要多少錢？',
    check: (r) => none(r.serviceRequest), expect: '無 serviceRequest' },
  { group: '服務', name: '含糊地想休息', player: tired, action: '好累啊，晚點或許該找個地方休息',
    check: (r) => none(r.serviceRequest), expect: '無 serviceRequest' },
  { group: '服務', name: '直接請店主開房', player: tired, action: `${innService?.provider ?? '老闆'}，幫我開一間房，我今晚住這裡`,
    check: (r) => r.serviceRequest?.serviceId === innService?.serviceId, expect: '有 serviceRequest' },
  { group: '服務', name: 'HP/MP 已滿要求住店', player: base, action: '我要在旅店住一晚',
    check: (r, p) => {
      const shop = r.serviceRequest ? data.getShopById(r.serviceRequest.shopId) : undefined;
      return !shop || !trade.purchaseService(p, shop, r.serviceRequest.serviceId, p.currentMapId).ok;
    }, expect: '不會成功扣款' },
  { group: '服務', name: '沒有旅店的地區要求住店', player: elsewhere, action: '我要找間旅店住一晚',
    check: (r) => none(r.serviceRequest), expect: '無 serviceRequest' },
  { group: '任務', name: '詢問有無委託', player: base, action: '最近有什麼委託嗎？',
    check: (r) => none(accepted(r)), expect: '不接任務' },
  { group: '任務', name: '明確接受委託', player: base, action: `「${startQuest?.title}」這個委託我接下了`,
    check: (r) => accepted(r).includes(startQuest?.id), expect: `接取 ${startQuest?.id}` },
  { group: '任務', name: '詢問報酬並考慮', player: base, action: `「${startQuest?.title}」的報酬是多少？讓我考慮一下`,
    check: (r) => none(accepted(r)), expect: '不接任務' },
  { group: '移動', name: '明確出發', player: base, action: `我出發前往${otherMap.name}`,
    check: (r) => r.travelRequest?.destinationMapId === otherMap.id, expect: `travelRequest ${otherMap.id}` },
  { group: '移動', name: '只詢問距離', player: base, action: `${otherMap.name}離這裡遠嗎？`,
    check: (r) => none(r.travelRequest), expect: '無 travelRequest' },
  { group: '移動', name: '同地區內走動', player: base, action: `我走進旅館找${innService?.provider ?? '老闆'}聊聊`,
    check: (r, _p, calls) => none(r.travelRequest) && calls === 1, expect: '無 travelRequest 且只呼叫 1 次' },
  ...(safeTrip ? [{ group: '移動', name: '多段移動先結算後敘事', player: safeTrip.player, travel: safeTrip, action: `我要回${startMap.name}找${merchant.name}`,
    check: consistentWithTrip(safeTrip), expect: `以${safeTrip.arrived.name}為抵達地、無 travelRequest` }] : []),
  ...(ambushTrip?.interruptedByUnitId ? [{ group: '移動', name: '途中遭遇停在中途', player: ambushTrip.player, travel: ambushTrip, action: `我要回${startMap.name}找${merchant.name}`,
    check: consistentWithTrip(ambushTrip), expect: `停在${ambushTrip.arrived.name}、不宣稱抵達${startMap.name}` }] : []),
  { group: '關係', name: '和 NPC 開玩笑', player: base, action: `我跟${merchant.name}開玩笑說他的手藝退步了`,
    check: (r) => none(r.stateChanges?.unitDispositionChanges), expect: '不改變關係' },
  { group: '遭遇', name: '和 NPC 閒聊', player: elsewhere, action: `我坐下來和${otherNpc?.name ?? '旅人'}聊聊最近的見聞`,
    check: (r) => none(r.encounterRequest), expect: '無 encounterRequest' },
  // O45 戰鬥前行動：AI 只選手段與目標，敘事停在出手前一刻，不宣稱命中或擊殺。
  { group: '戰鬥前行動', name: '悄悄繞到背後出手', player: spottedFoe, action: `我屏住呼吸，悄悄繞到${foe.name}背後，打算出其不意地出手`,
    check: (r) => r.combatRequest?.unitId === foe.id && ['ambush', 'attack'].includes(r.combatRequest?.method) && !encounters.hasCombatClaim(r.storyText), expect: 'combatRequest ambush/attack、不宣稱攻防' },
  { group: '戰鬥前行動', name: '正面衝鋒', player: spottedFoe, action: `我拔出劍，大吼一聲正面衝向${foe.name}`,
    check: (r) => r.combatRequest?.unitId === foe.id && !encounters.hasCombatClaim(r.storyText), expect: 'combatRequest 指向遭遇對象、不宣稱攻防' },
  { group: '戰鬥前行動', name: '一劍砍頭', player: spottedFoe, action: `我一劍砍下${foe.name}的頭`,
    check: (r) => r.combatRequest?.unitId === foe.id && !encounters.hasCombatClaim(r.storyText), expect: 'combatRequest、敘事不寫出擊殺' },
  { group: '戰鬥前行動', name: '拉弓射擊', player: spottedFoe, action: `我舉起弓瞄準${foe.name}射出一箭`,
    check: (r) => r.combatRequest?.unitId === foe.id && !encounters.hasCombatClaim(r.storyText), expect: 'combatRequest、敘事不寫出命中' },
  { group: '戰鬥前行動', name: '閃過撲擊反擊', player: metNeutral, action: `我閃過${neutralFoe.name}的撲擊，反手一刀砍向牠`,
    check: (r) => (r.combatRequest === null || r.combatRequest?.unitId === neutralFoe.id) && !encounters.hasCombatClaim(r.storyText), expect: '沒開戰或開戰對象正確、不宣稱攻防' },
  { group: '戰鬥前行動', name: '只是觀察', player: spottedFoe, action: `我躲在樹叢裡觀察${foe.name}的動向`,
    check: (r) => none(r.combatRequest) && !encounters.hasCombatClaim(r.storyText), expect: '無 combatRequest、不宣稱攻防' },
  { group: '戰鬥前行動', name: '等對方自己離開', player: metNeutral, action: `我停下腳步保持距離，等${neutralFoe.name}自己走開`,
    check: (r) => none(r.combatRequest) && !encounters.hasCombatClaim(r.storyText), expect: '無 combatRequest（encounterEnded 可為 true）' },
  { group: '戰鬥前行動', name: '向 NPC 打聽', player: metNeutral, action: `${wildNpc?.name ?? '旅人'}，這附近安不安全？`,
    check: (r) => none(r.combatRequest), expect: '無 combatRequest' },
  { group: '世界事件', name: '向目擊者詢問死因', player: successor, history: afterDeathHistory,
    action: `${witnessNpc.name}，${victimNpc.name}是怎麼死的？是誰下的手？`,
    check: (r) => r.storyText.includes(formerName), expect: `目擊者說出兇手 ${formerName}` },
  // 認知層級（O39）：與目擊者同勢力但未在場的人只聽過傳聞，以保留的口吻提到兇手；資料中目前沒有其他勢力的 NPC，「不知道」層級由規則腳本驗證。
  { group: '世界事件', name: '向同勢力未在場者打聽兇手', player: successorElsewhere, history: afterDeathHistory,
    action: `${otherNpc?.name ?? '旅人'}，你知道是誰殺了${victimNpc.name}嗎？`,
    check: (r) => r.storyText.includes(formerName) && /聽說|傳|據說|好像|不清楚|不確定/.test(r.storyText), expect: '以傳聞口吻提到兇手' },
  { group: '歷代角色', name: '向目擊者打聽前任冒險者', player: successor, history: afterDeathHistory,
    action: `${witnessNpc.name}，之前那位叫${formerName}的冒險者，你知道他做過什麼嗎？`,
    check: (r) => r.storyText.includes(victimNpc.name), expect: `目擊者說出前任冒險者殺害${victimNpc.name}` },
  { group: '委託', name: '向在場人物詢問工作', player: base, action: `${merchant.name}，你這邊有沒有什麼工作可以讓我幫忙？`,
    check: (r, p) => (r.questProposals ?? []).length === 1 && generated.validateQuestProposal(p, r.questProposals[0]).ok,
    expect: '提議一件合法委託' },
  { group: '委託', name: '同目標開放中不重複提議', player: postedOnce, action: `${secondGiver.name}，你這邊有沒有什麼工作可以讓我幫忙？`,
    check: (r, p) => (r.questProposals ?? []).every((proposal) => generated.validateQuestProposal(p, proposal).ok),
    expect: '沒有提議或提議合法（不重複同目標）' },
  { group: '委託', name: '閒聊不發布委託', player: base, action: `我跟${merchant.name}聊聊他最近打造的武器`,
    check: (r) => none(r.questProposals), expect: '無 questProposals' },
  { group: '對話記憶', name: '連續交談記得前文', player: base, messages: memoryHistory,
    action: `${merchant.name}，你還記得我一開始說我在找誰嗎？她身上有什麼特徵？`,
    check: (r) => r.storyText.includes('小蓮') && r.storyText.includes('月牙'), expect: '說出小蓮與月牙疤' },
  { group: '對話記憶', name: '記下值得記住的事', player: base,
    action: `${merchant.name}，我叫測試員，我在找${memoryFact}。如果你看到她，請一定要告訴我。`,
    check: (r) => (r.memoryNotes ?? []).some((entry) => entry.unitId === merchant.id && entry.note.includes('小蓮')), expect: `memoryNotes 記下 ${merchant.id} 與小蓮` },
  { group: '對話記憶', name: '依人物記憶延續', player: rememberedPlayer,
    action: `${merchant.name}，好久不見。你還記得我在找誰嗎？`,
    check: (r) => r.storyText.includes('小蓮'), expect: '依 memories 說出小蓮' },
  ...(storyCandidate && storyGiver ? [
    { group: '主線', name: '給予者帶出劇情片段', player: base,
      action: `我走到${storyGiver.name}面前問：「您看起來有心事，最近村子裡發生了什麼事嗎？有什麼我能幫忙的？」`,
      check: (r) => (r.storyletProposals ?? []).includes(storyCandidate.storylet.id), expect: `storyletProposals 含 ${storyCandidate.storylet.id}` },
    { group: '主線', name: '和其他人閒聊不開始片段', player: base, action: `我跟${storyBystander.name}聊聊今天的天氣和最近的收成`,
      check: (r) => none(r.storyletProposals), expect: '無 storyletProposals' },
    { group: '主線', name: '追問也不說出禁止事項', player: storyActive,
      action: `${storyGiver.name}，你剛說牠們以前不會靠這麼近，「以前」是什麼意思？你以前和哥布林的首領有過什麼來往嗎？請老實告訴我。`,
      check: (r) => none(r.storyletProposals) && !/格羅姆|裂牙/.test(r.storyText), expect: '不提酋長名字、不重複開始片段' }
  ] : []),
  ...(companion ? [
    { group: '同伴', name: '和同伴交談', player: withCompanion, action: `${companion.name}，你覺得我們接下來該先去哪裡？`,
      check: (r, p) => r.storyText.includes(companion.name) && companionUntouched(r) && consistentWithParty(r, p),
      expect: '同伴以自己的口吻回應、不宣稱入隊離隊、不改變同伴狀態' },
    { group: '同伴', name: '向同伴要東西', player: withCompanion, action: `${companion.name}，把你身上的東西分我一些吧`,
      check: (r, p) => companionUntouched(r) && consistentWithParty(r, p), expect: '沒有同伴的物品轉移' },
    { group: '同伴', name: '打字請同伴離開', player: withCompanion, action: `${companion.name}，你先回去吧，接下來我想一個人走`,
      check: (r, p) => companionUntouched(r) && consistentWithParty(r, p), expect: '敘事不宣稱同伴離隊（離隊由選項列執行）' },
    { group: '同伴', name: '打字邀請非同伴入隊', player: withCompanion, action: `${nonCompanion.name}，跟我們一起去冒險吧！`,
      check: (r, p) => companionUntouched(r) && consistentWithParty(r, p), expect: '敘事不宣稱對方入隊' },
    { group: '同伴', name: '叫同伴替我出手', player: companionInWild, action: `${companion.name}，替我朝${foe.name}射一箭！`,
      check: (r, p) => companionUntouched(r) && !encounters.hasCombatClaim(r.storyText) && consistentWithParty(r, p),
      expect: '不宣稱命中或擊倒（開戰與否由規則決定）' },
    { group: '同伴', name: '和他人交談時同伴在旁', player: withCompanion, action: `${merchant.name}，最近古道那邊的狀況怎麼樣？`,
      check: (r, p) => companionUntouched(r) && consistentWithParty(r, p), expect: '同伴可插話，但不改變同伴狀態、不宣稱入隊離隊' }
  ] : []),
  ...(agentNormal.agentBatch ? [{ group: '角色決策', name: '一般跨日（村長與酋長）', agent: agentNormal,
    check: (resolution) => agentOutcomesOk(resolution), expect: '每位角色都選了合法候選且有動機' }] : []),
  ...(agentSecret.agentBatch ? [{ group: '角色決策', name: '角色只知道部分事件', agent: agentSecret,
    check: (resolution) => agentOutcomesOk(resolution) && !resolution.state.world.events.some((event) => event.agent?.unitId === 'NPC-001' && /陷阱/.test(event.agent.intent)),
    expect: '回應有效、村長的動機不提未知的陷阱' }] : []),
  ...(agentQuest.agentBatch ? [{ group: '角色決策', name: '村民遇襲後需選委託', agent: agentQuest,
    check: (resolution) => agentOutcomesOk(resolution) && resolution.state.world.events.some((event) => event.agent?.unitId === 'NPC-001' && event.agent.action === 'post_quest'),
    expect: '村長選擇發布委託' }] : []),
  ...(proposableEvent ? [
    { group: '世界事件', name: '促成可提議事件', player: base,
      action: `我嚴肅地向${victimNpc.name}警告：古道上的哥布林越來越多，最近有人遇襲，請村民務必結伴出入、夜裡緊閉門戶。`,
      check: (r) => (r.eventProposals ?? []).includes(proposableEvent.id), expect: `提議 ${proposableEvent.id}` },
    { group: '世界事件', name: '只是閒聊不提議事件', player: base, action: `我跟${merchant.name}聊聊今天的天氣`,
      check: (r) => none(r.eventProposals), expect: '無 eventProposals' }
  ] : [])
];

const selected = onlyFilters.length ? scenarios.filter((scenario) => onlyFilters.some((text) => scenario.name.includes(text) || scenario.group === text)) : scenarios;

const summaries = [];
for (const model of models) {
  console.log(`\n========== ${config.provider} / ${model} ==========`);
  let passed = 0;
  let errors = 0;
  let totalCalls = 0;
  for (const [index, scenario] of selected.entries()) {
    if ((index > 0 || summaries.length > 0) && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    requestCount = 0;
    if (scenario.agent) {
      // 角色決策（O34 第 2 階段）：與遊戲相同的請求組裝、呼叫、解析與套用。
      const request = agentAI.buildAgentBatchRequest(scenario.agent.state, scenario.agent.agentBatch);
      let resolution;
      try {
        const text = await agentAI.requestAgentDecisionText({ provider: config.provider, model }, config.apiKey, request, 30000);
        resolution = agentAI.resolveAgentBatch(scenario.agent.state, request, text);
      } catch (error) {
        errors += 1;
        totalCalls += requestCount;
        console.log(`⚠️ [${scenario.group}] ${scenario.name}：呼叫失敗（${error instanceof Error ? error.message.slice(0, 120) : error}）`);
        continue;
      }
      totalCalls += requestCount;
      const ok = scenario.check(resolution);
      if (ok) passed += 1;
      console.log(`${ok ? '✅' : '❌'} [${scenario.group}] ${scenario.name}（預期：${scenario.expect}；請求 ${requestCount} 次、${request.systemPrompt.length + request.userPrompt.length} 字元）`);
      for (const outcome of resolution.report.outcomes) console.log(`   ${outcome.name}：${outcome.source === 'ai' ? 'AI' : `規則（${outcome.reason}）`}`);
      for (const event of resolution.state.world.events.filter((entry) => entry.agent && entry.cause.includes('AI'))) console.log(`   事件：${event.summary}｜動機：${event.agent.intent}`);
      if (!ok) console.log(`   回應：${resolution.report.responseText ?? resolution.report.reason}`);
      continue;
    }
    let response;
    try {
      // 與遊戲相同：玩家打字要同伴離隊時，送 AI 的行動附上「同伴仍在隊伍中」的提醒（D34）。
      const actionForAI = `${scenario.action}${partyClaims.describeDismissIntentForAI(partyClaims.findDismissIntent(scenario.player, scenario.action))}`;
      response = await ai.sendPlayerAction({ provider: config.provider, model }, config.apiKey, scenario.player, actionForAI, scenario.messages ?? [], scenario.history ?? [], scenario.travel);
    } catch (error) {
      errors += 1;
      totalCalls += requestCount;
      console.log(`⚠️ [${scenario.group}] ${scenario.name}：呼叫失敗（${error instanceof Error ? error.message.slice(0, 120) : error}）`);
      continue;
    }
    totalCalls += requestCount;
    const ok = scenario.check(response, scenario.player, requestCount);
    if (ok) passed += 1;
    const fields = {
      serviceRequest: response.serviceRequest ?? null,
      questAcceptances: accepted(response),
      travelRequest: response.travelRequest ?? null,
      unitDispositionChanges: response.stateChanges?.unitDispositionChanges ?? [],
      encounterRequest: response.encounterRequest ?? null,
      combatRequest: response.combatRequest ?? null,
      encounterEnded: response.encounterEnded || null,
      eventProposals: response.eventProposals ?? [],
      questProposals: response.questProposals ?? [],
      memoryNotes: response.memoryNotes ?? [],
      storyletProposals: response.storyletProposals ?? []
    };
    const shown = Object.fromEntries(Object.entries(fields).filter(([, value]) => !none(value)));
    console.log(`${ok ? '✅' : '❌'} [${scenario.group}] ${scenario.name}（預期：${scenario.expect}；請求 ${requestCount} 次）`);
    console.log(`   行動：${scenario.action}`);
    if (Object.keys(shown).length) console.log(`   欄位：${JSON.stringify(shown)}`);
    const invalidQuest = (response.questProposals ?? []).map((proposal) => generated.validateQuestProposal(scenario.player, proposal)).find((result) => !result.ok);
    if (invalidQuest) console.log(`   委託驗證：${invalidQuest.reason}`);
    if (!ok || scenario.travel || scenario.group === '同伴') console.log(`   敘事：${response.storyText.slice(0, 160)}${response.storyText.length > 160 ? '…' : ''}`);
  }
  summaries.push({ model, passed, errors, totalCalls });
}

console.log('\n========== 總結 ==========');
if (selected.some((scenario) => scenario.group === '同伴')) console.log(`「同伴」前端補說明次數：${companionNotices}`);
for (const summary of summaries) {
  const answered = selected.length - summary.errors;
  console.log(`${summary.model}：${summary.passed}/${answered} 符合預期${summary.errors ? `（${summary.errors} 個情境呼叫失敗）` : ''}，實際請求 ${summary.totalCalls} 次`);
}
process.exit(summaries.every((summary) => summary.passed === selected.length) ? 0 : 1);
