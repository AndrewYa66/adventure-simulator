/**
 * 規則用亂數來源（O35-1）：預設使用瀏覽器的安全亂數；驗證腳本可注入固定亂數，使戰鬥結果可重現。
 * 擲骰（d20）、掉落、成群數量與敵人選目標都經由這裡。
 */
let injected: (() => number) | undefined;

/** 注入固定亂數（回傳 0 以上、小於 1 的數）；傳入 undefined 恢復預設。只供驗證腳本使用。 */
export function setRandomSource(source: (() => number) | undefined): void {
  injected = source;
}

export const hasInjectedRandom = (): boolean => injected !== undefined;

/** 0 以上、小於 1 的亂數。 */
export function randomFloat(): number {
  if (injected) return injected();
  if (!globalThis.crypto?.getRandomValues) throw new Error('目前瀏覽器無法產生安全骰點，請更新瀏覽器後重試。');
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return values[0] / 0x1_0000_0000;
}

/** min～max（含）的整數。 */
export function randomInt(min: number, max: number): number {
  return min + Math.floor(randomFloat() * (max - min + 1));
}

/** 依權重挑選一項；權重總和為 0 時回傳 undefined。 */
export function pickWeighted<T>(entries: { item: T; weight: number }[]): T | undefined {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (total <= 0) return undefined;
  let roll = randomFloat() * total;
  for (const entry of entries) {
    roll -= Math.max(0, entry.weight);
    if (roll < 0) return entry.item;
  }
  return entries[entries.length - 1]?.item;
}
