import React, { useState } from 'react';
import type { PlayerState } from '../types/game';
import { buildNoticeBoardOptions, buildShopOptions, type SystemAction, type SystemOption, type SystemOptionGroupId, type SystemOptionSet } from '../utils/systemOptions';
import { getShopById } from '../data/staticData';

interface OptionBarProps {
  player: PlayerState;
  optionSet: SystemOptionSet;
  /** AI 回合進行中：全部停用。 */
  busy: boolean;
  /** 最新訊息的建議行動（AI 的 suggestedActions），排在系統選項之後。 */
  suggestions: string[];
  /** 最新訊息的候選目的地（移動意圖不明確時）。 */
  travelChoices: { mapId: string; name: string }[];
  onAction: (action: SystemAction) => void;
  onSuggestion: (text: string) => void;
  onTravel: (mapId: string) => void;
}

/** 展開中的面板：某個分組，或打開的商店／告示板。 */
type Panel = { kind: 'group'; id: SystemOptionGroupId } | { kind: 'shop'; shopId: string } | { kind: 'board' };

const rowStyle: React.CSSProperties = { display: 'flex', gap: '6px', overflowX: 'auto', flexWrap: 'nowrap', paddingBottom: '2px', scrollbarWidth: 'thin' };
const chip = (variant: 'system' | 'group' | 'open' | 'suggestion' | 'combat', disabled: boolean): React.CSSProperties => ({
  flex: '0 0 auto', whiteSpace: 'nowrap', padding: '6px 10px', borderRadius: '14px', fontSize: '13px',
  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
  ...(variant === 'system' ? { background: '#2f3d2f', color: '#dcedc8', border: '1px solid #557a45' }
    : variant === 'group' ? { background: '#2a2a2a', color: '#e0e0e0', border: '1px solid #555' }
    : variant === 'open' ? { background: '#3a3a3a', color: '#fff', border: '1px solid #999' }
    : variant === 'combat' ? { background: '#5a1f1f', color: '#ffdede', border: '1px solid #a44' }
    : { background: '#3e2723', color: '#ffcc80', border: '1px solid #8d6e63' })
});

/**
 * 選項列（O50 第一階段）：固定在輸入框上方、不隨訊息捲動。
 * 收合時最多兩行（系統選項一行、建議行動一行，各自橫向捲動）；點分組才展開該組。
 */
export const OptionBar: React.FC<OptionBarProps> = ({ player, optionSet, busy, suggestions, travelChoices, onAction, onSuggestion, onTravel }) => {
  const [panel, setPanel] = useState<Panel | null>(null);
  // 換地區或進出戰鬥時收合面板；面板內容每次依目前狀態重算。
  const panelKey = `${player.currentMapId}|${player.combat ? 'combat' : optionSet.mode}`;
  const [panelOwner, setPanelOwner] = useState(panelKey);
  if (panelOwner !== panelKey) {
    setPanelOwner(panelKey);
    setPanel(null);
  }

  const blocked = optionSet.mode === 'blocked';
  const combat = optionSet.mode === 'combat';
  const disabledAll = busy || blocked;

  const panelOptions: SystemOption[] = !panel ? []
    : panel.kind === 'group' ? optionSet.groups.find((group) => group.id === panel.id)?.options ?? []
    : panel.kind === 'shop' ? buildShopOptions(player, panel.shopId)
    : buildNoticeBoardOptions(player);
  const panelTitle = !panel ? '' : panel.kind === 'group' ? optionSet.groups.find((group) => group.id === panel.id)?.label ?? ''
    : panel.kind === 'shop' ? getShopById(panel.shopId)?.name ?? '' : '告示板';
  const panelOpen = !!panel && !combat && !blocked && (panel.kind !== 'group' || optionSet.groups.some((group) => group.id === panel.id));

  const choose = (option: SystemOption) => {
    if (disabledAll || option.disabledReason) return;
    if (option.action.kind === 'openShop') { setPanel({ kind: 'shop', shopId: option.action.shopId }); return; }
    if (option.action.kind === 'noticeBoard') { setPanel({ kind: 'board' }); return; }
    // 商店內連續買賣時保持展開；其他動作執行後收合。
    if (panel?.kind !== 'shop') setPanel(null);
    onAction(option.action);
  };

  const renderOption = (option: SystemOption, variant: 'system' | 'combat' = 'system') => {
    const disabled = disabledAll || !!option.disabledReason;
    return <button key={option.id} type="button" data-option-id={option.id} disabled={disabled}
      title={option.disabledReason ?? option.title} onClick={() => choose(option)} style={chip(variant, disabled)}>
      {option.label}{option.disabledReason ? `（${option.disabledReason}）` : ''}
    </button>;
  };

  return (
    <section aria-label="行動選項" data-testid="option-bar" style={{ flex: '0 0 auto', padding: '8px 12px', backgroundColor: '#1f1f1f', borderTop: '1px solid #333', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {panelOpen && <div data-testid="option-panel" style={{ maxHeight: '38vh', overflowY: 'auto', padding: '8px', background: '#262626', border: '1px solid #444', borderRadius: '6px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px', fontSize: '13px', color: '#bbb' }}>
          <span>{panel.kind === 'group' ? `${panelTitle} ▾` : panelTitle}</span>
          <span style={{ display: 'flex', gap: '6px' }}>
            {panel.kind !== 'group' && <button type="button" onClick={() => setPanel({ kind: 'group', id: 'facilities' })} style={chip('group', false)}>← 設施</button>}
            <button type="button" aria-label="收合選項" onClick={() => setPanel(null)} style={chip('group', false)}>✕</button>
          </span>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {panelOptions.map((option) => renderOption(option))}
          {!panelOptions.length && <span style={{ color: '#888', fontSize: '12px' }}>{panel.kind === 'board' ? '告示板上沒有可接取的委託。' : '目前沒有可用的選項。'}</span>}
        </div>
      </div>}

      <div style={rowStyle} data-testid="option-row-system">
        {blocked && <span style={{ color: '#888', fontSize: '13px', alignSelf: 'center', whiteSpace: 'nowrap' }}>{player.isDead ? '角色已死亡，無法行動。' : '目前無法行動。'}</span>}
        {optionSet.immediate.map((option) => renderOption(option, combat ? 'combat' : 'system'))}
        {travelChoices.map((destination) => <button key={`choice-${destination.mapId}`} type="button" disabled={disabledAll || combat}
          onClick={() => onTravel(destination.mapId)} style={chip('system', disabledAll || combat)}>前往 {destination.name}</button>)}
        {optionSet.groups.map((group) => {
          const open = panelOpen && panel?.kind === 'group' && panel.id === group.id;
          return <button key={group.id} type="button" data-group-id={group.id} aria-expanded={open} disabled={disabledAll}
            onClick={() => setPanel(open ? null : { kind: 'group', id: group.id })} style={chip(open ? 'open' : 'group', disabledAll)}>
            {group.label} {open ? '▾' : '▸'}
          </button>;
        })}
      </div>

      {suggestions.length > 0 && !combat && <div style={rowStyle} data-testid="option-row-suggestions">
        {suggestions.map((text, index) => <button key={`${index}-${text}`} type="button" disabled={disabledAll}
          onClick={() => onSuggestion(text)} style={chip('suggestion', disabledAll)}>{text}</button>)}
      </div>}
    </section>
  );
};
