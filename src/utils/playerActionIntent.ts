import { scenario } from '../data/staticData';

const CHINESE_DIGITS: Record<string, number> = {
  '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10
};

function parseAmount(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === '十') return 10;
  if (value.startsWith('十')) return 10 + (CHINESE_DIGITS[value[1]] ?? 0);
  if (value.endsWith('十')) return (CHINESE_DIGITS[value[0]] ?? 1) * 10;
  if (value.includes('十')) return (CHINESE_DIGITS[value[0]] ?? 1) * 10 + (CHINESE_DIGITS[value[2]] ?? 0);
  return CHINESE_DIGITS[value] ?? 0;
}

/** Resolve an unambiguous, numeric self-damage request without relying on model wording. */
export function parseExplicitSelfDamage(actionText: string): number | undefined {
  const amountPattern = '(\\d+|[一二兩三四五六七八九十]{1,3})';
  const patterns = [
    new RegExp(`對自己.{0,8}?${amountPattern}\\s*(?:點)?\\s*(?:傷害|生命|HP)`, 'u'),
    new RegExp(`自殘\\s*${amountPattern}\\s*(?:點)?\\s*(?:傷害|生命|HP)?`, 'u'),
    new RegExp(`(?:扣除|減少|損失)自己\\s*${amountPattern}\\s*(?:點)?\\s*(?:生命|HP)`, 'u'),
    new RegExp(`(?:傷害|攻擊|打|割|刺|戳)自己.{0,5}?${amountPattern}\\s*(?:點(?:傷害)?|傷害|生命|HP)`, 'u'),
    new RegExp(`自己.{0,5}?(?:受傷|流血|損血).{0,5}?${amountPattern}\\s*(?:點|HP|生命)`, 'u'),
    new RegExp(`(?:扣|減少|損失)(?:除)?\\s*(?:掉)?\\s*(?:自己|自身)?\\s*${amountPattern}\\s*(?:點|滴)(?:血|生命|HP)`, 'u'),
    new RegExp(`(?:我|角色)?(?:的)?(?:HP|血量|生命值)(?:下降|減少|扣除|損失|降低)\\s*${amountPattern}\\s*(?:點|滴)?`, 'u'),
    new RegExp(`(?:我|角色)(?:扣血|掉血|損失生命)\\s*${amountPattern}\\s*(?:點|滴)?`, 'u')
  ];
  for (const pattern of patterns) {
    const match = actionText.match(pattern);
    if (!match) continue;
    const amount = parseAmount(match[1]);
    if (Number.isSafeInteger(amount) && amount > 0 && amount <= 1000) return amount;
  }
  return undefined;
}

export function isSelfDamageIntent(actionText: string): boolean {
  return /(?:對自己|(?:傷害|攻擊|打|割傷|刺傷|劃傷|戳)自己|自殘|自傷|自己.{0,6}(?:造成傷害|受到傷害|受傷|流血|損血)|讓自己.{0,4}(?:受傷|流血|損血)|(?:我|角色).{0,6}(?:掉血|扣血|損血|HP下降|生命值下降)|(?:HP|血量|生命值).{0,5}(?:下降|減少|扣血|掉血)|(?:扣|減少|損失)(?:除)?\s*(?:掉)?\s*(?:自己|自身)?\s*\d+\s*(?:點|滴)(?:血|生命|HP))/u.test(actionText);
}

/** 比對時忽略大小寫、空白與連字號，讓「AK 47」與劇本設定的「AK-47」視為同一詞。 */
const normalizeItemTerm = (text: string): string => text.toLocaleLowerCase().replace(/[\s\-‐–—]+/gu, '');

export function unsupportedInventoryItemRequested(actionText: string): string | undefined {
  if (/(?:有沒有|是否|能不能|可不可以|怎麼取得|哪裡有|資訊|資料)/u.test(actionText)) return undefined;
  const normalizedAction = normalizeItemTerm(actionText);
  const item = scenario.anachronisticItemTerms.find((term) => normalizedAction.includes(normalizeItemTerm(term)));
  if (!item) return undefined;
  if (!/(?:掏出|拿出|取出|使用|裝備|拔出|丟出|投擲|射擊|開槍|給我|我要|我想要|取得|來一把)/u.test(actionText) &&
      normalizedAction !== normalizeItemTerm(item)) return undefined;
  return item;
}

export type WaitIntent =
  | { kind: 'duration'; minutes: number; hasFollowUp: boolean; /** 玩家原本的說法，例如「2 天」；超過上限時用於提示。 */ label?: string }
  | { kind: 'time_of_day' }
  | { kind: 'unspecified' };

const AMOUNT = String.raw`(\d+|[一二兩三四五六七八九十]{1,3})`;
const DURATION_PATTERN = new RegExp(
  String.raw`^\s*(?:了|約|大約)?\s*(?:(半)\s*個?\s*(?:小時|鐘頭)|${AMOUNT}\s*個?\s*(半)?\s*(?:小時|鐘頭)(半)?)?\s*(?:${AMOUNT}\s*分(?:鐘)?)?`,
  'u'
);
/** 以天以上為單位的時長（必定超過單次等待上限）；「幾天」等不明數量視為 2。「三天後」「一天內」是時間點而非時長，不算。 */
const LONG_DURATION_PATTERN = new RegExp(
  String.raw`^\s*(?:了|約|大約|上)?\s*(?:${AMOUNT}|(幾|數|好幾)|(整))?\s*個?\s*(整)?\s*(半)?\s*(天|日|晝夜|週|星期|禮拜|月|年)(?![後前內裡])`,
  'u'
);
const LONG_UNIT_MINUTES: Record<string, number> = { 天: 1440, 日: 1440, 晝夜: 1440, 週: 10080, 星期: 10080, 禮拜: 10080, 月: 43200, 年: 525600 };
const WAIT_VERB = /(?:原地)?(?:等待|等候|等|(?<![期招對接款看虐優善苛交])待(?!會|命|遇)|停留|逗留)/u;
/** 帶有休息或消磨時間意味的動詞；只攔截超過一天的時長，較短的照常交給 AI（例如旅店休息）。 */
const LONG_PASS_VERB = /(?:睡|休息|歇|度過|消磨|打發|躺)/u;

function parseLongDuration(after: string): { minutes: number; label: string; rest: string } | undefined {
  const match = after.match(LONG_DURATION_PATTERN);
  if (!match) return undefined;
  const [whole, amount, vague, fullOnly, , half, unit] = match;
  // 必須帶有數量（例如「兩天」「整天」「半天」），避免「等天亮」被誤判。
  if (!amount && !vague && !fullOnly && !half) return undefined;
  const count = amount ? parseAmount(amount) : vague ? 2 : 1;
  const minutes = half && !amount && !vague ? LONG_UNIT_MINUTES[unit] / 2 : count * LONG_UNIT_MINUTES[unit] + (half ? LONG_UNIT_MINUTES[unit] / 2 : 0);
  if (!(minutes > 0)) return undefined;
  return { minutes, label: whole.trim().replace(/^(?:了|約|大約|上)\s*/u, ''), rest: after.slice(whole.length) };
}

const remainderText = (text: string) => text.replace(/[\s。．.！!，,、～~]/gu, '');

/**
 * 解析原地等待；時長須由玩家明確指定，不交給 AI 判斷。
 * 「等一下」「等待村長」這類不含時長的句子不視為等待，照常交給 AI。
 * 以天為單位的時長也會解析（必定超過上限），避免交給 AI 後敘事跳過數天、遊戲時間卻只推進一般回合。
 */
export function parseWaitIntent(actionText: string): WaitIntent | undefined {
  if (/(?:如何|怎麼|能否|能不能|可不可以|是否|請問|要不要|不要|不想|不能|無法|多久)/u.test(actionText)) return undefined;
  const verb = actionText.match(WAIT_VERB);
  if (!verb || verb.index === undefined) {
    const passVerb = actionText.match(LONG_PASS_VERB);
    if (!passVerb || passVerb.index === undefined) return undefined;
    const long = parseLongDuration(actionText.slice(passVerb.index + passVerb[0].length));
    return long ? { kind: 'duration', minutes: long.minutes, label: long.label, hasFollowUp: remainderText(long.rest).length > 0 } : undefined;
  }
  const after = actionText.slice(verb.index + verb[0].length);

  const long = parseLongDuration(after);
  if (long) return { kind: 'duration', minutes: long.minutes, label: long.label, hasFollowUp: remainderText(long.rest).length > 0 };
  const match = after.match(DURATION_PATTERN);
  if (match && match[0].trim()) {
    const [, halfOnly, hours, halfBefore, halfAfter, minutes] = match;
    const total = (halfOnly ? 30 : 0) + (hours ? parseAmount(hours) * 60 : 0) +
      (halfBefore || halfAfter ? 30 : 0) + (minutes ? parseAmount(minutes) : 0);
    if (total > 0) {
      return { kind: 'duration', minutes: total, label: match[0].trim().replace(/^(?:了|約|大約)\s*/u, ''), hasFollowUp: remainderText(after.slice(match[0].length)).length > 0 };
    }
  }
  if (/^\s*(?:到|至)?\s*(?:天亮|天黑|日出|日落|早上|清晨|中午|下午|傍晚|晚上|深夜|半夜|明天|隔天)/u.test(after)) return { kind: 'time_of_day' };
  if (/原地(?:等待|等候|等)/u.test(actionText) && !after.replace(/[\s。．.！!～~]/gu, '')) return { kind: 'unspecified' };
  return undefined;
}
