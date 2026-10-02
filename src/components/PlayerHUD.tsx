import React from 'react';
import type { PlayerState } from '../types/game';
import { getItemById, getMapById, getMonsterById, getNpcById, getNpcCategoryById, getNpcStats, getPlayerGrowthByLevel, getUnlockedSkillsByLevel, questsDatabase } from '../data/staticData';
import { getPlayerStatBreakdown, STAT_LABELS } from '../utils/gameChecks';
import { canAcceptQuest } from '../utils/questRules';
import { canPlayerAct, isPlayerUnconscious } from '../utils/playerStatus';

interface PlayerHUDProps {
  player: PlayerState;
  onReset: () => void;
  storageWarning: boolean;
  onTravel: (mapId: string) => void;
  onAcceptQuest: (questId: string) => void;
  onStartCombat: (monsterId: string) => void;
  onFleeCombat: () => void;
  onAttack: () => void;
  onUseSkill: (skillId: string) => void;
  onUseItem: (itemId: string) => void;
}

export const PlayerHUD: React.FC<PlayerHUDProps> = ({ player, onReset, storageWarning, onTravel, onAcceptQuest, onStartCombat, onFleeCombat, onAttack, onUseSkill, onUseItem }) => {
  const growth = getPlayerGrowthByLevel(player.level);
  const maxHp = growth?.maxHp || 100;
  const maxMp = growth?.maxMp || 30;
  const maxExp = growth?.requiredExp || 100;
  const unlockedSkills = getUnlockedSkillsByLevel(player.level);

  const currentMap = getMapById(player.currentMapId);
  const weapon = player.equipped.weaponItemId ? getItemById(player.equipped.weaponItemId) : null;
  const armor = player.equipped.armorItemId ? getItemById(player.equipped.armorItemId) : null;
  const combatStats = (['atk', 'def', 'spd'] as const).map((stat) => ({
    stat,
    label: STAT_LABELS[stat],
    ...getPlayerStatBreakdown(player, stat)
  }));

  return (
    <aside id="player-sidebar" aria-label="玩家選單" style={{ width: '300px', minHeight: 0, overflowY: 'auto', backgroundColor: '#212121', padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div>
        <h3 style={{ margin: '0 0 10px 0', borderBottom: '1px solid #444', paddingBottom: '6px' }}>👤 角色狀態</h3>
        <p style={{ margin: '4px 0' }}><strong>姓名:</strong> {player.name}</p>
        {(player.isDead || isPlayerUnconscious(player)) && <p role="status" style={{ margin: '4px 0', color: '#ff8a80', fontWeight: 'bold' }}>{player.isDead ? '☠️ 已死亡' : '💫 昏迷中'}</p>}
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

      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>📊 戰鬥能力</h4>
        {combatStats.map((ability) => (
          <div key={ability.stat} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '3px 0', fontSize: '12px' }}>
            <strong>{ability.label}</strong>
            <span style={{ textAlign: 'right' }}>
              <strong>{ability.statValue}</strong> <span style={{ color: '#aaa' }}>(修正 {ability.modifier >= 0 ? '+' : ''}{ability.modifier})</span>
              <span style={{ display: 'block', color: '#888', fontSize: '10px' }}>基礎 {ability.baseStat} · 裝備 {ability.equipmentBonus >= 0 ? '+' : ''}{ability.equipmentBonus}</span>
            </span>
          </div>
        ))}
        <p style={{ color: '#888', fontSize: '11px', margin: '5px 0 0' }}>數值包含目前裝備加成；擲 d20 時使用修正值。</p>
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
                {staticItem?.type === 'consumable' && <button onClick={() => onUseItem(item.itemId)} disabled={!canPlayerAct(player) || (!!player.combat && !staticItem.usableInCombat)} style={{ marginLeft: '6px', padding: '2px 5px', cursor: !canPlayerAct(player) || (!!player.combat && !staticItem.usableInCombat) ? 'not-allowed' : 'pointer' }}>使用</button>}
                {staticItem?.type === 'consumable' && <span style={{ display: 'block', color: '#888', fontSize: '11px' }}>{staticItem.description}</span>}
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
          return <button key={mapId} disabled={!!player.combat} onClick={() => onTravel(mapId)} style={{ display: 'block', margin: '4px 0', padding: '5px 8px', background: '#303c30', color: '#dcedc8', border: '1px solid #546e45', borderRadius: '4px', cursor: player.combat ? 'not-allowed' : 'pointer', opacity: player.combat ? 0.5 : 1 }}>前往 {destination.name}</button>;
        })}
      </div>

      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>🧑‍🤝‍🧑 當前地區人物</h4>
        {(currentMap?.npcsPresent ?? []).map((npcId) => {
          const npc = getNpcById(npcId);
          const stats = npc ? getNpcStats(npc) : undefined;
          if (!npc || !stats) return null;
          return <div key={npc.id} style={{ marginBottom: '7px', fontSize: '12px' }}>
            <strong>{npc.name}・{npc.title}</strong>
            <div style={{ color: '#aaa' }}>類別：{getNpcCategoryById(npc.categoryId)?.name ?? npc.categoryId} · HP {stats.hp} · ATK {stats.atk} · DEF {stats.def} · SPD {stats.spd}</div>
          </div>;
        })}
        {!currentMap?.npcsPresent.length && <div style={{ color: '#888', fontSize: '12px' }}>目前沒有在場人物。</div>}
      </div>

      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>👹 遭遇</h4>
        {player.combat ? (() => {
          const monster = getMonsterById(player.combat.monsterId);
          return <div>
            <div style={{ marginBottom: '6px' }}>{monster?.name || player.combat.monsterId} HP {player.combat.currentHp}/{monster?.stats.hp}</div>
            <div style={{ color: '#aaa', fontSize: '11px', marginBottom: '8px' }}>第 {player.combat.round} 回合</div>
            <button onClick={onAttack} disabled={!canPlayerAct(player)} style={{ marginRight: '6px', padding: '6px 10px', background: '#8e2424', color: 'white', border: '1px solid #b44', borderRadius: '4px', cursor: 'pointer' }}>攻擊</button>
            {unlockedSkills.map((skill) => <button key={skill.id} onClick={() => onUseSkill(skill.id)} disabled={!canPlayerAct(player) || player.mp < skill.costMp} title={skill.description} style={{ marginRight: '6px', padding: '6px 10px', cursor: player.mp < skill.costMp || !canPlayerAct(player) ? 'not-allowed' : 'pointer' }}>{skill.name}（MP {skill.costMp}）</button>)}
            <button onClick={onFleeCombat} disabled={!canPlayerAct(player)} style={{ padding: '6px 10px', cursor: canPlayerAct(player) ? 'pointer' : 'not-allowed' }}>脫離戰鬥</button>
          </div>;
        })() : (currentMap?.isSafeZone ? <div style={{ color: '#aaa', fontSize: '12px' }}>安全地區沒有可挑戰的敵人。</div> : (currentMap?.monstersPresent ?? []).map((monsterId) => {
          const monster = getMonsterById(monsterId);
          if (!monster) return null;
          return <button key={monsterId} onClick={() => onStartCombat(monsterId)} style={{ display: 'block', margin: '4px 0', padding: '5px 8px', background: '#4a2525', color: '#ffcdd2', border: '1px solid #844', borderRadius: '4px', cursor: 'pointer' }}>挑戰 {monster.name}</button>;
        }))}
      </div>

      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>📜 任務</h4>
        {questsDatabase.map((quest) => {
          const active = player.activeQuests.find((entry) => entry.questId === quest.id);
          const status = active?.status;
          const inventoryCount = (itemId: string) => player.inventory.find((item) => item.itemId === itemId)?.quantity ?? 0;
          return <div key={quest.id} style={{ marginBottom: '8px', fontSize: '12px' }}>
            <strong>{quest.title}</strong>
            <div>{status === 'completed' ? '已完成' : status === 'in_progress' ? '進行中' : quest.objective}</div>
            {status && <div style={{ marginTop: '4px', color: '#bbb' }}>
              {(quest.requirements.defeatMonsters ?? []).map((requirement) => {
                const count = active?.progress?.defeatedMonsters[requirement.monsterId] ?? 0;
                return <div key={requirement.monsterId}>擊敗 {getMonsterById(requirement.monsterId)?.name || requirement.monsterId}: {Math.min(count, requirement.quantity)}/{requirement.quantity}</div>;
              })}
              {(quest.requirements.collectItems ?? []).map((requirement) => {
                const item = getItemById(requirement.itemId);
                const count = inventoryCount(requirement.itemId);
                return <div key={requirement.itemId} style={{ color: status === 'completed' ? '#81c784' : count >= requirement.quantity ? '#81c784' : '#ffcc80' }}>
                  {status === 'completed' ? '已交付' : count >= requirement.quantity ? '可交付' : '尚缺'} {item?.name || requirement.itemId}: {Math.min(count, requirement.quantity)}/{requirement.quantity}
                </div>;
              })}
            </div>}
            {!status && (canAcceptQuest(player, quest)
              ? <button onClick={() => onAcceptQuest(quest.id)} style={{ marginTop: '4px', padding: '4px 7px', cursor: 'pointer' }}>接取任務</button>
              : <div style={{ marginTop: '4px', color: '#888' }}>需在 {getMapById(quest.mapId)?.name ?? quest.mapId} 找到 {quest.questGiver}</div>)}
          </div>;
        })}
      </div>
    </aside>
  );
};
