import { useEffect, useMemo, useRef, useState } from 'react';
import { api, defaultEnv, fmtDayTime, statusLabel, type DeployStatus, type Project, type QueueStatus, type TaskBrief } from './api.ts';
import { feishuRecordUrl, openQuestions } from '../../server/shared.ts';
import { DeployPanel, confirmDeploy } from './Deploy.tsx';
import { Icon } from './Icon.tsx';
import { DiffView, SpecSummary } from './TaskDrawer.tsx';

interface Props {
  project: Project;
  tasks: TaskBrief[];
  queue: QueueStatus;
  deploy?: DeployStatus;
  onOpenTask: (id: string) => void;
  onConfigure: () => void;
}

/** 状态 pill 颜色；显示名统一走 statusLabel */
const STATUS_PILL: Record<string, { cls: string }> = {
  pending_confirm: { cls: 'soft' },
  todo: { cls: 'blue' },
  in_progress: { cls: 'amber' },
  testing: { cls: 'amber' },
  review: { cls: 'purple' },
  done: { cls: 'ok' },
  blocked: { cls: 'err' },
};

export const shortId = (id: string) => `#${id.slice(0, 6)}`;

/** 飞书原文定位链接：优先在项目配置的原链接上定位记录，保留知识库/页签上下文 */
function feishuLink(project: Project, t: TaskBrief): string | null {
  if (t.sourceKey) {
    const link = feishuRecordUrl(project.feishu.url, t.sourceKey);
    if (link) return link;
  }
  return t.source === 'feishu' ? project.feishu.url || null : null;
}

/** 任务收件箱：左侧飞书任务列表，右侧问题详情 / 验收规格 / 代码变更 */
export function Inbox({ project, tasks, queue, deploy, onOpenTask, onConfigure }: Props) {
  // 进来先看还没做完的；做完的单独一个页签。每条任务具体在哪个阶段看它自己的状态标签
  const [tab, setTab] = useState<'open' | 'done' | 'all'>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [detailTab, setDetailTab] = useState<'detail' | 'spec' | 'diff'>('detail');
  const [shot, setShot] = useState(0);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const [err, setErr] = useState('');
  const specTimer = useRef<number | undefined>(undefined);
  // 正在输入的回答先留在本地：输入框的内容原先只来自服务端推回的规格，
  // 保存有 500ms 防抖，期间每敲一个字都基于旧规格重算，结果是打字看不到、最后只存下最后一个字
  const [specDraft, setSpecDraft] = useState<{ id: string; spec: NonNullable<TaskBrief['spec']> } | null>(null);
  // 还没发出的保存，以及正在路上的保存数：两者都为空时，草稿才可以让位给服务端的规格
  const pendingSpec = useRef<{ id: string; spec: NonNullable<TaskBrief['spec']> } | null>(null);
  const savingSpec = useRef(0);
  const [deployErr, setDeployErr] = useState('');

  useEffect(() => {
    setSelectedId(null);
    setNotice(null);
    setDetailTab('detail');
  }, [project.id]);

  const listed = useMemo(() => {
    const list = tab === 'all' ? tasks : tasks.filter((t) => (t.status === 'done') === (tab === 'done'));
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [tasks, tab]);

  const selected = listed.find((t) => t.id === selectedId) ?? listed[0];
  useEffect(() => {
    setShot(0);
  }, [selected?.id]);

  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const counts = { open: tasks.length - doneCount, done: doneCount, all: tasks.length };

  const doImport = async () => {
    setImporting(true);
    setNotice(null);
    try {
      const r = await api<{ total: number; matched: number; created: number; skipped: number; synced: number }>(`/api/projects/${project.id}/import`, 'POST');
      const filtered = r.matched !== r.total ? `，符合过滤条件 ${r.matched} 条` : '';
      const synced = r.synced ? `，按飞书状态移动 ${r.synced} 个任务` : '';
      setNotice({ text: `共 ${r.total} 条记录${filtered}，新增 ${r.created} 条，跳过已导入 ${r.skipped} 条${synced}` });
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true });
    } finally {
      setImporting(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  /**
   * 把还没发出的回答立即保存，返回这次保存的完成时机（没有待发内容时立即完成）。
   * 切换任务、离开收件箱、点会用到规格的按钮之前都先调它，否则最后一段输入会丢。
   * 刷新或关闭标签页不走这里：最后 500ms 内的输入仍可能丢。
   */
  const flushSpec = (): Promise<void> => {
    window.clearTimeout(specTimer.current);
    const p = pendingSpec.current;
    if (!p) return Promise.resolve();
    pendingSpec.current = null;
    savingSpec.current++;
    return act(() => api(`/api/tasks/${p.id}`, 'PATCH', { spec: p.spec })).finally(() => {
      savingSpec.current--;
    });
  };
  // 切换任务或离开收件箱时，把没发出的保存发出去
  useEffect(
    () => () => {
      void flushSpec();
    },
    [selected?.id],
  );
  // 这条任务在服务端有了更新、且本地没有待发或在途的保存：草稿作废。
  // 不这样做的话草稿会一直盖住服务端的规格，下次输入时把别处的修改整份写回旧值。
  // 自己的保存通常不会触发这里（推送先于保存的响应到达，那时还算在途），草稿会留到这条任务下一次被别处更新
  useEffect(() => {
    if (!pendingSpec.current && savingSpec.current === 0) setSpecDraft(null);
  }, [selected?.id, selected?.analyzing, selected?.updatedAt]);

  /** 部署面板里的「重新部署」：与任务看板的同一个面板行为一致 */
  const redeploy = async () => {
    const env = defaultEnv(project);
    // 没有部署命令时不发请求：是否弹确认看的是本页面的数据，是否部署看的是服务端的数据，
    // 两边不一致时（别处刚配好命令）发出去就会不经确认直接开始部署
    if (!env.deployCommand) return setDeployErr(`请先在「项目管理 → 配置 → 部署环境 → ${env.name}」中填写部署命令`);
    setDeployErr('');
    try {
      // 先检查是不是已经是最新版本，再确认：与顶栏的「一键部署」同一套
      const go = await confirmDeploy(project, env);
      if (!go) return;
      await api(`/api/projects/${project.id}/deploy`, 'POST', { envId: env.id, force: go.force });
    } catch (e) {
      setDeployErr((e as Error).message);
    }
  };

  // 大图打开时 Esc 关闭
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setLightbox(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  const images = (selected?.attachments ?? []).filter((a) => a.type.startsWith('image/'));
  const src = (token: string) => `/api/tasks/${selected!.id}/attachments/${encodeURIComponent(token)}`;
  const open = selected?.spec ? openQuestions(selected.spec).length : 0;
  const link = selected ? feishuLink(project, selected) : null;
  const queueState = queue.currentId ? '执行中' : queue.running ? '队列运行中' : '队列已暂停';

  return (
    <div className="inbox">
      <section className="inbox-list" aria-label="飞书任务列表">
        <div className="inbox-list-head">
          <h2>飞书任务</h2>
          {project.feishu.url ? (
            <button className="btn btn-outline-primary sm" onClick={doImport} disabled={importing}>
              <Icon name="sync" className={importing ? 'spin' : undefined} /> {importing ? '同步中…' : '手动飞书同步'}
            </button>
          ) : (
            <button className="btn btn-outline-primary sm" onClick={onConfigure}>
              配置飞书来源
            </button>
          )}
        </div>
        <div className="inbox-tabs" role="tablist">
          {(
            [
              ['open', '未完成'],
              ['done', '已完成'],
              ['all', '全部'],
            ] as const
          ).map(([key, label]) => (
            <button key={key} role="tab" aria-selected={tab === key} className={`inbox-tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
              {label} {counts[key]}
            </button>
          ))}
        </div>
        {notice && <div className={`notice ${notice.error ? 'error' : ''}`}>{notice.text}</div>}
        <div className="inbox-items">
          {listed.map((t) => {
            const pill = STATUS_PILL[t.status];
            const active = selected?.id === t.id;
            return (
              <button key={t.id} className={`inbox-item ${active ? 'active' : ''}`} onClick={() => setSelectedId(t.id)}>
                <div className="inbox-item-top">
                  <span className="mono muted">{shortId(t.id)}</span>
                  {!!t.attachments?.length && (
                    <span className="muted att-count" title={`${t.attachments.length} 个附件`}>
                      <Icon name="copy" size={13} /> {t.attachments.length}
                    </span>
                  )}
                </div>
                <div className="inbox-item-title">{t.title}</div>
                <div className="inbox-item-meta">
                  <Icon name="rocket" className="feishu-ico" size={13} />
                  <span>{t.source === 'feishu' ? '飞书任务' : '手动创建'}</span>
                  <span className={`pill ${pill.cls}`}>{statusLabel(project, t.status)}</span>
                  <span className="muted">{fmtDayTime(t.updatedAt)}</span>
                </div>
              </button>
            );
          })}
          {listed.length === 0 && (
            <div className="empty-cell">
              {tab === 'all' ? '暂无任务。点「手动飞书同步」拉取多维表格里的记录。' : tab === 'open' ? '没有未完成的任务。做完的在「已完成」里。' : '还没有已完成的任务。'}
            </div>
          )}
        </div>
      </section>

      <section className="inbox-detail" aria-label="任务详情">
        {!selected ? (
          <div className="empty-cell">选择左侧任务查看详情。</div>
        ) : (
          <>
            <div className="inbox-detail-head">
              <div>
                <div className="muted">
                  {shortId(selected.id)} · {selected.source === 'feishu' ? '来自飞书任务' : '手动创建'}
                </div>
                <h1>{selected.title}</h1>
              </div>
              <div className="head-actions">
                {selected.status === 'pending_confirm' && (
                  <>
                    <button
                      className="btn btn-outline-primary"
                      disabled={selected.analyzing}
                      onClick={() => {
                        // 先等没发出的回答存完，再重新生成：否则旧规格的保存会落在生成期间
                        void flushSpec().then(() => act(() => api(`/api/tasks/${selected.id}/analyze`, 'POST')));
                      }}
                    >
                      <Icon name="doc" /> {selected.analyzing ? '生成中…' : selected.analysis ? '重新生成规格' : '生成规格'}
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={selected.analyzing || open > 0}
                      title={open > 0 ? `规格里还有 ${open} 个问题没有回答，回答后才能确认` : `确认规格，放入${statusLabel(project, 'todo')}队列`}
                      onClick={() => {
                        // 先等没发出的回答存完，再确认：确认会冻结规格，顺序反了冻结的就是少了最后几个字的那一版
                        void flushSpec().then(() => act(() => api(`/api/tasks/${selected.id}/confirm`, 'POST')));
                      }}
                    >
                      <Icon name="play" /> 加入修复队列
                    </button>
                  </>
                )}
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    void flushSpec();
                    onOpenTask(selected.id);
                  }}
                  title="打开完整任务抽屉：编辑、执行、验收、追加指令等">
                  更多操作
                </button>
              </div>
            </div>
            {link && (
              <div className="feishu-origin">
                <Icon name="rocket" className="feishu-ico" /> 飞书原文：
                <a className="link" href={link} target="_blank" rel="noreferrer">
                  查看飞书原文 <Icon name="external" size={13} />
                </a>
              </div>
            )}
            {err && <div className="notice error">{err}</div>}

            <div className="detail-tabs" role="tablist">
              {(
                [
                  ['detail', '问题详情'],
                  ['spec', '验收规格'],
                  ['diff', '代码变更'],
                ] as const
              ).map(([key, label]) => (
                <button key={key} role="tab" aria-selected={detailTab === key} className={`detail-tab ${detailTab === key ? 'active' : ''}`} onClick={() => setDetailTab(key)}>
                  {label}
                </button>
              ))}
            </div>

            <div className="detail-body">
              {detailTab === 'detail' && (
                <>
                  <h3 className="bar-title">问题描述</h3>
                  <p className="pre muted-dark">{selected.description || '（没有填写问题描述）'}</p>
                  <h3 className="bar-title shots-title">
                    问题截图 <span className="tag">{images.length}</span>
                  </h3>
                  {images.length === 0 ? (
                    <p className="muted">没有截图。可在「更多操作」里粘贴或上传。</p>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="shot-main"
                        title="点击放大"
                        onClick={() => setLightbox(src(images[Math.min(shot, images.length - 1)].token))}
                      >
                        <img src={src(images[Math.min(shot, images.length - 1)].token)} alt={images[Math.min(shot, images.length - 1)].name} />
                        <span className="shot-page">
                          {Math.min(shot, images.length - 1) + 1} / {images.length}
                        </span>
                        <span className="shot-zoom-hint">
                          <Icon name="zoom" size={13} /> 点击放大
                        </span>
                      </button>
                      <div className="shot-thumbs">
                        {images.map((a, i) => (
                          <button key={a.token} className={`shot-thumb ${i === shot ? 'active' : ''}`} onClick={() => setShot(i)}>
                            <img src={src(a.token)} alt={a.name} loading="lazy" />
                            <small>{a.name}</small>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
              {detailTab === 'spec' &&
                (selected.spec ? (
                  <SpecSummary
                    spec={specDraft?.id === selected.id ? specDraft.spec : selected.spec}
                    exec={project.exec}
                    canAnswer={selected.status === 'pending_confirm' && !selected.analyzing}
                    onChange={(spec) => {
                      setSpecDraft({ id: selected.id, spec });
                      pendingSpec.current = { id: selected.id, spec };
                      // 回答逐字输入，防抖后再写回服务端
                      window.clearTimeout(specTimer.current);
                      specTimer.current = window.setTimeout(() => void flushSpec(), 500);
                    }}
                  />
                ) : (
                  <div className="notice">
                    还没有规格。
                    {selected.status === 'pending_confirm' && (
                      <button className="link" disabled={selected.analyzing} onClick={() => act(() => api(`/api/tasks/${selected.id}/analyze`, 'POST'))}>
                        {selected.analyzing ? '生成中…' : '生成规格'}
                      </button>
                    )}
                  </div>
                ))}
              {detailTab === 'diff' && <DiffView taskId={selected.id} stamp={selected.updatedAt} defaultOpen />}
            </div>
          </>
        )}
      </section>

      <footer className="inbox-foot">
        <span className={`queue-state ${queue.running || queue.currentId ? 'on' : ''}`}>
          <Icon name={queue.running || queue.currentId ? 'play' : 'pause'} /> {queueState}
        </span>
        <span className="muted grow">
          {queue.currentId ? '有任务正在执行，详情见任务看板。' : queue.running ? '按待修改顺序逐个执行。' : '当前没有任务执行，修复队列处于暂停状态。'}
        </span>
        {queue.running ? (
          <button className="btn btn-outline-primary" data-usage="btn-queue-pause" onClick={() => act(() => api(`/api/projects/${project.id}/queue/pause`, 'POST'))}>
            <Icon name="pause" /> 暂停队列
          </button>
        ) : (
          <button className="btn btn-outline-primary" data-usage="btn-queue-start" onClick={() => act(() => api(`/api/projects/${project.id}/queue/start`, 'POST'))}>
            <Icon name="play" /> 启动队列
          </button>
        )}
        <span className="top-divider" aria-hidden />
        <span className="muted">
          <Icon name="branch" /> 最近部署{deploy?.commit ? ` · ${deploy.commit.split(' ')[0]}` : ' · 暂无'}
        </span>
        <button
          className="link"
          onClick={() => {
            setDeployErr('');
            setDeployOpen(true);
          }}
        >
          查看日志 <Icon name="external" size={13} />
        </button>
      </footer>

      {lightbox && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="截图大图" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="截图大图" />
          <span className="lightbox-hint">点击任意处关闭 · Esc</span>
        </div>
      )}
      {deployOpen && <DeployPanel project={project} status={deploy} error={deployErr} onClose={() => setDeployOpen(false)} onRetry={redeploy} />}
    </div>
  );
}
