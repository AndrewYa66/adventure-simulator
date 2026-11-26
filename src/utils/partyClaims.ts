import type { PlayerState } from '../types/game';
import { getWorldUnitById, getWorldUnitsAtMap, partyRules } from '../data/staticData';

/**
 * 同伴敘事與狀態不符的輕量處理（O35-1 D34）：不改 AI 回應格式、不增加 AI 呼叫。
 * - 玩家打字對隊伍同伴表達離隊意圖 → 選項列冒出「請 X 離隊」（按下才離隊），並提醒 AI 同伴仍在隊伍中。
 * - 敘事宣稱同伴離去、他人入隊、同伴出手（戰鬥外）、同伴給東西 → 敘事後補一行說明。
 * 字詞在 party_rules.json 的 narrativeChecks（正規表示式來源字串，可調）。
 */

const compile = (patterns: string[]) => patterns.map((pattern) => new RegExp(pattern));
const checks = {
  dismissIntent: compile(partyRules.narrativeChecks.dismissIntent),
  leave: compile(partyRules.narrativeChecks.leave),
  join: compile(partyRules.narrativeChecks.join),
  act: compile(partyRules.narrativeChecks.act),
  give: compile(partyRules.narrativeChecks.give)
};

/** 去掉引號內的對話：角色說的話不算敘事宣稱（同 O44 的抵達偵測）。 */
const stripQuotes = (text: string) => text.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/g, '');
const splitSentences = (text: string) => text.split(/[。！？!?\n]+/).map((sentence) => sentence.trim()).filter(Boolean);

/** 句子符合某類宣稱：去掉符合的字詞後仍有否定字詞（例如「沒有轉身離去」「婉拒同行」）就不算。 */
function claims(sentence: string, patterns: RegExp[]): boolean {
  const matched = patterns.filter((pattern) => pattern.test(sentence));
  if (!matched.length) return false;
  const rest = matched.reduce((text, pattern) => text.replace(new RegExp(pattern.source, 'g'), ''), sentence);
  return !partyRules.narrativeChecks.negations.some((word) => rest.includes(word));
}

const companionNames = (state: PlayerState) => state.party.flatMap((unitId) => {
  const unit = getWorldUnitById(unitId, state);
  return unit ? [{ unitId, name: unit.name }] : [];
});

/** 玩家文字中提到名字、且表達要對方離隊的隊伍同伴（D34-a）。 */
export function findDismissIntent(state: PlayerState, text: string): { unitId: string; name: string }[] {
  if (state.combat || !state.party.length) return [];
  if (!checks.dismissIntent.some((pattern) => pattern.test(text))) return [];
  return companionNames(state).filter((member) => text.includes(member.name));
}

/** 送給 AI 的提醒（附在玩家行動之後，不顯示給玩家）。 */
export const describeDismissIntentForAI = (members: { name: string }[]): string =>
  members.length ? `\n（系統說明：${members.map((member) => member.name).join('、')}此刻仍在隊伍中；離隊只能由玩家使用選項列決定，請只描寫對方的反應，不要寫成已經離開。）` : '';

/**
 * 敘事中與隊伍狀態不符的宣稱（D34-b）。state 為 AI 看到的狀態（本回合行動前）。
 * 離去：句中有同伴名字，或只有一位同伴、整段敘事提到他且句中用代名詞；「留你一人」這類說法有同伴就算。
 * 入隊：句中有在場、不在隊伍中的人物名字。出手（戰鬥外）、給東西：句中有同伴名字。
 */
export function findCompanionClaims(state: PlayerState, storyText: string): string[] {
  const narrative = stripQuotes(storyText);
  const sentences = splitSentences(narrative);
  const members = companionNames(state);
  const notices: string[] = [];
  const add = (text: string) => { if (!notices.includes(text)) notices.push(text); };

  for (const member of members) {
    const mentioned = narrative.includes(member.name);
    const soleCompanion = members.length === 1;
    const refersTo = (sentence: string) => sentence.includes(member.name) || (soleCompanion && mentioned && /[他她]|對方/.test(sentence));
    if (sentences.some((sentence) => claims(sentence, checks.leave) && (refersTo(sentence) || /你(獨自)?一人/.test(sentence)))) {
      add(`${member.name}仍在隊伍中，沒有離開；要讓對方離隊，請用選項列「人物」的「👋 請${member.name}離隊」。`);
    }
    if (!state.combat && sentences.some((sentence) => sentence.includes(member.name) && claims(sentence, checks.act))) {
      add(`${member.name}沒有出手；開戰由規則決定，請用選項列的伏擊或挑戰。`);
    }
    if (sentences.some((sentence) => sentence.includes(member.name) && claims(sentence, checks.give))) {
      add(`${member.name}沒有給你任何東西，物品沒有轉移。`);
    }
  }

  const others = getWorldUnitsAtMap(state.currentMapId, state).filter((unit) => !state.party.includes(unit.id));
  // 句中同時提到隊伍同伴時（例如「與你同行的某某」）不算他人入隊。
  const mentionsMember = (sentence: string) => members.some((member) => sentence.includes(member.name));
  for (const unit of others) {
    if (sentences.some((sentence) => sentence.includes(unit.name) && !mentionsMember(sentence) && claims(sentence, checks.join))) {
      add(`${unit.name}沒有加入隊伍；同伴只能在條件成立時從選項列「人物」邀請。`);
    }
  }
  return notices;
}
