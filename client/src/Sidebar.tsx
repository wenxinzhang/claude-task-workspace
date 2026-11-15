import { useEffect, useRef, useState } from 'react';
import type { Project } from './api.ts';
import { Icon } from './Icon.tsx';
import logoMark from './assets/fuxing-fde-mark.png';

export type View = 'projects' | 'inbox' | 'board' | 'history' | 'observer';

export const VIEW_LABEL: Record<View, string> = {
  projects: '项目管理',
  inbox: '任务收件箱',
  board: '任务看板',
  history: '执行记录',
  observer: '观察者',
};

/** 工作区一级目录：作用于下拉框选中的当前项目，不再按项目嵌套 */
const WORKSPACE: { key: View; icon: string }[] = [
  { key: 'inbox', icon: 'inbox' },
  { key: 'board', icon: 'board' },
  { key: 'history', icon: 'clock' },
];

/** 项目切换器：自绘下拉，替代原生 select 的系统弹窗，键盘可用 */
function ProjectPicker({
  projects,
  currentId,
  onSelect,
  onManage,
}: {
  projects: Project[] | null;
  currentId: string | null;
  onSelect: (id: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = projects?.find((p) => p.id === currentId);

  // 点击外部关闭；Esc 关闭并回到触发按钮
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  const toggle = () => {
    if (!open) setActive(Math.max(0, (projects ?? []).findIndex((p) => p.id === currentId)));
    setOpen(!open);
  };

  const choose = (p: Project) => {
    onSelect(p.id);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const list = projects ?? [];
    if (!list.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(list.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(list[active]);
    }
  };

  return (
    <div className="project-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        className={`picker-trigger ${open ? 'open' : ''}`}
        onClick={toggle}
        disabled={!projects?.length}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="切换当前项目"
      >
        <span className="picker-ico">
          <Icon name="layers" />
        </span>
        <span className="grow ellipsis picker-name">{current?.name ?? (projects === null ? '加载中…' : '暂无项目')}</span>
        <Icon name="chevron" size={14} className={`chev ${open ? 'open' : ''}`} />
      </button>

      {!!projects?.length && (
        // 常挂载、hidden 收起：展开时 display 变化重放入场动画，入口也始终在 DOM 中
        <div className="picker-pop" role="listbox" aria-label="选择项目" ref={listRef} tabIndex={-1} hidden={!open} onKeyDown={onListKey}>
          <div className="picker-pop-head">
            切换项目 <span className="tag">{projects.length}</span>
          </div>
          {projects.map((p, i) => (
            <button
              key={p.id}
              role="option"
              aria-selected={p.id === currentId}
              className={`picker-option ${p.id === currentId ? 'selected' : ''} ${i === active ? 'active' : ''}`}
              onClick={() => choose(p)}
              onMouseEnter={() => setActive(i)}
            >
              <Icon name="layers" size={14} />
              <span className="grow ellipsis">{p.name}</span>
              {p.id === currentId && <Icon name="check" size={14} />}
            </button>
          ))}
          <button
            className="picker-manage"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            <Icon name="folder" size={14} /> 管理项目
            <span className="grow" />
            <Icon name="external" size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

interface Props {
  projects: Project[] | null;
  currentId: string | null;
  view: View;
  connected: boolean;
  /** 待确认提案数：>0 时观察者入口显示角标 */
  observerPending?: number;
  onNav: (v: View) => void;
  onSelectProject: (id: string) => void;
  onCreate: () => void;
}

/** 侧边栏：项目下拉框 + 当前项目的收件箱 / 看板 / 记录；底部是全局的观察者与项目管理（含各项目配置与全局设置） */
export function Sidebar({ projects, currentId, view, connected, observerPending = 0, onNav, onSelectProject, onCreate }: Props) {
  // 归档项目不出现在切换器里，在「项目管理 → 已归档」中管理
  const pickable = projects?.filter((p) => !p.archived) ?? null;
  const hasProject = !!pickable?.some((p) => p.id === currentId);
  return (
    <aside className="side">
      <div className="brand">
        {/* 图形是装饰，名称由旁边的文字给出，所以 alt 留空 */}
        <img className="brand-mark" src={logoMark} alt="" width={37} height={48} loading="eager" />
        <div>
          <div className="brand-name">FUXING-FDE</div>
          <div className="brand-sub">AI SECOND BRAIN</div>
        </div>
      </div>

      <div className="side-scroll">
        <nav className="main-nav" aria-label="主导航">
          <ProjectPicker projects={pickable} currentId={currentId} onSelect={onSelectProject} onManage={() => onNav('projects')} />

          {hasProject &&
            WORKSPACE.map((n) => (
              <button key={n.key} data-guide={n.key} className={`nav-item ${view === n.key ? 'active' : ''}`} onClick={() => onNav(n.key)} aria-current={view === n.key ? 'page' : undefined}>
                <Icon name={n.icon} />
                <span className="grow">{VIEW_LABEL[n.key]}</span>
              </button>
            ))}

          {pickable?.length === 0 && (
            <button className="nav-item" onClick={onCreate}>
              <Icon name="plus" />
              <span className="grow">新建项目</span>
            </button>
          )}
        </nav>
      </div>

      <div className="side-foot">
        <button data-guide="observer" className={`nav-item ${view === 'observer' ? 'active' : ''}`} onClick={() => onNav('observer')} aria-current={view === 'observer' ? 'page' : undefined}>
          <Icon name="eye" />
          <span className="grow">观察者</span>
          {observerPending > 0 && <span className="nav-badge" aria-label={`${observerPending} 个待批准提案`}>{observerPending}</span>}
        </button>
        {/* 项目的配置、执行方式与全局设置都在这一个入口里 */}
        <button data-guide="projects" className={`nav-item ${view === 'projects' ? 'active' : ''}`} onClick={() => onNav('projects')} aria-current={view === 'projects' ? 'page' : undefined}>
          <Icon name="sliders" />
          <span className="grow">项目管理</span>
        </button>
        <div className="conn">
          <span className={`dot ${connected ? 'ok' : 'off'}`} aria-hidden />
          {connected ? '本机服务已连接' : '服务未连接'}
        </div>
      </div>
    </aside>
  );
}
