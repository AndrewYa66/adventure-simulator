// 戰鬥回歸測試（O35-1，review 第 1 輪 S5）：多對多戰鬥核心規則，固定亂數、不呼叫 AI。
// 用法：npm run test:combat。涵蓋 O35-1 規格書驗收 4～14、26、27 與 D34 的敘事宣稱偵測。
// 測試中為製造情境會暫時修改記憶體中的資料（不寫回檔案），每段結束後還原。
import { runnerImport } from 'vite';

const { module: M } = await runnerImport('/scripts/combat-regression-entry.ts');
const { combat, combatState, random, data, init, world, options, claims, factions, gameChecks } = M;

let pass = 0, fail = 0;
function check(id, name, ok, detail = '') {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? '✅' : '❌'} [${id}] ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}
function seeded(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const constant = (v) => () => v;
const HIGH = 0.999; // d20 = 20
const LOW = 0; // d20 = 1

// 範例同伴（伊凡）；訊息比對用名字，換劇本資料時一起更新。
const IVAN = 'NPC-006';
const home = data.getWorldUnitById(IVAN).homeMapId;
const base = () => init.createInitialPlayer('測試員', data.scenario.defaultPlayer.classId, data.scenario.defaultPlayer.alignment, true);
const at = (p, mapId) => ({ ...p, currentMapId: mapId });
const withParty = (p, ids) => ({ ...p, party: ids });
const forest = () => withParty(at(base(), home), [IVAN]);
const startCombat = (p, unitId, opening = 'normal', group) => combat.buildCombatPlayer({ ...p, encounteredUnitId: unitId, encounterInfo: { startedAtMinutes: p.gameTimeMinutes, playerSpottedFirst: true } }, unitId, opening, group);
const inst = (p, id) => p.unitInstances[id];
const lines = (r) => r.text.split('\n');

// ---------------------------------------------------------------------------
// 驗收 4：行動順序
// ---------------------------------------------------------------------------
{
  random.setRandomSource(seeded(4));
  const p = startCombat(forest(), 'MON-004', 'normal', 3);
  const c = p.combat;
  const spd = (key) => combatState.getParticipantSpd(p, combatState.getParticipant(c, key));
  const sorted = c.turnOrder.every((key, i) => i === 0 || spd(c.turnOrder[i - 1]) >= spd(key));
  check(4, '依 SPD 由高到低', sorted, c.turnOrder.map((k) => `${k}:${spd(k)}`).join(' → '));
  // 同速：用世界修正把狼與伊凡的速度調成和玩家相同
  const pspd = spd('PLAYER-001');
  const tie = (unitId, s) => ({ id: `T-${unitId}`, scope: `unit:${unitId}`, stat: 'spd', op: 'add', value: pspd - s, sourceEventId: 'T' });
  const ivanSpd = data.getWorldUnitById(IVAN, p).stats.spd, wolfSpd = data.getWorldUnitById('MON-004', p).stats.spd;
  const tied = { ...p, world: { ...p.world, modifiers: [...p.world.modifiers, tie(IVAN, ivanSpd), tie('MON-004', wolfSpd)] } };
  const order = combatState.buildTurnOrder(tied, c.participants);
  check(4, '同速：玩家 → 同伴 → 敵人', order[0] === 'PLAYER-001' && order[1] === IVAN && order.slice(2).every((k) => k.startsWith('MON-004')), order.join(' → '));
  // 可重現：同一種子整場戰鬥兩次結果相同
  const runBattle = (seed) => {
    random.setRandomSource(seeded(seed));
    let s = startCombat(forest(), 'MON-004', 'normal', 3);
    const log = [];
    for (let i = 0; i < 200 && s.combat && !s.isDead; i += 1) {
      const r = combat.resolvePlayerCombatAction(s, { kind: 'attack' });
      if (!r) break;
      log.push(r.text);
      s = r.player;
    }
    return { log: log.join('\n'), hp: s.hp, ivan: inst(s, IVAN).currentHp };
  };
  const a = runBattle(42), b = runBattle(42), d = runBattle(43);
  check(4, '固定亂數下整場戰鬥可重現', a.log === b.log && a.hp === b.hp && a.log !== d.log, `長度 ${a.log.length}`);
}

// ---------------------------------------------------------------------------
// 驗收 5：自動結算到玩家回合、每個行動者一行、玩家昏迷自動跳過
// ---------------------------------------------------------------------------
{
  random.setRandomSource(seeded(5));
  const p = startCombat(forest(), 'MON-004', 'normal', 3);
  const r = combat.resolvePlayerCombatAction(p, { kind: 'attack' });
  const actorLines = lines(r).filter((l) => /^(⚔️|🛡️|👹|✨|💫)/.test(l));
  const endsOnPlayer = !r.player.combat || combat.isPlayerTurn(r.player);
  check(5, '一次行動後結算到玩家回合', endsOnPlayer, `turnIndex=${r.player.combat?.turnIndex}`);
  const playerChecks = r.checks.filter((c) => !c.detail), detailChecks = r.checks.filter((c) => c.detail);
  check('P2', '同伴與敵人的檢定標為戰鬥明細、玩家自己的攻擊檢定照常顯示', playerChecks.every((c) => c.label === '玩家攻擊檢定') && playerChecks.length === 1 &&
    detailChecks.length > 0 && detailChecks.every((c) => c.label !== '玩家攻擊檢定'), r.checks.map((c) => `${c.label}${c.detail ? '（明細）' : ''}`).join('、'));
  check(5, '系統訊息每個行動者一行', actorLines.length >= 1 && actorLines.every((l) => !l.includes('\n')), `\n${r.text}`);
  // 玩家昏迷 2 回合：skip 一次後，下一輪自動跳過，最後停在玩家回合且已清醒
  random.setRandomSource(constant(HIGH));
  let q = startCombat(forest(), 'MON-002', 'normal', 1);
  q = combat.resolvePlayerCombatAction(q, { kind: 'attack' }).player; // 先到玩家回合
  q = combat.applyStatus(q, 'PLAYER-001', { id: 'unconscious', remainingTurns: 2 });
  const blocked = combat.getCombatActionBlock(q, { kind: 'attack' });
  const s = combat.resolvePlayerCombatAction(q, { kind: 'skip' });
  const skippedAuto = s.text.split('你仍昏迷').length - 1;
  check(5, '玩家昏迷時攻擊被擋下、自動跳過回合', !!blocked && skippedAuto === 2 && combat.isPlayerTurn(s.player) && !s.player.statusEffects.some((e) => e.id === 'unconscious'), `blocked=${blocked} skips=${skippedAuto}\n${s.text}`);
}

// ---------------------------------------------------------------------------
// 驗收 6：同伴規則行為
// ---------------------------------------------------------------------------
{
  const hunter = data.getCharacterClassById('hunter');
  const savedUnlocks = hunter.skillUnlocks;
  hunter.skillUnlocks = [{ level: 1, skillId: 'SKL-002' }];
  const ivanMaxMp = data.getWorldUnitById(IVAN).stats.mp;
  random.setRandomSource(constant(HIGH));
  let p = startCombat(forest(), 'MON-002', 'normal', 1);
  p = { ...p, combat: { ...p.combat, participants: p.combat.participants.map((x) => x.side === 'enemy' ? { ...x, currentHp: 999 } : x) } };
  const caps = data.getPlayerResourceCaps(p);
  const low = { ...p, hp: Math.floor(caps.maxHp * 0.3) };
  const r = combat.resolvePlayerCombatAction(low, { kind: 'attack' });
  check(6, `HP 低於 40% 且有治療技能與 MP 時治療最低者（伊凡 MP 上限 ${ivanMaxMp}）`, ivanMaxMp >= 5 ? /✨ 伊凡對你施放急救術/.test(r.text) : true, ivanMaxMp >= 5 ? r.text : '伊凡 MP 上限不足 5，以下改測 MP 0 分支');
  // 伊凡自己最低
  const ivanLow = { ...p, unitInstances: { ...p.unitInstances, [IVAN]: { ...inst(p, IVAN), currentHp: 1, currentMp: ivanMaxMp } } };
  const r2 = combat.resolvePlayerCombatAction(ivanLow, { kind: 'attack' });
  check(6, '同伴自己最低時治療自己', ivanMaxMp < 5 || /✨ 伊凡對自己施放急救術/.test(r2.text), r2.text.split('\n').find((l) => l.includes('伊凡')));
  // MP 0：改攻擊
  const noMp = { ...low, unitInstances: { ...low.unitInstances, [IVAN]: { ...inst(low, IVAN), currentMp: 0 } } };
  const r3 = combat.resolvePlayerCombatAction(noMp, { kind: 'attack' });
  check(6, 'MP 不足時改攻擊', /🛡️ 伊凡攻擊/.test(r3.text) && !/伊凡.*施放/.test(r3.text));
  hunter.skillUnlocks = savedUnlocks;
  // 鎖定目標 / 目標倒下改打 HP 最低者
  random.setRandomSource(constant(0.5));
  let w = startCombat(forest(), 'MON-004', 'normal', 3);
  w = { ...w, combat: { ...w.combat, targetKey: 'MON-004#3', participants: w.combat.participants.map((x) => x.side === 'enemy' ? { ...x, currentHp: 500 } : x) } };
  const r4 = combat.resolvePlayerCombatAction(w, { kind: 'attack' });
  const ivanLine = lines(r4).find((l) => l.startsWith('🛡️ 伊凡'));
  check(6, '健康時攻擊玩家鎖定目標', !!ivanLine && ivanLine.includes('灰林狼 3'), ivanLine);
  // 鎖定的已倒下（#1 0 HP），#2 100、#3 7 → 伊凡打 #3；玩家打第一個站著的 #2
  let v = startCombat(forest(), 'MON-004', 'normal', 3);
  v = { ...v, combat: { ...v.combat, targetKey: 'MON-004#1', participants: v.combat.participants.map((x) => x.key === 'MON-004#1' ? { ...x, currentHp: 0 } : x.key === 'MON-004#2' ? { ...x, currentHp: 100 } : x.key === 'MON-004#3' ? { ...x, currentHp: 70 } : x) } };
  // 讓玩家行動時鎖定已倒下：companionAct 的 fallback 用 HP 最低
  const lowestTest = { ...v, combat: combatState.setEnemyHp(v.combat, 'MON-004#2', 100) };
  const r5 = combat.resolvePlayerCombatAction(lowestTest, { kind: 'attack' });
  const ivan5 = lines(r5).find((l) => l.startsWith('🛡️ 伊凡'));
  // 玩家攻擊後會自動改鎖定（#2），所以只在鎖定仍指向倒下者時才會 fallback；這裡檢查伊凡打的是站著的敵人
  check(6, '鎖定目標倒下時同伴改打站著的敵人', !!ivan5 && !ivan5.includes('灰林狼 1'), `${ivan5} / target=${r5.player.combat?.targetKey}`);
}

// ---------------------------------------------------------------------------
// 驗收 7：仇恨權重
// ---------------------------------------------------------------------------
{
  random.setRandomSource(seeded(7));
  const p = startCombat(forest(), 'MON-004', 'normal', 2);
  let player = 0; const N = 30000;
  for (let i = 0; i < N; i += 1) if (combat.pickEnemyTarget(p) === 'PLAYER-001') player += 1;
  const ratio = player / N;
  check(7, '玩家被選中比例約 2/3', Math.abs(ratio - 2 / 3) < 0.015, ratio.toFixed(4));
  const taunt = combat.applyStatus(p, IVAN, { id: 'taunt', remainingTurns: 2 });
  let onlyIvan = true; for (let i = 0; i < 2000; i += 1) if (combat.pickEnemyTarget(taunt) !== IVAN) onlyIvan = false;
  check(7, '嘲諷期間只打施放者', onlyIvan);
  const downed = { ...p, unitInstances: { ...p.unitInstances, [IVAN]: { ...inst(p, IVAN), currentHp: 0, downed: true } } };
  let neverIvan = true; for (let i = 0; i < 2000; i += 1) if (combat.pickEnemyTarget(downed) === IVAN) neverIvan = false;
  check(7, '倒地者不會被選中', neverIvan);
  const downedTaunt = combat.applyStatus(downed, IVAN, { id: 'taunt', remainingTurns: 2 });
  check(7, '倒地的嘲諷者不吸引攻擊', combat.pickEnemyTarget(downedTaunt) === 'PLAYER-001');
}

// ---------------------------------------------------------------------------
// 驗收 8：同伴倒地與起身、玩家死亡
// ---------------------------------------------------------------------------
{
  random.setRandomSource(constant(HIGH));
  let p = startCombat(forest(), 'MON-004', 'normal', 1);
  p = combat.resolvePlayerCombatAction(p, { kind: 'skip' })?.player ?? p;
  p = { ...p, statusEffects: [], combat: combatState.setEnemyHp(p.combat, 'MON-004#1', 1), unitInstances: { ...p.unitInstances, [IVAN]: { ...inst(p, IVAN), currentHp: 0, downed: true } } };
  const win = combat.resolvePlayerCombatAction(p, { kind: 'attack' });
  const iv = inst(win.player, IVAN);
  const endHp = Math.max(1, Math.floor(data.getWorldUnitById(IVAN, p).stats.hp * data.partyRules.battleEndReviveRatio));
  check(8, `勝利後倒地同伴以最大 HP 25%（${endHp}）起身`, win.victory && iv.currentHp === endHp && !iv.downed && !win.player.combat && win.text.includes(`以 ${endHp} HP 起身`), win.text.split('\n').at(-1));
  const fleeState = { ...p, combat: combatState.setEnemyHp(p.combat, 'MON-004#1', 99) };
  const fled = combat.resolvePlayerCombatAction(fleeState, { kind: 'flee' });
  const iv2 = inst(fled.player, IVAN);
  check(8, '逃跑成功後倒地同伴以最大 HP 25% 起身', !fled.player.combat && iv2.currentHp === endHp && !iv2.downed, lines(fled).at(-1));
  random.setRandomSource(constant(LOW));
  const dying = { ...fleeState, hp: 1 };
  const died = combat.resolvePlayerCombatAction(dying, { kind: 'attack' });
  check(8, '玩家 HP 歸零照舊死亡', died.player.isDead && !died.player.combat && died.deathHints?.['PLAYER-001']?.cause === 'combat', lines(died).slice(-2).join(' / '));
  check(8, '倒地同伴不是死亡', !world.isUnitAlive(p, IVAN) === false);
}

// ---------------------------------------------------------------------------
// 驗收 9：全隊逃跑
// ---------------------------------------------------------------------------
{
  random.setRandomSource(constant(LOW));
  let p = startCombat(forest(), 'MON-001', 'normal', 2);
  p = { ...p, combat: { ...p.combat, turnIndex: p.combat.turnOrder.indexOf('PLAYER-001') }, hp: 999 };
  const fastest = Math.max(...combatState.getStandingEnemies(p.combat).map((e) => data.getWorldUnitById(e.unitId, p).stats.spd));
  const r = combat.resolvePlayerCombatAction(p, { kind: 'flee' });
  const fleeCheck = r.checks.find((c) => c.label === '逃跑檢定');
  check(9, 'DC＝10＋敵方最高 SPD÷2', fleeCheck?.dc === 10 + Math.floor(fastest / 2), `dc=${fleeCheck?.dc} spd=${fastest}`);
  check(9, '逃跑失敗時敵人照常行動', !!r.player.combat && /👹/.test(r.text), r.text.split('\n').slice(0, 3).join(' / '));
  // 只算站著的敵人
  const oneDown = { ...p, combat: combatState.setEnemyHp(p.combat, 'MON-001#1', 0) };
  const r2 = combat.resolvePlayerCombatAction(oneDown, { kind: 'flee' });
  check(9, '倒下的敵人不擋路（說明用站著的）', !/斥候 1擋住/.test(r2.text));
}

// ---------------------------------------------------------------------------
// 驗收 10：兩隻同種敵人分別結算
// ---------------------------------------------------------------------------
{
  random.setRandomSource(constant(HIGH));
  let p = startCombat(forest(), 'MON-004', 'normal', 2);
  const exp0 = p.exp, ivanExp0 = inst(p, IVAN).exp, count0 = p.defeatedUnits['MON-004'] ?? 0;
  const keys = combatState.getEnemyParticipants(p.combat).map((e) => e.key);
  check(10, '成群敵人各有編號', keys.length === 2 && keys[0] !== keys[1] && combatState.getEnemyParticipants(p.combat).every((e) => /灰林狼 [12]/.test(e.label)), keys.join(','));
  p = { ...p, combat: combatState.setEnemyHp(combatState.setEnemyHp(p.combat, keys[0], 1), keys[1], 500) };
  p = { ...p, combat: { ...p.combat, turnIndex: p.combat.turnOrder.indexOf('PLAYER-001'), targetKey: keys[0] } };
  const r1 = combat.resolvePlayerCombatAction(p, { kind: 'attack' });
  const e1 = combatState.getParticipant(r1.player.combat, keys[0]), e2 = combatState.getParticipant(r1.player.combat, keys[1]);
  check(10, '分別受傷、一隻倒下時戰鬥未結束', !!r1.player.combat && e1.currentHp === 0 && e2.currentHp > 0 && e2.currentHp < 500, `#1=${e1.currentHp} #2=${e2.currentHp}`);
  const expGain = data.getWorldUnitById('MON-004', p).expReward;
  check(10, '第一隻倒下即給一次經驗與擊倒數', r1.player.exp - exp0 === expGain || r1.player.level > p.level, `exp ${exp0}→${r1.player.exp}（${expGain}）`);
  let q = { ...r1.player, combat: combatState.setEnemyHp(r1.player.combat, keys[1], 1) };
  q = { ...q, combat: { ...q.combat, turnIndex: q.combat.turnOrder.indexOf('PLAYER-001') } };
  const r2 = combat.resolvePlayerCombatAction(q, { kind: 'attack' });
  check(10, '全部倒下才勝利', r2.victory === true && !r2.player.combat);
  check(10, '擊倒數各算一次', (r2.player.defeatedUnits['MON-004'] ?? 0) - count0 === 2, `${count0}→${r2.player.defeatedUnits['MON-004']}`);
  const ivanExp = inst(r2.player, IVAN).exp - ivanExp0;
  check(10, '同伴各拿完整經驗', ivanExp === expGain * 2, `伊凡 +${ivanExp}、每隻 ${expGain}`);
  check(10, '每隻各自結算掉落（訊息兩行倒下）', [r1.text, r2.text].join('\n').split('倒下了！').length - 1 === 2);
}

// ---------------------------------------------------------------------------
// 驗收 11：任務只結算吻合目標
// ---------------------------------------------------------------------------
{
  random.setRandomSource(constant(HIGH));
  const q1 = data.getQuestById('QST-001'), q2 = data.getQuestById('QST-002');
  const map2 = data.getMapById('MAP-002'), map3 = data.getMapById('MAP-003');
  const saved = { q1: q1.mapId, q2: q2.mapId, m2: [...map2.unitsPresent], m3: [...map3.unitsPresent] };
  // 讓委託人在場（暫時修改資料），才能在擊倒當下交付
  q1.mapId = 'MAP-002'; q2.mapId = 'MAP-003';
  map2.unitsPresent.push('NPC-001'); map3.unitsPresent.push('NPC-001');
  const giveQuests = (p, progress) => ({
    ...p,
    activeQuests: [
      { questId: 'QST-001', status: 'in_progress', acceptedAtMinutes: 0, progress: { defeatedUnits: { 'MON-001': progress } } },
      { questId: 'QST-002', status: 'in_progress', acceptedAtMinutes: 0, progress: { defeatedUnits: {} } }
    ],
    inventory: [...p.inventory, { itemId: 'ITEM-002', quantity: 1 }, { itemId: 'ITEM-004', quantity: 1 }]
  });
  const killOne = (p, unitId) => {
    let s = startCombat(p, unitId, 'normal', 1);
    const key = combatState.getEnemyParticipants(s.combat)[0].key;
    s = { ...s, combat: { ...combatState.setEnemyHp(s.combat, key, 1), turnIndex: s.combat.turnOrder.indexOf('PLAYER-001') } };
    return combat.resolvePlayerCombatAction(s, { kind: 'attack' });
  };
  const status = (s, id) => s.activeQuests.find((q) => q.questId === id)?.status;
  // 族群委託：已擊倒 2 隻斥候，再擊倒 1 隻 → QST-001 完成，QST-002 不動
  const a = killOne(giveQuests(at(base(), 'MAP-002'), 2), 'MON-001');
  check(11, '討伐族群的委託可完成', status(a.player, 'QST-001') === 'completed' && status(a.player, 'QST-002') === 'in_progress', a.text.split('\n').find((l) => l.includes('任務')));
  // 族群委託條件已滿足，擊倒無關的狼 → 不交付
  const b = killOne(giveQuests(at(base(), 'MAP-002'), 3), 'MON-004');
  check(11, '擊倒無關單位不交付其他任務', status(b.player, 'QST-001') === 'in_progress');
  // 唯一個體委託：擊倒酋長 → QST-002 完成；QST-001（已滿足）不被順便交付
  const c = killOne(giveQuests(at(base(), 'MAP-003'), 3), 'MON-003');
  check(11, '討伐唯一個體的委託可完成、不順便交付他案', status(c.player, 'QST-002') === 'completed' && status(c.player, 'QST-001') === 'in_progress', `${status(c.player, 'QST-001')}/${status(c.player, 'QST-002')}`);
  // 任務給予者在場被擊倒 → 不交付
  const villageGiver = giveQuests(base(), 3);
  q1.mapId = 'MAP-001';
  const d = killOne({ ...villageGiver, unitDispositionOverrides: { ...villageGiver.unitDispositionOverrides, 'NPC-001': 'hostile' } }, 'NPC-001');
  check(11, '任務給予者在場被擊倒不交付任務', status(d.player, 'QST-001') === 'in_progress' && status(d.player, 'QST-002') === 'in_progress', `${status(d.player, 'QST-001')}/${status(d.player, 'QST-002')}`);
  q1.mapId = saved.q1; q2.mapId = saved.q2; map2.unitsPresent.splice(0, Infinity, ...saved.m2); map3.unitsPresent.splice(0, Infinity, ...saved.m3);
}

// ---------------------------------------------------------------------------
// 驗收 12：開場方式
// ---------------------------------------------------------------------------
{
  random.setRandomSource(constant(HIGH));
  const wolf = data.getWorldUnitById('MON-004');
  // 伏擊成功：固定 3 隻
  const savedGroup = wolf.source.groupSize;
  data.getUnitTemplateById('MON-004').groupSize = { min: 3, max: 3 };
  const p = { ...forest(), encounteredUnitId: 'MON-004', encounterInfo: { startedAtMinutes: 480, playerSpottedFirst: true } };
  const r = combat.resolveAmbush(p, data.getWorldUnitById('MON-004', p));
  const firstRound = r.text.split('第 2 回合')[0];
  check(12, '伏擊成功：第一輪只有我方行動', !/👹/.test(firstRound) && /先手一擊/.test(firstRound) && /🛡️ 伊凡/.test(firstRound), firstRound.replace(/\n/g, ' / '));
  const playerLine = firstRound.split('\n').find((l) => l.includes('先手一擊'));
  const dmg = Number(playerLine?.match(/造成 (\d+) 點/)?.[1]);
  // 1.5 倍：base = max(1, atk - def)
  const playerAtk = gameChecks.getPlayerStatBreakdown(p, 'atk').statValue;
  const expected = Math.max(1, Math.floor(Math.max(1, playerAtk - wolf.stats.def) * 1.5));
  check(12, '玩家必中 1.5 倍', dmg === expected && !r.checks.some((c) => c.label === '玩家攻擊檢定' && c.reason.includes('先手')), `dmg=${dmg} expected=${expected}`);
  // 伏擊檢定用敵方數值（同種個體相同）：DC = 10 + wis 修正
  const amb = r.checks.find((c) => c.label === '伏擊檢定');
  check(12, '成群對抗檢定以敵方數值計算 DC（單一 DC）', !!amb && r.checks.filter((c) => c.label === '伏擊檢定').length === 1, `dc=${amb?.dc}`);
  // 陷阱：注入 random 讓等待中出現敵人
  const trapP = { ...forest() };
  const tr = combat.resolveTrapWait(trapP, 60, constant(0));
  const trapLine = tr ? lines(tr).find((l) => l.includes('踩中陷阱')) : undefined;
  const trapTarget = trapLine?.match(/^(.+?)踩中陷阱/)?.[1];
  check(12, '陷阱成功：打在鎖定的那一隻，之後我方第一輪', !!trapLine && !/👹/.test(tr.text.split('第 2 回合')[0]), `${trapLine} target=${trapTarget}`);
  // 敵方偷襲：3 隻各攻擊一次，不觸發特殊能力
  random.setRandomSource(constant(LOW));
  const big = { ...forest(), hp: 999 };
  const amb2 = combat.startEnemyAmbush(big, data.getWorldUnitById('MON-004', big), '');
  const round0 = amb2.text.split('── 第 1 回合 ──')[0];
  const attacks = round0.split('\n').filter((l) => l.startsWith('👹'));
  check(12, '敵方偷襲：第 0 輪每個敵人各攻擊一次', attacks.length === 3 && attacks.every((l) => l.includes('偷襲')) && !/施放/.test(round0), attacks.join(' / '));
  data.getUnitTemplateById('MON-004').groupSize = savedGroup;
}

// ---------------------------------------------------------------------------
// 驗收 13：Lv.1 單人對 2 隻斥候偷襲，最大傷害不致死
// ---------------------------------------------------------------------------
{
  const scout = data.getUnitTemplateById('MON-001');
  const maxGroup = scout.groupSize.max;
  const report = [];
  let allOk = true;
  for (const cls of data.playerSelectableClasses()) {
    const p0 = at(init.createInitialPlayer('測試員', cls.id, '絕對中立', true), 'MAP-002');
    // 最壞情況：每次閃避都失敗（d20=1），選目標必定是玩家（單人）；第 0 輪 + 第 1 輪比玩家快的斥候
    random.setRandomSource(constant(LOW));
    const r = combat.startEnemyAmbush(p0, data.getWorldUnitById('MON-001', p0), '');
    const groupUsed = combatState.getEnemyParticipants(r.player.combat ?? { participants: [] }).length;
    const hp0 = p0.hp;
    const ok = !r.player.isDead;
    // 只算到玩家第一次能行動前（startEnemyAmbush 會結算到玩家回合）
    report.push(`${cls.id}: HP ${hp0}→${r.player.hp}（${groupUsed || '?'} 隻）`);
    if (!ok || groupUsed !== Math.min(maxGroup, groupUsed)) allOk = false;
  }
  // 固定亂數 0 讓 groupSize 擲出最小；改用 0.999 讓群數最大但閃避…分開：直接以 groupSize=max 建戰鬥
  const worst = [];
  for (const cls of data.playerSelectableClasses()) {
    const p0 = at(init.createInitialPlayer('測試員', cls.id, '絕對中立', true), 'MAP-002');
    random.setRandomSource(constant(LOW));
    let s = combat.buildCombatPlayer(p0, 'MON-001', 'enemy_ambush', maxGroup);
    const unit = data.getWorldUnitById('MON-001', s);
    const perHit = combat.getEnemyHitDamage(s, unit, 1);
    const playerSpd = M.combatState.getParticipantSpd(s, { unitId: 'PLAYER-001' });
    const fasterCount = unit.stats.spd > playerSpd ? maxGroup : 0;
    const hits = maxGroup + fasterCount;
    const total = perHit * hits;
    worst.push(`${cls.id}: HP ${p0.hp}、最大傷害 ${perHit}×${hits}=${total}`);
    if (total >= p0.hp) allOk = false;
  }
  check(13, `Lv.1 各職業被 ${maxGroup} 隻斥候偷襲（全被命中）不致死`, allOk, `\n  ${worst.join('\n  ')}\n  實跑：${report.join('；')}`);
}

// ---------------------------------------------------------------------------
// 驗收 14：極端情境不卡住
// ---------------------------------------------------------------------------
{
  const terminates = (state, action, label) => {
    const t0 = Date.now();
    const r = combat.resolvePlayerCombatAction(state, action);
    const ok = !!r && (!r.player.combat || combat.isPlayerTurn(r.player)) && Date.now() - t0 < 2000;
    return { ok, r, label };
  };
  random.setRandomSource(seeded(14));
  let p = startCombat(forest(), 'MON-004', 'normal', 3);
  // 全員昏迷（玩家、同伴、敵人）
  let all = combat.applyStatus(p, 'PLAYER-001', { id: 'unconscious', remainingTurns: 3 });
  all = combat.applyStatus(all, IVAN, { id: 'unconscious', remainingTurns: 3 });
  for (const e of combatState.getEnemyParticipants(all.combat)) all = combat.applyStatus(all, e.key, { id: 'unconscious', remainingTurns: 3 });
  const t1 = terminates(all, { kind: 'skip' }, '全員昏迷');
  check(14, '全員昏迷可回到玩家回合', t1.ok, t1.r?.text.split('\n').length + ' 行');
  // 同伴 MP 0
  const noMp = { ...p, unitInstances: { ...p.unitInstances, [IVAN]: { ...inst(p, IVAN), currentMp: 0 } } };
  check(14, '同伴 MP 0', terminates(noMp, { kind: 'attack' }).ok);
  // 只剩倒地同伴（玩家昏迷、同伴倒地）
  const onlyDowned = combat.applyStatus({ ...p, unitInstances: { ...p.unitInstances, [IVAN]: { ...inst(p, IVAN), currentHp: 0, downed: true } } }, 'PLAYER-001', { id: 'unconscious', remainingTurns: 5 });
  const t3 = terminates({ ...onlyDowned, hp: 9999 }, { kind: 'skip' });
  check(14, '玩家昏迷且同伴倒地', t3.ok);
  // 敵人全部閃避：我方攻擊永遠落空（d20=1），重複行動直到結束或 300 次
  random.setRandomSource(constant(LOW));
  let miss = { ...p, hp: 99999 };
  let rounds = 0, stuck = false;
  for (; rounds < 300 && miss.combat; rounds += 1) {
    const t = terminates(miss, { kind: 'attack' });
    if (!t.ok) { stuck = true; break; }
    miss = t.r.player;
  }
  check(14, '我方全落空 300 次仍每次回到玩家回合', !stuck, `rounds=${rounds} hp=${miss.hp}`);
  // 安全上限：全員昏迷 999 回合
  let forever = p;
  for (const key of p.combat.participants.map((x) => x.key)) forever = combat.applyStatus(forever, key, { id: 'unconscious', remainingTurns: 999 });
  const t5 = terminates(forever, { kind: 'skip' });
  check(14, '超長昏迷觸發安全上限後回到玩家回合', t5.ok && /自動結算達到上限/.test(t5.r.text));
}

// ---------------------------------------------------------------------------
// 驗收 27（review R2）：昏迷自動跳過的回合也推進時間
// ---------------------------------------------------------------------------
{
  random.setRandomSource(constant(HIGH));
  let q = startCombat(forest(), 'MON-002', 'normal', 1);
  q = { ...q, combat: { ...combatState.setEnemyHp(q.combat, 'MON-002#1', 999) } };
  q = combat.resolvePlayerCombatAction(q, { kind: 'attack' }).player; // 停在玩家回合
  const t0 = q.gameTimeMinutes;
  const round = data.scenario.rules?.actionDurations?.combatRound;
  q = combat.applyStatus(q, 'PLAYER-001', { id: 'unconscious', remainingTurns: 2 });
  const skipped = combat.resolvePlayerCombatAction(q, { kind: 'skip' });
  const attacked = combat.resolvePlayerCombatAction(skipped.player, { kind: 'attack' });
  const perRound = (skipped.player.gameTimeMinutes - t0) / 2;
  check(27, '昏迷 2 回合（手動跳過＋自動跳過）後再攻擊，時間共增加 3 個戰鬥回合', perRound > 0 && attacked.player.gameTimeMinutes - t0 === perRound * 3,
    `每回合 ${perRound} 分鐘（資料 ${round}）、共 ${attacked.player.gameTimeMinutes - t0}`);
}

// ---------------------------------------------------------------------------
// 驗收 26（D9、D35）：一般治療不能救起倒地者、復甦藥
// ---------------------------------------------------------------------------
{
  const REVIVE = data.itemsDatabase.find((item) => item.effect.revive)?.id;
  const POTION = data.itemsDatabase.find((item) => item.type === 'consumable' && (item.effect.hpRestore ?? 0) > 0)?.id;
  const HEAL = data.getUnlockedSkills(data.scenario.defaultPlayer.classId, 1).find((skill) => skill.effect.kind === 'healing');
  check(26, '範例資料有復甦藥、在村裡商店販售且經營者有庫存', !!REVIVE && data.shopsDatabase.some((shop) => shop.items.some((entry) => entry.itemId === REVIVE) &&
    (data.getUnitTemplateById(shop.ownerUnitId)?.startingInventory ?? []).some((entry) => entry.itemId === REVIVE) && data.getMapById(data.getWorldUnitById(shop.ownerUnitId).homeMapId)?.isSafeZone));
  random.setRandomSource(constant(HIGH));
  let p = startCombat(forest(), 'MON-002', 'normal', 1);
  p = combat.resolvePlayerCombatAction({ ...p, combat: combatState.setEnemyHp(p.combat, 'MON-002#1', 999) }, { kind: 'attack' }).player;
  p = { ...p, inventory: [...p.inventory, { itemId: REVIVE, quantity: 2 }], unitInstances: { ...p.unitInstances, [IVAN]: { ...inst(p, IVAN), currentHp: 0, downed: true } } };
  const item = (id) => data.getItemById(id);
  check(26, '一般藥水不能對倒地者使用', !!combat.getCombatActionBlock(p, { kind: 'item', item: item(POTION), targetKey: IVAN }));
  check(26, '一般治療技能不能對倒地者使用', !!combat.getCombatActionBlock(p, { kind: 'heal', skill: HEAL, targetKey: IVAN }));
  check(26, '復甦藥不能對站著的人使用', !!combat.getCombatActionBlock(p, { kind: 'item', item: item(REVIVE), targetKey: 'PLAYER-001' }));
  const ids = options.buildSystemOptions(p).groups.flatMap((group) => group.options.map((option) => option.id));
  check(26, '選項列：一般治療與藥水不列倒地者、復甦藥只列倒地者', !ids.some((id) => id.endsWith(`:${IVAN}`) && !id.includes(REVIVE)) && ids.includes(`combat:item:${REVIVE}:${IVAN}`) && !ids.includes(`combat:item:${REVIVE}:PLAYER-001`), ids.join(','));
  const maxHp = data.getWorldUnitById(IVAN, p).stats.hp;
  const r = combat.resolvePlayerCombatAction(p, { kind: 'item', item: item(REVIVE), targetKey: IVAN });
  const iv = inst(r.player, IVAN);
  const left = r.player.inventory.find((entry) => entry.itemId === REVIVE)?.quantity;
  check(26, '復甦藥救起後以最大 HP 25% 起身、消耗一瓶', iv.downed !== true && iv.currentHp === Math.max(1, Math.floor(maxHp * data.partyRules.reviveRatio)) && left === 1, `HP ${iv.currentHp}/${maxHp}、剩 ${left}`);
  check(26, '救起後在之後輪到時才行動（同一次結算中有伊凡行動行）', /🛡️ 伊凡|✨ 伊凡/.test(r.text.split('起身')[1] ?? ''), r.text);
  // 同伴的規則治療不選倒地者
  const hunter = data.getCharacterClassById(data.getWorldUnitById(IVAN).classId);
  const savedUnlocks = hunter.skillUnlocks;
  hunter.skillUnlocks = [{ level: 1, skillId: HEAL.id }];
  const ally = data.unitsDatabase.find((unit) => unit.id !== IVAN && !unit.requiresEncounter && unit.homeMapId !== home && unit.companion === undefined);
  const savedCompanion = ally.companion;
  ally.companion = { recruitable: true };
  let two = startCombat(withParty(at(base(), home), [IVAN, ally.id]), 'MON-002', 'normal', 1);
  two = { ...two, combat: combatState.setEnemyHp(two.combat, 'MON-002#1', 999), unitInstances: { ...two.unitInstances, [ally.id]: { ...inst(two, ally.id), currentHp: 0, downed: true } } };
  const healTurn = combat.resolvePlayerCombatAction(two, { kind: 'attack' });
  check(26, '同伴的規則治療不選倒地者', !new RegExp(`伊凡對${data.getWorldUnitById(ally.id).name}施放`).test(healTurn.text) && inst(healTurn.player, ally.id).downed === true, healTurn.text);
  hunter.skillUnlocks = savedUnlocks;
  ally.companion = savedCompanion;
}

// ---------------------------------------------------------------------------
// review S1：玩家戰死時同伴不留在倒地狀態
// ---------------------------------------------------------------------------
{
  random.setRandomSource(constant(LOW));
  let p = startCombat(forest(), 'MON-004', 'normal', 1);
  p = { ...p, hp: 1, unitInstances: { ...p.unitInstances, [IVAN]: { ...inst(p, IVAN), currentHp: 0, downed: true } } };
  p = { ...p, combat: { ...p.combat, turnIndex: p.combat.turnOrder.indexOf('PLAYER-001') } };
  const r = combat.resolvePlayerCombatAction(p, { kind: 'attack' });
  check('S1', '玩家戰死後同伴起身、沒有戰鬥狀態', r.player.isDead && !r.player.combat && inst(r.player, IVAN).downed === false && inst(r.player, IVAN).currentHp === Math.max(1, Math.floor(data.getWorldUnitById(IVAN, r.player).stats.hp * data.partyRules.battleEndReviveRatio)));
}

// ---------------------------------------------------------------------------
// review S2：地區勢力在場判定跟著同伴走
// ---------------------------------------------------------------------------
{
  const ivanFaction = data.getUnitFactionId(IVAN);
  const elsewhere = data.mapsDatabase.find((map) => map.id !== home && !map.unitsPresent.some((unitId) => data.getUnitFactionId(unitId) === ivanFaction));
  if (elsewhere) {
    const scope = { knownBy: 'region', mapId: elsewhere.id, witnessUnitIds: [] };
    const withIvan = factions.getAwareFactionIds(withParty(at(base(), elsewhere.id), [IVAN]), scope);
    const without = factions.getAwareFactionIds(at(base(), elsewhere.id), scope);
    check('S2', '同伴所屬勢力在玩家所在地算在場', withIvan.includes(ivanFaction) && !without.includes(ivanFaction));
  } else check('S2', '找不到沒有同伴勢力成員的地區，略過', true);
}

// ---------------------------------------------------------------------------
// review S4、S6：技能檢查、道具對象顯示
// ---------------------------------------------------------------------------
{
  random.setRandomSource(constant(HIGH));
  let p = startCombat(forest(), 'MON-002', 'normal', 1);
  p = combat.resolvePlayerCombatAction({ ...p, combat: combatState.setEnemyHp(p.combat, 'MON-002#1', 999) }, { kind: 'attack' }).player;
  const damageSkill = data.skillsDatabase.find((skill) => skill.effect.kind === 'damage_multiplier');
  const healSkill = data.skillsDatabase.find((skill) => skill.effect.kind === 'healing');
  const unlockedDamage = data.getUnlockedSkills(p.classId, p.level).some((skill) => skill.id === damageSkill.id);
  check('S4', '未習得的技能被擋下', unlockedDamage || /尚未習得/.test(combat.getCombatActionBlock({ ...p, mp: 999 }, { kind: 'attack', skill: damageSkill }) ?? ''));
  check('S4', '治療技能不能當攻擊、攻擊技能不能當治療', !!combat.getCombatActionBlock({ ...p, mp: 999 }, { kind: 'attack', skill: healSkill }) &&
    !!combat.getCombatActionBlock({ ...p, mp: 999, level: 10 }, { kind: 'heal', skill: damageSkill, targetKey: 'PLAYER-001' }));
  const mpPotion = data.itemsDatabase.find((item) => item.type === 'consumable' && (item.effect.mpRestore ?? 0) > 0 && !item.effect.hpRestore);
  const out = { ...forest(), inventory: [{ itemId: mpPotion.id, quantity: 1 }], unitInstances: { ...forest().unitInstances, [IVAN]: { ...inst(forest(), IVAN), currentMp: 0 } } };
  const label = options.buildSystemOptions(out).groups.flatMap((group) => group.options).find((option) => option.id === `item:${mpPotion.id}:${IVAN}`)?.label ?? '';
  check('S6', '只恢復 MP 的道具，對象顯示 MP', /MP 0\//.test(label) && !/HP/.test(label), label);
}

// ---------------------------------------------------------------------------
// D34：打字離隊意圖與敘事宣稱偵測
// ---------------------------------------------------------------------------
{
  const p = withParty(at(base(), home), [IVAN]);
  const name = data.getWorldUnitById(IVAN).name;
  const other = data.getWorldUnitsAtMap(data.scenario.start.mapId).find((unit) => !unit.requiresEncounter);
  const village = withParty(at(base(), data.scenario.start.mapId), [IVAN]);
  for (const text of [`${name}，你先回去吧`, `${name}，你走吧，接下來我想一個人走`, `${name}，別跟了`]) {
    check('D34', `離隊意圖：「${text}」`, claims.findDismissIntent(p, text).some((member) => member.unitId === IVAN));
  }
  for (const text of [`${name}，你覺得接下來該去哪？`, `${name}，你回去過村子嗎？`, '你先回去吧']) {
    check('D34', `不是離隊意圖：「${text}」`, claims.findDismissIntent(p, text).length === 0);
  }
  check('D34', '送 AI 的提醒註明仍在隊伍中', /仍在隊伍中/.test(claims.describeDismissIntentForAI([{ name }])));
  const leave = claims.findCompanionClaims(village, `${name}微微一愣，點了點頭。說完，他轉身朝村落的巡守哨所走去，留下你一人站在村口。`);
  check('D34', '敘事宣稱同伴離去（代名詞）→ 補說明', leave.some((text) => text.includes('仍在隊伍中')), leave.join(''));
  const stay = claims.findCompanionClaims(village, `${name}搖了搖頭，沒有轉身離去，只是說：「我先回去了也沒用。」`);
  check('D34', '否定句與引號內的話不算宣稱', stay.length === 0, stay.join(''));
  const join = claims.findCompanionClaims(village, `${other.name}點點頭，答應與你同行。`);
  check('D34', '敘事宣稱他人入隊 → 補說明', join.some((text) => text.includes(`${other.name}沒有加入隊伍`)), join.join(''));
  const decline = claims.findCompanionClaims(village, `${other.name}婉拒與你同行，一旁的${name}默默點頭。`);
  check('D34', '婉拒同行、或句中提到隊伍同伴時不算入隊', decline.length === 0, decline.join(''));
  const act = claims.findCompanionClaims(p, `${name}拉開長弓，一箭射中了哥布林的肩膀。`);
  check('D34', '戰鬥外宣稱同伴出手 → 補說明', act.some((text) => text.includes('沒有出手')), act.join(''));
  const potionName = data.itemsDatabase.find((item) => item.type === 'consumable').name;
  const give = claims.findCompanionClaims(village, `${name}從腰間取出一瓶${potionName}遞給你。`);
  check('D34', '宣稱同伴給具體道具 → 補說明', give.some((text) => text.includes('沒有給你任何東西')), give.join(''));
  const gold = claims.findCompanionClaims(village, `${name}掏出幾枚金幣塞給你。`);
  check('S7', '宣稱同伴給金幣 → 補說明', gold.some((text) => text.includes('沒有給你任何東西')), gold.join(''));
  for (const text of [`${name}給了你一個眼神，示意你小心。`, `${name}遞給你一個安心的笑容。`]) {
    const look = claims.findCompanionClaims(village, text);
    check('S7', `沒有具體道具不算給東西：「${text}」`, look.length === 0, look.join(''));
  }
  for (const text of [`${name}，你不要先回去`, `${name}，你不用離隊`, `${name}，別一個人走`]) {
    check('S8', `含否定字不算離隊意圖：「${text}」`, claims.findDismissIntent(p, text).length === 0);
  }
  check('S8', '否定字是離隊字詞的一部分時仍算（「別跟了」）', claims.findDismissIntent(p, `${name}，別跟了`).length === 1);
  // 試玩 P1 與 Andrew 試玩回報：用否定寫的離去、已在隊伍中卻拒絕同行或要留守
  check('P1', '試玩那句是離隊意圖（遊戲據此不當成移動）', claims.findDismissIntent(p, `${name}，你先回去吧，接下來我想一個人走`).length === 1);
  const stayed = claims.findCompanionClaims(village, `林地獵人${name}雖然留在原地或因任務未了而搖了搖頭，沒有隨你一同折返，但他看著你離去的背影。`);
  check('P1', '「留在原地、沒有隨你一同折返」→ 補說明', stayed.some((text) => text.includes('仍在隊伍中')), stayed.join(''));
  const followed = claims.findCompanionClaims(village, `${name}沒有留在原地，緊跟在你的身旁。`);
  check('P1', '「沒有留在原地」不算離去', followed.length === 0, followed.join(''));
  const refused = claims.findCompanionClaims(village, `${name}搖了搖頭，拒絕與你同行，說他得守在古道入口。`);
  check('P1', '已在隊伍中卻拒絕同行、要留守 → 補「已在你的隊伍中」', refused.some((text) => text.includes(`${name}已在你的隊伍中`)), refused.join(''));
  const accepted = claims.findCompanionClaims(village, `${name}並沒有拒絕，只是點點頭：「我早就跟著你了。」`);
  check('P1', '沒有拒絕、或引號內說已同行 → 不補', accepted.length === 0, accepted.join(''));
  const chat = claims.findCompanionClaims(village, `一旁的${name}抱著長弓，低聲補充：「我在古道邊緣見過牠們的腳印。」`);
  check('D34', '正常的同伴插話不補說明', chat.length === 0, chat.join(''));
}

random.setRandomSource(undefined);
console.log(`\n合計：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
