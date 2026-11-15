import { useState } from 'react';
import type { FlowMetrics, Observation, ObserverStatus, Project, Proposal } from './api.ts';
import { isActionable } from '../../server/observe-types.ts';
import { FlowHealth } from './FlowHealth.tsx';
import { Observations } from './Observations.tsx';
import { Proposals } from './Proposals.tsx';

interface Props {
  observations: Observation[];
  proposals: Proposal[];
  status: ObserverStatus | null;
  flow: Record<string, FlowMetrics>;
  projects: Project[];
  onOpenTask: (projectId: string, taskId: string) => void;
}

/** 观察者页：流程体检在上（现在流程长什么样），下面是优化提案与问题台账两页签 */
export function Observer({ observations, proposals, status, flow, projects, onOpenTask }: Props) {
  const [tab, setTab] = useState<'proposals' | 'observations'>('proposals');
  const active = status && (status.applying || status.probing);
  const actionable = observations.filter(isActionable).length;
  const waiting = proposals.filter((p) => p.status === 'pending').length;
  return (
    <div className="observer-page">
      <h1>观察者</h1>
      <p className="muted">
        以第三方视角审查修复流程：哪里慢、哪里花钱多却没换来结果、哪里卡住了任务。审查产出的提案经你确认后才会应用；应用前自动备份，类型检查或测试不过自动回滚。
      </p>
      <FlowHealth flow={flow} projects={projects} />
      {active && (
        <div className="observer-status" role="status">
          {status!.applying && <span className="pill amber">{status!.applyMode === 'rollback' ? '回滚中' : '应用中'}</span>}
          {status!.probing && <span className="pill purple">复验中</span>}
        </div>
      )}
      <div className="chip-tabs" role="tablist">
        <button id="obs-tab-proposals" role="tab" aria-selected={tab === 'proposals'} aria-controls="obs-panel" className={`chip-tab ${tab === 'proposals' ? 'active' : ''}`} onClick={() => setTab('proposals')}>
          优化提案{waiting > 0 && `（${waiting}）`}
        </button>
        <button id="obs-tab-observations" role="tab" aria-selected={tab === 'observations'} aria-controls="obs-panel" className={`chip-tab ${tab === 'observations' ? 'active' : ''}`} onClick={() => setTab('observations')}>
          问题台账{actionable > 0 && `（${actionable}）`}
        </button>
      </div>
      <div id="obs-panel" role="tabpanel" aria-labelledby={tab === 'proposals' ? 'obs-tab-proposals' : 'obs-tab-observations'}>
        {tab === 'proposals' ? (
          <Proposals proposals={proposals} observations={observations} status={status} />
        ) : (
          <Observations observations={observations} projects={projects} onOpenTask={onOpenTask} />
        )}
      </div>
    </div>
  );
}
