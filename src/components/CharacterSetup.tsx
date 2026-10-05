import { useState, type FormEvent } from 'react';
import type { CharacterAlignment } from '../types/game';
import { characterClassesDatabase, getItemById, scenario } from '../data/staticData';

const alignments: CharacterAlignment[] = [
  '守序善良', '中立善良', '混亂善良', '守序中立', '絕對中立', '混亂中立', '守序邪惡', '中立邪惡', '混亂邪惡'
];

interface CharacterSetupProps {
  onCreate: (name: string, classId: string, alignment: CharacterAlignment) => void;
}

export function CharacterSetup({ onCreate }: CharacterSetupProps) {
  const [name, setName] = useState(scenario.defaultPlayer.name);
  const [classId, setClassId] = useState(scenario.defaultPlayer.classId);
  const [alignment, setAlignment] = useState<CharacterAlignment>(scenario.defaultPlayer.alignment);
  const characterClass = characterClassesDatabase.find((entry) => entry.id === classId) ?? characterClassesDatabase[0];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name.trim()) onCreate(name.trim(), characterClass.id, alignment);
  };

  return <div role="dialog" aria-modal="true" aria-labelledby="character-setup-title" style={{ position: 'fixed', inset: 0, zIndex: 20, display: 'grid', placeItems: 'center', background: '#000c', padding: '20px' }}>
    <form onSubmit={submit} style={{ width: 'min(560px, 100%)', maxHeight: '90vh', overflowY: 'auto', padding: '24px', background: '#242424', border: '1px solid #666', borderRadius: '10px', color: '#eee', boxShadow: '0 12px 48px #0009' }}>
      <h2 id="character-setup-title" style={{ marginTop: 0 }}>建立冒險角色</h2>
      <label style={{ display: 'block', marginBottom: '14px' }}>角色名稱
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={24} required style={{ display: 'block', boxSizing: 'border-box', width: '100%', marginTop: '5px', padding: '9px', background: '#151515', color: '#fff', border: '1px solid #555', borderRadius: '4px' }} />
      </label>
      <label style={{ display: 'block', marginBottom: '14px' }}>職業
        <select value={classId} onChange={(event) => setClassId(event.target.value)} style={{ display: 'block', width: '100%', marginTop: '5px', padding: '9px', background: '#151515', color: '#fff', border: '1px solid #555', borderRadius: '4px' }}>
          {characterClassesDatabase.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </label>
      <label style={{ display: 'block', marginBottom: '14px' }}>陣營傾向
        <select value={alignment} onChange={(event) => setAlignment(event.target.value as CharacterAlignment)} style={{ display: 'block', width: '100%', marginTop: '5px', padding: '9px', background: '#151515', color: '#fff', border: '1px solid #555', borderRadius: '4px' }}>
          {alignments.map((entry) => <option key={entry}>{entry}</option>)}
        </select>
      </label>
      <p style={{ color: '#bbb' }}>{characterClass.description}</p>
      <h3>能力值</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', fontSize: '13px' }}>
        {Object.entries(characterClass.baseAbilities).map(([stat, value]) => <div key={stat} style={{ padding: '7px', background: '#333', borderRadius: '4px' }}>{stat.toUpperCase()} {value}</div>)}
      </div>
      <p>戰鬥加值：ATK {characterClass.bonuses.atk >= 0 ? '+' : ''}{characterClass.bonuses.atk} · DEF {characterClass.bonuses.def >= 0 ? '+' : ''}{characterClass.bonuses.def} · SPD {characterClass.bonuses.spd >= 0 ? '+' : ''}{characterClass.bonuses.spd}<br />資源加值：HP {characterClass.bonuses.maxHp >= 0 ? '+' : ''}{characterClass.bonuses.maxHp} · MP {characterClass.bonuses.maxMp >= 0 ? '+' : ''}{characterClass.bonuses.maxMp}</p>
      <h3>初始持有物</h3>
      <div style={{ fontSize: '13px', color: '#ccc' }}>{characterClass.startingItems.map((item) => `${getItemById(item.itemId)?.name ?? item.itemId} ×${item.quantity}`).join('、') || '無'}</div>
      <button type="submit" style={{ width: '100%', marginTop: '20px', padding: '11px', background: '#2e7d32', color: 'white', border: 0, borderRadius: '5px', cursor: 'pointer' }}>開始冒險</button>
    </form>
  </div>;
}
