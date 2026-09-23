import React from 'react';
import type { PlayerState } from '../types/game';
import { getItemById, getMapById, getPlayerGrowthByLevel } from '../data/staticData';

interface PlayerHUDProps {
  player: PlayerState;
}

export const PlayerHUD: React.FC<PlayerHUDProps> = ({ player }) => {
  const growth = getPlayerGrowthByLevel(player.level);
  const maxHp = growth?.maxHp || 100;
  const maxMp = growth?.maxMp || 30;
  const maxExp = growth?.requiredExp || 100;

  const currentMap = getMapById(player.currentMapId);
  const weapon = player.equipped.weaponItemId ? getItemById(player.equipped.weaponItemId) : null;
  const armor = player.equipped.armorItemId ? getItemById(player.equipped.armorItemId) : null;

  return (
    <div style={{ width: '300px', backgroundColor: '#212121', padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div>
        <h3 style={{ margin: '0 0 10px 0', borderBottom: '1px solid #444', paddingBottom: '6px' }}>👤 角色狀態</h3>
        <p style={{ margin: '4px 0' }}><strong>姓名:</strong> {player.name}</p>
        <p style={{ margin: '4px 0' }}><strong>等級:</strong> Lv.{player.level} ({player.exp}/{maxExp} EXP)</p>
        <p style={{ margin: '4px 0' }}><strong>💰 金幣:</strong> {player.gold} Gold</p>
        <p style={{ margin: '4px 0' }}><strong>📍 位置:</strong> {currentMap?.name || player.currentMapId}</p>
      </div>

      {/* 血條與魔力條 */}
      <div>
        <div style={{ marginBottom: '8px' }}>
          <span style={{ fontSize: '12px' }}>❤️ HP ({player.hp}/{maxHp})</span>
          <div style={{ height: '10px', backgroundColor: '#424242', borderRadius: '5px', overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, (player.hp / maxHp) * 100)}%`, height: '100%', backgroundColor: '#e53935' }} />
          </div>
        </div>
        <div>
          <span style={{ fontSize: '12px' }}>🔷 MP ({player.mp}/{maxMp})</span>
          <div style={{ height: '10px', backgroundColor: '#424242', borderRadius: '5px', overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, (player.mp / maxMp) * 100)}%`, height: '100%', backgroundColor: '#1e88e5' }} />
          </div>
        </div>
      </div>

      {/* 裝備欄 */}
      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>⚔️ 當前裝備</h4>
        <p style={{ margin: '2px 0', fontSize: '13px' }}>主手: {weapon?.name || '無'}</p>
        <p style={{ margin: '2px 0', fontSize: '13px' }}>防具: {armor?.name || '無'}</p>
      </div>

      {/* 背包欄 */}
      <div style={{ flex: 1 }}>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>🎒 背包物品</h4>
        <ul style={{ paddingLeft: '20px', margin: 0, fontSize: '13px' }}>
          {player.inventory.map((item) => {
            const staticItem = getItemById(item.itemId);
            return (
              <li key={item.itemId} style={{ marginBottom: '4px' }}>
                {staticItem?.name || item.itemId} x{item.quantity}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};