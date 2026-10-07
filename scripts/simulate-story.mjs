// 主線自動模擬（O33）：不呼叫 AI，大量重複遊玩目前的劇本資料，檢查卡死、統計結局與保底觸發頻率、量測 AI 上下文大小。
// 用法：npm run test:sim [-- --runs 200] [--seed 123] [--days 60]；預設值見 scripts/simulation.config.json。
// 有例外、結局判定不可重現、上下文超出預算、未達成結局或模擬不可重現時以非零結束碼結束；疑似漏報的卡死只列出供人工檢查。
import { readFileSync } from 'node:fs';
import { runnerImport } from 'vite';

const config = JSON.parse(readFileSync(new URL('./simulation.config.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(`--${name}`); return index >= 0 ? Number(args[index + 1]) : undefined; };
for (const [flag, key] of [['runs', 'runs'], ['seed', 'seed'], ['days', 'maxGameDays']]) {
  const value = option(flag);
  if (value !== undefined) {
    if (!Number.isInteger(value) || value < 1) { console.error(`--${flag} 須為正整數`); process.exit(1); }
    config[key] = value;
  }
}

const { module } = await runnerImport('/src/dev/storySimulation.ts');
const started = Date.now();
const summary = module.runSimulation(config, (done) => {
  if (done % 100 === 0 || done === config.runs) process.stdout.write(`\r模擬中 ${done}/${config.runs}`);
});
process.stdout.write('\n');

const percent = (count) => `${count}（${((count / summary.runs) * 100).toFixed(1)}%）`;
console.log(`\n=== 主線自動模擬：${summary.runs} 次，種子 ${config.seed} 起，上限 ${config.maxGameDays} 遊戲日，耗時 ${((Date.now() - started) / 1000).toFixed(1)} 秒 ===`);
console.log('\n結局（依玩家類型）：');
for (const [profile, endings] of Object.entries(summary.endings)) {
  const total = Object.values(endings).reduce((sum, count) => sum + count, 0);
  console.log(`  ${profile}（${total} 次）：${Object.entries(endings).map(([endingId, count]) => `${endingId} ${count}`).join('、')}`);
}
if (summary.noEnding) console.log(`  ⚠️ 要求達成結局的玩家類型中，有 ${summary.noEnding} 次在 ${config.maxGameDays} 遊戲日內沒有達成結局`);
if (summary.unreachedEndingIds.length) console.log(`  ⚠️ 一次都沒有達成的結局：${summary.unreachedEndingIds.join('、')}（請確認資料或調整行為模型）`);
console.log(`  時間線結束（afterEnding: end）：${percent(summary.timelineEnded)}`);
console.log(`\n平均遊戲日數：${summary.avgDays.toFixed(1)}`);
console.log('各幕停留天數（平均／最長）：');
for (const [act, stats] of Object.entries(summary.actDays)) console.log(`  ${act}：${stats.avg.toFixed(1)}／${stats.max.toFixed(1)}`);
console.log(`\n卡死保底：觸發保底事件 ${percent(summary.runsWithStuckEvent)}，強制完成預設片段 ${percent(summary.runsWithForcedCompletion)}`);
if (summary.stuckGroups.length) {
  console.log(`主要卡死情況（被判定卡死時的狀態，共 ${summary.stuckGroups.length} 種，列出前 5 種）：`);
  for (const group of summary.stuckGroups.slice(0, 5)) console.log(`  ${group.count} 次（例：種子 ${group.exampleSeed}）：${group.signature}`);
}
console.log(`AI 上下文：最大 ${summary.maxContextChars} 字元，超出預算 ${summary.contextOverBudgetRuns} 次；事件紀錄最多 ${summary.maxFinalEvents} 件，編年史最多 ${summary.maxChronicleLines} 行`);
if (summary.stress) console.log(`壓力測試（灌入 ${config.stressEvents} 件事件）：保留 ${summary.stress.events} 件、編年史 ${summary.stress.chronicleLines} 行、上下文 ${summary.stress.contextChars} 字元${summary.stress.overBudget ? '（超出預算）' : ''}`);
console.log(`重要角色行動（規則後備）：${Object.entries(summary.agentActions).map(([action, entry]) => `${action} ${entry.total} 次（${percent(entry.runs)} 的模擬）`).join('、') || '無'}`);
console.log(`結局判定不可重現：${summary.irreproducibleEndings} 次；同一種子重跑一致：${summary.deterministic ? '是' : '否'}`);

if (summary.stallGroups.length) {
  console.log(`\n疑似漏報的卡死（同一幕超過各玩家類型的 stallDays 沒有進展，卡死偵測卻未判定）：${summary.stallGroups.reduce((sum, group) => sum + group.count, 0)} 次，${summary.stallGroups.length} 種情況`);
  for (const group of summary.stallGroups.slice(0, 10)) console.log(`  ${group.count} 次（${group.profile}，例：種子 ${group.exampleSeed}）：${group.signature}`);
} else console.log('\n疑似漏報的卡死：0');

if (summary.errors.length) {
  console.log(`\n錯誤 ${summary.errors.length} 件：`);
  for (const error of summary.errors.slice(0, 20)) console.log(`  種子 ${error.seed}：${error.message}`);
}

const failed = summary.errors.length > 0 || summary.irreproducibleEndings > 0 || summary.contextOverBudgetRuns > 0 || summary.stress?.overBudget || summary.noEnding > 0 || !summary.deterministic;
console.log(failed ? '\n模擬測試失敗。' : '\n模擬測試通過。');
process.exit(failed ? 1 : 0);
