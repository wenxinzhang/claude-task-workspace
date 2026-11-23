import { useEffect, useRef, useState } from 'react';
import { IDLE_QUEUE, useLive, type Project } from './api.ts';
import { Board } from './Board.tsx';
import { Guide, guideSeen } from './Guide.tsx';
import { Icon } from './Icon.tsx';
import { Inbox } from './Inbox.tsx';
import { Observer, OBSERVER_HASH, parseObserverHash } from './Observer.tsx';
import { ProjectsPage, type ManageTarget } from './ProjectsPage.tsx';
import { Records } from './Records.tsx';
import { NewProjectDialog } from './Settings.tsx';
import { Sidebar, VIEW_LABEL, type View } from './Sidebar.tsx';
import { TaskDrawer } from './TaskDrawer.tsx';
import { TopBar } from './TopBar.tsx';
import { initUsageCollect, installUsageClicks, track } from './usage.ts';

const LAST_PROJECT_KEY = 'lastProjectId';
const readLast = () => {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
};
const writeLast = (id: string) => {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, id);
  } catch {
    // 无痕模式等场景不可用，忽略
  }
};

// 当前在哪个视图也记下来：刷新页面后停在原来的视图，不回到任务收件箱
const LAST_VIEW_KEY = 'lastView';
const readView = (): View => {
  try {
    const v = localStorage.getItem(LAST_VIEW_KEY);
    // 只认 VIEW_LABEL 自己的键：用 in 的话 toString 这类继承来的名字也会通过
    return v && Object.prototype.hasOwnProperty.call(VIEW_LABEL, v) ? (v as View) : 'inbox';
  } catch {
    return 'inbox';
  }
};

export function App() {
  const { projects, tasks, queues, deploys, history, observations, proposals, observer, flow, connected } = useLive();
  // 角标与提案列表同源同一数组：计数结构性等于列表长度
  const observerPending = proposals.filter((p) => p.status === 'pending').length;
  // 地址栏带观察者路由（刷新详情页、直接打开链接）时优先进观察者
  const [view, setView] = useState<View>(() => {
    if (parseObserverHash(location.hash)) return 'observer';
    // 整页重新加载回到某个历史条目时，以条目里记的视图为准，不被上次停留的观察者盖掉
    const saved = (window.history.state as { view?: unknown } | null)?.view;
    if (typeof saved === 'string' && saved !== 'observer' && Object.prototype.hasOwnProperty.call(VIEW_LABEL, saved)) return saved as View;
    return readView();
  });
  const lastTrackedView = useRef<View | null>(null);
  // 观察者用 hash 路由：进观察者时补上默认地址，离开时清掉；浏览器前进后退在两边切换。
  // 注意这里的 history 被 useLive 的执行记录占了名字，浏览器历史用 window.history
  const firstView = useRef(true);
  useEffect(() => {
    const inHash = !!parseObserverHash(location.hash);
    const first = firstView.current;
    firstView.current = false;
    if (view === 'observer' && !inHash) {
      // 首次打开就停在观察者（上次停在这里）：替换当前地址，不多出一条历史；从别的视图进来才新增一条
      const url = `${OBSERVER_HASH}/issues`;
      if (first) window.history.replaceState({ view }, '', url);
      else window.history.pushState({ view }, '', url);
    } else if (view !== 'observer' && inHash) {
      window.history.pushState({ view }, '', location.pathname + location.search);
    } else if (!inHash) {
      // 记下当前视图：从观察者后退回来时回到原来的视图，而不是一律回收件箱
      window.history.replaceState({ ...(window.history.state ?? {}), view }, '');
    }
  }, [view]);
  useEffect(() => {
    const on = () => {
      if (parseObserverHash(location.hash)) return setView('observer');
      const saved = (window.history.state as { view?: unknown } | null)?.view;
      const back = typeof saved === 'string' && saved !== 'observer' && Object.prototype.hasOwnProperty.call(VIEW_LABEL, saved) ? (saved as View) : 'inbox';
      setView((v) => (v === 'observer' ? back : v));
    };
    window.addEventListener('hashchange', on);
    window.addEventListener('popstate', on);
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener('popstate', on);
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(LAST_VIEW_KEY, view);
    } catch {
      // 无痕模式等场景不可用，忽略
    }
    // StrictMode 开发期 effect 双跑：同一视图只报一次
    if (lastTrackedView.current !== view) {
      lastTrackedView.current = view;
      track('view', view);
    }
  }, [view]);
  // 使用观测：初始化采集开关 + 全局点击委托（只收 data-usage 标记的控件）
  useEffect(() => {
    initUsageCollect();
    return installUsageClicks();
  }, []);
  const [projectId, setProjectId] = useState<string | null>(readLast);
  const [creating, setCreating] = useState(false);
  // 项目管理页当前打开的是什么：项目列表、全局设置，或某个项目的配置
  const [manage, setManage] = useState<ManageTarget>({ kind: 'list' });
  const openProjectConfig = (id: string) => {
    setManage({ kind: 'project', id, tab: 'info' });
    setView('projects');
  };
  // 当前打开的任务抽屉：看板、收件箱、执行记录都能打开
  const [openId, setOpenId] = useState<string | null>(null);
  // 抽屉停留时长：打开时记时刻，关闭时把毫秒数随 close_drawer 上报
  const drawerOpenedAt = useRef<number | null>(null);
  useEffect(() => {
    if (openId && drawerOpenedAt.current === null) {
      drawerOpenedAt.current = Date.now();
      track('open_drawer', 'task-drawer');
    } else if (!openId && drawerOpenedAt.current !== null) {
      track('close_drawer', 'task-drawer', Date.now() - drawerOpenedAt.current);
      drawerOpenedAt.current = null;
    }
  }, [openId]);
  // 操作指引：第一次打开时自动出现一次（等项目列表到了、页面上的入口都渲染出来之后），之后只在点按钮时出现
  const [guideOpen, setGuideOpen] = useState(false);
  const guideAuto = useRef(false);
  useEffect(() => {
    if (projects === null || guideAuto.current) return;
    guideAuto.current = true;
    if (!guideSeen()) setGuideOpen(true);
  }, [projects]);
  const guideButton = (
    <button className="btn btn-ghost guide-btn" data-guide="guide-button" onClick={() => setGuideOpen(true)} title="从全局设置、建项目到执行和部署，按顺序带你配置一遍">
      操作指引
    </button>
  );

  // 选中的项目不存在（首次打开、已删除、已归档）时回退到第一个未归档项目
  const activeProjects = projects?.filter((p) => !p.archived);
  const project = activeProjects?.find((p) => p.id === projectId) ?? activeProjects?.[0];
  useEffect(() => {
    if (project && project.id !== projectId) setProjectId(project.id);
  }, [project?.id]);

  const select = (id: string, v: View = 'inbox') => {
    setProjectId(id);
    writeLast(id);
    setOpenId(null);
    setView(v);
  };

  const projectTasks = project ? tasks.filter((t) => t.projectId === project.id) : [];
  const queue = (project && queues[project.id]) || IDLE_QUEUE;
  const openTask = openId ? tasks.find((t) => t.id === openId) : undefined;
  const commitStamp = projectTasks.map((t) => t.commit?.hash ?? '').join('');

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        currentId={project?.id ?? null}
        view={view}
        connected={connected}
        observerPending={observerPending}
        onNav={(v) => {
          // 从侧边栏进项目管理总是回到列表，不停在上次打开的某个项目配置里
          if (v === 'projects') setManage({ kind: 'list' });
          setView(v);
        }}
        onSelectProject={(id) => {
          // 正在配置某个项目时切项目：留在配置页，换成新项目的同一个页签
          if (view === 'projects' && manage.kind === 'project') {
            setProjectId(id);
            writeLast(id);
            setManage({ ...manage, id });
            return;
          }
          select(id, view === 'projects' ? 'inbox' : view);
        }}
        onCreate={() => setCreating(true)}
      />

      <div className="main">
        {view === 'projects' || view === 'observer' || !project ? (
          <header className="topbar">
            <div className="crumb">
              {view === 'observer'
                ? '全局 / 观察者'
                : `全局 / 项目管理${manage.kind === 'project' ? ` / ${projects?.find((p) => p.id === manage.id)?.name ?? ''}` : manage.kind === 'global' ? ' / 全局设置' : ''}`}
            </div>
            {guideButton}
          </header>
        ) : (
          <TopBar
            project={project}
            crumb={`${project.name} / ${VIEW_LABEL[view]}`}
            busy={!!queue.currentId}
            deploy={deploys[project.id]}
            stamp={commitStamp}
            onConfigure={() => openProjectConfig(project.id)}
            guideButton={guideButton}
          />
        )}

        <main className="page">
          {view === 'observer' ? (
            <Observer
              observations={observations}
              proposals={proposals}
              status={observer}
              flow={flow}
              projects={projects ?? []}
              currentProjectId={project?.id ?? null}
              onOpenTask={(pid, tid) => {
                // 目标项目已归档/删除或任务不存在时不跳转，避免落错项目上下文
                if (!(projects ?? []).some((p) => p.id === pid && !p.archived) || !tasks.some((t) => t.id === tid)) return;
                // select 会清 openId，顺序不能反
                select(pid, 'inbox');
                setOpenId(tid);
              }}
            />
          ) : view === 'projects' || projects === null ? (
            <ProjectsPage
              projects={projects}
              currentId={project?.id ?? null}
              target={manage}
              onTarget={setManage}
              onEnter={(id) => select(id)}
              onCreate={() => setCreating(true)}
              onDeleted={(id) => {
                if (projectId === id) setProjectId(null);
              }}
            />
          ) : !project ? (
            <div className="empty-state">
              <h1>创建第一个项目</h1>
              <p className="muted">每个项目对应一个代码目录和一个任务看板，可以分别配置飞书任务来源和执行方式。</p>
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                <Icon name="plus" /> 新建项目
              </button>
            </div>
          ) : view === 'history' ? (
            <Records project={project} tasks={projectTasks} queue={queue} history={history[project.id] ?? []} onOpenTask={setOpenId} />
          ) : view === 'board' ? (
            <Board project={project} tasks={projectTasks} queue={queue} deploy={deploys[project.id]} onConfigure={() => openProjectConfig(project.id)} setOpenId={setOpenId} />
          ) : (
            <Inbox
              project={project}
              tasks={projectTasks}
              queue={queue}
              deploy={deploys[project.id]}
              onOpenTask={setOpenId}
              onConfigure={() => openProjectConfig(project.id)}
            />
          )}
        </main>
      </div>

      {openTask && project && (
        <TaskDrawer
          // 切换任务时重建抽屉，避免沿用上一个任务的编辑内容和日志
          key={openTask.id}
          task={openTask}
          project={project}
          running={queue.currentId === openTask.id}
          queue={queue}
          onClose={() => setOpenId(null)}
          onConfirmed={() => setOpenId(null)}
        />
      )}
      {creating && (
        <NewProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            select(p.id);
          }}
        />
      )}
      {guideOpen && (
        <Guide
          projectId={project?.id ?? null}
          go={(v, m) => {
            // 指引的每一步自己带到对应页面；已打开的任务抽屉先收起，免得挡住
            if (m) setManage(m);
            setOpenId(null);
            setView(v);
          }}
          onClose={() => setGuideOpen(false)}
        />
      )}
    </div>
  );
}
