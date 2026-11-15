import { useEffect, useState } from 'react';
import { api, defaultEnv, type DeployStatus, type Project, type RepoInfo } from './api.ts';
import { DeployButton } from './Deploy.tsx';
import { Icon } from './Icon.tsx';

interface Props {
  project: Project;
  crumb: string;
  busy: boolean;
  deploy?: DeployStatus;
  /** 任务提交后刷新仓库信息 */
  stamp: string;
  onConfigure: () => void;
  /** 「操作指引」按钮：放在顶栏最右边，由 App 统一提供，各页面的顶栏都有 */
  guideButton?: React.ReactNode;
}

/** 顶栏：面包屑 + 分支切换 / 同步 / 推送 / 环境选择 / 一键部署 */
export function TopBar({ project, crumb, busy, deploy, stamp, onConfigure, guideButton }: Props) {
  const [repo, setRepo] = useState<RepoInfo | null | undefined>(undefined);
  const [working, setWorking] = useState('');
  const [err, setErr] = useState('');
  // 同步 / 推送的结果说明（不是错误）：合并了几个提交、是否已经最新
  const [note, setNote] = useState('');
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchList, setBranchList] = useState<string[]>([]);
  const [envId, setEnvId] = useState(defaultEnv(project).id);

  useEffect(() => {
    setEnvId(defaultEnv(project).id);
    setBranchOpen(false);
  }, [project.id]);

  useEffect(() => {
    setRepo(undefined);
    api<{ repo: RepoInfo | null }>(`/api/projects/${project.id}/git`).then(
      (r) => setRepo(r.repo),
      () => setRepo(null),
    );
  }, [project.id, project.workdir, stamp, busy]);

  const openBranches = async () => {
    const next = !branchOpen;
    setBranchOpen(next);
    if (next) {
      const r = await api<{ branches: string[] }>(`/api/projects/${project.id}/git/branches`).catch(() => null);
      if (r) setBranchList(r.branches);
    }
  };

  const switchBranch = async (b: string) => {
    if (b === repo?.branch) return;
    setWorking('checkout');
    setErr('');
    try {
      const r = await api<{ repo: RepoInfo | null; branches: string[] }>(`/api/projects/${project.id}/git/checkout`, 'POST', { branch: b });
      setRepo(r.repo);
      setBranchList(r.branches);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking('');
    }
  };

  const act = async (name: 'fetch' | 'push') => {
    if (!repo) return;
    if (name === 'push' && !confirm(`把分支 ${repo.branch} 上的 ${repo.ahead} 个提交推送到 ${repo.upstream}？\n\n会先同步远端：远端有新提交就自动合并进来再推送，合并不了则不推送。\n推送后其他人就能拉取到这些改动。`)) return;
    setWorking(name);
    setErr('');
    setNote('');
    try {
      const r = await api<{ repo: RepoInfo | null; sync?: { status: string; pulled?: number; merged?: boolean; error?: string } }>(`/api/projects/${project.id}/git/${name}`, 'POST');
      setRepo(r.repo);
      if (r.sync?.status === 'conflict') setErr(r.sync.error ?? '同步存在冲突，未自动合并');
      else if (r.sync?.status === 'success') setNote(`${r.sync.merged ? '已自动合并' : '已取回'}远端的 ${r.sync.pulled} 个提交${name === 'push' ? '，并已推送' : r.sync.merged ? '，可以推送了' : ''}`);
      else if (name === 'fetch') setNote('本地已经是最新，远端没有新提交');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking('');
    }
  };

  const env = project.envs.find((e) => e.id === envId) ?? defaultEnv(project);

  return (
    <header className="topbar">
      <div className="crumb">{crumb}</div>
      <div className="top-actions" data-guide="top-actions">
        {repo !== undefined && (
          <div className="branch-wrap">
            <button className="btn btn-ghost branch-btn" onClick={openBranches} title={repo ? repo.head : '代码目录不是 git 仓库'} aria-expanded={branchOpen}>
              <Icon name="branch" />
              <span className="mono">{repo ? repo.branch : '非 git 仓库'}</span>
              <Icon name="chevron" size={14} className={`chev ${branchOpen ? 'open' : ''}`} />
            </button>
            {branchOpen && repo && (
              <div className="branch-pop">
                <div className="picker-pop-head">切换分支</div>
                {branchList.map((b) => (
                  <button key={b} className={`picker-option ${b === repo.branch ? 'selected' : ''}`} onClick={() => switchBranch(b)} disabled={!!working}>
                    <Icon name="branch" size={14} />
                    <span className="grow ellipsis mono">{b}</span>
                    {b === repo.branch && <Icon name="check" size={14} />}
                  </button>
                ))}
                <div className="branch-pop-row">
                  <span className="muted">待推送 / 落后</span>
                  <span>
                    {repo.ahead} / {repo.behind}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
        <button className="btn btn-ghost" disabled={!repo || !!working} onClick={() => act('fetch')} title="取回远端更新并合并进来；本地也有新提交时自动合并，两边改了同一处才需要手动处理">
          <Icon name="sync" />
          {working === 'fetch' ? '同步中…' : '同步远端'}
        </button>
        <button
          className="btn btn-ghost push-btn"
          // 落后远端时也能点：推送前会先自动同步合并
          disabled={!repo || !!working || busy || !repo.upstream || !repo.ahead}
          onClick={() => act('push')}
          aria-label={repo?.ahead ? `推送代码，${repo.ahead} 个提交待推送` : '推送代码'}
          title={
            busy
              ? '有任务正在执行，结束后再推送'
              : !repo?.ahead
                ? '没有待推送的提交'
                : repo.behind > 0
                  ? `远端有 ${repo.behind} 个提交本地还没有：会先自动合并进来，再推送本地的 ${repo.ahead} 个提交`
                  : `先同步远端，再把当前分支的 ${repo.ahead} 个提交推送到它的上游`
          }
        >
          <Icon name="upload" />
          {working === 'push' ? '推送中…' : '推送代码'}
          {!!repo?.ahead && (
            <span className="push-badge" key={repo.ahead} aria-hidden>
              {repo.ahead > 99 ? '99+' : repo.ahead}
            </span>
          )}
        </button>
        <span className="top-divider" aria-hidden />
        <select className="env-select" aria-label="部署环境" value={envId} onChange={(e) => setEnvId(e.target.value)}>
          {project.envs.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <DeployButton project={project} env={env} status={deploy} busy={busy} onConfigure={onConfigure} />
      </div>
      {guideButton}
      {note && !err && (
        <div className="topbar-err topbar-note" role="status">
          {note}
          <button className="icon-btn" onClick={() => setNote('')} aria-label="关闭">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {err && (
        <div className="topbar-err" role="alert">
          {err}
          <button className="icon-btn" onClick={() => setErr('')} aria-label="关闭">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
    </header>
  );
}
