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

export function unsupportedInventoryItemRequested(actionText: string): string | undefined {
  if (/(?:有沒有|是否|能不能|可不可以|怎麼取得|哪裡有|資訊|資料)/u.test(actionText)) return undefined;
  const item = actionText.match(/手榴彈|巴雷特|AK\s*[- ]?\s*47/iu)?.[0];
  if (!item) return undefined;
  if (!/(?:掏出|拿出|取出|使用|裝備|拔出|丟出|投擲|射擊|開槍|給我|我要|我想要|取得|來一把)/u.test(actionText) && actionText.trim() !== item) return undefined;
  return item.toUpperCase().replace(/\s+/g, ' ');
}
