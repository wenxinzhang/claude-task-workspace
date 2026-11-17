import { useEffect, useMemo, useRef, useState } from 'react';
import { api, checkImage, fieldOf, fmtDuration, STAGE_LABEL, statusLabel, uploadImage, useNow, type DeployStatus, type Project, type QueueStatus, type TaskBrief, type TaskStatus } from './api.ts';
import { openQuestions } from '../../server/shared.ts';
import { Icon } from './Icon.tsx';
import { ImagePicker, imagesFrom } from './ImagePicker.tsx';
import { Activity, DeployRecord, QueueCard } from './Rail.tsx';

interface Props {
  project: Project;
  tasks: TaskBrief[];
  queue: QueueStatus;
  deploy?: DeployStatus;
  onConfigure: () => void;
  setOpenId: (id: string | null) => void;
}

/** 看板列：执行中的两个阶段合成「修复中」，验证中的任务在卡片上打标签 */
/** 列定义：显示名统一走 statusLabel（修复中为合并列，固定名） */
const BOARD: { key: string; color: string; statuses: TaskStatus[] }[] = [
  { key: 'pending_confirm', color: '#9aa39d', statuses: ['pending_confirm'] },
  { key: 'todo', color: '#5b7fd6', statuses: ['todo'] },
  { key: 'fixing', color: '#e0973a', statuses: ['in_progress', 'testing'] },
  { key: 'review', color: '#9a6fd6', statuses: ['review'] },
  { key: 'done', color: '#2f9e6e', statuses: ['done'] },
  { key: 'blocked', color: '#d64545', statuses: ['blocked'] },
];

/** 每一列在等什么：一句话写在列头下面 */
const COLUMN_HINT: Record<string, string> = {
  pending_confirm: '看规格、回答问题，确认后排队',
  todo: '已确认，按顺序逐个执行',
  fixing: '代理改代码，随后自动验证',
  review: '自动验证没验到的，等你看',
  done: '已修改，交给测试',
  blocked: '没跑通，需要处理',
};

/** 拖拽能做的流转：从哪一列拖到哪一列，对应哪个接口动作。其余方向不接受（执行中的任务、已完成的任务不能拖） */
const DROPS: Record<string, { action: string; label: string }> = {
  'pending_confirm>todo': { action: 'confirm', label: '已确认，进入排队' },
  'todo>pending_confirm': { action: 'unconfirm', label: '已退回待确认' },
  'blocked>todo': { action: 'retry', label: '已重新排队' },
  'blocked>pending_confirm': { action: 'reopen', label: '已退回待确认' },
  'review>todo': { action: 'retry', label: '已重新排队' },
  'review>done': { action: 'accept', label: '已验收通过' },
};

export function Board({ project, tasks, queue, deploy, onConfigure, setOpenId }: Props) {
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const now = useNow(!!queue.currentId);
  // 正在拖的卡片来自哪一列、鼠标停在哪一列：用来高亮能放下的列
  const [drag, setDrag] = useState<{ id: string; from: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const canDrop = (to: string) => !!drag && !!DROPS[`${drag.from}>${to}`];
  const drop = async (to: string) => {
    const d = drag;
    setDrag(null);
    setOver(null);
    const rule = d && DROPS[`${d.from}>${to}`];
    if (!d || !rule) return;
    try {
      await api(`/api/tasks/${d.id}/${rule.action}`, 'POST');
      setNotice({ text: rule.label });
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true });
    }
  };

  useEffect(() => {
    setNotice(null);
    setSearch('');
  }, [project.id]);

  const bulk = async (path: string, label: string) => {
    try {
      const r = await api<Record<string, number>>(path, 'POST');
      const skipped = r.skipped ? `，${r.skipped} 条还有问题没回答，未确认` : '';
      setNotice({ text: `${label}：${Object.values(r)[0]} 条${skipped}` });
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true });
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((t) => `${t.title}\n${t.description}`.toLowerCase().includes(q));
  }, [tasks, search]);

  const pendingCount = tasks.filter((t) => t.status === 'pending_confirm').length;
  // 排队名次按全部待修改任务算，不受搜索过滤影响
  const queueOrder = tasks.filter((t) => t.status === 'todo').sort((a, b) => a.order - b.order).map((t) => t.id);
  // 拖到一半卡片被换了列（例如正好被队列取走）：源节点已卸载，dragend 不会触发，这里清掉残留
  useEffect(() => {
    if (!drag) return;
    const t = tasks.find((x) => x.id === drag.id);
    const col = t && BOARD.find((c) => c.statuses.includes(t.status));
    if (!col || col.key !== drag.from) {
      setDrag(null);
      setOver(null);
    }
  }, [tasks, drag]);
  // 异常、待验证两列只在有任务时出现，平时不占位置：正常流程是 待确认 → 待修改 → 修复中 → 已完成
  const columns = BOARD.filter((c) => (c.key !== 'blocked' && c.key !== 'review') || tasks.some((t) => c.statuses.includes(t.status)));

  return (
    <div className="board-page">
      <div className="workspace">
        <section className="board-card">
          <div className="board-head">
            <h2>
              任务看板 <span className="tag">{tasks.length}</span>
            </h2>
            <span className="grow" />
            <details className="menu">
              <summary className="btn btn-ghost sm">批量操作</summary>
              <div className="menu-list">
                <button disabled={!pendingCount} onClick={() => bulk(`/api/projects/${project.id}/analyze-all`, '已加入规格生成队列')}>
                  全部生成规格
                </button>
                <button disabled={!pendingCount} onClick={() => bulk(`/api/projects/${project.id}/confirm-all`, `已确认进入${statusLabel(project, 'todo')}`)}>
                  全部确认
                </button>
                <button onClick={() => setCreating(true)}>新建任务</button>
              </div>
            </details>
            <span className="search-wrap">
              <Icon name="search" />
              <input type="search" aria-label="搜索任务" placeholder="搜索任务" value={search} onChange={(e) => setSearch(e.target.value)} />
            </span>
          </div>

          {notice && (
            <div className={`notice ${notice.error ? 'error' : ''}`} role="status">
              {notice.text}
            </div>
          )}
          {!project.workdir && !notice && (
            <div className="notice">
              这个项目还没有代码目录，代理无法执行任务。
              <button className="link" onClick={onConfigure}>
                打开项目配置 →
              </button>
            </div>
          )}

          <div className="columns" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(140px, 1fr))` }}>
            {columns.map((col) => {
              const items = filtered.filter((t) => col.statuses.includes(t.status)).sort((a, b) => a.order - b.order);
              const label = col.key === 'fixing' ? '修复中' : statusLabel(project, col.key as TaskStatus);
              return (
                <section
                  className={`column ${canDrop(col.key) ? 'droppable' : ''} ${over === col.key && canDrop(col.key) ? 'drop-over' : ''}`}
                  key={col.key}
                  aria-label={label}
                  onDragOver={(e) => {
                    if (!canDrop(col.key)) return;
                    e.preventDefault();
                    setOver(col.key);
                  }}
                  onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
                  onDrop={(e) => {
                    e.preventDefault();
                    void drop(col.key);
                  }}
                >
                  <header>
                    <span className="dot" style={{ background: col.color }} aria-hidden />
                    <strong>{label}</strong>
                    <span className="tag">{items.length}</span>
                  </header>
                  <small className="column-hint muted">{COLUMN_HINT[col.key]}</small>
                  {items.length === 0 ? (
                    <div className="empty">
                      <small>{canDrop(col.key) ? '拖到这里' : '暂无任务'}</small>
                    </div>
                  ) : (
                    // 列占满看板高度，卡片在列内滚动：屏幕高就多显示几张，屏幕矮也不会把页面撑出一屏
                    <div className="column-cards">
                    {items.map((t) => {
                      const running = queue.currentId === t.id;
                      const type = fieldOf(t.description, '类型');
                      const open = t.spec ? openQuestions(t.spec).length : 0;
                      const toCheck = t.gate?.items.filter((i) => i.result === 'unverified').length ?? 0;
                      const firstFail = t.gate?.items.find((i) => i.result === 'fail');
                      return (
                        <button
                          key={t.id}
                          className={`card ${running ? 'running' : ''} ${drag?.id === t.id ? 'dragging' : ''}`}
                          onClick={() => setOpenId(t.id)}
                          // 执行中、已完成的不能拖；其余按 DROPS 里的方向流转
                          draggable={col.key !== 'fixing' && col.key !== 'done' && !t.analyzing}
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = 'move';
                            // Firefox 要求写入数据才开始拖拽
                            e.dataTransfer.setData('text/plain', t.id);
                            setDrag({ id: t.id, from: col.key });
                          }}
                          onDragEnd={() => {
                            setDrag(null);
                            setOver(null);
                          }}
                        >
                          <div className="card-title">{t.title}</div>
                          <div className="card-meta">
                            <span>{t.source === 'feishu' ? '飞书' : '手动'}</span>
                            {type && <span>· {type}</span>}
                          </div>
                          <div className="card-tags">
                            {t.analyzing && <span className="pill">规格生成中…</span>}
                            {!t.analyzing && t.status === 'pending_confirm' && !t.analysis && !t.error && <span className="pill">还没有规格</span>}
                            {!t.analyzing && t.status === 'pending_confirm' && t.error && !t.spec && <span className="pill err">生成规格失败</span>}
                            {!t.analyzing && t.status === 'pending_confirm' && !!t.analysis && (open ? <span className="pill warn">{open} 个问题待回答</span> : <span className="pill ok">已有规格</span>)}
                            {t.status === 'todo' && <span className="pill">第 {queueOrder.indexOf(t.id) + 1} 个执行</span>}
                            {t.status === 'testing' && <span className="pill amber">验证中</span>}
                            {running && queue.progress && (
                              <span className="pill">
                                {STAGE_LABEL[queue.progress.stage]} · {fmtDuration(now - queue.progress.startedAt)}
                              </span>
                            )}
                            {firstFail && <span className="pill err">验收项未通过 · {firstFail.id}</span>}
                            {t.status === 'review' && toCheck > 0 && <span className="pill warn">{toCheck} 项待你验收</span>}
                            {t.writeback?.state === 'failed' && <span className="pill err">飞书回写失败</span>}
                            {t.writeback?.state === 'done' && <span className="pill ok">已回写飞书</span>}
                            {t.status === 'done' && t.manualChecks && <span className="pill">有部署后核对项</span>}
                            {t.knowledge && <span className="pill ok">经验已入库</span>}
                            {/* 验收项未通过时上面已有标签，这里不再把同一句错误原文重复一遍 */}
                            {t.error && !firstFail && !(t.status === 'pending_confirm' && !t.spec) && (
                              <span className="pill err card-error" title={t.error}>
                                {t.error}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </section>

        <aside className="rail">
          <QueueCard project={project} queue={queue} tasks={tasks} onOpen={setOpenId} />
          <DeployRecord project={project} status={deploy} />
          <Activity project={project} tasks={tasks} onOpen={setOpenId} />
        </aside>
      </div>

      {creating && <NewTaskDialog projectId={project.id} onClose={() => setCreating(false)} onCreated={(id) => setOpenId(id)} />}
    </div>
  );
}

function NewTaskDialog({ projectId, onClose, onCreated }: { projectId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [images, setImages] = useState<{ key: string; file: File; src: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // 关闭时释放预览用的 object URL
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => imagesRef.current.forEach((i) => URL.revokeObjectURL(i.src)), []);

  const addImages = (files: File[]) =>
    setImages((prev) => [...prev, ...files.map((file) => ({ key: crypto.randomUUID(), file, src: URL.createObjectURL(file) }))]);
  const removeImage = (key: string) =>
    setImages((prev) => {
      const hit = prev.find((i) => i.key === key);
      if (hit) URL.revokeObjectURL(hit.src);
      return prev.filter((i) => i.key !== key);
    });

  // 在对话框任意位置粘贴截图都能添加；纯文本照常粘贴
  const onPaste = (e: React.ClipboardEvent) => {
    const files = imagesFrom(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    addImages(files.filter((f) => !checkImage(f)));
    const bad = files.map(checkImage).find(Boolean);
    if (bad) setErr(bad);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr('');
    let created: TaskBrief | null = null;
    try {
      created = await api<TaskBrief>(`/api/projects/${projectId}/tasks`, 'POST', { title, description });
      for (const img of images) await uploadImage(created.id, img.file);
      onClose();
      onCreated(created.id);
    } catch (e) {
      // 任务已创建但截图上传失败：打开任务，让用户在详情里补传
      if (created) {
        alert(`任务已创建，但截图上传失败：${(e as Error).message}\n可在任务详情中重新添加。`);
        onClose();
        onCreated(created.id);
      } else {
        setErr((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        onPaste={onPaste}
      >
        <h2 id="new-task-title">新建任务</h2>
        <label>
          标题
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label>
          需求详情
          <textarea rows={8} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="描述问题或需求；截图可以直接粘贴（Ctrl+V）" />
        </label>
        <ImagePicker items={images.map((i) => ({ key: i.key, src: i.src, name: i.file.name }))} onAdd={addImages} onRemove={removeImage} />
        {err && <div className="error">{err}</div>}
        <div className="actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={saving}>
            {saving ? (images.length ? '上传截图中…' : '创建中…') : '创建'}
          </button>
        </div>
      </form>
    </div>
  );
}
