import { useEffect, useMemo, useState } from 'react';
import { api, defaultEnv, type Project, type RepoInfo } from './api.ts';
import { Icon } from './Icon.tsx';
import { ObserverSettings } from './ObserverSettings.tsx';
import { ModelsSettings } from './ModelSelect.tsx';
import { ExecSettings, FeishuSettings, ProjectSettings, SkillLibrarySettings } from './Settings.tsx';

/** 项目管理页当前打开的内容：项目列表、全局设置，或某个项目的配置（项目信息 / 执行设置） */
export type ManageTarget = { kind: 'list' } | { kind: 'global' } | { kind: 'project'; id: string; tab: 'info' | 'exec' };

interface Props {
  projects: Project[] | null;
  currentId: string | null;
  target: ManageTarget;
  onTarget: (t: ManageTarget) => void;
  onEnter: (id: string) => void;
  onCreate: () => void;
  onDeleted: (id: string) => void;
}

/**
 * 项目管理：项目的一切配置都从这里进。
 * 「项目」页签是所有项目的一览，点「配置」进入该项目的项目信息与执行设置；
 * 「全局设置」是所有项目共用的飞书连接、skill 库、可用模型、观察者。
 */
export function ProjectsPage({ projects, currentId, target, onTarget, onEnter, onCreate, onDeleted }: Props) {
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'all' | 'archived'>('all');
  const [repos, setRepos] = useState<Record<string, RepoInfo | null>>({});
  const [err, setErr] = useState('');

  const ids = (projects ?? []).map((p) => p.id).join(',');
  useEffect(() => {
    let alive = true;
    for (const p of projects ?? []) {
      api<{ repo: RepoInfo | null }>(`/api/projects/${p.id}/git`).then(
        (r) => alive && setRepos((m) => ({ ...m, [p.id]: r.repo })),
        () => alive && setRepos((m) => ({ ...m, [p.id]: null })),
      );
    }
    return () => {
      alive = false;
    };
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (projects ?? []).filter((p) => (tab === 'archived' ? p.archived : !p.archived) && (!q || p.name.toLowerCase().includes(q)));
  }, [projects, search, tab]);

  const setArchived = async (p: Project, archived: boolean) => {
    try {
      await api(`/api/projects/${p.id}`, 'PUT', { archived });
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const remove = async (p: Project) => {
    if (!confirm(`删除项目「${p.name}」及其全部任务？此操作不可恢复。代码目录中的文件不受影响。`)) return;
    try {
      await api(`/api/projects/${p.id}`, 'DELETE');
      onDeleted(p.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const repoName = (p: Project) => {
    const r = repos[p.id];
    if (r === undefined) return '读取中…';
    if (!r) return p.workdir ? '非 git 仓库' : '未配置';
    const name = r.remote?.split(/[/:]/).filter(Boolean).pop()?.replace(/\.git$/, '');
    return name || r.branch;
  };

  // 打开的项目已被删掉时显示列表
  const configuring = target.kind === 'project' ? projects?.find((p) => p.id === target.id) : undefined;
  if (target.kind === 'project' && configuring) {
    return (
      <div className="projects-page">
        <button className="link manage-back" onClick={() => onTarget({ kind: 'list' })}>
          ← 返回项目列表
        </button>
        <header className="page-head">
          <div>
            <h1>{configuring.name}</h1>
            <p className="muted">这个项目自己的配置。飞书应用凭证、skill 库、可用模型、观察者是所有项目共用的，在「全局设置」里。</p>
          </div>
          {/* 已归档的项目进不去（会被带到别的项目），不显示入口 */}
          {!configuring.archived && (
            <button className="btn btn-outline-primary" onClick={() => onEnter(configuring.id)}>
              进入项目
            </button>
          )}
        </header>
        <div className="chip-tabs manage-tabs" role="tablist">
          <button role="tab" aria-selected={target.tab === 'info'} className={`chip-tab ${target.tab === 'info' ? 'active' : ''}`} onClick={() => onTarget({ ...target, tab: 'info' })}>
            项目信息
          </button>
          <button role="tab" aria-selected={target.tab === 'exec'} className={`chip-tab ${target.tab === 'exec' ? 'active' : ''}`} onClick={() => onTarget({ ...target, tab: 'exec' })}>
            执行设置
          </button>
        </div>
        {/* 两个表单都保持挂载，只藏起非当前的：切页签不丢还没保存的修改 */}
        <div hidden={target.tab !== 'info'}>
          <ProjectSettings key={configuring.id} project={configuring} />
        </div>
        <div hidden={target.tab !== 'exec'}>
          <ExecSettings key={configuring.id} project={configuring} />
        </div>
      </div>
    );
  }

  const global = target.kind === 'global';
  return (
    <div className="projects-page">
      <header className="page-head">
        <div>
          <h1>项目管理</h1>
          <p className="muted">{global ? '所有项目共用的设置' : `${projects?.length ?? 0} 个项目`}</p>
        </div>
        {!global && (
          <button className="btn btn-primary" onClick={onCreate}>
            <Icon name="plus" /> 添加项目
          </button>
        )}
      </header>

      <div className="chip-tabs manage-tabs" role="tablist">
        <button role="tab" aria-selected={!global} className={`chip-tab ${!global ? 'active' : ''}`} onClick={() => onTarget({ kind: 'list' })}>
          项目
        </button>
        <button role="tab" aria-selected={global} className={`chip-tab ${global ? 'active' : ''}`} onClick={() => onTarget({ kind: 'global' })}>
          全局设置
        </button>
      </div>

      {global && (
        <>
          <FeishuSettings />
          <SkillLibrarySettings />
          <ModelsSettings />
          <ObserverSettings />
        </>
      )}

      {!global && (
        <>
      <div className="projects-toolbar">
        <span className="search-wrap">
          <Icon name="search" />
          <input type="search" placeholder="搜索项目" aria-label="搜索项目" value={search} onChange={(e) => setSearch(e.target.value)} />
        </span>
        <button className={`chip-tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>
          全部项目
        </button>
        <button className={`chip-tab ${tab === 'archived' ? 'active' : ''}`} onClick={() => setTab('archived')}>
          已归档
        </button>
      </div>

      {err && <div className="notice error">{err}</div>}

      {projects === null ? (
        <p className="muted">加载中…</p>
      ) : (
        <div className="table-card">
          <table className="table">
            <thead>
              <tr>
                <th>项目名称</th>
                <th>飞书来源</th>
                <th>Git 仓库</th>
                <th>部署环境</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                    {p.id === currentId && <span className="pill soft">使用中</span>}
                  </td>
                  <td>
                    {p.feishu.url ? (
                      <a className="link" href={p.feishu.url} target="_blank" rel="noreferrer" title={p.feishu.url}>
                        <Icon name="rocket" className="feishu-ico" /> {p.feishu.name || '飞书表格'}
                      </a>
                    ) : (
                      <span className="muted">未配置</span>
                    )}
                  </td>
                  <td>
                    <span className="repo-cell">
                      <Icon name="repo" /> {repoName(p)}
                    </span>
                  </td>
                  <td>{defaultEnv(p).deployCommand ? defaultEnv(p).name : <span className="muted">未配置</span>}</td>
                  <td>
                    <span className="row-ops">
                      <button className="btn btn-outline-primary sm" onClick={() => onEnter(p.id)}>
                        进入项目
                      </button>
                      <button className="btn btn-outline sm" onClick={() => onTarget({ kind: 'project', id: p.id, tab: 'info' })}>
                        配置
                      </button>
                      <details className="menu">
                        <summary className="icon-btn" aria-label={`${p.name} 更多操作`}>
                          <Icon name="dots" />
                        </summary>
                        <div className="menu-list">
                          <button onClick={() => setArchived(p, !p.archived)}>{p.archived ? '恢复项目' : '归档项目'}</button>
                          <button onClick={() => remove(p)}>删除项目</button>
                        </div>
                      </details>
                    </span>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-cell">
                    {tab === 'archived' ? '暂无已归档项目。在「全部项目」的 ⋯ 菜单里归档。' : search ? '没有匹配的项目。' : '还没有项目，点右上角「添加项目」。'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
        </>
      )}
    </div>
  );
}
