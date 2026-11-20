import type { PlayerState } from '../types/game';
import { canPlayerEnterMap, getItemById, getMapById, getPlayerResourceCaps, getShopById, getShopForUnit, getUnlockedSkills, getWorldUnitById, getWorldUnitDisposition, getWorldUnitsAtMap, scenario } from '../data/staticData';
import { canAcceptQuest, canTurnInQuest, getQuestGiverName, listVisibleQuests } from './questRules';
import { canPlayerAct, isPlayerUnconscious } from './playerStatus';
import { canTrade } from './tradeRules';
import { formatDuration, MAX_WAIT_MINUTES } from './gameTime';
import { hasNoticeBoard } from './storylets';

/**
 * 系統選項（O50 第一階段）：前端依目前狀態產生、規則直接執行的動作。
 * 每次狀態改變後重算，不存入存檔；只列出此刻合法的動作。
 */
export type SystemAction =
  | { kind: 'travel'; mapId: string }
  | { kind: 'talk'; unitId: string }
  | { kind: 'challenge'; unitId: string }
  | { kind: 'acceptQuest'; questId: string }
  | { kind: 'turnInQuest'; questId: string }
  | { kind: 'openShop'; shopId: string }
  | { kind: 'buy'; shopId: string; itemId: string }
  | { kind: 'sell'; shopId: string; itemId: string }
  | { kind: 'service'; shopId: string; serviceId: string }
  | { kind: 'noticeBoard' }
  | { kind: 'wait'; minutes: number }
  | { kind: 'useSkill'; skillId: string }
  | { kind: 'attack' }
  | { kind: 'flee' };

export interface SystemOption {
  id: string;
  label: string;
  action: SystemAction;
  /** 列出但暫時不能按（例如商品金幣不足）；只用於展開後的清單。 */
  disabledReason?: string;
  title?: string;
}

export type SystemOptionGroupId = 'travel' | 'people' | 'quests' | 'facilities' | 'skills' | 'wait';

export interface SystemOptionGroup {
  id: SystemOptionGroupId;
  label: string;
  options: SystemOption[];
}

export interface SystemOptionSet {
  /** normal：一般；combat：戰鬥中；blocked：死亡、昏迷（非戰鬥）、時間線結束，全部停用。 */
  mode: 'normal' | 'combat' | 'blocked';
  /** 當下可做的事，不需展開：可交付的任務、剛遭遇的敵人；戰鬥中為全部戰鬥動作。 */
  immediate: SystemOption[];
  groups: SystemOptionGroup[];
}

/** 開始戰鬥的條件；不能開始時回傳給玩家看的原因。provoke 為 true 時允許對非敵對單位動手（打字攻擊會激怒對方）。 */
export function getCombatStartBlock(player: PlayerState, unitId: string, provoke = false): string | undefined {
  if (player.combat) return '目前已在戰鬥中。';
  if (!canPlayerAct(player)) return '角色目前無法採取行動。';
  const map = getMapById(player.currentMapId);
  const unit = getWorldUnitById(unitId, player);
  if (!map || !unit) return '目前地區或目標資料不存在。';
  if (!unit.mapIds.includes(map.id) || !map.unitsPresent.includes(unitId) || player.unitInstances[unitId]?.isDormant) return `${unit.name}不在這裡。`;
  const unitState = unit.population ? undefined : player.unitInstances[unit.id];
  if (unitState?.isDead || unitState?.currentHp === 0) return `${unit.name}已經倒下。`;
  if (unit.requiresEncounter) {
    if (map.isSafeZone) return '安全地區不會遭遇敵人。';
    if (player.encounteredUnitId !== unitId) return `你尚未遭遇${unit.name}；請先探索，等實際遭遇後再攻擊。`;
    if (unit.requiredQuestId && !player.activeQuests.some((quest) => quest.questId === unit.requiredQuestId && quest.status === 'in_progress')) return `目前無法與${unit.name}交戰。`;
  }
  if (!provoke && getWorldUnitDisposition(player, unitId) !== 'hostile') return `${unit.name}目前不是敵對關係。`;
  return undefined;
}

/** 在場且可互動的人物：地區居民（存活），以及目前已遭遇且仍在場的需遭遇單位。 */
function getPresentUnits(player: PlayerState) {
  const map = getMapById(player.currentMapId);
  if (!map) return [];
  return getWorldUnitsAtMap(map.id, player).filter((unit) => {
    const state = unit.population ? undefined : player.unitInstances[unit.id];
    if (state?.isDead || state?.currentHp === 0) return false;
    return !unit.requiresEncounter || (!map.isSafeZone && player.encounteredUnitId === unit.id);
  });
}

/** 目前地區可交易的商店（經營者在場、存活、非敵對）。 */
function getOpenShops(player: PlayerState) {
  return getPresentUnits(player).flatMap((unit) => {
    const shop = getShopForUnit(unit.source);
    return shop && canTrade(player, shop, player.currentMapId) ? [{ shop, owner: unit }] : [];
  });
}

/** 打開商店後的清單：購買、出售、服務（沿用交易規則；金幣或庫存不足時列出但停用）。 */
export function buildShopOptions(player: PlayerState, shopId: string): SystemOption[] {
  const shop = getShopById(shopId);
  if (!shop || !canTrade(player, shop, player.currentMapId)) return [];
  const { maxHp, maxMp } = getPlayerResourceCaps(player);
  const buy = shop.items.flatMap((listing) => {
    const item = getItemById(listing.itemId);
    if (!item) return [];
    const price = listing.buyPrice ?? item.buyPrice;
    const stock = player.unitInstances[shop.ownerUnitId]?.inventory.find((entry) => entry.itemId === item.id)?.quantity ?? 0;
    const disabledReason = stock <= 0 ? '缺貨' : player.gold < price ? '金幣不足' : undefined;
    return [{ id: `buy:${shop.id}:${item.id}`, label: `購買 ${item.name}（${price} 金幣・庫存 ${stock}）`, title: item.description, disabledReason, action: { kind: 'buy', shopId: shop.id, itemId: item.id } } satisfies SystemOption];
  });
  const services = (shop.services ?? []).map((service): SystemOption => ({
    id: `service:${shop.id}:${service.id}`,
    label: `${service.name}（${service.price} 金幣）`,
    title: service.description,
    disabledReason: player.gold < service.price ? '金幣不足'
      : service.kind === 'restore_resources' && player.hp >= maxHp && player.mp >= maxMp ? '生命與魔力已滿' : undefined,
    action: { kind: 'service', shopId: shop.id, serviceId: service.id }
  }));
  const sell = player.inventory.flatMap((entry) => {
    const item = getItemById(entry.itemId);
    if (!item || item.type === 'quest' || item.sellPrice <= 0 || entry.quantity <= 0) return [];
    return [{ id: `sell:${shop.id}:${item.id}`, label: `出售 ${item.name}（${item.sellPrice} 金幣・持有 ${entry.quantity}）`, action: { kind: 'sell', shopId: shop.id, itemId: item.id } } satisfies SystemOption];
  });
  return [...services, ...buy, ...sell];
}

/** 告示板：列出此地可接取的委託（不呼叫 AI）。 */
export function buildNoticeBoardOptions(player: PlayerState): SystemOption[] {
  return listVisibleQuests(player).filter((quest) => canAcceptQuest(player, quest)).map((quest) => ({
    id: `board:${quest.id}`, label: `接取「${quest.title}」`, title: quest.objective, action: { kind: 'acceptQuest', questId: quest.id }
  }));
}

export function buildSystemOptions(player: PlayerState): SystemOptionSet {
  const map = getMapById(player.currentMapId);
  const skills = getUnlockedSkills(player.classId, player.level);

  if (player.combat) {
    const target = getWorldUnitById(player.combat.targetUnitId, player);
    // 昏迷時只能跳過回合（敵人照常行動），與原本 HUD 的攻擊按鈕相同。
    if (isPlayerUnconscious(player) && !player.isDead) {
      return { mode: 'combat', groups: [], immediate: [{ id: 'combat:attack', label: '💫 昏迷中（跳過回合）', action: { kind: 'attack' } }] };
    }
    if (!canPlayerAct(player)) return { mode: 'blocked', immediate: [], groups: [] };
    return {
      mode: 'combat',
      groups: [],
      immediate: [
        { id: 'combat:attack', label: `⚔️ 攻擊${target ? ` ${target.name}` : ''}`, action: { kind: 'attack' } },
        ...skills.filter((skill) => skill.effect.kind === 'damage_multiplier').map((skill): SystemOption => ({
          id: `combat:skill:${skill.id}`, label: `✨ ${skill.name}（MP ${skill.costMp}）`, title: skill.description,
          disabledReason: player.mp < skill.costMp ? '魔力不足' : undefined, action: { kind: 'useSkill', skillId: skill.id }
        })),
        { id: 'combat:flee', label: '🏃 逃跑', action: { kind: 'flee' } }
      ]
    };
  }

  if (!canPlayerAct(player) || !map) return { mode: 'blocked', immediate: [], groups: [] };

  const immediate: SystemOption[] = [];
  const presentUnits = getPresentUnits(player);

  // 剛遭遇的敵人：直接列在最前面。
  const encountered = player.encounteredUnitId ? presentUnits.find((unit) => unit.id === player.encounteredUnitId && unit.requiresEncounter) : undefined;
  if (encountered && !getCombatStartBlock(player, encountered.id)) {
    immediate.push({ id: `challenge:${encountered.id}`, label: `⚔️ 挑戰 ${encountered.name}`, action: { kind: 'challenge', unitId: encountered.id } });
  }

  // 可交付的任務：直接列在最前面。
  const turnIns = listVisibleQuests(player).filter((quest) => canTurnInQuest(player, quest));
  for (const quest of turnIns) {
    immediate.push({ id: `turnin:${quest.id}`, label: `✅ 向${getQuestGiverName(player, quest)}交付「${quest.title}」`, action: { kind: 'turnInQuest', questId: quest.id } });
  }

  const travel: SystemOption[] = map.connectedMapIds.flatMap((mapId) => {
    const destination = getMapById(mapId);
    return destination && canPlayerEnterMap(player, destination)
      ? [{ id: `travel:${mapId}`, label: `前往 ${destination.name}`, title: destination.description, action: { kind: 'travel', mapId } } satisfies SystemOption]
      : [];
  });

  const people: SystemOption[] = presentUnits.flatMap((unit) => {
    const options: SystemOption[] = [{ id: `talk:${unit.id}`, label: `💬 與${unit.name}交談`, action: { kind: 'talk', unitId: unit.id } }];
    if (unit.id !== encountered?.id && !getCombatStartBlock(player, unit.id)) {
      options.push({ id: `challenge:${unit.id}`, label: `⚔️ 挑戰 ${unit.name}`, action: { kind: 'challenge', unitId: unit.id } });
    }
    return options;
  });

  const quests: SystemOption[] = [
    ...turnIns.map((quest): SystemOption => ({ id: `quest-turnin:${quest.id}`, label: `✅ 交付「${quest.title}」`, action: { kind: 'turnInQuest', questId: quest.id } })),
    ...listVisibleQuests(player).filter((quest) => canAcceptQuest(player, quest)).map((quest): SystemOption => ({
      id: `accept:${quest.id}`, label: `📜 接取「${quest.title}」`, title: quest.objective, action: { kind: 'acceptQuest', questId: quest.id }
    }))
  ];

  const facilities: SystemOption[] = [
    ...getOpenShops(player).map(({ shop }): SystemOption => ({
      id: `shop:${shop.id}`, label: `${(shop.services ?? []).length ? '🛏️' : '🪙'} 打開${shop.name}`, action: { kind: 'openShop', shopId: shop.id }
    })),
    ...(hasNoticeBoard(map.id) ? [{ id: 'board', label: '📋 查看告示板', action: { kind: 'noticeBoard' } } satisfies SystemOption] : [])
  ];

  // 戰鬥外可用的技能（目前只有治療類）；生命已滿時不列出。
  const { maxHp } = getPlayerResourceCaps(player);
  const skillOptions: SystemOption[] = skills.filter((skill) => skill.effect.kind === 'healing' && player.hp < maxHp).map((skill) => ({
    id: `skill:${skill.id}`, label: `✨ ${skill.name}（MP ${skill.costMp}）`, title: skill.description,
    disabledReason: player.mp < skill.costMp ? '魔力不足' : undefined, action: { kind: 'useSkill', skillId: skill.id }
  }));

  const wait: SystemOption[] = scenario.rules.waitOptionMinutes.filter((minutes) => minutes > 0 && minutes <= MAX_WAIT_MINUTES).map((minutes) => ({
    id: `wait:${minutes}`, label: `⏳ 等待 ${formatDuration(minutes)}`, action: { kind: 'wait', minutes }
  }));

  const groups: SystemOptionGroup[] = [
    { id: 'travel', label: '移動', options: travel },
    { id: 'people', label: '人物', options: people },
    { id: 'quests', label: '任務', options: quests },
    { id: 'facilities', label: '設施', options: facilities },
    { id: 'skills', label: '技能', options: skillOptions },
    { id: 'wait', label: '等待', options: wait }
  ];
  return { mode: 'normal', immediate, groups: groups.filter((group) => group.options.length > 0) };
}
