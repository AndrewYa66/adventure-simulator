import type { ItemStatic, PlayerState, ShopStatic } from '../types/game';
import { getMapById, getPlayerResourceCaps, getShopForUnit, getWorldUnitById, getWorldUnitDisposition } from '../data/staticData';
import { advanceGameTime } from './gameTime';
import { canPlayerAct } from './playerStatus';

export type TradeResult = { ok: true; player: PlayerState; quantity: number; totalPrice: number } |
  { ok: false; reason: string };

function canTrade(player: PlayerState, shop: ShopStatic, currentMapId: string): boolean {
  const unit = getWorldUnitById(shop.ownerUnitId);
  return canPlayerAct(player) && !player.combat && !!unit && !player.unitInstances[unit.id]?.isDead && player.unitInstances[unit.id]?.currentHp !== 0 && getWorldUnitDisposition(player, unit.id) !== 'hostile' && unit.source.shopId === shop.id &&
    unit.mapIds.includes(currentMapId) && (!unit.requiresEncounter || player.encounteredUnitId === unit.id);
}

function record(player: PlayerState, type: PlayerState['transactionHistory'][number]['type'], description: string, goldChange: number) {
  return [{ id: `${Date.now()}-${Math.random()}`, type, description, goldChange, timestamp: Date.now() }, ...player.transactionHistory].slice(0, 100);
}

export function buyItem(
  player: PlayerState,
  shop: ShopStatic,
  item: ItemStatic,
  currentMapId: string,
  quantity = 1
): TradeResult {
  if (!canTrade(player, shop, currentMapId)) return { ok: false, reason: '目前無法交易。' };
  const listing = shop.items.find((entry) => entry.itemId === item.id);
  if (!listing) return { ok: false, reason: '這間商店沒有販售該物品。' };
  const unitPrice = listing.buyPrice ?? item.buyPrice;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99 || !Number.isSafeInteger(unitPrice) || unitPrice <= 0) {
    return { ok: false, reason: '交易數量或價格無效。' };
  }
  const totalPrice = unitPrice * quantity;
  if (!Number.isSafeInteger(totalPrice)) return { ok: false, reason: '交易金額超出有效範圍。' };
  if (player.gold < totalPrice) return { ok: false, reason: `金幣不足，需要 ${totalPrice} 枚。` };
  const inventory = player.inventory.map((entry) => ({ ...entry }));
  const ownerState = player.unitInstances[shop.ownerUnitId];
  if (!ownerState || (ownerState.inventory.find((entry) => entry.itemId === item.id)?.quantity ?? 0) < quantity) {
    return { ok: false, reason: '商店目前庫存不足。' };
  }
  const ownerInventory = ownerState.inventory.map((entry) => ({ ...entry }));
  const stock = ownerInventory.find((entry) => entry.itemId === item.id)!;
  stock.quantity -= quantity;
  if (stock.quantity === 0) ownerInventory.splice(ownerInventory.indexOf(stock), 1);
  const owned = inventory.find((entry) => entry.itemId === item.id);
  if (owned) owned.quantity += quantity;
  else inventory.push({ itemId: item.id, quantity });
  const description = `購買 ${item.name} ×${quantity}`;
  return { ok: true, player: {
    ...player, gold: player.gold - totalPrice, inventory,
    unitInstances: { ...player.unitInstances, [shop.ownerUnitId]: { ...ownerState, gold: ownerState.gold + totalPrice, inventory: ownerInventory } },
    transactionHistory: record(player, 'purchase', description, -totalPrice)
  }, quantity, totalPrice };
}

export function sellItem(
  player: PlayerState,
  shop: ShopStatic,
  item: ItemStatic,
  currentMapId: string,
  quantity = 1
): TradeResult {
  if (!canTrade(player, shop, currentMapId)) return { ok: false, reason: '目前無法交易。' };
  if (item.type === 'quest' || item.sellPrice <= 0) return { ok: false, reason: '任務道具或不可販售物品不能出售。' };
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99 || !Number.isSafeInteger(item.sellPrice)) {
    return { ok: false, reason: '交易數量或價格無效。' };
  }
  const inventory = player.inventory.map((entry) => ({ ...entry }));
  const owned = inventory.find((entry) => entry.itemId === item.id);
  if (!owned || owned.quantity < quantity) return { ok: false, reason: '持有數量不足。' };
  const ownerState = player.unitInstances[shop.ownerUnitId];
  const totalPrice = item.sellPrice * quantity;
  if (!Number.isSafeInteger(totalPrice)) return { ok: false, reason: '交易金額超出有效範圍。' };
  if (!ownerState || ownerState.gold < totalPrice) return { ok: false, reason: '商人目前沒有足夠金幣收購。' };
  owned.quantity -= quantity;
  if (owned.quantity === 0) inventory.splice(inventory.indexOf(owned), 1);
  const ownerInventory = ownerState.inventory.map((entry) => ({ ...entry }));
  const stock = ownerInventory.find((entry) => entry.itemId === item.id);
  if (stock) stock.quantity += quantity;
  else ownerInventory.push({ itemId: item.id, quantity });
  return { ok: true, player: {
    ...player, gold: player.gold + totalPrice, inventory,
    unitInstances: { ...player.unitInstances, [shop.ownerUnitId]: { ...ownerState, gold: ownerState.gold - totalPrice, inventory: ownerInventory } },
    transactionHistory: record(player, 'sale', `出售 ${item.name} ×${quantity}`, totalPrice)
  }, quantity, totalPrice };
}

export function purchaseService(player: PlayerState, shop: ShopStatic, serviceId: string, currentMapId: string): TradeResult {
  if (!canTrade(player, shop, currentMapId)) return { ok: false, reason: '目前無法使用服務。' };
  const service = shop.services?.find((entry) => entry.id === serviceId);
  const ownerState = player.unitInstances[shop.ownerUnitId];
  if (!service || !ownerState) return { ok: false, reason: '找不到這項服務。' };
  if (!Number.isSafeInteger(service.price) || service.price < 0) return { ok: false, reason: '服務價格資料無效。' };
  if (player.gold < service.price) return { ok: false, reason: `金幣不足，需要 ${service.price} 枚。` };
  if (player.hp >= getPlayerResourceCaps(player).maxHp &&
      player.mp >= getPlayerResourceCaps(player).maxMp) return { ok: false, reason: '目前生命與魔力已恢復，無需休息。' };
  const caps = getPlayerResourceCaps(player);
  // 休息類服務依行動類型固定耗時（rest）。
  return { ok: true, quantity: 1, totalPrice: service.price, player: advanceGameTime({
    ...player,
    hp: caps.maxHp,
    mp: caps.maxMp,
    gold: player.gold - service.price,
    unitInstances: { ...player.unitInstances, [shop.ownerUnitId]: { ...ownerState, gold: ownerState.gold + service.price } },
    transactionHistory: record(player, 'service', `使用服務：${service.name}`, -service.price)
  }, 'rest') };
}

/** 目前地區可使用的商店服務（經營者在場、存活、非敵對）；供 HUD 與 AI 的 serviceRequest 候選共用。 */
export function getAvailableServices(player: PlayerState) {
  return (getMapById(player.currentMapId)?.unitsPresent ?? []).flatMap((unitId) => {
    const unit = getWorldUnitById(unitId);
    const shop = unit ? getShopForUnit(unit.source) : undefined;
    if (!shop || !canTrade(player, shop, player.currentMapId)) return [];
    return (shop.services ?? []).map((service) => ({
      shopId: shop.id, serviceId: service.id, name: service.name, price: service.price, description: service.description, provider: unit!.name
    }));
  });
}
