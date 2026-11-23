import { useEffect, useRef, useState } from 'react';
import { api, fmtSec, onDeployLog, type DeployEnv, type DeployStatus, type DeployStep, type Project } from './api.ts';
import { Icon } from './Icon.tsx';

const time = (ms?: number) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '');

/**
 * 部署前先问服务端：这个环境上是不是已经是当前版本。是 → 提醒不用部署（仍可选择重新部署）；不是 → 确认后部署。
 * 返回 null 表示使用者取消了；否则返回要随部署请求带上的 force。
 * 顶栏的「一键部署」和部署面板里的「重新部署」共用
 */
export async function confirmDeploy(project: Project, env: DeployEnv): Promise<{ force: boolean } | null> {
  const check = await api<{ upToDate: boolean; commit?: string; at?: number }>(`/api/projects/${project.id}/deploy/check?envId=${encodeURIComponent(env.id)}`);
  if (check.upToDate) {
    const again = confirm(`「${env.name}」上已经是最新版本，不用部署。\n\n已部署版本：${check.commit ?? ''}\n部署时间：${time(check.at)}\n\n仍要重新部署一次吗？`);
    return again ? { force: true } : null;
  }
  const from = check.commit ? `\n\n上次部署的版本：${check.commit}` : '\n\n这个环境还没有成功部署过。';
  return confirm(`将当前代码部署到「${env.name}」？${from}\n执行命令：${env.deployCommand}`) ? { force: false } : null;
}

/** 顶栏的部署按钮：未配置时引导去设置；运行中显示进度，点击查看日志 */
export function DeployButton({ project, env, status, busy, onConfigure }: { project: Project; env: DeployEnv; status?: DeployStatus; busy: boolean; onConfigure: () => void }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');

  if (!env.deployCommand) {
    // 没填部署命令时部署不了。先说清原因再跳去配置：直接跳页面，看起来像「点了部署却没部署」
    const explain = () => {
      const filled = env.host ? `「${env.name}」已经填了服务器地址和账号，但` : `「${env.name}」`;
      if (confirm(`现在还不能部署：${filled}还没有填「部署命令」。\n\n一键部署做的事是在代码目录里执行你填的部署命令；服务器地址和账号只提供给代理做验证，不会自动用来发布。\n\n现在去填部署命令吗？（项目管理 → 配置 → 部署环境 → ${env.name} → 编辑）`)) onConfigure();
    };
    return (
      <button className="btn btn-primary" onClick={explain} title={`「${env.name}」还没有填部署命令，填了才能部署`}>
        一键部署
      </button>
    );
  }

  const start = async () => {
    setErr('');
    try {
      const go = await confirmDeploy(project, env);
      if (!go) return;
      setOpen(true);
      await api(`/api/projects/${project.id}/deploy`, 'POST', { envId: env.id, force: go.force });
    } catch (e) {
      setErr((e as Error).message);
      // 检查这一步就失败时面板还没打开：打开它，错误才看得见
      setOpen(true);
    }
  };

  const prog = deployProgress(status);
  const label = status?.running
    ? prog.repairing
      ? '修复中…'
      : prog.total
        ? `部署中 ${Math.max(prog.current, 1)}/${prog.total}`
        : '部署中…'
    : '一键部署';
  const title = status?.running
    ? '点击查看部署日志'
    : status?.finishedAt
      ? `上次部署${status.ok ? '成功' : '失败'}：${time(status.finishedAt)}`
      : busy
        ? '有任务正在执行，完成后再部署'
        : undefined;

  return (
    <>
      <button
        className={`btn btn-primary deploy-btn${status?.ok === false && !status.running ? ' failed' : ''}`}
        onClick={status?.running ? () => setOpen(true) : start}
        disabled={!status?.running && busy}
        title={title}
      >
        {status?.running && <span className="spinner" aria-hidden />}
        {label}
      </button>
      {open && <DeployPanel project={project} status={status} error={err} onClose={() => setOpen(false)} onRetry={start} />}
    </>
  );
}

const REPAIR_PREFIX = '智能体修复';

/**
 * 部署进度：只按当前这一遍（构建 → 发布 → 健康检查）算一共几步、现在第几步。
 * 修复重试时上一遍和修复步骤不计入，分母不会越滚越大；新的一遍开始时进度从 0 重新算，
 * 步骤名带「（第 N 次）」说明这是重试。修复步骤单独通过 repairing 给出。
 * 老状态没有 passStart 时按 0 处理，退化成整体计算。
 */
export function deployProgress(status?: DeployStatus): {
  total: number;
  current: number;
  finished: number;
  currentName?: string;
  repairing?: string;
} {
  const all = status?.steps ?? [];
  const tail = all.slice(Math.min(status?.passStart ?? 0, all.length));
  const steps = tail.filter((s) => !s.name.startsWith(REPAIR_PREFIX));
  const repairing = tail.find((s) => s.name.startsWith(REPAIR_PREFIX) && s.status === 'running')?.name;
  const total = steps.length;
  const finished = steps.filter((s) => s.status === 'ok' || s.status === 'fail' || s.status === 'skipped').length;
  const idx = steps.findIndex((s) => s.status === 'running');
  const current = idx >= 0 ? idx + 1 : finished;
  return { total, current, finished, currentName: idx >= 0 ? steps[idx].name : undefined, repairing };
}

/** 步骤状态图标：执行记录页的部署步骤也用它，pending / skipped 不能显示成对勾 */
export function StepIcon({ status }: { status: DeployStep['status'] }) {
  if (status === 'running')
    return (
      <span className="step-ico run">
        <span className="spinner step-spinner" aria-hidden />
      </span>
    );
  if (status === 'pending' || status === 'skipped') return <span className="step-ico idle" aria-hidden />;
  return (
    <span className={`step-ico ${status === 'fail' ? 'err' : 'ok'}`}>
      <Icon name={status === 'fail' ? 'x' : 'check'} size={12} />
    </span>
  );
}

function DeployProgress({ status }: { status: DeployStatus }) {
  const { total, current, finished, currentName, repairing } = deployProgress(status);
  const raw = total ? Math.round((finished / total) * 100) : 0;
  // 还在跑（比如这一遍失败、正等智能体修复）时不显示 100%，避免看起来像已经结束
  const pct = status.running ? Math.min(raw, 99) : raw;
  const text = status.running
    ? repairing
      ? `${repairing}进行中，修好后重新部署`
      : currentName
        ? `第 ${current}/${total} 步：${currentName}`
        : finished >= total
          ? '处理中…'
          : `已完成 ${finished}/${total} 步`
    : status.aborted
      ? `已手动停止（${finished}/${total} 步已结束）`
      : status.ok
        ? `共 ${total} 步，全部完成`
        : `部署失败（${finished}/${total} 步已结束）`;
  const barClass = status.running ? undefined : status.aborted ? 'stopped' : status.ok === false ? 'err' : undefined;
  return (
    <div className="deploy-progress">
      <div className="row">
        <span>{text}</span>
        <span className="grow" />
        <span className="mono muted">{pct}%</span>
      </div>
      <div
        className="deploy-progress-bar"
        role="progressbar"
        aria-label="部署进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={text}
      >
        <span style={{ width: `${pct}%` }} className={barClass} />
      </div>
    </div>
  );
}

export function DeployPanel({ project, status, error, onClose, onRetry }: { project: Project; status?: DeployStatus; error: string; onClose: () => void; onRetry: () => void }) {
  const [logs, setLogs] = useState<string[]>([]);
  const ref = useRef<HTMLPreElement>(null);

  // 每次开始部署时重新拉取日志，之后通过推送追加
  useEffect(() => {
    api<{ logs: string[] }>(`/api/projects/${project.id}/deploy`).then((r) => setLogs(r.logs));
    return onDeployLog((e) => {
      if (e.projectId === project.id) setLogs((prev) => [...prev.slice(-1999), e.line]);
    });
  }, [project.id, status?.startedAt]);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const state = status?.running ? '部署中' : status?.ok === undefined ? '未部署' : status.ok ? '部署成功' : '部署失败';

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog deploy-dialog" role="dialog" aria-modal="true" aria-labelledby="deploy-title" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2 id="deploy-title">部署到测试服务器</h2>
          <span className={`pill ${status?.running ? '' : status?.ok ? 'ok' : status?.ok === false ? 'err' : ''}`}>{state}</span>
          <span className="grow" />
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="muted mono deploy-meta">
          {status?.envName && <div>环境：{status.envName}</div>}
          {status?.commit && <div>版本：{status.commit}</div>}
          {status?.startedAt && <div>开始：{time(status.startedAt)}</div>}
          {status?.finishedAt && <div>结束：{time(status.finishedAt)}</div>}
        </div>
        {!!status?.steps?.length && <DeployProgress status={status} />}
        {!!status?.steps?.length && (
          <ul className="step-list">
            {status.steps.map((s, i) => (
              <li key={i} className={s.status === 'pending' || s.status === 'skipped' ? 'step-idle' : undefined}>
                <StepIcon status={s.status} />
                <span className="grow">
                  {i + 1}. {s.name}
                </span>
                <span className="mono muted">{s.status === 'skipped' ? '已跳过' : s.status === 'pending' ? '等待中' : s.durationMs !== undefined ? fmtSec(s.durationMs) : ''}</span>
              </li>
            ))}
          </ul>
        )}
        {error && <div className="notice error">{error}</div>}
        <pre className="logs" ref={ref} aria-live="polite">
          {logs.length ? logs.join('\n') : '暂无日志'}
        </pre>
        <div className="actions">
          {status?.running ? (
            <button className="btn btn-outline" onClick={() => api(`/api/projects/${project.id}/deploy/stop`, 'POST')}>
              停止部署
            </button>
          ) : (
            <button className="btn btn-outline" onClick={onRetry}>
              重新部署
            </button>
          )}
          <button className="btn btn-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
