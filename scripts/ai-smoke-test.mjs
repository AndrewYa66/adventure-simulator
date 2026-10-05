// AI 實際呼叫的意圖測試：以真實模型驗證結構化欄位（服務、任務、移動、關係、遭遇）是否只在玩家明確要求時出現，
// 並計算每個情境實際送出的 API 請求數（含移動修正請求），可同時比較多個模型。
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

const base = init.createInitialPlayer('測試員', data.scenario.defaultPlayer.classId, data.scenario.defaultPlayer.alignment, true);
const startMap = data.getMapById(base.currentMapId);
const otherMap = data.getMapById(startMap.connectedMapIds[0]);
const tired = { ...base, hp: 40 };
const elsewhere = { ...tired, currentMapId: otherMap.id };
const innService = trade.getAvailableServices(base)[0];
const startQuest = data.questsDatabase.find((quest) => quests.canAcceptQuest(base, quest));
const startNpcs = startMap.npcsPresent.map((id) => data.getWorldUnitById(id));
const otherNpc = data.getWorldUnitById(otherMap.npcsPresent[0]);
const merchant = startNpcs.find((unit) => unit.source.shopId && unit.id !== innService?.shopId && data.getShopById(unit.source.shopId)?.npcId === unit.id) ?? startNpcs[1];

const none = (value) => value === undefined || value === null || (Array.isArray(value) && value.length === 0);
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
  { group: '關係', name: '和 NPC 開玩笑', player: base, action: `我跟${merchant.name}開玩笑說他的手藝退步了`,
    check: (r) => none(r.stateChanges?.unitDispositionChanges), expect: '不改變關係' },
  { group: '遭遇', name: '和 NPC 閒聊', player: elsewhere, action: `我坐下來和${otherNpc?.name ?? '旅人'}聊聊最近的見聞`,
    check: (r) => none(r.encounterRequest), expect: '無 encounterRequest' }
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
    let response;
    try {
      response = await ai.sendPlayerAction({ provider: config.provider, model }, config.apiKey, scenario.player, scenario.action, []);
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
      encounterRequest: response.encounterRequest ?? null
    };
    const shown = Object.fromEntries(Object.entries(fields).filter(([, value]) => !none(value)));
    console.log(`${ok ? '✅' : '❌'} [${scenario.group}] ${scenario.name}（預期：${scenario.expect}；請求 ${requestCount} 次）`);
    console.log(`   行動：${scenario.action}`);
    if (Object.keys(shown).length) console.log(`   欄位：${JSON.stringify(shown)}`);
    if (!ok) console.log(`   敘事：${response.storyText.slice(0, 100)}${response.storyText.length > 100 ? '…' : ''}`);
  }
  summaries.push({ model, passed, errors, totalCalls });
}

console.log('\n========== 總結 ==========');
for (const summary of summaries) {
  const answered = selected.length - summary.errors;
  console.log(`${summary.model}：${summary.passed}/${answered} 符合預期${summary.errors ? `（${summary.errors} 個情境呼叫失敗）` : ''}，實際請求 ${summary.totalCalls} 次`);
}
process.exit(summaries.every((summary) => summary.passed === selected.length) ? 0 : 1);
