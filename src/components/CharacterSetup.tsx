import { useState, type FormEvent } from 'react';
import type { CharacterAlignment } from '../types/game';
import { getPlayerBaseStats, getSpeciesById, getItemById, getUnitAbilities, playerSelectableClasses, scenario } from '../data/staticData';

const alignments: CharacterAlignment[] = [
  '守序善良', '中立善良', '混亂善良', '守序中立', '絕對中立', '混亂中立', '守序邪惡', '中立邪惡', '混亂邪惡'
];

interface CharacterSetupProps {
  onCreate: (name: string, classId: string, alignment: CharacterAlignment, relatedToPrevious: boolean) => void;
  /** 在同一世界接續新角色且劇本允許關聯時提供：勾選後部分繼承前角色的勢力聲望。 */
  relatedOptionLabel?: string;
  /** 提供時顯示「取消」（在同一世界接續新角色時可返回）。 */
  onCancel?: () => void;
}

export function CharacterSetup({ onCreate, onCancel, relatedOptionLabel }: CharacterSetupProps) {
  const [relatedToPrevious, setRelatedToPrevious] = useState(false);
  const [name, setName] = useState(scenario.defaultPlayer.name);
  const [classId, setClassId] = useState(scenario.defaultPlayer.classId);
  const [alignment, setAlignment] = useState<CharacterAlignment>(scenario.defaultPlayer.alignment);
  const selectableClasses = playerSelectableClasses();
  const characterClass = selectableClasses.find((entry) => entry.id === classId) ?? selectableClasses[0];
  const build = { speciesId: scenario.defaultPlayer.speciesId, classId: characterClass.id, level: 1 };
  const abilities = getUnitAbilities(build);
  const stats = getPlayerBaseStats(build);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name.trim()) onCreate(name.trim(), characterClass.id, alignment, !!relatedOptionLabel && relatedToPrevious);
  };

  return <div role="dialog" aria-modal="true" aria-labelledby="character-setup-title" style={{ position: 'fixed', inset: 0, zIndex: 20, display: 'grid', placeItems: 'center', background: '#000c', padding: '20px' }}>
    <form onSubmit={submit} style={{ width: 'min(560px, 100%)', maxHeight: '90vh', overflowY: 'auto', padding: '24px', background: '#242424', border: '1px solid #666', borderRadius: '10px', color: '#eee', boxShadow: '0 12px 48px #0009' }}>
      <h2 id="character-setup-title" style={{ marginTop: 0 }}>建立冒險角色</h2>
      <label style={{ display: 'block', marginBottom: '14px' }}>角色名稱
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={24} required style={{ display: 'block', boxSizing: 'border-box', width: '100%', marginTop: '5px', padding: '9px', background: '#151515', color: '#fff', border: '1px solid #555', borderRadius: '4px' }} />
      </label>
      <label style={{ display: 'block', marginBottom: '14px' }}>職業
        <select value={classId} onChange={(event) => setClassId(event.target.value)} style={{ display: 'block', width: '100%', marginTop: '5px', padding: '9px', background: '#151515', color: '#fff', border: '1px solid #555', borderRadius: '4px' }}>
          {selectableClasses.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </label>
      <label style={{ display: 'block', marginBottom: '14px' }}>陣營傾向
        <select value={alignment} onChange={(event) => setAlignment(event.target.value as CharacterAlignment)} style={{ display: 'block', width: '100%', marginTop: '5px', padding: '9px', background: '#151515', color: '#fff', border: '1px solid #555', borderRadius: '4px' }}>
          {alignments.map((entry) => <option key={entry}>{entry}</option>)}
        </select>
      </label>
      {relatedOptionLabel && <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '14px', color: '#ddd' }}>
        <input type="checkbox" checked={relatedToPrevious} onChange={(event) => setRelatedToPrevious(event.target.checked)} style={{ marginTop: '3px' }} />
        <span>{relatedOptionLabel}<span style={{ display: 'block', color: '#999', fontSize: '12px' }}>不勾選時，各勢力對新角色的聲望從初始值開始。</span></span>
      </label>}
      <p style={{ color: '#bbb' }}>{characterClass.description}</p>
      <h3>能力值</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', fontSize: '13px' }}>
        {Object.entries(abilities ?? {}).map(([stat, value]) => <div key={stat} style={{ padding: '7px', background: '#333', borderRadius: '4px' }}>{stat.toUpperCase()} {value}</div>)}
      </div>
      <p>種族：{getSpeciesById(build.speciesId)?.name ?? build.speciesId}（由劇本設定）<br />Lv.1 數值：HP {stats.hp} · MP {stats.mp} · ATK {stats.atk} · DEF {stats.def} · SPD {stats.spd}</p>
      <h3>初始持有物</h3>
      <div style={{ fontSize: '13px', color: '#ccc' }}>{(characterClass.startingItems ?? []).map((item) => `${getItemById(item.itemId)?.name ?? item.itemId} ×${item.quantity}`).join('、') || '無'}</div>
      <button type="submit" style={{ width: '100%', marginTop: '20px', padding: '11px', background: '#2e7d32', color: 'white', border: 0, borderRadius: '5px', cursor: 'pointer' }}>開始冒險</button>
      {onCancel && <button type="button" onClick={onCancel} style={{ width: '100%', marginTop: '8px', padding: '9px', background: '#333', color: '#eee', border: '1px solid #555', borderRadius: '5px', cursor: 'pointer' }}>取消</button>}
    </form>
  </div>;
}
