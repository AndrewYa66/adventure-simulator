// 建置前驗證靜態遊戲資料（種族/職階組合、等級基準、單位參照、劇本設定）；有錯誤即以非零結束碼中止。
import { runnerImport } from 'vite';

const { module } = await runnerImport('/src/data/staticData.ts');
const issues = module.validateGameData();

if (issues.length) {
  console.error(`資料驗證失敗（${issues.length} 項）：`);
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exit(1);
}
console.log('資料驗證通過。');
