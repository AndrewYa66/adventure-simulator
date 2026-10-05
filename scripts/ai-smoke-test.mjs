// AI 實際呼叫的冒煙測試：以真實模型驗證 serviceRequest 等結構化欄位，並套用與遊戲相同的前端規則。
// 金鑰讀自專案根目錄的 ai-test.local.json（*.local 已列入 .gitignore，不會被提交，也不會打包進網站）：
//   { "provider": "gemini", "model": "gemini-3.8-flash", "apiKey": "..." }
// 執行：npm run test:ai   （每個情境呼叫一次模型，會產生少量 API 費用）
// 暫時改用其他模型或調整情境間隔：npm run test:ai -- --model gemini-3.6-flash --delay 20
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

const modelArgIndex = process.argv.indexOf('--model');
if (modelArgIndex > 0 && process.argv[modelArgIndex + 1]) config.model = process.argv[modelArgIndex + 1];
console.log(`模型：${config.provider} / ${config.model}`);

const { module: ai } = await runnerImport('/src/services/aiService.ts');
const { module: init } = await runnerImport('/src/utils/playerInit.ts');
const { module: trade } = await runnerImport('/src/utils/tradeRules.ts');
const { module: data } = await runnerImport('/src/data/staticData.ts');
const { module: time } = await runnerImport('/src/utils/gameTime.ts');

const base = init.createInitialPlayer('測試員', data.scenario.defaultPlayer.classId, data.scenario.defaultPlayer.alignment, true);
const otherMapId = data.getMapById(base.currentMapId)?.connectedMapIds[0];
const scenarios = [
  { name: '起始地區、HP 未滿，要求住店', player: { ...base, hp: 40 }, action: '我要在旅店住一晚，好好休息', expectService: true, expectOk: true },
  { name: '起始地區、只詢問價格', player: { ...base, hp: 40 }, action: '請問住一晚旅店要多少錢？', expectService: false },
  { name: '起始地區、HP/MP 已滿，要求住店', player: base, action: '我要在旅店住一晚', expectService: true, expectOk: false },
  ...(otherMapId ? [{ name: '沒有旅店的地區，要求住店', player: { ...base, hp: 40, currentMapId: otherMapId }, action: '我要找間旅店住一晚', expectService: false }] : [])
];

// Gemini 免費額度約每分鐘 5 次；情境之間預設間隔 15 秒，可用 --delay <秒> 調整。
const delayArgIndex = process.argv.indexOf('--delay');
const delayMs = (delayArgIndex > 0 ? Number(process.argv[delayArgIndex + 1]) : 15) * 1000;

let failures = 0;
for (const [index, scenario] of scenarios.entries()) {
  if (index > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  let response;
  try {
    response = await ai.sendPlayerAction({ provider: config.provider, model: config.model }, config.apiKey, scenario.player, scenario.action, []);
  } catch (error) {
    failures += 1;
    console.log(`\n⚠️ ${scenario.name}：呼叫失敗（${error instanceof Error ? error.message.slice(0, 160) : error}）`);
    continue;
  }
  const request = response.serviceRequest ?? null;
  const shop = request ? data.getShopById(request.shopId) : undefined;
  const result = request && shop ? trade.purchaseService(scenario.player, shop, request.serviceId, scenario.player.currentMapId) : undefined;
  const passed = (!!request === scenario.expectService) && (!scenario.expectService || scenario.expectOk === undefined || (result?.ok ?? false) === scenario.expectOk);
  if (!passed) failures += 1;

  console.log(`\n${passed ? '✅' : '❌'} ${scenario.name}`);
  console.log(`   行動：${scenario.action}`);
  console.log(`   serviceRequest：${JSON.stringify(request)}（預期${scenario.expectService ? '有' : '無'}）`);
  if (result?.ok) {
    console.log(`   結算：金幣 ${scenario.player.gold}→${result.player.gold}、HP ${scenario.player.hp}→${result.player.hp}、時間 ${time.formatGameTime(scenario.player.gameTimeMinutes)}→${time.formatGameTime(result.player.gameTimeMinutes)}`);
  } else if (result) {
    console.log(`   結算：未完成（${result.reason}）`);
  }
  const changes = response.stateChanges ?? {};
  if (changes.hpChange || changes.goldChange) console.log(`   ⚠️ AI 另外回報 hpChange=${changes.hpChange ?? 0}、goldChange=${changes.goldChange ?? 0}`);
  console.log(`   敘事：${response.storyText.slice(0, 120)}${response.storyText.length > 120 ? '…' : ''}`);
}

console.log(`\n${scenarios.length - failures}/${scenarios.length} 個情境符合預期。`);
process.exit(failures ? 1 : 0);
