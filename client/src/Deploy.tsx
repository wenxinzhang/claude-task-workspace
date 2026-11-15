import { useEffect, useRef, useState } from 'react';
import { api, fmtSec, onDeployLog, type DeployEnv, type DeployStatus, type Project } from './api.ts';
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

  const label = status?.running ? '部署中…' : '一键部署';
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
        {!!status?.steps?.length && (
          <ul className="step-list">
            {status.steps.map((s, i) => (
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
