import { useEffect, useRef, useState } from 'react';
import { api, type FlowMetrics, type Observation, type ObserverStatus, type Project, type Proposal } from './api.ts';
import { FlowHealth } from './FlowHealth.tsx';
import { Crumb, DEFAULT_FILTERS, IssueDetail, IssueForm, IssueList, ScreenshotDiagnose, issueHref, type IssueFilters } from './IssueCatalog.tsx';
import { Proposals } from './Proposals.tsx';
import { UsageInsights } from './UsageInsights.tsx';

interface Props {
  observations: Observation[];
  proposals: Proposal[];
  status: ObserverStatus | null;
  flow: Record<string, FlowMetrics>;
  projects: Project[];
  currentProjectId: string | null;
  onOpenTask: (projectId: string, taskId: string) => void;
}

/** 观察者的前端路由：用 hash，刷新、直接访问、浏览器前进后退都能用，不需要后端配合 */
export type ObserverRoute =
  | { page: 'issues' }
  | { page: 'issue'; ref: string }
  | { page: 'new' }
  | { page: 'proposals'; id?: string }
  | { page: 'insights' };

export const OBSERVER_HASH = '#/observer';

export function parseObserverHash(hash: string): ObserverRoute | null {
  if (!hash.startsWith(OBSERVER_HASH)) return null;
  let parts: string[];
  try {
    parts = hash.slice(OBSERVER_HASH.length).split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    // 链接被截断、带非法 % 序列：回到目录，不让整个应用白屏
    return { page: 'issues' };
  }
  if (parts[0] === 'proposals') return { page: 'proposals', id: parts[1] };
  if (parts[0] === 'insights') return { page: 'insights' };
  if (parts[0] === 'issues' && parts[1] === 'new') return { page: 'new' };
  if (parts[0] === 'issues' && parts[1]) return { page: 'issue', ref: parts[1] };
  return { page: 'issues' };
}

// 目录的搜索和筛选：离开目录（进详情、切到别的视图）再回来仍保留；刷新后也还在
const FILTER_KEY = 'observerIssueFilters';
const readFilters = (): IssueFilters => {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(sessionStorage.getItem(FILTER_KEY) ?? '{}') };
  } catch {
    return DEFAULT_FILTERS;
  }
};

// 本次打开页面后是否在站内换过地址：没换过（新标签页直接打开）时「取消」不能用后退，否则会离开应用
let navigatedInApp = false;

function useHashRoute(): ObserverRoute {
  const [route, setRoute] = useState<ObserverRoute>(() => parseObserverHash(location.hash) ?? { page: 'issues' });
  useEffect(() => {
    const on = () => {
      navigatedInApp = true;
      setRoute(parseObserverHash(location.hash) ?? { page: 'issues' });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

/** 观察者页：默认问题目录；优化提案复用原列表与操作；使用洞察收纳流程体检与使用摩擦 */
export function Observer({ observations, proposals, status, flow, projects, currentProjectId, onOpenTask }: Props) {
  const route = useHashRoute();
  const [filters, setFilters] = useState<IssueFilters>(readFilters);
  const main = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      sessionStorage.setItem(FILTER_KEY, JSON.stringify(filters));
    } catch {
      // 无痕模式等场景不可用，忽略
    }
  }, [filters]);
  // 换页时回到顶部，焦点移到内容区，读屏能感知到页面变了
  const routeKey = JSON.stringify(route);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    main.current?.scrollTo(0, 0);
    main.current?.focus({ preventScroll: true });
  }, [routeKey]);

  // 详情页找不到记录时只等几秒推送：刚新建的会在这段时间里到达；超时还没有就是真的不存在（被清理或编号无效）
  const issueRef = route.page === 'issue' ? route.ref : '';
  const [waitedLong, setWaitedLong] = useState(false);
  useEffect(() => {
    setWaitedLong(false);
    if (!issueRef) return;
    const t = setTimeout(() => setWaitedLong(true), 4000);
    return () => clearTimeout(t);
  }, [issueRef]);

  const waiting = proposals.filter((p) => p.status === 'pending').length;
  const openIssues = observations.filter((o) => o.status === 'new').length;
  const tab = route.page === 'proposals' ? 'proposals' : route.page === 'insights' ? 'insights' : 'issues';
  const active = status && (status.applying || status.probing);

  const hero = (
    <>
      <div className="oi-hero">
        <div>
          <h1>观察者</h1>
          <p>追踪执行中发现的问题、处理方案与验收结果</p>
        </div>
        <div className="oi-hero-actions">
          {active && (
            <span role="status" className="oi-hero-status">
              {status!.applying && <span className="pill amber">{status!.applyMode === 'rollback' ? '回滚中' : '应用中'}</span>}
              {status!.probing && <span className="pill purple">复验中</span>}
            </span>
          )}
          {tab === 'issues' && <ScreenshotDiagnose />}
          <a className="oi-btn oi-primary" href={`${OBSERVER_HASH}/issues/new`}><span className="oi-plus" aria-hidden="true">+</span>新建问题</a>
        </div>
      </div>
      <nav className="oi-tabs" aria-label="观察者栏目">
        <a href={`${OBSERVER_HASH}/issues`} aria-current={tab === 'issues' ? 'page' : undefined}>问题目录 <span className="oi-count">{openIssues}</span></a>
        <a href={`${OBSERVER_HASH}/proposals`} aria-current={tab === 'proposals' ? 'page' : undefined}>优化提案 {waiting > 0 && <span className="oi-count">{waiting}</span>}</a>
        <a href={`${OBSERVER_HASH}/insights`} aria-current={tab === 'insights' ? 'page' : undefined}>使用洞察</a>
      </nav>
    </>
  );

  let body;
  if (route.page === 'issue') {
    // 编号优先；旧链接或没编号的记录用 id 兜底
    const o = observations.find((x) => String(x.number) === route.ref) ?? observations.find((x) => x.id === route.ref);
    // 编号比已知的都大：多半是刚新建、实时推送还没到，先显示加载中，不误报「已被清理」
    const maxKnown = observations.reduce((m, x) => Math.max(m, x.number ?? 0), 0);
    const pendingRaw = !observations.length || (/^\d+$/.test(route.ref) && Number(route.ref) > maxKnown);
    body = o ? (
      // 按记录重建：在两个问题的详情之间直接切换时，编辑表单和提示不能沿用上一条的
      <IssueDetail key={o.id} observation={o} projects={projects} proposals={proposals} onOpenTask={onOpenTask} />
    ) : (
      <>
        <Crumb>#{route.ref}</Crumb>
        <p className="oi-muted">{!waitedLong && pendingRaw ? '正在加载…' : '没有找到这个问题，可能已被清理。'}</p>
      </>
    );
  } else if (route.page === 'new') {
    body = (
      <>
        <Crumb>新建问题</Crumb>
        <div className="oi-title"><h1>新建问题</h1></div>
        <IssueForm
          mode="new"
          projects={projects}
          initial={{ title: '', sections: {}, owner: '', projectId: currentProjectId ?? '', source: '' }}
          // 新标签页直接打开新建页时没有站内上一页：回目录，而不是离开应用
          onCancel={() => (navigatedInApp ? window.history.back() : location.replace(`${OBSERVER_HASH}/issues`))}
          onSubmit={async (v) => {
            const created = await api<Observation>('/api/observations', 'POST', v);
            // 替换掉表单这一步：从详情页后退直接回目录，不回到已提交的表单
            location.replace(issueHref(created));
          }}
        />
      </>
    );
  } else if (route.page === 'proposals') {
    body = (
      <>
        {hero}
        <Proposals key={route.id ?? ''} proposals={proposals} observations={observations} status={status} focusId={route.id} />
      </>
    );
  } else if (route.page === 'insights') {
    body = (
      <>
        {hero}
        <FlowHealth flow={flow} projects={projects} />
        <UsageInsights />
      </>
    );
  } else {
    body = (
      <>
        {hero}
        <IssueList observations={observations} projects={projects} filters={filters} onFilters={setFilters} />
      </>
    );
  }

  return (
    <div className="observer-page oi-page" ref={main} tabIndex={-1}>
      <div className="oi-content">{body}</div>
    </div>
  );
}
