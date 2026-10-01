import React from 'react';
import type { PlayerState } from '../types/game';
import { getItemById, getMapById, getPlayerGrowthByLevel, questsDatabase } from '../data/staticData';

interface PlayerHUDProps {
  player: PlayerState;
  onReset: () => void;
  storageWarning: boolean;
  onTravel: (mapId: string) => void;
  onAcceptQuest: (questId: string) => void;
}

export const PlayerHUD: React.FC<PlayerHUDProps> = ({ player, onReset, storageWarning, onTravel, onAcceptQuest }) => {
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

      {storageWarning && <p role="status" style={{ color: '#ffb74d', margin: 0, fontSize: '12px' }}>瀏覽器儲存不可用，變更可能無法保存。</p>}
      <button onClick={onReset} style={{ padding: '7px 10px', backgroundColor: '#5d3030', color: '#fff', border: '1px solid #844', borderRadius: '4px', cursor: 'pointer' }}>
        清除存檔並重新開始
      </button>

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

      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>🧭 鄰近地點</h4>
        {(currentMap?.connectedMapIds ?? []).map((mapId) => {
          const destination = getMapById(mapId);
          if (!destination) return null;
          return <button key={mapId} onClick={() => onTravel(mapId)} style={{ display: 'block', margin: '4px 0', padding: '5px 8px', background: '#303c30', color: '#dcedc8', border: '1px solid #546e45', borderRadius: '4px', cursor: 'pointer' }}>前往 {destination.name}</button>;
        })}
      </div>

      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>📜 任務</h4>
        {questsDatabase.map((quest) => {
          const status = player.activeQuests.find((active) => active.questId === quest.id)?.status;
          return <div key={quest.id} style={{ marginBottom: '8px', fontSize: '12px' }}>
            <strong>{quest.title}</strong>
            <div>{status === 'completed' ? '已完成' : status === 'in_progress' ? '進行中' : quest.objective}</div>
            {!status && <button onClick={() => onAcceptQuest(quest.id)} style={{ marginTop: '4px', padding: '4px 7px', cursor: 'pointer' }}>接取任務</button>}
          </div>;
        })}
      </div>
    </div>
  );
};
