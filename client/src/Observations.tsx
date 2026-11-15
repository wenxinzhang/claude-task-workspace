import { useState } from 'react';
import { api, fmtDayTime, type Observation, type Project } from './api.ts';
import { effectiveAttribution, isActionable } from '../../server/observe-types.ts';

const KIND_LABEL: Record<Observation['kind'], string> = {
  exec_error: '执行报错',
  gate_fail: '门禁未过',
  gate_unverified: '需人工验收',
  commit_fail: '提交失败',
  analyze_fail: '理解失败',
  preflight_fail: '自检失败',
  feishu_import: '飞书导入',
  feishu_writeback: '飞书回写',
  deploy_fail: '部署失败',
  git_sync: 'Git 同步',
  git_push: 'Git 推送',
  llm_finding: 'LLM 复盘',
  flow_backlog: '任务积压',
  flow_gate: '门禁放行',
  flow_finding: '流程审查',
};

const ATTRIBUTION_LABEL = { tool: '工具', project: '目标项目', environment: '环境' } as const;

const STATUS_LABEL: Record<Observation['status'], string> = { new: '等你处理', resolved: '已解决', ignored: '已忽略' };
const SEVERITY_CLS: Record<Observation['severity'], string> = { error: 'err', warn: 'amber', note: 'gray' };

interface Props {
  observations: Observation[];
  projects: Project[];
  onOpenTask: (projectId: string, taskId: string) => void;
}

/** 问题台账：默认只列可行动项（与侧边计数、审查输入同一判据），环境问题、备注与已处理的折叠进「其他记录」 */
export function Observations({ observations, projects, onOpenTask }: Props) {
  const [showOthers, setShowOthers] = useState(false);
  const [projectFilter, setProjectFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const actionable = observations.filter(isActionable);
  const othersCount = observations.length - actionable.length;
  const visible = (showOthers ? observations : actionable).filter(
    (o) => (projectFilter === 'all' || o.projectId === projectFilter) && (kindFilter === 'all' || o.kind === kindFilter),
  );
  // 流程审查的发现不属于某个项目
  const projectName = (id: string) => (id ? projects.find((p) => p.id === id)?.name ?? id.slice(0, 8) : '全部项目');

  const setStatus = async (id: string, status: 'resolved' | 'ignored') => {
    try {
      await api(`/api/observations/${id}/status`, 'POST', { status });
      setMsg(null);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="observations">
      <div className="records-toolbar">
        <button className={`chip-tab ${showOthers ? 'active' : ''}`} onClick={() => setShowOthers(!showOthers)}>
          其他记录（{othersCount}）
        </button>
        {showOthers && (
          <>
            <select className="env-select" aria-label="按项目过滤" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
              <option value="all">全部项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select className="env-select" aria-label="按类型过滤" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
              <option value="all">全部类型</option>
              {Object.entries(KIND_LABEL).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </>
        )}
        {showOthers && observations.some((o) => o.status !== 'new') && (
          <button
            className="link"
            title="删除已解决和已忽略的记录；待处理的保留"
            onClick={() => void api('/api/observations/clear', 'POST').then(() => setMsg(null), (e: Error) => setMsg(e.message))}
          >
            清理已处理的
          </button>
        )}
        <span className="grow" />
        {msg && <span className="error">{msg}</span>}
      </div>
      <div className="table-card">
        <table className="table">
          <thead>
            <tr>
              <th>问题</th>
              <th>类型</th>
              <th>项目</th>
              <th>时间</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((o) => (
              <tr
                key={o.id}
                className={expanded === o.id ? 'selected' : ''}
                tabIndex={0}
                onClick={() => setExpanded(expanded === o.id ? null : o.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setExpanded(expanded === o.id ? null : o.id);
                  }
                }}
              >
                <td>
                  <span className={`pill ${SEVERITY_CLS[o.severity]}`}>{o.severity === 'error' ? '错误' : o.severity === 'warn' ? '关注' : '备注'}</span>{' '}
                  {o.title}
                </td>
                <td>
                  {KIND_LABEL[o.kind]}
                  {effectiveAttribution(o) && <span className="muted"> · {ATTRIBUTION_LABEL[effectiveAttribution(o)!]}</span>}
                </td>
                <td>{projectName(o.projectId)}</td>
                <td>{fmtDayTime(o.at)}</td>
                <td>{STATUS_LABEL[o.status]}</td>
                <td className="obs-actions" onClick={(e) => e.stopPropagation()}>
                  {o.taskId && (
                    <button className="btn btn-sm" onClick={() => onOpenTask(o.projectId, o.taskId!)}>查看任务</button>
                  )}
                  {o.status === 'new' && (
                    <>
                      <button className="btn btn-sm" onClick={() => void setStatus(o.id, 'resolved')}>标记已解决</button>
                      <button className="btn btn-sm" onClick={() => void setStatus(o.id, 'ignored')}>忽略</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="empty-cell">
                  {showOthers ? '没有匹配的记录' : '暂无需要处理的问题'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {expanded && (() => {
        const o = observations.find((x) => x.id === expanded);
        if (!o) return null;
        return (
          <div className="obs-detail">
            <pre className="logs">{o.detail || '（无详情）'}</pre>
            <p className="muted">
              来源：{o.source === 'llm' ? (o.kind === 'flow_finding' ? '流程审查' : 'LLM 复盘') : '代码采集'}
              {effectiveAttribution(o) === 'environment' && ' · 环境问题，不计入审查'}
              {o.context.provider && ` · 代理 ${o.context.provider}`}
              {o.context.durationMs !== undefined && ` · 耗时 ${Math.round(o.context.durationMs / 1000)} 秒`}
              {o.context.toolCalls != null && ` · 工具调用 ${o.context.toolCalls} 次`}
              {o.proposalId && ' · 已由提案处理'}
            </p>
          </div>
        );
      })()}
    </div>
  );
}