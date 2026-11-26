// 戰鬥回歸測試的 re-export 入口（scripts/combat-regression.mjs 使用）：讓腳本共用同一份模組實例（固定亂數、暫時修改的資料）。
export * as combat from '../src/utils/combatResolution';
export * as combatState from '../src/utils/combatState';
export * as random from '../src/utils/random';
export * as data from '../src/data/staticData';
export * as init from '../src/utils/playerInit';
export * as world from '../src/utils/worldEvents';
export * as options from '../src/utils/systemOptions';
export * as claims from '../src/utils/partyClaims';
export * as factions from '../src/utils/factions';
export * as gameChecks from '../src/utils/gameChecks';
