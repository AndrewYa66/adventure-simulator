import React, { useSyncExternalStore } from 'react';
import { getLastAIContextReport, subscribeAIContextReport } from '../services/aiContext';

/** 開發模式專用：檢視上一次送給 AI 的上下文（各區段大小、截斷情況與完整提示）。 */
export const AIContextDebugPanel: React.FC = () => {
  const report = useSyncExternalStore(subscribeAIContextReport, getLastAIContextReport);
  return (
    <details data-testid="ai-context-debug" style={{ fontSize: '12px', border: '1px dashed #666', borderRadius: '4px', padding: '6px' }}>
      <summary style={{ cursor: 'pointer' }}>🛠️ AI 上下文（開發模式）</summary>
      {!report ? <p style={{ color: '#bbb', margin: '6px 0 0' }}>尚未送出 AI 請求。</p> : <>
        <p style={{ margin: '6px 0', color: report.overBudget ? '#ff8a80' : '#bbb' }}>
          {new Date(report.builtAt).toLocaleTimeString()}｜{report.totalChars.toLocaleString()} / {report.budgetChars.toLocaleString()} 字元
          ｜約 {report.estimatedTokens.toLocaleString()} tokens｜每回合最多 {report.maxCallsPerTurn} 次呼叫{report.overBudget ? '｜超出預算' : ''}
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={{ textAlign: 'left' }}>區段</th><th style={{ textAlign: 'right' }}>字元</th><th style={{ textAlign: 'right' }}>上限</th><th style={{ textAlign: 'right' }}>省略</th></tr></thead>
          <tbody>
            {report.sections.map((section) => <tr key={section.id} style={{ color: section.droppedEntries ? '#ffb74d' : undefined }}>
              <td>{section.id}</td>
              <td style={{ textAlign: 'right' }}>{section.chars.toLocaleString()}</td>
              <td style={{ textAlign: 'right' }}>{section.maxChars?.toLocaleString() ?? '—'}</td>
              <td style={{ textAlign: 'right' }}>{section.droppedEntries || ''}</td>
            </tr>)}
          </tbody>
        </table>
        <details style={{ marginTop: '6px' }}>
          <summary style={{ cursor: 'pointer' }}>完整提示</summary>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '320px', overflow: 'auto', fontSize: '11px', background: '#111', padding: '6px' }}>
            {report.systemPrompt}{'\n\n'}{report.userPrompt}
          </pre>
        </details>
      </>}
    </details>
  );
};
