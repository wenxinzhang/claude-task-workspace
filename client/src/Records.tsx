import { useEffect, useMemo, useState } from 'react';
import { api, fmtDateTime, fmtSec, onDeployLog, statusLabel, type HistoryRecord, type Project, type QueueStatus, type Task, type TaskBrief } from './api.ts';
import { Icon } from './Icon.tsx';
import { shortId } from './Inbox.tsx';
import { StepIcon } from './Deploy.tsx';

interface Props {
  project: Project;
  tasks: TaskBrief[];
  queue: QueueStatus;
  history: HistoryRecord[];
  onOpenTask: (id: string) => void;
}

type Tab = 'all' | 'ai' | 'sync' | 'push' | 'deploy';

interface Row {
  id: string;
  kind: Tab;
  label: string;
  status: HistoryRecord['status'];
  startedAt?: number;
  durationMs?: number;
  record?: HistoryRecord;
  task?: TaskBrief;
}

const STATUS_META: Record<HistoryRecord['status'], { label: string; cls: string }> = {
  success: { label: '成功', cls: 'ok' },
  failed: { label: '失败', cls: 'err' },
  queued: { label: '排队中', cls: 'gray' },
  running: { label: '运行中', cls: 'blue' },
  review: { label: '待验证', cls: 'purple' },
  uptodate: { label: '已最新', cls: 'ok' },
  conflict: { label: '有冲突', cls: 'amber' },
};

const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'ai', label: 'AI 修复' },
  { key: 'sync', label: 'Git 同步' },
  { key: 'push', label: '代码推送' },
  { key: 'deploy', label: '部署' },
];

/** 执行记录：服务端持久化历史 + 排队中 / 运行中的虚拟行 */
export function Records({ project, tasks, queue, history, onOpenTask }: Props) {
  const [tab, setTab] = useState<Tab>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | HistoryRecord['status']>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(null);
    setTab('all');
  }, [project.id]);

  const rows = useMemo(() => {
    const recs: Row[] = history.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.kind === 'deploy' ? (r.envName ?? '测试环境') : r.kind === 'ai' ? r.title : (r.branch ?? r.title),
      status: r.status,
      startedAt: r.startedAt,
      durationMs: r.finishedAt ? r.finishedAt - r.startedAt : undefined,
      record: r,
    }));
    const virtual: Row[] = [];
    for (const t of tasks) {
      if (t.status === 'todo') virtual.push({ id: `queued-${t.id}`, kind: 'ai', label: t.title, status: 'queued', task: t });
      if (queue.currentId === t.id && !history.some((r) => r.kind === 'ai' && r.taskId === t.id && r.status === 'running')) {
        virtual.push({ id: `running-${t.id}`, kind: 'ai', label: t.title, status: 'running', startedAt: queue.progress?.startedAt, task: t });
      }
    }
    return [...recs, ...virtual].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }, [history, tasks, queue]);

  const visible = rows.filter((r) => (tab === 'all' || r.kind === tab) && (statusFilter === 'all' || r.status === statusFilter));
  const selected = visible.find((r) => r.id === selectedId) ?? visible[0];
  const firstCol = tab === 'ai' ? '任务' : tab === 'sync' || tab === 'push' ? '分支' : tab === 'deploy' ? '部署环境' : '操作';

  return (
    <div className="records-page">
      <h1>执行记录</h1>
      <div className="records-toolbar">
        <div className="chip-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={`chip-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <select className="env-select" aria-label="按状态过滤" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | HistoryRecord['status'])}>
          <option value="all">全部状态</option>
          <option value="success">成功</option>
          <option value="failed">失败</option>
          <option value="queued">排队中</option>
          <option value="running">运行中</option>
          <option value="review">{statusLabel(project, 'review')}</option>
        </select>
      </div>

      <div className="records-split">
        <div className="table-card">
          <table className="table">
            <thead>
              <tr>
                <th>{firstCol}</th>
                <th>状态</th>
                <th>开始时间</th>
                <th className="num">耗时</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const meta = STATUS_META[r.status];
                const label = tab === 'all' && r.kind !== 'ai' ? (r.record?.title ?? r.label) : r.label;
                return (
                  <tr key={r.id} className={selected?.id === r.id ? 'selected' : ''} onClick={() => setSelectedId(r.id)}>
                    <td>{label}</td>
                    <td>
                      <span className={`pill ${meta.cls}`}>{r.status === 'review' ? statusLabel(project, 'review') : meta.label}</span>
                    </td>
                    <td>{r.startedAt ? fmtDateTime(r.startedAt) : '-'}</td>
                    <td className="num mono">{r.durationMs !== undefined ? fmtSec(r.durationMs) : '-'}</td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty-cell">
                    暂无记录。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <aside className="record-detail">
          {selected ? (
            selected.kind === 'ai' ? (
              <AiDetail row={selected} reviewLabel={statusLabel(project, 'review')} onOpenTask={onOpenTask} />
            ) : selected.record ? (
              <OpDetail record={selected.record} />
            ) : null
          ) : (
            <div className="empty-cell">选择左侧记录查看详情。</div>
          )}
        </aside>
      </div>
    </div>
  );
}

/** AI 修复详情：步骤来自执行记录，日志对着关联任务 */
function AiDetail({ row, reviewLabel, onOpenTask }: { row: Row; reviewLabel: string; onOpenTask: (id: string) => void }) {
  const record = row.record;
  const taskId = record?.taskId ?? row.task?.id;
  const [task, setTask] = useState<Task | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!taskId) return;
    api<Task>(`/api/tasks/${taskId}`).then(setTask, () => setTask(null));
  }, [taskId, record?.finishedAt]);

  const meta = STATUS_META[row.status];
  const steps = record?.steps ?? [];
  const failReason = record?.error ?? task?.error;
  const cost = [task?.evidence?.analysis, task?.evidence?.implement, task?.evidence?.verify].reduce((n, e) => n + (e?.costUsd ?? 0) + (e?.reruns ?? []).reduce((x, r) => x + (r.costUsd ?? 0), 0), 0);

  const rerun = async () => {
    if (!taskId) return;
    setBusy(true);
    setErr('');
    try {
      const t = task ?? (await api<Task>(`/api/tasks/${taskId}`));
      if (['blocked', 'review', 'done'].includes(t.status)) await api(`/api/tasks/${taskId}/retry`, 'POST');
      await api(`/api/tasks/${taskId}/run`, 'POST');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="record-card">
      <h3 className="bar-title">AI 修复详情</h3>
      <div className="record-status-row">
        <span className={`pill ${meta.cls}`}>{row.status === 'review' ? reviewLabel : meta.label}</span>
        {taskId && <span className="muted">任务 {shortId(taskId)}</span>}
        <span className="grow" />
        {taskId && (
          <button className="btn btn-ghost sm" onClick={() => onOpenTask(taskId)}>
            查看任务
          </button>
        )}
      </div>
      {steps.length > 0 && (
        <ul className="step-list">
          {steps.map((s, i) => (
            <li key={i}>
              <span className={`step-ico ${s.status === 'fail' ? 'err' : s.status === 'running' ? 'run' : 'ok'}`}>
                <Icon name={s.status === 'fail' ? 'x' : 'check'} size={12} />
              </span>
              <span className="grow">{s.name}</span>
              <span className="mono muted">{s.durationMs !== undefined ? fmtSec(s.durationMs) : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {row.status === 'queued' && <div className="note-box">排队中：队列按待修改顺序执行到它时开始。</div>}
      {failReason && row.status === 'failed' && (
        <div className="fail-box">
          <strong>
            <Icon name="alert" /> 未通过
          </strong>
          <p>{failReason}</p>
        </div>
      )}
      {cost > 0 && <small className="muted">花费 ${cost.toFixed(2)}（来自代理事件流）</small>}
      <h3 className="bar-title">执行日志</h3>
      <pre className="logs logs-sm">{task?.logs.length ? task.logs.join('\n') : '暂无日志'}</pre>
      {err && <div className="error">{err}</div>}
      {taskId && row.status !== 'running' && row.status !== 'queued' && (
        <div className="record-foot">
          <button className="btn btn-ghost" disabled={busy} onClick={rerun}>
            {busy ? '发起中…' : '重新执行'}
          </button>
        </div>
      )}
    </div>
  );
}

/** Git 同步 / 代码推送 / 部署详情 */
function OpDetail({ record }: { record: HistoryRecord }) {
  const [logs, setLogs] = useState<string[]>(record.logs);
  const [copied, setCopied] = useState(false);
  const meta = STATUS_META[record.status];

  useEffect(() => {
    setLogs(record.logs);
    // 运行中的部署：日志实时追加
    if (record.kind === 'deploy' && record.status === 'running') {
      return onDeployLog((e) => {
        if (e.projectId === record.projectId) setLogs((prev) => [...prev.slice(-1999), e.line]);
      });
    }
  }, [record.id, record.logs, record.status]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logs.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const title = record.kind === 'sync' ? 'Git 同步详情' : record.kind === 'push' ? '代码推送详情' : '部署详情';
  const logTitle = record.kind === 'sync' ? '同步日志' : record.kind === 'push' ? '推送日志' : '执行日志';

  return (
    <div className="record-card">
      <h3 className="bar-title">{title}</h3>
      <div className="record-status-row">
        <span className={`pill ${meta.cls}`}>{meta.label}</span>
        {record.kind === 'deploy' && (
          <>
            <span className="muted">{record.envName}</span>
            {record.commit && <span className="muted">提交 {record.commit.split(' ')[0]}</span>}
          </>
        )}
      </div>

      {record.kind === 'sync' && (
        <>
          <ul className="step-list">
            <li>
              <span className="step-ico ok">
                <Icon name="check" size={12} />
              </span>
              <span className="grow">远端分支</span>
              <span className="mono muted">{record.upstream ?? '未设置'}</span>
            </li>
            <li>
              <span className="step-ico ok">
                <Icon name="check" size={12} />
              </span>
              <span className="grow">同步前</span>
              <span className="mono muted">{record.before?.split(' ')[0] ?? '-'}</span>
            </li>
            <li>
              <span className="step-ico ok">
                <Icon name="check" size={12} />
              </span>
              <span className="grow">同步后</span>
              <span className="mono muted">{record.after?.split(' ')[0] ?? '-'}</span>
            </li>
          </ul>
          <div className="note-box">
            {record.status === 'success'
              ? `拉取 ${record.count ?? 0} 个提交 · 无冲突`
              : record.status === 'uptodate'
                ? '本地已是最新 · 无冲突'
                : (record.error ?? '未自动合并')}
          </div>
        </>
      )}

      {record.kind === 'push' && (
        <>
          <ul className="step-list">
            <li>
              <span className="step-ico ok">
                <Icon name="check" size={12} />
              </span>
              <span className="grow">本地分支</span>
              <span className="mono muted">{record.branch}</span>
            </li>
            <li>
              <span className="step-ico ok">
                <Icon name="check" size={12} />
              </span>
              <span className="grow">目标分支</span>
              <span className="mono muted">{record.upstream ?? '-'}</span>
            </li>
          </ul>
          <h3 className="bar-title">已推送提交（{record.count ?? 0}）</h3>
          <div className="commit-list">
            {(record.commits ?? []).map((c) => (
              <div key={c.hash} className="commit-row">
                <code className="scope-chip">{c.hash}</code>
                <span className="ellipsis">{c.subject}</span>
              </div>
            ))}
            {!record.commits?.length && <div className="note-box">{record.count ? `${record.count} 个提交已推送到远端` : '没有待推送的提交'}</div>}
          </div>
        </>
      )}

      {record.kind === 'deploy' && !!record.steps?.length && (
        <ul className="step-list">
          {record.steps.map((s, i) => (
            <li key={i} className={s.status === 'pending' || s.status === 'skipped' ? 'step-idle' : undefined}>
              <StepIcon status={s.status} />
              <span className="grow">{s.name}</span>
              <span className="mono muted">{s.status === 'skipped' ? '已跳过' : s.status === 'pending' ? '等待中' : s.durationMs !== undefined ? fmtSec(s.durationMs) : ''}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="shots-head">
        <h3 className="bar-title">{logTitle}</h3>
        {record.kind === 'deploy' && (
          <button className="btn btn-ghost sm" onClick={copy}>
            <Icon name="copy" /> {copied ? '已复制' : '复制日志'}
          </button>
        )}
      </div>
      <pre className="logs logs-sm">{logs.length ? logs.join('\n') : '暂无日志'}</pre>
      {record.error && record.kind !== 'sync' && <div className="error">{record.error}</div>}
    </div>
  );
}
