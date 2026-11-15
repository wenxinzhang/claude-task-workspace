import { useState } from 'react';
import { api, COLUMNS, defaultEnv, fmtDuration, STAGE_LABEL, statusLabel, useNow, type DeployStatus, type Preflight, type Project, type QueueStatus, type TaskBrief } from './api.ts';
import { DeployPanel, confirmDeploy } from './Deploy.tsx';
import { Icon } from './Icon.tsx';

const clock = (ms: number) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });

/** 开工前自检的结果：没过时队列不会开始取任务 */
function PreflightNote({ preflight }: { preflight: Preflight }) {
  if (preflight.state === 'checking') return <small className="muted">正在用当前配置自检：让代理读一个文件、试跑验证命令用到的程序…</small>;
  const failed = preflight.state === 'failed';
  if (!failed) return <small className="ok-text">自检通过</small>;
  return (
    <div className="preflight failed">
      <strong>自检未通过，队列已停止</strong>
      {[...preflight.problems, ...preflight.notes].map((text, i) => (
        <small key={i}>{text}</small>
      ))}
      <small>在「项目管理 → 配置」里调整后，重新启动队列会再检一次。</small>
    </div>
  );
}

/** 执行队列：状态、正在执行的任务的实时进度、启动 / 暂停 */
export function QueueCard({ project, queue, tasks, onOpen }: { project: Project; queue: QueueStatus; tasks: TaskBrief[]; onOpen: (id: string) => void }) {
  const [err, setErr] = useState('');
  const act = (path: string) => api(`/api/projects/${project.id}/queue/${path}`, 'POST').then(() => setErr(''), (e) => setErr(e.message));
  const now = useNow(!!queue.currentId);
  const current = queue.currentId ? tasks.find((t) => t.id === queue.currentId) : undefined;
  const p = queue.progress;
  const state = queue.currentId ? '执行中' : queue.preflight?.state === 'checking' ? '自检中' : queue.running ? '运行中' : '已暂停';
  const quiet = p ? now - p.lastAt : 0;

  return (
    <section className="rail-card" aria-live="polite" aria-label={`${project.name} 执行队列`}>
      <div className="rail-head">
        <strong>执行队列</strong>
        <span className={`pill ${queue.currentId || queue.running ? 'ok' : 'amber'}`}>{state}</span>
      </div>
      <p className="muted">{queue.todoCount} 项等待执行</p>

      {current && (
        <button className="run-now" onClick={() => onOpen(current.id)} title="查看执行过程">
          <span className="run-title">{current.title}</span>
          {p ? (
            <>
              <span>
                {STAGE_LABEL[p.stage]}阶段 · 已用时 {fmtDuration(now - p.startedAt)} · 工具调用 {p.toolCalls} 次
              </span>
              {p.lastStep && <span className="run-step mono">{p.lastStep}</span>}
              {quiet > 90_000 && <span className="muted">已 {fmtDuration(quiet)} 没有新的操作，可能在等待模型回复</span>}
              {p.costUsd > 0 && <span className="muted">已结束阶段花费 ${p.costUsd.toFixed(2)}</span>}
            </>
          ) : (
            <span className="muted">准备中…</span>
          )}
        </button>
      )}

      {queue.preflight && <PreflightNote preflight={queue.preflight} />}
      {project.exec.scheduleEnabled && <small className="muted">每天 {project.exec.scheduleTime} 自动启动，待修改清空后暂停</small>}
      {queue.running ? (
        <button className="btn btn-queue wide" onClick={() => act('pause')}>
          <Icon name="pause" /> 暂停队列
        </button>
      ) : (
        <button className="btn btn-queue wide" onClick={() => act('start')} title="按待修改的先后顺序逐个执行；只想跑一个任务时，打开该任务点「立即执行这一个」">
          <Icon name="play" /> 启动队列
        </button>
      )}
      {queue.currentId && (
        <button className="btn btn-danger-text wide" onClick={() => act('stop-current')}>
          停止当前任务
        </button>
      )}
      {err && <small className="error">{err}</small>}
    </section>
  );
}

/** 部署记录：最近一次部署的结果与版本 */
export function DeployRecord({ project, status }: { project: Project; status?: DeployStatus }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const redeploy = async () => {
    const env = defaultEnv(project);
    setErr('');
    try {
      // 先检查是不是已经是最新版本，再确认：与顶栏的「一键部署」同一套
      const go = await confirmDeploy(project, env);
      if (!go) return;
      await api(`/api/projects/${project.id}/deploy`, 'POST', { envId: env.id, force: go.force });
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const state = status?.running ? '部署中' : status?.ok === undefined ? '' : status.ok ? '成功' : '失败';

  return (
    <section className="rail-card" aria-label="部署记录">
      <div className="rail-head">
        <strong>部署记录</strong>
      </div>
      {!defaultEnv(project).deployCommand ? (
        <small className="muted">还没有配置部署命令。部署后，需要在浏览器里看的验收项才能确认。</small>
      ) : !state ? (
        <>
          <small className="muted">暂无部署记录</small>
          <button className="btn btn-ghost wide" onClick={() => setOpen(true)}>
            查看记录
          </button>
        </>
      ) : (
        <>
          <span className={`pill ${status?.running ? 'blue' : status?.ok ? 'ok' : 'err'}`}>{state}</span>
          <small className="muted">测试环境{status?.finishedAt ? ` · ${clock(status.finishedAt)}` : ''}</small>
          {status?.commit && <small className="muted mono">版本：{status.commit.split(' ')[0]}</small>}
          <button className="btn btn-ghost wide" onClick={() => setOpen(true)}>
            查看记录
          </button>
        </>
      )}
      {open && <DeployPanel project={project} status={status} error={err} onClose={() => setOpen(false)} onRetry={redeploy} />}
    </section>
  );
}

/** 最近活动：按最后更新时间列出任务及其当前阶段 */
export function Activity({ project, tasks, onOpen }: { project: Project; tasks: TaskBrief[]; onOpen: (id: string) => void }) {
  const recent = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  return (
    <section className="rail-card" aria-label="最近活动">
      <div className="rail-head">
        <strong>最近活动</strong>
      </div>
      {recent.length === 0 ? (
        <small className="muted">还没有任务。</small>
      ) : (
        <ul className="activity">
          {recent.map((t) => {
            const col = COLUMNS.find((c) => c.key === t.status)!;
            return (
              <li key={t.id}>
                <span className="dot" style={{ background: col.color }} aria-hidden />
                <button className="link left ellipsis" onClick={() => onOpen(t.id)} title={t.title}>
                  {statusLabel(project, t.status)}：{t.title}
                </button>
                <small className="muted">{clock(t.updatedAt)}</small>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
