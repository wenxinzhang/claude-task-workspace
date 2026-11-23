// 问题目录：列表 / 独立详情 / 新建与编辑。数据来自问题台账（/api/observations），状态与权限沿用后端规则
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, checkImage, fmtDateTime, uploadScreenshot, type Observation, type Project, type Proposal } from './api.ts';
import { OBSERVATION_SECTION_KEYS, OBSERVATION_SECTION_LABEL, type ObservationSectionKey, type ObservationSections, type ObservationStatus } from '../../server/observe-types.ts';
import { ISSUE_TITLE_LIMIT, OBSERVATION_TEXT_LIMIT, observationSections } from '../../server/observation-review.ts';
import { ObservationDetail } from './ObservationDetail.tsx';

export const KIND_LABEL: Record<Observation['kind'], string> = {
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
  usage_friction: '使用摩擦',
  screenshot_finding: '截图诊断',
  manual: '人工录入',
};

/** 后端只有三种状态，页面不另造状态 */
export const STATUS_LABEL: Record<ObservationStatus, string> = { new: '待处理', resolved: '已解决', ignored: '已忽略' };
const STATUSES: ObservationStatus[] = ['new', 'resolved', 'ignored'];

const SECTION_HINT: Record<ObservationSectionKey, string> = {
  problem: '实际发生了什么、在什么条件下发生，有哪些执行记录或证据',
  impact: '影响了哪些任务、流程环节或使用者',
  goal: '修复后应该达到的业务表现',
  plan: '具体改哪里、怎么处理，可关联优化提案',
  verification: '如何复验、看到什么结果才算解决',
};
const REQUIRED: ObservationSectionKey[] = ['problem', 'goal'];

export interface IssueFilters {
  query: string;
  status: '' | ObservationStatus;
  kind: string;
  sort: 'created' | 'updated';
}
export const DEFAULT_FILTERS: IssueFilters = { query: '', status: '', kind: '', sort: 'created' };

export const updatedAt = (o: Observation) => o.updatedAt ?? o.resolvedAt ?? o.at;
const pad = (n: number) => String(n).padStart(2, '0');
const fmtDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const sourceLabel = (o: Observation) =>
  o.kind === 'manual' ? '人工录入' : o.kind === 'flow_finding' ? '流程审查' : o.kind === 'screenshot_finding' ? '截图诊断' : o.source === 'llm' ? 'LLM 复盘' : '代码采集';
export const issueHref = (o: Pick<Observation, 'number' | 'id'>) => `#/observer/issues/${o.number ?? o.id}`;

export function StatusBadge({ status }: { status: ObservationStatus }) {
  return <span className="oi-badge" data-state={status}>{STATUS_LABEL[status]}</span>;
}

function projectNameOf(projects: Project[], id: string) {
  return id ? projects.find((p) => p.id === id)?.name ?? id.slice(0, 8) : '全局';
}

// ---------------- 列表 ----------------

interface ListProps {
  observations: Observation[];
  projects: Project[];
  filters: IssueFilters;
  onFilters: (f: IssueFilters) => void;
}

export function IssueList({ observations, projects, filters, onFilters }: ListProps) {
  const [msg, setMsg] = useState<string | null>(null);
  const set = <K extends keyof IssueFilters>(k: K, v: IssueFilters[K]) => onFilters({ ...filters, [k]: v });
  const q = filters.query.trim().toLowerCase();
  const num = /^#?\s*(\d+)$/.exec(q)?.[1];
  // 记住的类型筛选如果已经没有记录（被清理了），也要留在下拉里，否则下拉显示「全部类型」但列表是空的
  const kinds = [...new Set([...observations.map((o) => o.kind), ...(filters.kind ? [filters.kind as Observation['kind']] : [])])];
  const rows = observations
    .filter((o) => (!filters.status || o.status === filters.status) && (!filters.kind || o.kind === filters.kind))
    .filter((o) => !q || o.title.toLowerCase().includes(q) || (num !== undefined && String(o.number ?? '') === num))
    .sort((a, b) => (filters.sort === 'updated' ? updatedAt(b) - updatedAt(a) : (b.number ?? 0) - (a.number ?? 0) || b.at - a.at));

  return (
    <>
      <div className="oi-filters">
        <div className="oi-search">
          <input type="search" aria-label="搜索问题" placeholder="搜索标题或编号" value={filters.query} onChange={(e) => set('query', e.target.value)} />
        </div>
        <select aria-label="按状态筛选" value={filters.status} onChange={(e) => set('status', e.target.value as IssueFilters['status'])}>
          <option value="">全部状态</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <select aria-label="按类型筛选" value={filters.kind} onChange={(e) => set('kind', e.target.value)}>
          <option value="">全部类型</option>
          {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <select aria-label="问题排序" value={filters.sort} onChange={(e) => set('sort', e.target.value as IssueFilters['sort'])}>
          <option value="created">最新创建</option>
          <option value="updated">最近更新</option>
        </select>
      </div>
      <div className="oi-panel">
        <div className="oi-list-head">
          <span>问题</span><span>状态</span><span className="oi-hide-sm">类型</span><span className="oi-hide-sm">负责人</span><span className="oi-hide-sm">最后更新</span>
        </div>
        {rows.map((o) => (
          <a key={o.id} href={issueHref(o)} className="oi-row">
            <span>
              <strong>{o.title}</strong>
              <small><span className="oi-mono">#{o.number ?? '—'}</span> · {projectNameOf(projects, o.projectId)} · {sourceLabel(o)}</small>
            </span>
            <span><StatusBadge status={o.status} /></span>
            <span className="oi-hide-sm"><span className="oi-pill">{KIND_LABEL[o.kind]}</span></span>
            <span className="oi-hide-sm oi-muted">{o.owner || '待分配'}</span>
            <time className="oi-hide-sm oi-muted" dateTime={new Date(updatedAt(o)).toISOString()}>{fmtDate(updatedAt(o))}</time>
          </a>
        ))}
        {rows.length === 0 && <div className="oi-empty">{observations.length ? '没有符合当前筛选条件的问题' : '还没有问题记录'}</div>}
        <div className="oi-list-foot">
          <span>显示 {rows.length} 条 · 共 {observations.length} 条问题</span>
          <span className="grow" />
          <span role="status">{msg && <span className="error">{msg}</span>}</span>
          {observations.some((o) => o.status !== 'new') && (
            <button
              className="link"
              title="删除已解决和已忽略的记录；待处理的保留"
              onClick={() => {
                const n = observations.filter((o) => o.status !== 'new').length;
                if (!window.confirm(`删除 ${n} 条已解决和已忽略的问题？删除后不能恢复（仍被已应用提案引用、或刚解决的流程问题会保留）。`)) return;
                void api('/api/observations/clear', 'POST').then(() => setMsg(null), (e: Error) => setMsg(e.message));
              }}
            >
              清理已处理的
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** 截图诊断入口：沿用原台账的上传流程，诊断结果作为新问题进入目录 */
export function ScreenshotDiagnose() {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const start = async () => {
    if (!file) return;
    setBusy(true);
    try {
      await uploadScreenshot(file, '', note);
      setFile(null);
      setNote('');
      setMsg({ text: '诊断已开始，结果稍后出现在问题目录（可能需要几分钟）' });
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const err = checkImage(f);
          if (err) return setMsg({ text: err, error: true });
          setFile(f);
          setMsg(null);
        }}
      />
      <button className="oi-btn" data-usage="btn-screenshot-diagnose" disabled={busy} onClick={() => input.current?.click()}>上传截图诊断</button>
      {(file || msg) && (
        <div className="oi-shot">
          {msg && <span className={msg.error ? 'error' : 'oi-muted'} role="status">{msg.text}</span>}
          {file && (
            <>
              <span className="oi-muted">已选截图：{file.name}</span>
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="补充说明（可选）：哪里不对、期望是什么样" aria-label="截图补充说明" maxLength={2000} disabled={busy} />
              <p className="oi-muted">截图交给本机配置的观察者代理做只读诊断，代理会把截图发给它所配置的模型服务分析。产出建议进入问题目录，不会直接改代码；截图暂存在本地，可在详情里删除。</p>
              <div className="oi-actions">
                <button className="oi-btn" disabled={busy} onClick={() => { setFile(null); setNote(''); }}>取消</button>
                <button className="oi-btn oi-primary" disabled={busy} onClick={() => void start()}>{busy ? '上传中…' : '开始诊断'}</button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ---------------- 详情 ----------------

function Sections({ sections }: { sections: ObservationSections }) {
  return (
    <>
      {OBSERVATION_SECTION_KEYS.map((k) => (
        <section key={k}>
          <h3>{OBSERVATION_SECTION_LABEL[k]}</h3>
          {sections[k] ? <div className="oi-body">{sections[k]}</div> : <div className="oi-body oi-muted">待补充</div>}
        </section>
      ))}
    </>
  );
}

export function Crumb({ children }: { children: ReactNode }) {
  return (
    <nav className="oi-crumb" aria-label="面包屑">
      <a href="#/observer/issues">问题目录</a>
      <span aria-hidden="true">/</span>
      <span>{children}</span>
    </nav>
  );
}

interface DetailProps {
  observation: Observation;
  projects: Project[];
  proposals: Proposal[];
  onOpenTask: (projectId: string, taskId: string) => void;
}

export function IssueDetail({ observation: o, projects, proposals, onOpenTask }: DetailProps) {
  const [editing, setEditing] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const sections = observationSections(o);
  const related = proposals.filter((p) => p.id === o.proposalId || p.problemIds.includes(o.id));
  const project = projectNameOf(projects, o.projectId);
  const c = o.context;
  const facts = [
    c.provider && `代理 ${c.provider}${c.model ? ` / ${c.model}` : ''}`,
    c.durationMs !== undefined && `耗时 ${Math.round(c.durationMs / 1000)} 秒`,
    c.toolCalls != null && `工具调用 ${c.toolCalls} 次`,
    c.costUsd !== undefined && `花费 $${c.costUsd.toFixed(2)}`,
    c.gateVerdict && `门禁结论 ${c.gateVerdict}`,
    c.envName && `环境 ${c.envName}`,
  ].filter(Boolean) as string[];

  const changeStatus = async (status: ObservationStatus) => {
    try {
      await api(`/api/observations/${o.id}/status`, 'POST', { status });
      setStatusMsg({ text: '状态已更新' });
    } catch (e) {
      setStatusMsg({ text: (e as Error).message, error: true });
    }
  };

  if (editing) {
    return (
      <>
        <Crumb><a href={issueHref(o)}>#{o.number}</a> / 编辑</Crumb>
        <div className="oi-title"><h1>编辑问题</h1></div>
        <IssueForm
          mode="edit"
          manual={o.kind === 'manual'}
          projects={projects}
          initial={{ title: o.title, sections, owner: o.owner ?? '', projectId: o.projectId, source: '' }}
          onCancel={() => setEditing(false)}
          onSubmit={async (v) => {
            await api(`/api/observations/${o.id}/content`, 'POST', { title: v.title, sections: v.sections, owner: v.owner });
            setEditing(false);
          }}
        />
      </>
    );
  }

  return (
    <>
      <Crumb>#{o.number}</Crumb>
      <div className="oi-title">
        <div className="oi-title-row">
          <h1>{o.title}</h1>
          <button className="oi-btn" onClick={() => setEditing(true)}>编辑</button>
        </div>
        <p>
          <span className="oi-mono">#{o.number}</span>
          <StatusBadge status={o.status} />
          <span>更新于 {fmtDateTime(updatedAt(o))}</span>
          <span>· 创建于 {fmtDateTime(o.at)}</span>
        </p>
      </div>
      <div className="oi-detail-grid">
        <div className="oi-stack">
          <article className="oi-panel">
            <h2 className="oi-card-head">问题说明</h2>
            <div className="oi-desc"><Sections sections={sections} /></div>
          </article>
          {o.kind !== 'manual' && (o.detail || facts.length > 0) && (
            <article className="oi-panel">
              <h2 className="oi-card-head">原始观察记录</h2>
              <div className="oi-desc">
                <section>
                  {o.detail ? <pre className="oi-raw">{o.detail}</pre> : <p className="oi-muted">（无原文）</p>}
                  {facts.length > 0 && <p className="oi-muted oi-facts">{facts.join(' · ')}</p>}
                </section>
              </div>
            </article>
          )}
          {c.screenshotToken && <ScreenshotBlock token={c.screenshotToken} />}
        </div>
        <aside className="oi-panel oi-side" aria-label="问题属性">
          <h2>问题属性</h2>
          <dl>
            <div><dt>所属项目</dt><dd>{project}</dd></div>
            <div><dt>问题类型</dt><dd><span className="oi-pill">{KIND_LABEL[o.kind]}</span></dd></div>
            <div><dt>负责人</dt><dd>{o.owner || '待分配'}</dd></div>
            <div><dt>发现来源</dt><dd>{o.kind === 'manual' && o.detail.startsWith('发现来源：') ? o.detail.slice(5) : sourceLabel(o)}</dd></div>
            <div>
              <dt>关联执行记录</dt>
              <dd>{o.taskId ? <button className="link" onClick={() => onOpenTask(o.projectId, o.taskId!)}>查看关联任务 ↗</button> : '暂无'}</dd>
            </div>
            <div>
              <dt>关联优化提案</dt>
              <dd>
                {related.length
                  ? related.map((p) => <a key={p.id} className="oi-ref" href={`#/observer/proposals/${p.id}`}>{p.title}</a>)
                  : '暂无'}
              </dd>
            </div>
            {o.issue && (
              <div><dt>GitHub Issue</dt><dd><a className="oi-ref" href={o.issue.url} target="_blank" rel="noreferrer">#{o.issue.number} ↗</a></dd></div>
            )}
          </dl>
          <label htmlFor="oi-status">处理状态</label>
          <select id="oi-status" value={o.status} onChange={(e) => void changeStatus(e.target.value as ObservationStatus)}>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
          {statusMsg && <small className={statusMsg.error ? 'error' : 'oi-ok'} role="status">{statusMsg.text}</small>}
          {!o.issue && (
            <button className="oi-btn oi-side-btn" onClick={() => setGithubOpen(true)}>提交到 GitHub Issues</button>
          )}
        </aside>
      </div>
      {githubOpen && (
        <ObservationDetail
          observation={o}
          projectName={project}
          kindLabel={KIND_LABEL[o.kind]}
          statusLabel={STATUS_LABEL[o.status]}
          onClose={() => setGithubOpen(false)}
          onOpenTask={(taskId) => onOpenTask(o.projectId, taskId)}
        />
      )}
    </>
  );
}

function ScreenshotBlock({ token }: { token: string }) {
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <article className="oi-panel">
      <h2 className="oi-card-head">诊断截图</h2>
      <div className="oi-desc">
        <section>
          {gone ? (
            <p className="oi-muted">截图文件已删除或不存在</p>
          ) : (
            <>
              <img className="oi-shot-img" src={`/api/observations/screenshot/${token}`} alt="用户上传的诊断截图" loading="lazy" onError={() => setGone(true)} />
              <div className="oi-actions">
                {error && <span className="error">{error}</span>}
                <button className="oi-btn" onClick={() => api(`/api/observations/screenshot/${token}`, 'DELETE').then(() => setGone(true), (e) => setError((e as Error).message))}>删除截图文件</button>
              </div>
            </>
          )}
        </section>
      </div>
    </article>
  );
}

// ---------------- 新建 / 编辑表单 ----------------

export interface IssueFormValue {
  title: string;
  sections: ObservationSections;
  owner: string;
  projectId: string;
  source: string;
}

interface FormProps {
  mode: 'new' | 'edit';
  /** 编辑的是手动问题：和后端一致，「要解决什么」也必填 */
  manual?: boolean;
  projects: Project[];
  initial: IssueFormValue;
  onCancel: () => void;
  onSubmit: (v: IssueFormValue) => Promise<void>;
}

export function IssueForm({ mode, manual = false, projects, initial, onCancel, onSubmit }: FormProps) {
  const [v, setV] = useState<IssueFormValue>(initial);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 校验没过的字段：标红并把错误文字关联给读屏
  const [invalid, setInvalid] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  // 新建时 problem / goal 必填；编辑旧记录不强制补「要解决什么」，缺了就继续显示待补充
  const required = mode === 'new' || manual ? REQUIRED : (['problem'] as ObservationSectionKey[]);
  const setSection = (k: ObservationSectionKey, text: string) => setV({ ...v, sections: { ...v.sections, [k]: text } });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const missing = !v.title.trim() ? 'title' : required.find((k) => !v.sections[k]?.trim());
    if (missing) {
      setPreview(false);
      setInvalid(missing);
      setError(`请填写「${missing === 'title' ? '问题标题' : OBSERVATION_SECTION_LABEL[missing as ObservationSectionKey]}」`);
      // 等切回填写后再聚焦
      requestAnimationFrame(() => (form.current?.elements.namedItem(missing) as HTMLElement | null)?.focus());
      return;
    }
    setBusy(true);
    setError(null);
    setInvalid(null);
    try {
      await onSubmit(v);
    } catch (err) {
      // 失败保留已填内容
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form ref={form} className="oi-panel oi-form" onSubmit={submit} noValidate>
      <label>
        问题标题
        <input
          name="title"
          value={v.title}
          onChange={(e) => setV({ ...v, title: e.target.value })}
          maxLength={ISSUE_TITLE_LIMIT}
          placeholder="一句话描述看到的问题"
          disabled={busy}
          aria-required
          aria-invalid={invalid === 'title' || undefined}
          aria-describedby={invalid === 'title' ? 'oi-form-error' : undefined}
        />
      </label>
      <div className="oi-form-row">
        {mode === 'new' && (
          <label>
            所属项目
            <select value={v.projectId} onChange={(e) => setV({ ...v, projectId: e.target.value })} disabled={busy}>
              <option value="">全局（不属于某个项目）</option>
              {projects.filter((p) => !p.archived).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <label>
          负责人 <span>（可选）</span>
          <input value={v.owner} onChange={(e) => setV({ ...v, owner: e.target.value })} maxLength={60} placeholder="待分配" disabled={busy} />
        </label>
        {mode === 'new' && (
          <label>
            发现来源 <span>（可选）</span>
            <input value={v.source} onChange={(e) => setV({ ...v, source: e.target.value })} maxLength={120} placeholder="例如流程审查或执行记录" disabled={busy} />
          </label>
        )}
      </div>
      <div className="oi-edit-tabs" role="group" aria-label="问题说明">
        <button type="button" className="oi-btn" aria-pressed={!preview} onClick={() => setPreview(false)}>填写</button>
        <button type="button" className="oi-btn" aria-pressed={preview} onClick={() => setPreview(true)}>预览</button>
      </div>
      {preview ? (
        <div className="oi-preview">
          <h2>{v.title.trim() || <span className="oi-muted">（未填写标题）</span>}</h2>
          <Sections sections={Object.fromEntries(Object.entries(v.sections).map(([k, t]) => [k, t?.trim()]))} />
        </div>
      ) : (
        <div className="oi-stack">
          {OBSERVATION_SECTION_KEYS.map((k) => (
            <label key={k}>
              {OBSERVATION_SECTION_LABEL[k]} {!required.includes(k) && <span>（可选）</span>}
              <textarea
                name={k}
                value={v.sections[k] ?? ''}
                onChange={(e) => setSection(k, e.target.value)}
                maxLength={OBSERVATION_TEXT_LIMIT}
                placeholder={SECTION_HINT[k]}
                rows={4}
                disabled={busy}
                aria-required={required.includes(k) || undefined}
                aria-invalid={invalid === k || undefined}
                aria-describedby={invalid === k ? 'oi-form-error' : undefined}
              />
            </label>
          ))}
        </div>
      )}
      {error && <p id="oi-form-error" role="alert" className="error">{error}</p>}
      <div className="oi-actions">
        <button type="button" className="oi-btn" disabled={busy} onClick={onCancel}>取消</button>
        <button className="oi-btn oi-primary" disabled={busy}>{busy ? '提交中…' : mode === 'new' ? '创建问题' : '保存修改'}</button>
      </div>
    </form>
  );
}
