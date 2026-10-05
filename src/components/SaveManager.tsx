import { useRef, useState, type ChangeEvent } from 'react';
import type { SaveSlotId } from '../types/game';
import { getMapById } from '../data/staticData';
import { formatGameTime } from '../utils/gameTime';
import { AUTO_SLOT_ID, getStorageUsage, listSlotSummaries, loadSaveIndex, MANUAL_SLOT_IDS, STORAGE_WARNING_RATIO, type SlotSummary } from '../utils/saveStorage';

interface SaveManagerProps {
  activeWorldId?: string;
  /** AI 回合進行中時禁止存讀檔，避免回應套用到錯誤的狀態。 */
  busy: boolean;
  onSaveManual: (slotId: SaveSlotId) => string;
  onLoad: (worldId: string, slotId: SaveSlotId) => string;
  onDeleteSlot: (worldId: string, slotId: SaveSlotId) => string;
  onDeleteWorld: (worldId: string) => string;
  onExport: (worldId: string) => string;
  onImport: (text: string) => string;
  onNewWorld: () => void;
  onClose: () => void;
}

const slotLabels: Record<SaveSlotId, string> = { auto: '自動存檔', 'manual-1': '手動存檔 1', 'manual-2': '手動存檔 2', 'manual-3': '手動存檔 3' };

const describeSlot = (summary: SlotSummary | null) => summary
  ? `${summary.characterName} Lv.${summary.level}${summary.isDead ? '（已死亡）' : ''} · ${getMapById(summary.mapId)?.name ?? summary.mapId} · ${formatGameTime(summary.gameTimeMinutes)} · 存於 ${new Date(summary.savedAt).toLocaleString()}`
  : '空';

const buttonStyle = { padding: '4px 8px', marginLeft: '4px', background: '#333', color: '#eee', border: '1px solid #555', borderRadius: '4px', cursor: 'pointer' } as const;

export function SaveManager({ activeWorldId, busy, onSaveManual, onLoad, onDeleteSlot, onDeleteWorld, onExport, onImport, onNewWorld, onClose }: SaveManagerProps) {
  const [status, setStatus] = useState('');
  // 每次操作後遞增，觸發重新讀取索引、欄位摘要與用量。
  const [, setRevision] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const run = (action: () => string) => {
    setStatus(action());
    setRevision((value) => value + 1);
  };

  const index = loadSaveIndex();
  const activeWorld = index.worlds.find((world) => world.id === activeWorldId);
  const otherWorlds = index.worlds.filter((world) => world.id !== activeWorldId).sort((a, b) => b.updatedAt - a.updatedAt);
  const activeSlots = activeWorld ? listSlotSummaries(activeWorld.id) : undefined;
  const usage = getStorageUsage();

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    file.text().then((text) => run(() => onImport(text))).catch(() => setStatus('無法讀取檔案。'));
  };

  return <div role="dialog" aria-modal="true" aria-labelledby="save-manager-title" style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', background: '#000b', padding: '16px' }}>
    <div style={{ width: 'min(640px, 100%)', maxHeight: '90vh', overflowY: 'auto', padding: '20px', background: '#242424', border: '1px solid #555', borderRadius: '8px', color: '#eee', fontSize: '13px' }}>
      <h3 id="save-manager-title" style={{ marginTop: 0 }}>💾 存檔管理</h3>
      {busy && <p style={{ color: '#ffcc80' }}>AI 回合進行中，請稍候再存讀檔。</p>}
      <p style={{ color: usage.ratio >= STORAGE_WARNING_RATIO ? '#ff8a80' : '#aaa', margin: '0 0 12px' }}>
        瀏覽器儲存用量：約 {(usage.usedBytes / 1024).toFixed(0)} KB / {(usage.limitBytes / 1024 / 1024).toFixed(0)} MB（{(usage.ratio * 100).toFixed(1)}%）
        {usage.ratio >= STORAGE_WARNING_RATIO && '。空間即將用完，請先匯出備份並刪除不需要的世界或存檔。'}
      </p>

      {activeWorld && activeSlots ? <section>
        <h4 style={{ margin: '0 0 6px' }}>目前世界：{activeWorld.name}</h4>
        <div style={{ color: '#aaa', marginBottom: '8px' }}>{slotLabels[AUTO_SLOT_ID]}（每次狀態變更後覆寫）：{describeSlot(activeSlots[AUTO_SLOT_ID])}</div>
        {MANUAL_SLOT_IDS.map((slotId) => <div key={slotId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', padding: '6px 0', borderTop: '1px solid #333' }}>
          <span><strong>{slotLabels[slotId]}</strong>：{describeSlot(activeSlots[slotId])}</span>
          <span style={{ whiteSpace: 'nowrap' }}>
            <button style={buttonStyle} disabled={busy} onClick={() => {
              if (!activeSlots[slotId] || window.confirm(`覆寫「${slotLabels[slotId]}」？`)) run(() => onSaveManual(slotId));
            }}>存到此欄</button>
            <button style={buttonStyle} disabled={busy || !activeSlots[slotId]} onClick={() => {
              if (window.confirm(`讀取「${slotLabels[slotId]}」？目前進度會被取代（每個世界只有一條時間線）。`)) run(() => onLoad(activeWorld.id, slotId));
            }}>讀取</button>
            <button style={buttonStyle} disabled={busy || !activeSlots[slotId]} onClick={() => {
              if (window.confirm(`刪除「${slotLabels[slotId]}」？`)) run(() => onDeleteSlot(activeWorld.id, slotId));
            }}>刪除</button>
          </span>
        </div>)}
        <div style={{ marginTop: '8px' }}>
          <button style={{ ...buttonStyle, marginLeft: 0 }} onClick={() => run(() => onExport(activeWorld.id))}>匯出此世界（JSON 備份）</button>
        </div>
      </section> : <p style={{ color: '#aaa' }}>目前沒有進行中的世界。</p>}

      <section style={{ marginTop: '16px' }}>
        <h4 style={{ margin: '0 0 6px' }}>其他世界</h4>
        {otherWorlds.length === 0 && <div style={{ color: '#888' }}>沒有其他世界。</div>}
        {otherWorlds.map((world) => <div key={world.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', padding: '6px 0', borderTop: '1px solid #333' }}>
          <span><strong>{world.name}</strong><br /><span style={{ color: '#aaa' }}>{describeSlot(listSlotSummaries(world.id)[AUTO_SLOT_ID])}</span></span>
          <span style={{ whiteSpace: 'nowrap' }}>
            <button style={buttonStyle} disabled={busy} onClick={() => run(() => onLoad(world.id, AUTO_SLOT_ID))}>切換</button>
            <button style={buttonStyle} onClick={() => run(() => onExport(world.id))}>匯出</button>
            <button style={buttonStyle} disabled={busy} onClick={() => {
              if (window.confirm(`永久刪除世界「${world.name}」及其所有存檔？建議先匯出備份。`)) run(() => onDeleteWorld(world.id));
            }}>刪除</button>
          </span>
        </div>)}
      </section>

      <section style={{ marginTop: '16px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <button style={{ ...buttonStyle, marginLeft: 0 }} disabled={busy} onClick={() => fileInput.current?.click()}>匯入世界檔案</button>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={handleFile} />
        <button style={{ ...buttonStyle, marginLeft: 0, background: '#2e5d32' }} disabled={busy} onClick={() => {
          if (window.confirm('建立新世界？目前世界會保留在「其他世界」中。')) onNewWorld();
        }}>建立新世界</button>
        {activeWorld && <button style={{ ...buttonStyle, marginLeft: 0, background: '#5d3030' }} disabled={busy} onClick={() => {
          if (window.confirm(`永久刪除目前世界「${activeWorld.name}」及其所有存檔，並建立新世界？建議先匯出備份。`)) run(() => onDeleteWorld(activeWorld.id));
        }}>刪除目前世界</button>}
        <button style={{ ...buttonStyle, marginLeft: 'auto' }} onClick={onClose}>關閉</button>
      </section>
      {status && <p role="status" style={{ marginBottom: 0, color: '#c5e1a5' }}>{status}</p>}
    </div>
  </div>;
}
