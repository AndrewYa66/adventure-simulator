import type {
  AbilityScores,
  CharacterClassStatic,
  CheckBonuses,
  LevelBenchmarkStatic,
  SpeciesStatic,
  UnitStatBlock,
  UnitStatKey
} from '../types/game';

// 純規則函式：只接收資料物件，不直接讀取資料庫，讓 staticData 與驗證腳本都能共用。

export const UNIT_STAT_KEYS: readonly UnitStatKey[] = ['hp', 'mp', 'atk', 'def', 'spd'];
export const ABILITY_KEYS: readonly (keyof AbilityScores)[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const ABILITY_BASE = 10;
const ABILITY_MIN = 1;
const ABILITY_MAX = 30;

/**
 * 有效數值 = round(等級基準 × 種族倍率 × 職階倍率) + 個體相對修正。
 * 玩家與所有單位一律使用此公式；裝備加值由呼叫端另外疊加。
 */
export function computeUnitStats(
  benchmark: LevelBenchmarkStatic,
  species: SpeciesStatic,
  characterClass: CharacterClassStatic | undefined,
  adjustments: Partial<UnitStatBlock> = {}
): UnitStatBlock {
  const stats = {} as UnitStatBlock;
  for (const key of UNIT_STAT_KEYS) {
    const scaled = Math.round(benchmark[key] * species.statMultipliers[key] * (characterClass?.statMultipliers[key] ?? 1));
    stats[key] = Math.max(key === 'hp' ? 1 : 0, scaled + (adjustments[key] ?? 0));
  }
  return stats;
}

/** 能力值 = 10 + 種族修正 + 職階修正，限制在 1–30。 */
export function computeUnitAbilities(species: SpeciesStatic, characterClass: CharacterClassStatic | undefined): AbilityScores {
  const abilities = {} as AbilityScores;
  for (const key of ABILITY_KEYS) {
    const score = ABILITY_BASE + (species.abilityModifiers[key] ?? 0) + (characterClass?.abilityModifiers[key] ?? 0);
    abilities[key] = Math.min(ABILITY_MAX, Math.max(ABILITY_MIN, score));
  }
  return abilities;
}

/** 擊倒獎勵經驗 = 等級基準獎勵 × 種族倍率 × 職階倍率；不由資料手填。 */
export function computeExpReward(
  benchmark: LevelBenchmarkStatic,
  species: SpeciesStatic,
  characterClass: CharacterClassStatic | undefined
): number {
  return Math.max(0, Math.round(benchmark.expReward * species.expRewardMultiplier * (characterClass?.expRewardMultiplier ?? 1)));
}

/** 種族與職階的檢定加值合計。 */
export function computeCheckBonus(
  species: SpeciesStatic | undefined,
  characterClass: CharacterClassStatic | undefined,
  stat: keyof CheckBonuses
): number {
  return (species?.checkBonuses?.[stat] ?? 0) + (characterClass?.checkBonuses?.[stat] ?? 0);
}

/** 種族是否允許此職階（或無職階）。 */
export function isValidSpeciesClassCombo(species: SpeciesStatic, characterClass: CharacterClassStatic | undefined): boolean {
  return characterClass ? species.allowedClassCategories.includes(characterClass.category) : species.allowsNoClass;
}

/** 依累計經驗計算等級；只升不降，並受 maxLevel 限制。 */
export function resolveLevelFromExp(
  benchmarks: readonly LevelBenchmarkStatic[],
  currentLevel: number,
  exp: number,
  maxLevel: number
): number {
  let level = currentLevel;
  while (level < maxLevel) {
    const benchmark = benchmarks.find((entry) => entry.level === level);
    if (!benchmark || exp < benchmark.requiredExp || !benchmarks.some((entry) => entry.level === level + 1)) break;
    level += 1;
  }
  return level;
}
