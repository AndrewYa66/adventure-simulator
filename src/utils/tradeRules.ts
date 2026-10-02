import type { ItemStatic, PlayerState, ShopStatic } from '../types/game';
import { getMapById, getNpcById } from '../data/staticData';
import { canPlayerAct } from './playerStatus';

export type TradeResult = { ok: true; player: PlayerState; quantity: number; totalPrice: number } |
  { ok: false; reason: string };

function canTrade(player: PlayerState, shop: ShopStatic, currentMapId: string): boolean {
  const npc = getNpcById(shop.npcId);
  return canPlayerAct(player) && !player.combat && !!npc && npc.mapId === currentMapId &&
    !!getMapById(currentMapId)?.npcsPresent.includes(npc.id);
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
  if (player.gold < totalPrice) return { ok: false, reason: `金幣不足，需要 ${totalPrice} 枚。` };
  const inventory = player.inventory.map((entry) => ({ ...entry }));
  const owned = inventory.find((entry) => entry.itemId === item.id);
  if (owned) owned.quantity += quantity;
  else inventory.push({ itemId: item.id, quantity });
  return { ok: true, player: { ...player, gold: player.gold - totalPrice, inventory }, quantity, totalPrice };
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
  owned.quantity -= quantity;
  if (owned.quantity === 0) inventory.splice(inventory.indexOf(owned), 1);
  const totalPrice = item.sellPrice * quantity;
  return { ok: true, player: { ...player, gold: player.gold + totalPrice, inventory }, quantity, totalPrice };
}
