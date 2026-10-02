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
    new RegExp(`(?:扣除|減少|損失)自己\\s*${amountPattern}\\s*(?:點)?\\s*(?:生命|HP)`, 'u')
  ];
  for (const pattern of patterns) {
    const match = actionText.match(pattern);
    if (!match) continue;
    const amount = parseAmount(match[1]);
    if (Number.isSafeInteger(amount) && amount > 0 && amount <= 1000) return amount;
  }
  return undefined;
}
