import React from 'react';
import type { PlayerState } from '../types/game';
import { canPlayerEnterMap, factionData, factionsDatabase, getCharacterClassById, getFactionById, getFactionRelation, getFactionReputation, getItemById, getMapById, describeUnitBuild, getLevelBenchmark, getReputationTier, getSpeciesById, getPlayerResourceCaps, getQuestById, getShopForNpc, getUnlockedSkills, getWorldUnitById, getWorldUnitDisposition, getWorldUnitsAtMap, questsDatabase } from '../data/staticData';
import { getPlayerStatBreakdown, STAT_LABELS } from '../utils/gameChecks';
import { canAcceptQuest, canTurnInQuest, getQuestGiverName } from '../utils/questRules';
import { canPlayerAct, isPlayerUnconscious } from '../utils/playerStatus';
import { getCombatTarget } from '../utils/combatState';
import { formatGameTime } from '../utils/gameTime';

const RELATION_LABELS = { war: '交戰', hostile: '敵對', tense: '緊張', neutral: '中立', friendly: '友好', alliance: '同盟' } as const;

interface PlayerHUDProps {
  player: PlayerState;
  onOpenSaveManager: () => void;
  /** 角色死亡後在同一世界建立新角色；沒有進行中的世界時不提供。 */
  onContinueWithNewCharacter?: () => void;
  storageWarning: boolean;
  onTravel: (mapId: string) => void;
  onAcceptQuest: (questId: string) => void;
  onStartCombat: (unitId: string) => void;
  onFleeCombat: () => void;
  onAttack: () => void;
  onUseSkill: (skillId: string) => void;
  onUseItem: (itemId: string) => void;
  onBuyItem: (shopId: string, itemId: string) => void;
  onSellItem: (shopId: string, itemId: string) => void;
  onEquipItem: (itemId: string) => void;
  onUseService: (shopId: string, serviceId: string) => void;
  onTurnInQuest: (questId: string) => void;
}

export const PlayerHUD: React.FC<PlayerHUDProps> = ({ player, onOpenSaveManager, onContinueWithNewCharacter, storageWarning, onTravel, onAcceptQuest, onStartCombat, onFleeCombat, onAttack, onUseSkill, onUseItem, onBuyItem, onSellItem, onEquipItem, onUseService, onTurnInQuest }) => {
  const growth = getLevelBenchmark(player.level);
  const { maxHp, maxMp } = getPlayerResourceCaps(player);
  const maxExp = growth?.requiredExp || 100;
  const unlockedSkills = getUnlockedSkills(player.classId, player.level);

  const currentMap = getMapById(player.currentMapId);
  const presentNpcs = getWorldUnitsAtMap(player.currentMapId, player).filter((unit) => unit.kind === 'npc');
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
        <p style={{ margin: '4px 0' }}><strong>🕰️ 時間:</strong> {formatGameTime(player.gameTimeMinutes)}</p>
        <p style={{ margin: '4px 0' }}><strong>姓名:</strong> {player.name}</p>
        <p style={{ margin: '4px 0' }}><strong>種族:</strong> {getSpeciesById(player.speciesId)?.name ?? player.speciesId}</p>
        <p style={{ margin: '4px 0' }}><strong>職業:</strong> {getCharacterClassById(player.classId)?.name ?? player.classId}</p>
        <p style={{ margin: '4px 0' }}><strong>傾向:</strong> {player.alignment}</p>
        {(player.isDead || isPlayerUnconscious(player)) && <p role="status" style={{ margin: '4px 0', color: '#ff8a80', fontWeight: 'bold' }}>{player.isDead ? '☠️ 已死亡' : '💫 昏迷中'}</p>}
        <p style={{ margin: '4px 0' }}><strong>等級:</strong> Lv.{player.level} ({player.exp}/{maxExp} EXP)</p>
        <p style={{ margin: '4px 0' }}><strong>💰 金幣:</strong> {player.gold} Gold</p>
        {player.transactionHistory.length > 0 && <details>
          <summary style={{ cursor: 'pointer', fontSize: '12px' }}>交易紀錄（最近 {Math.min(5, player.transactionHistory.length)} 筆）</summary>
          {player.transactionHistory.slice(0, 5).map((entry) => <div key={entry.id} style={{ color: '#bbb', fontSize: '11px', marginTop: '4px' }}>
            {new Date(entry.timestamp).toLocaleString()} · {entry.description}{entry.goldChange ? ` (${entry.goldChange > 0 ? '+' : ''}${entry.goldChange} 金幣)` : ''}
          </div>)}
        </details>}
        <p style={{ margin: '4px 0' }}><strong>📍 位置:</strong> {currentMap?.name || player.currentMapId}</p>
      </div>

      {storageWarning && <p role="status" style={{ color: '#ffb74d', margin: 0, fontSize: '12px' }}>瀏覽器儲存不可用或空間不足，變更可能無法保存；請開啟存檔管理匯出備份。</p>}
      {player.isDead && onContinueWithNewCharacter && <button onClick={onContinueWithNewCharacter} style={{ padding: '7px 10px', backgroundColor: '#2e5d32', color: '#fff', border: '1px solid #4a8', borderRadius: '4px', cursor: 'pointer' }}>
        以新角色接續這個世界
      </button>}
      <button onClick={onOpenSaveManager} style={{ padding: '7px 10px', backgroundColor: '#333', color: '#fff', border: '1px solid #666', borderRadius: '4px', cursor: 'pointer' }}>
        💾 存檔管理（存讀檔、匯出入、新世界）
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
              <span style={{ display: 'block', color: '#888', fontSize: '10px' }}>基礎 {ability.baseStat} · 裝備 {ability.equipmentBonus >= 0 ? '+' : ''}{ability.equipmentBonus}{ability.checkBonus ? ` · 檢定 ${ability.checkBonus > 0 ? '+' : ''}${ability.checkBonus}` : ''}</span>
            </span>
          </div>
        ))}
        <p style={{ color: '#888', fontSize: '11px', margin: '5px 0 0' }}>數值包含目前裝備加成；擲 d20 時使用修正值。</p>
      </div>

      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>🎲 冒險能力</h4>
        {(Object.entries(player.abilities) as [keyof PlayerState['abilities'], number][]).map(([stat, score]) => (
          <div key={stat} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: '12px' }}>
            <span>{STAT_LABELS[stat]}</span><span>{score}（修正 {Math.floor((score - 10) / 2) >= 0 ? '+' : ''}{Math.floor((score - 10) / 2)}）</span>
          </div>
        ))}
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
                {staticItem && ['weapon', 'armor', 'accessory'].includes(staticItem.type) && <button onClick={() => onEquipItem(item.itemId)} disabled={!canPlayerAct(player) || !!player.combat} style={{ marginLeft: '6px', padding: '2px 5px' }}>裝備</button>}
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
          const locked = !canPlayerEnterMap(player, destination);
          const disabled = !!player.combat || !canPlayerAct(player) || locked;
          const requirement = destination.requiredQuestId ? getQuestById(destination.requiredQuestId) : undefined;
          return <button key={mapId} disabled={disabled} title={locked ? `需先接取「${requirement?.title ?? destination.requiredQuestId}」` : undefined} onClick={() => onTravel(mapId)} style={{ display: 'block', margin: '4px 0', padding: '5px 8px', background: '#303c30', color: '#dcedc8', border: '1px solid #546e45', borderRadius: '4px', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}>前往 {destination.name}{locked ? `（需接取${requirement?.title ?? '前置任務'}）` : ''}</button>;
        })}
      </div>

      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>🧑‍🤝‍🧑 當前地區人物</h4>
        {presentNpcs.map((unit) => {
          const npc = unit.source;
          const stats = unit.stats;
          const disposition = getWorldUnitDisposition(player, unit.id);
          const npcState = player.unitInstances[npc.id];
          const dispositionLabel = disposition === 'friendly' ? '友善' : disposition === 'hostile' ? '敵對' : '中立';
          return <div key={npc.id} style={{ marginBottom: '7px', fontSize: '12px' }}>
            <strong>{npc.name}・{npc.title}</strong>{unit.factionId && <span style={{ color: '#9fa8da', marginLeft: '6px' }}>［{getFactionById(unit.factionId)?.name ?? unit.factionId}］</span>}
            <div style={{ color: '#aaa' }}>{describeUnitBuild(unit)} · 關係：{dispositionLabel} · HP {npcState?.currentHp ?? stats.hp}/{stats.hp} · ATK {stats.atk} · DEF {stats.def} · SPD {stats.spd}{npcState?.isDead ? ' · 已死亡' : ''}</div>
            {!npcState?.isDead && disposition === 'hostile' && <button onClick={() => onStartCombat(npc.id)} disabled={!canPlayerAct(player) || !!player.combat} style={{ margin: '4px 0', padding: '4px 7px' }}>挑戰 {npc.name}</button>}
            {!npcState?.isDead && <div style={{ color: '#888' }}>持有：金幣 {npcState?.gold ?? 0} · {(npcState?.inventory ?? []).map((entry) => `${getItemById(entry.itemId)?.name ?? entry.itemId} ×${entry.quantity}`).join('、') || '無物品'}</div>}
            {(() => {
              const shop = getShopForNpc(npc);
              if (!shop) return null;
              if (npcState?.isDead) return null;
              const unavailable = !canPlayerAct(player) || !!player.combat || disposition === 'hostile';
              return <div style={{ marginTop: '5px', padding: '6px', background: '#29251d', borderRadius: '4px' }}>
                <strong>🪙 {shop.name} · 金幣 {player.gold}</strong>
                {shop.items.map((listing) => {
                  const item = getItemById(listing.itemId);
                  if (!item) return null;
                  const price = listing.buyPrice ?? item.buyPrice;
                  const stock = player.unitInstances[npc.id]?.inventory.find((entry) => entry.itemId === item.id)?.quantity ?? 0;
                  return <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', marginTop: '4px' }}>
                    <span>{item.name} · {price} 金幣 · 庫存 {stock}</span>
                    <button disabled={unavailable || player.gold < price || stock <= 0} onClick={() => onBuyItem(shop.id, item.id)}>購買</button>
                  </div>;
                })}
                {(shop.services ?? []).map((service) => <div key={service.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', marginTop: '5px' }}>
                  <span title={service.description}>{service.name} · {service.price} 金幣</span>
                  <button disabled={unavailable || player.gold < service.price || (service.kind === 'restore_resources' && player.hp >= maxHp && player.mp >= maxMp)} onClick={() => onUseService(shop.id, service.id)}>使用</button>
                </div>)}
                {player.inventory.filter((entry) => {
                  const item = getItemById(entry.itemId);
                  return item && item.type !== 'quest' && item.sellPrice > 0;
                }).map((entry) => {
                  const item = getItemById(entry.itemId)!;
                  return <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', marginTop: '4px' }}>
                    <span>收購 {item.name} · {item.sellPrice} 金幣</span>
                    <button disabled={unavailable} onClick={() => onSellItem(shop.id, item.id)}>出售</button>
                  </div>;
                })}
              </div>;
            })()}
          </div>;
        })}
        {!presentNpcs.length && <div style={{ color: '#888', fontSize: '12px' }}>目前沒有在場人物。</div>}
      </div>

      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>👹 遭遇</h4>
        {player.combat ? (() => {
          const unit = getWorldUnitById(player.combat.targetUnitId, player);
          return <div>
            <div style={{ marginBottom: '6px' }}>{unit?.name || player.combat.targetUnitId} HP {getCombatTarget(player.combat)?.currentHp ?? 0}/{unit?.stats.hp}</div>
            <div style={{ color: '#aaa', fontSize: '11px', marginBottom: '8px' }}>第 {player.combat.round} 回合</div>
            <button onClick={onAttack} disabled={player.isDead} style={{ marginRight: '6px', padding: '6px 10px', background: '#8e2424', color: 'white', border: '1px solid #b44', borderRadius: '4px', cursor: player.isDead ? 'not-allowed' : 'pointer' }}>{isPlayerUnconscious(player) ? '昏迷中（跳過回合）' : '攻擊'}</button>
            {unlockedSkills.filter((skill) => skill.effect.kind === 'damage_multiplier').map((skill) => <button key={skill.id} onClick={() => onUseSkill(skill.id)} disabled={!canPlayerAct(player) || player.mp < skill.costMp} title={skill.description} style={{ marginRight: '6px', padding: '6px 10px', cursor: player.mp < skill.costMp || !canPlayerAct(player) ? 'not-allowed' : 'pointer' }}>{skill.name}（MP {skill.costMp}）</button>)}
            <button onClick={onFleeCombat} disabled={!canPlayerAct(player)} style={{ padding: '6px 10px', cursor: canPlayerAct(player) ? 'pointer' : 'not-allowed' }}>脫離戰鬥</button>
          </div>;
        })() : (() => {
          const unit = player.encounteredUnitId ? getWorldUnitById(player.encounteredUnitId, player) : undefined;
          const monster = unit?.kind === 'monster' ? unit : undefined;
          const disposition = monster ? getWorldUnitDisposition(player, monster.id) : undefined;
          const dispositionLabel = disposition === 'friendly' ? '友善' : disposition === 'hostile' ? '敵對' : '中立';
          return monster && currentMap?.monstersPresent.includes(monster.id)
            ? <div>
              <div style={{ color: '#ffcc80', fontSize: '12px', marginBottom: '5px' }}>已遭遇：{monster.name}（{dispositionLabel}）</div>
              {disposition === 'hostile' && <button onClick={() => onStartCombat(monster.id)} disabled={!canPlayerAct(player)} style={{ display: 'block', margin: '4px 0', padding: '5px 8px', background: '#4a2525', color: '#ffcdd2', border: '1px solid #844', borderRadius: '4px', cursor: canPlayerAct(player) ? 'pointer' : 'not-allowed' }}>挑戰 {monster.name}</button>}
            </div>
            : <div style={{ color: '#aaa', fontSize: '12px' }}>{currentMap?.isSafeZone ? '安全地區沒有敵人。' : '尚未遭遇敵人；探索或搜索周遭以觸發遭遇。'}</div>;
        })()}
        {!player.combat && unlockedSkills.filter((skill) => skill.effect.kind === 'healing').map((skill) => <button key={skill.id} onClick={() => onUseSkill(skill.id)} disabled={!canPlayerAct(player) || player.mp < skill.costMp || player.hp >= maxHp} title={skill.description} style={{ display: 'block', marginTop: '5px', padding: '6px 10px' }}>{skill.name}（MP {skill.costMp}）</button>)}
      </div>

      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>📜 任務</h4>
        {questsDatabase.map((quest) => {
          const active = player.activeQuests.find((entry) => entry.questId === quest.id);
          const status = active?.status;
          const inventoryCount = (itemId: string) => player.inventory.find((item) => item.itemId === itemId)?.quantity ?? 0;
          return <div key={quest.id} style={{ marginBottom: '8px', fontSize: '12px' }}>
            <strong>{quest.title}</strong>
            <div style={status === 'failed' ? { color: '#ef9a9a' } : undefined}>{status === 'completed' ? '已完成' : status === 'in_progress' ? '進行中' : status === 'failed' ? '已失敗（委託人已死亡）' : quest.objective}</div>
            {status === 'in_progress' && active?.giverUnitId && <div style={{ color: '#ffcc80' }}>原委託人已身亡，改由 {getQuestGiverName(player, quest)} 接手</div>}
            {status && <div style={{ marginTop: '4px', color: '#bbb' }}>
              {(quest.requirements.defeatMonsters ?? []).map((requirement) => {
                const count = active?.progress?.defeatedMonsters[requirement.monsterId] ?? 0;
                const unit = getWorldUnitById(requirement.monsterId);
                const name = unit?.kind === 'monster' ? unit.name : requirement.monsterId;
                return <div key={requirement.monsterId}>擊敗 {name}: {Math.min(count, requirement.quantity)}/{requirement.quantity}</div>;
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
              : player.unitInstances[quest.questGiverId]?.isDead
                ? <div style={{ marginTop: '4px', color: '#888' }}>委託人已死亡，無法接取</div>
              : getWorldUnitDisposition(player, quest.questGiverId) === 'hostile'
                ? <div style={{ marginTop: '4px', color: '#ef9a9a' }}>任務給予者目前敵對，無法接取</div>
                : <div style={{ marginTop: '4px', color: '#888' }}>需在 {getMapById(quest.mapId)?.name ?? quest.mapId} 找到 {quest.questGiver}</div>)}
            {status === 'in_progress' && canTurnInQuest(player, quest) && <button onClick={() => onTurnInQuest(quest.id)} style={{ marginTop: '4px', padding: '4px 7px' }}>向 {getQuestGiverName(player, quest)} 交付</button>}
          </div>;
        })}
      </div>

      <details>
        <summary style={{ cursor: 'pointer', fontWeight: 'bold' }}>🏳️ 勢力聲望</summary>
        <div style={{ color: '#888', fontSize: '11px', margin: '4px 0' }}>聲望只會因勢力得知的事件而改變；敵視時成員會敵對你。</div>
        {factionsDatabase.map((faction) => {
          const reputation = getFactionReputation(player, faction.id);
          const tier = getReputationTier(reputation);
          const changed = reputation !== faction.initialReputation;
          return <div key={faction.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12px', padding: '2px 0' }}>
            <span title={faction.summary}>{faction.name}</span>
            <span style={{ color: tier.disposition === 'hostile' ? '#ef9a9a' : tier.disposition === 'friendly' ? '#a5d6a7' : '#ccc' }}>
              {tier.name} {reputation}{changed ? <span style={{ color: '#888' }}>（初始 {faction.initialReputation}）</span> : null}
            </span>
          </div>;
        })}
        {(() => {
          // 勢力間關係：只列出非中立或有附加關係的組合。
          const pairs = factionsDatabase.flatMap((a, index) => factionsDatabase.slice(index + 1).map((b) => ({ a, b, relation: getFactionRelation(player.world, a.id, b.id) })))
            .filter(({ relation }) => relation.status !== 'neutral' || relation.tags.length);
          if (!pairs.length) return null;
          return <details style={{ marginTop: '6px' }}>
            <summary style={{ cursor: 'pointer', fontSize: '12px' }}>勢力間關係（{pairs.length}）</summary>
            {pairs.map(({ a, b, relation }) => <div key={`${a.id}|${b.id}`} style={{ color: '#bbb', fontSize: '11px', marginTop: '3px' }}>
              {a.name} ⇄ {b.name}：{RELATION_LABELS[relation.status]}{relation.tags.length ? `（${relation.tags.map((tag) => factionData.relationTags.find((entry) => entry.id === tag)?.name ?? tag).join('、')}）` : ''}
            </div>)}
          </details>;
        })()}
      </details>

      <details>
        <summary style={{ cursor: 'pointer', fontWeight: 'bold' }}>🌍 世界紀錄（{player.world.events.length} 件）</summary>
        {player.world.events.length === 0 && <div style={{ color: '#888', fontSize: '12px', marginTop: '4px' }}>這個世界還沒有發生重大事件。</div>}
        {player.world.events.slice(-8).reverse().map((event) => <div key={event.id} style={{ color: '#bbb', fontSize: '12px', marginTop: '6px' }}>
          <div style={{ color: '#888' }}>{formatGameTime(event.gameTimeMinutes)} · {getMapById(event.mapId)?.name ?? event.mapId}</div>
          {event.summary}
        </div>)}
        {player.world.modifiers.length > 0 && <div style={{ color: '#888', fontSize: '11px', marginTop: '8px' }}>生效中的世界修正：{player.world.modifiers.length} 項</div>}
      </details>
    </aside>
  );
};
