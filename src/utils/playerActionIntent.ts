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
  | { kind: 'duration'; minutes: number; hasFollowUp: boolean }
  | { kind: 'time_of_day' }
  | { kind: 'unspecified' };

const AMOUNT = String.raw`(\d+|[一二兩三四五六七八九十]{1,3})`;
const DURATION_PATTERN = new RegExp(
  String.raw`^\s*(?:了|約|大約)?\s*(?:(半)\s*個?\s*(?:小時|鐘頭)|${AMOUNT}\s*個?\s*(半)?\s*(?:小時|鐘頭)(半)?)?\s*(?:${AMOUNT}\s*分(?:鐘)?)?`,
  'u'
);

/**
 * 解析原地等待；時長須由玩家明確指定，不交給 AI 判斷。
 * 「等一下」「等待村長」這類不含時長的句子不視為等待，照常交給 AI。
 */
export function parseWaitIntent(actionText: string): WaitIntent | undefined {
  if (/(?:如何|怎麼|能否|能不能|可不可以|是否|請問|要不要|不要|不想|不能|無法|多久)/u.test(actionText)) return undefined;
  const verb = actionText.match(/(?:原地)?(?:等待|等候|等)/u);
  if (!verb || verb.index === undefined) return undefined;
  const after = actionText.slice(verb.index + verb[0].length);

  const match = after.match(DURATION_PATTERN);
  if (match && match[0].trim()) {
    const [, halfOnly, hours, halfBefore, halfAfter, minutes] = match;
    const total = (halfOnly ? 30 : 0) + (hours ? parseAmount(hours) * 60 : 0) +
      (halfBefore || halfAfter ? 30 : 0) + (minutes ? parseAmount(minutes) : 0);
    if (total > 0) {
      const followUp = after.slice(match[0].length).replace(/[\s。．.！!，,、～~]/gu, '');
      return { kind: 'duration', minutes: total, hasFollowUp: followUp.length > 0 };
    }
  }
  if (/^\s*(?:到|至)\s*(?:天亮|天黑|日出|日落|早上|清晨|中午|下午|傍晚|晚上|深夜|半夜|明天|隔天)/u.test(after)) return { kind: 'time_of_day' };
  if (/原地(?:等待|等候|等)/u.test(actionText) && !after.replace(/[\s。．.！!～~]/gu, '')) return { kind: 'unspecified' };
  return undefined;
}
