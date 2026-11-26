import React from 'react';
import { AIContextDebugPanel } from './AIContextDebugPanel';
import type { PlayerState } from '../types/game';
import { canPlayerEnterMap, factionData, factionsDatabase, getCharacterClassById, getFactionById, getFactionRelation, getFactionReputation, getItemById, getMapById, describeUnitBuild, getLevelBenchmark, getReputationTier, getSpeciesById, getPlayerResourceCaps, getQuestById, getShopForUnit, getStoryActById, getStoryletById, getUnlockedSkills, getWorldUnitById, getWorldUnitDisposition, getWorldUnitsAtMap, partyRules } from '../data/staticData';
import { getPlayerStatBreakdown, STAT_LABELS } from '../utils/gameChecks';
import { canAcceptQuest, canTurnInQuest, getQuestGiverName, isGeneratedQuest, listVisibleQuests } from '../utils/questRules';
import { canPlayerAct, isPlayerUnconscious } from '../utils/playerStatus';
import { getCombatTarget, getCurrentActorKey, getEnemyParticipants } from '../utils/combatState';
import { getCompanionResources, getPartyMembers } from '../utils/party';
import { OPENING_LABELS } from '../utils/combatResolution';
import { formatGameTime } from '../utils/gameTime';
import { describeStoryletGiver, getActDeadline, getEndingEpilogue, resolveStoryletGiver } from '../utils/storylets';
import { getPlayerKnownEvents } from '../utils/worldEvents';

const RELATION_LABELS = { war: '交戰', hostile: '敵對', tense: '緊張', neutral: '中立', friendly: '友好', alliance: '同盟' } as const;

interface PlayerHUDProps {
  player: PlayerState;
  onOpenSaveManager: () => void;
  /** 角色死亡後在同一世界建立新角色；沒有進行中的世界時不提供。 */
  /** 以新角色接續目前世界；死亡改為讀檔制後暫不提供入口，保留給 O42。 */
  onContinueWithNewCharacter?: () => void;
  storageWarning: boolean;
  /** AI 回合進行中（例如開戰敘事）：停用背包按鈕，避免動作順序顛倒。 */
  busy?: boolean;
  /** HUD 只保留背包的使用與裝備；其他動作都在選項列（O50）。 */
  onUseItem: (itemId: string) => void;
  onEquipItem: (itemId: string) => void;
}

export const PlayerHUD: React.FC<PlayerHUDProps> = ({ player, onOpenSaveManager, onContinueWithNewCharacter, storageWarning, busy = false, onUseItem, onEquipItem }) => {
  const growth = getLevelBenchmark(player.level);
  // 世界紀錄只列玩家角色知道的事件（O34 第 2 階段）。
  const knownEvents = getPlayerKnownEvents(player);
  const { maxHp, maxMp } = getPlayerResourceCaps(player);
  const maxExp = growth?.requiredExp || 100;
  const unlockedSkills = getUnlockedSkills(player.classId, player.level);

  const currentMap = getMapById(player.currentMapId);
  // 隊伍同伴另列在「隊伍」區（O35-1）。
  const presentResidents = getWorldUnitsAtMap(player.currentMapId, player).filter((unit) => !unit.requiresEncounter && !player.party.includes(unit.id));
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
      {import.meta.env.DEV && <AIContextDebugPanel />}

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
                {staticItem?.type === 'consumable' && <button onClick={() => onUseItem(item.itemId)} disabled={busy || !canPlayerAct(player) || (!!player.combat && !staticItem.usableInCombat)} style={{ marginLeft: '6px', padding: '2px 5px', cursor: busy || !canPlayerAct(player) || (!!player.combat && !staticItem.usableInCombat) ? 'not-allowed' : 'pointer' }}>使用</button>}
                {staticItem && ['weapon', 'armor', 'accessory'].includes(staticItem.type) && <button onClick={() => onEquipItem(item.itemId)} disabled={busy || !canPlayerAct(player) || !!player.combat} style={{ marginLeft: '6px', padding: '2px 5px' }}>裝備</button>}
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
          const requirement = destination.requiredQuestId ? getQuestById(destination.requiredQuestId) : undefined;
          return <div key={mapId} style={{ margin: '3px 0', fontSize: '12px', color: locked ? '#888' : '#dcedc8' }}>{destination.name}{locked ? `（需接取${requirement?.title ?? '前置任務'}）` : ''}</div>;
        })}
      </div>

      <div data-testid="party-panel">
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>🛡️ 隊伍（{player.party.length}/{partyRules.maxCompanions}）</h4>
        {getPartyMembers(player).map((unit) => {
          const resources = getCompanionResources(player, unit);
          const statuses = player.unitInstances[unit.id]?.statusEffects ?? [];
          return <div key={unit.id} style={{ marginBottom: '7px', fontSize: '12px' }}>
            <strong>{unit.name}{unit.title ? `・${unit.title}` : ''}</strong>
            <div style={{ color: '#aaa' }}>{describeUnitBuild(unit)} · HP {resources.hp}/{resources.maxHp} · MP {resources.mp}/{resources.maxMp}{resources.downed ? ' · 倒地' : ''}{statuses.map((effect) => effect.id === 'unconscious' ? ' · 💫 昏迷' : ' · 嘲諷中').join('')}</div>
          </div>;
        })}
        {!player.party.length && <div style={{ color: '#888', fontSize: '12px' }}>目前沒有同伴。條件成立時，可從選項列的「人物」邀請同行。</div>}
      </div>

      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>🧑‍🤝‍🧑 當前地區人物</h4>
        {presentResidents.map((unit) => {
          const stats = unit.stats;
          const disposition = getWorldUnitDisposition(player, unit.id);
          const unitState = player.unitInstances[unit.id];
          const dispositionLabel = disposition === 'friendly' ? '友善' : disposition === 'hostile' ? '敵對' : '中立';
          return <div key={unit.id} style={{ marginBottom: '7px', fontSize: '12px' }}>
            <strong>{unit.name}{unit.title ? `・${unit.title}` : ''}</strong>{unit.factionId && <span style={{ color: '#9fa8da', marginLeft: '6px' }}>［{getFactionById(unit.factionId)?.name ?? unit.factionId}］</span>}
            <div style={{ color: '#aaa' }}>{describeUnitBuild(unit)} · 關係：{dispositionLabel} · HP {unitState?.currentHp ?? stats.hp}/{stats.hp} · ATK {stats.atk} · DEF {stats.def} · SPD {stats.spd}{unitState?.isDead ? ' · 已死亡' : ''}</div>
            {!unitState?.isDead && <div style={{ color: '#888' }}>持有：金幣 {unitState?.gold ?? 0} · {(unitState?.inventory ?? []).map((entry) => `${getItemById(entry.itemId)?.name ?? entry.itemId} ×${entry.quantity}`).join('、') || '無物品'}</div>}
            {(() => {
              const shop = getShopForUnit(unit.source);
              return shop && !unitState?.isDead ? <div style={{ color: '#bfa76a' }}>🪙 經營：{shop.name}（可從選項列的「設施」打開）</div> : null;
            })()}
          </div>;
        })}
        {!presentResidents.length && <div style={{ color: '#888', fontSize: '12px' }}>目前沒有在場人物。</div>}
      </div>

      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>👹 遭遇</h4>
        {player.combat ? (() => {
          // 戰鬥區（O35-1）：雙方 HP、行動順序與目前行動者；鎖定的目標以 🎯 標示。
          const combat = player.combat;
          const target = getCombatTarget(combat);
          const currentKey = getCurrentActorKey(combat);
          const nameOf = (key: string) => {
            const participant = combat.participants.find((entry) => entry.key === key);
            return participant?.side === 'enemy' ? participant.label : key === player.unitId ? player.name : getWorldUnitById(key, player)?.name ?? key;
          };
          const isDown = (key: string) => {
            const participant = combat.participants.find((entry) => entry.key === key);
            if (participant?.side === 'enemy') return participant.currentHp <= 0;
            return key !== player.unitId && player.unitInstances[key]?.downed === true;
          };
          return <div data-testid="combat-panel">
            <div style={{ color: '#aaa', fontSize: '11px', marginBottom: '6px' }}>第 {combat.round} 回合・{OPENING_LABELS[combat.opening]}</div>
            <div style={{ fontSize: '12px', marginBottom: '6px' }}>
              <div style={{ color: '#ef9a9a', marginBottom: '2px' }}>敵方</div>
              {getEnemyParticipants(combat).map((enemy) => {
                const unit = getWorldUnitById(enemy.unitId, player);
                return <div key={enemy.key} style={{ color: enemy.currentHp <= 0 ? '#777' : '#eee', textDecoration: enemy.currentHp <= 0 ? 'line-through' : undefined }}>
                  {target?.key === enemy.key ? '🎯 ' : ''}{enemy.label} HP {enemy.currentHp}/{unit?.stats.hp ?? '?'}{enemy.currentHp <= 0 ? '（倒下）' : ''}
                </div>;
              })}
            </div>
            <div style={{ fontSize: '12px', marginBottom: '6px' }}>
              <div style={{ color: '#a5d6a7', marginBottom: '2px' }}>我方</div>
              <div>{player.name} HP {player.hp}/{maxHp}{isPlayerUnconscious(player) ? '・💫 昏迷' : ''}</div>
              {getPartyMembers(player).map((unit) => {
                const resources = getCompanionResources(player, unit);
                return <div key={unit.id} style={{ color: resources.downed ? '#777' : '#eee' }}>{unit.name} HP {resources.hp}/{resources.maxHp}{resources.downed ? '（倒地）' : ''}</div>;
              })}
            </div>
            <div style={{ fontSize: '11px', color: '#bbb', marginBottom: '6px' }} data-testid="turn-order">
              行動順序：{combat.turnOrder.map((key, index) => <span key={key} style={{ color: key === currentKey ? '#ffcc80' : isDown(key) ? '#666' : '#bbb', fontWeight: key === currentKey ? 'bold' : undefined }}>
                {index > 0 ? ' → ' : ''}{key === currentKey ? '▶' : ''}{nameOf(key)}
              </span>)}
            </div>
            <div style={{ color: '#ffcc80', fontSize: '11px' }}>{isPlayerUnconscious(player) ? '💫 昏迷中，' : ''}戰鬥動作在選項列：攻擊、技能、逃跑；「目標」切換鎖定（不耗回合）。</div>
          </div>;
        })() : (() => {
          const unit = player.encounteredUnitId ? getWorldUnitById(player.encounteredUnitId, player) : undefined;
          // O45：玩家先發現的敵對居民也是遭遇對象。
          const encountered = unit?.requiresEncounter || player.encounterInfo?.playerSpottedFirst ? unit : undefined;
          const disposition = encountered ? getWorldUnitDisposition(player, encountered.id) : undefined;
          const dispositionLabel = disposition === 'friendly' ? '友善' : disposition === 'hostile' ? '敵對' : '中立';
          return encountered && currentMap?.unitsPresent.includes(encountered.id)
            ? <div>
              <div style={{ color: '#ffcc80', fontSize: '12px', marginBottom: '5px' }}>已遭遇：{encountered.name}（{dispositionLabel}）{player.encounterInfo?.playerSpottedFirst ? '・你先發現對方' : ''}</div>
            </div>
            : <div style={{ color: '#aaa', fontSize: '12px' }}>{currentMap?.isSafeZone ? '安全地區沒有敵人。' : '尚未遭遇敵人；探索或搜索周遭以觸發遭遇。'}</div>;
        })()}
      </div>

      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>✨ 技能</h4>
        {unlockedSkills.map((skill) => <div key={skill.id} style={{ fontSize: '12px', marginBottom: '4px' }}>
          <strong>{skill.name}</strong> <span style={{ color: '#aaa' }}>MP {skill.costMp}・{skill.effect.kind === 'healing' ? '戰鬥外' : '戰鬥中'}</span>
          <div style={{ color: '#888', fontSize: '11px' }}>{skill.description}</div>
        </div>)}
        {!unlockedSkills.length && <div style={{ color: '#888', fontSize: '12px' }}>尚未習得主動技能。</div>}
      </div>

      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>📖 主線</h4>
        <div style={{ fontSize: '12px', color: '#ccc', marginBottom: '6px' }}>{getStoryActById(player.world.story.currentActId)?.title ?? player.world.story.currentActId}</div>
        {(() => {
          const reached = getEndingEpilogue(player);
          if (reached) return <div style={{ fontSize: '12px', color: '#d8ccff', marginBottom: '6px' }}>🏁 已達成結局：{reached.ending.title}{reached.ending.afterEnding === 'end' ? '（時間線已結束）' : '（主線已結束，世界繼續運作）'}</div>;
          const deadline = getActDeadline(player);
          return deadline && <div style={{ fontSize: '12px', color: '#ffcc80', marginBottom: '6px' }}>⏳ 期限：{formatGameTime(deadline.dueAtMinutes)} 之前</div>;
        })()}
        {player.world.story.activeStorylets.length === 0 && !player.world.story.ending && <div style={{ fontSize: '12px', color: '#888' }}>目前沒有進行中的劇情</div>}
        {player.world.story.activeStorylets.map((entry) => {
          const storylet = getStoryletById(entry.id);
          if (!storylet) return null;
          const giver = resolveStoryletGiver(player, storylet);
          const handedOver = entry.giverUnitId && giver?.kind === 'unit' && giver.unitId !== entry.giverUnitId;
          return <div key={entry.id} style={{ marginBottom: '8px', fontSize: '12px' }}>
            <strong>{storylet.title}</strong>
            <div>{storylet.goal.summary}</div>
            <div style={{ color: handedOver ? '#ffcc80' : '#aaa' }}>{handedOver ? `原給予者已不在，改由 ${describeStoryletGiver(giver)} 接手` : `給予者：${describeStoryletGiver(giver)}`}</div>
          </div>;
        })}
      </div>

      <div>
        <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid #444' }}>📜 任務</h4>
        {listVisibleQuests(player).map((quest) => {
          const active = player.activeQuests.find((entry) => entry.questId === quest.id);
          const status = active?.status;
          const generated = isGeneratedQuest(quest) ? quest : undefined;
          const failedLabel = generated?.status === 'expired' ? '已失敗（委託已逾期）' : '已失敗（委託人已死亡）';
          const inventoryCount = (itemId: string) => player.inventory.find((item) => item.itemId === itemId)?.quantity ?? 0;
          return <div key={quest.id} style={{ marginBottom: '8px', fontSize: '12px' }}>
            <strong>{quest.title}</strong>{generated && <span style={{ color: '#9fa8da', marginLeft: '6px' }}>［支線委託・{generated.questGiver}］</span>}
            <div style={status === 'failed' ? { color: '#ef9a9a' } : undefined}>{status === 'completed' ? '已完成' : status === 'in_progress' ? '進行中' : status === 'failed' ? failedLabel : quest.objective}</div>
            {generated && status !== 'completed' && status !== 'failed' && <div style={{ color: '#aaa' }}>
              報酬：{generated.rewards.exp} EXP · {generated.rewards.gold} 金幣{(generated.rewards.items ?? []).map((item) => ` · ${getItemById(item.itemId)?.name ?? item.itemId} ×${item.quantity}`).join('')}（委託人已預先保留）· 期限 {formatGameTime(generated.expiresAtMinutes)}
            </div>}
            {status === 'in_progress' && active?.giverUnitId && <div style={{ color: '#ffcc80' }}>原委託人已身亡，改由 {getQuestGiverName(player, quest)} 接手</div>}
            {status && <div style={{ marginTop: '4px', color: '#bbb' }}>
              {(quest.requirements.defeatUnits ?? []).map((requirement) => {
                const count = active?.progress?.defeatedUnits[requirement.unitId] ?? 0;
                const name = getWorldUnitById(requirement.unitId)?.name ?? requirement.unitId;
                return <div key={requirement.unitId}>擊敗 {name}: {Math.min(count, requirement.quantity)}/{requirement.quantity}</div>;
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
              ? <div style={{ marginTop: '4px', color: '#a5d6a7' }}>可接取（選項列「任務」）</div>
              : player.unitInstances[quest.questGiverId]?.isDead
                ? <div style={{ marginTop: '4px', color: '#888' }}>委託人已死亡，無法接取</div>
              : getWorldUnitDisposition(player, quest.questGiverId) === 'hostile'
                ? <div style={{ marginTop: '4px', color: '#ef9a9a' }}>任務給予者目前敵對，無法接取</div>
                : <div style={{ marginTop: '4px', color: '#888' }}>需在 {getMapById(quest.mapId)?.name ?? quest.mapId} 找到 {quest.questGiver}</div>)}
            {status === 'in_progress' && canTurnInQuest(player, quest) && <div style={{ marginTop: '4px', color: '#a5d6a7' }}>可向 {getQuestGiverName(player, quest)} 交付（選項列）</div>}
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
        <summary style={{ cursor: 'pointer', fontWeight: 'bold' }}>🌍 世界紀錄（{knownEvents.length} 件）</summary>
        {knownEvents.length === 0 && <div style={{ color: '#888', fontSize: '12px', marginTop: '4px' }}>你還沒有聽說這個世界發生的重大事件。</div>}
        {knownEvents.slice(-8).reverse().map((event) => <div key={event.id} style={{ color: '#bbb', fontSize: '12px', marginTop: '6px' }}>
          <div style={{ color: '#888' }}>{formatGameTime(event.gameTimeMinutes)} · {getMapById(event.mapId)?.name ?? event.mapId}</div>
          {event.summary}
        </div>)}
        {player.world.modifiers.length > 0 && <div style={{ color: '#888', fontSize: '11px', marginTop: '8px' }}>生效中的世界修正：{player.world.modifiers.length} 項</div>}
      </details>
    </aside>
  );
};
