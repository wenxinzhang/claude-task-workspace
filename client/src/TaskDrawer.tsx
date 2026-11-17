import { useEffect, useRef, useState } from 'react';
import { api, COLUMNS, onLog, PROVIDER_LABEL, statusLabel, uploadImage, type Criterion, type ExecConfig, type GateResult, type Project, type QueueStatus, type RunEvidence, type Spec, type Task, type TaskBrief } from './api.ts';
import { blockedExecutables, openQuestions } from '../../server/shared.ts';
import { ImagePicker, imagesFrom } from './ImagePicker.tsx';

interface Props {
  task: TaskBrief;
  /** 所属项目：判断验收项在当前权限下能不能自动验证 */
  project: Project;
  running: boolean;
  /** 所属项目的队列状态：单独执行前要看有没有任务在跑、自检结果如何 */
  queue: QueueStatus;
  onClose: () => void;
  /** 确认成功后调用，看板据此关闭抽屉 */
  onConfirmed: () => void;
}

interface Form {
  title: string;
  description: string;
  analysis: string;
  spec?: Spec;
}

const formOf = (t: TaskBrief): Form => ({ title: t.title, description: t.description, analysis: t.analysis, spec: t.spec });

const RESULT_LABEL = { pass: '通过', fail: '未通过', unverified: '待人工确认' } as const;
const STAGE_LABEL = { analysis: '理解', implement: '实现', verify: '验证' } as const;

export function TaskDrawer({ task, project, running, queue, onClose, onConfirmed }: Props) {
  const [form, setForm] = useState<Form>(formOf(task));
  const [dirty, setDirty] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [err, setErr] = useState('');
  // 状态已变更类拒绝（如验收成功后再点一次）用灰色提示，不用红色报错
  const [errSoft, setErrSoft] = useState(false);
  const [busy, setBusy] = useState(false);
  // ref 守卫是同步的：同一 tick 内的连点也能拦住（state 更新要等下一次渲染）
  const busyRef = useRef(false);
  const [note, setNote] = useState('');
  const logRef = useRef<HTMLPreElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // 规格默认只显示摘要，一屏内可以确认；需要逐项修改时再展开编辑
  const [editSpec, setEditSpec] = useState(false);
  // 已有规格时先看规格，原始的任务详情收起；还没有规格时展开
  const [detailOpen, setDetailOpen] = useState(!task.analysis);
  // 展开「任务与规格」时自动收起执行过程，把位置让给规格；也可以手动展开 / 收起
  const [logOpen, setLogOpen] = useState(true);

  // 执行中不能改；待办中的任务规格已冻结，要改先退回待确认
  const frozen = task.status === 'todo';
  const editable = task.status !== 'in_progress' && task.status !== 'testing' && !frozen;
  const column = COLUMNS.find((c) => c.key === task.status)!;

  // 服务端内容变化（如规格生成完成）时，未编辑则同步
  useEffect(() => {
    if (!dirty) setForm(formOf(task));
  }, [task.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api<Task>(`/api/tasks/${task.id}`).then((t) => setLogs(t.logs));
    return onLog((e) => {
      if (e.id === task.id) setLogs((prev) => [...prev.slice(-1999), e.line]);
    });
  }, [task.id]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, logOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const change = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };

  const run = async (fn: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErr('');
    setErrSoft(false);
    try {
      await fn();
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === '当前状态不支持该操作') {
        // 状态已流转（典型：第一次点击已成功，这是重复点击）：SSE 会把抽屉刷到最新状态
        setErrSoft(true);
        setErr('任务状态已变化，已按最新状态显示');
      } else {
        setErr(msg);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const save = () =>
    api(`/api/tasks/${task.id}`, 'PATCH', {
      title: form.title,
      description: form.description,
      // 有结构化规格时文本由服务端按规格生成；spec 为 null 表示改回自由文本
      ...(form.spec ? { spec: form.spec } : { spec: null, analysis: form.analysis }),
    }).then(() => setDirty(false));
  const action = (name: string) => async () => {
    if (dirty) await save();
    await api(`/api/tasks/${task.id}/${name}`, 'POST');
  };
  const remove = async () => {
    if (!confirm(`删除任务「${task.title}」？`)) return;
    await api(`/api/tasks/${task.id}`, 'DELETE');
    onClose();
  };

  const canWriteBack = task.source === 'feishu' && (task.status === 'review' || task.status === 'done') && task.writeback?.state !== 'done';
  // 执行过的任务：抽屉以执行过程为主，任务与规格折叠起来
  const ran = task.status !== 'pending_confirm' && task.status !== 'todo';
  const canFollowUp = ['review', 'blocked', 'done'].includes(task.status) && !queue.currentId;
  const followHint = running
    ? '任务正在执行，这一轮结束后可以追加指令；要立刻改方向，先点「停止当前任务」。'
    : queue.currentId
      ? '本项目有其他任务正在执行，等它结束后再发送。'
      : '代理会在上一轮改动的基础上继续，然后重新验证并过门禁。这一轮没有产生新的代码改动会判为未通过。';
  // 规格里还没回答的问题：回答完才能确认
  const openCount = form.spec ? openQuestions(form.spec).length : 0;
  const reject = () => {
    setLogOpen(true);
    // 等执行过程区域展开后再定位到输入框
    setTimeout(() => {
      noteRef.current?.scrollIntoView({ block: 'center' });
      noteRef.current?.focus();
    }, 0);
  };
  const sendNote = async () => {
    await api('/api/tasks/' + task.id + '/follow-up', 'POST', { text: note });
    setNote('');
  };

  const titleField = (
          <label>
            标题
            <input value={form.title} onChange={(e) => change({ title: e.target.value })} disabled={!editable} />
          </label>
  );
  const detailFields = (
    <>
          <label>
            任务详情
            <textarea rows={6} value={form.description} onChange={(e) => change({ description: e.target.value })} disabled={!editable} />
          </label>
          {(editable || !!task.attachments?.length) && <Attachments task={task} editable={editable} onError={setErr} />}
    </>
  );
  const specBlock = (
    <>
          <div className="spec-head">
            <strong>任务规格</strong>
            {task.analyzing && <span className="pill">生成中…</span>}
            {frozen && (
              <span className="pill ok" title="执行与验证都以确认时的规格为准；要修改请先退回待确认">
                已确认并冻结{task.confirmed?.specHash ? ` · ${task.confirmed.specHash}` : ''}
              </span>
            )}
            <span className="grow" />
            {editable && !task.analyzing && form.spec && (
              <button type="button" className="link" onClick={() => setEditSpec(!editSpec)}>
                {editSpec ? '收起编辑' : '编辑规格'}
              </button>
            )}
            {editable && !task.analyzing && form.spec && editSpec && (
              <button type="button" className="link" onClick={() => change({ spec: undefined })} title="放弃结构化规格，直接编辑文本；验证时只有一条整体验收项">
                改为自由文本
              </button>
            )}
          </div>
          {form.spec ? (
            editSpec && editable ? (
              <SpecEditor spec={form.spec} disabled={task.analyzing} onChange={(spec) => change({ spec })} />
            ) : (
              <SpecSummary spec={form.spec} exec={project.exec} canAnswer={editable && !task.analyzing} onChange={(spec) => change({ spec })} />
            )
          ) : (
            <label>
              <textarea
                rows={10}
                value={form.analysis}
                onChange={(e) => change({ analysis: e.target.value })}
                disabled={!editable || task.analyzing}
                aria-label="任务理解"
                placeholder="点击「生成规格」让代理阅读项目代码后给出目标、根因、改动范围和逐条验收项；也可以直接手写"
              />
              <small className="muted">这是自由文本，没有逐条验收项：验证时只能给一个整体结论，也不会检查改动范围。</small>
            </label>
          )}
    </>
  );
  const taskFields = (
    <>
      {titleField}
      {detailFields}
      {specBlock}
    </>
  );
  const results = (
    <>
          {task.summary && (
            <div className="summary">
              <strong>执行总结（代理自述，不参与判定）</strong>
              <p>{task.summary}</p>
            </div>
          )}
          {task.evidence && <EvidenceList evidence={task.evidence} />}

    </>
  );
  const processPanel = (
    <>
          <div className="log-head">
            执行过程 {running && <span className="pill">运行中</span>}
            {ran && !logOpen && <span className="muted">已收起 · {logs.length} 行</span>}
            {ran && (
              <button type="button" className="link" aria-expanded={logOpen} onClick={() => setLogOpen(!logOpen)}>
                {logOpen ? '收起' : '展开'}
              </button>
            )}
            <span className="grow" />
            {running && (
              <button type="button" className="btn btn-danger-text sm" onClick={() => run(() => api('/api/projects/' + task.projectId + '/queue/stop-current', 'POST'))}>
                停止当前任务
              </button>
            )}
          </div>
          <pre className={ran ? 'logs logs-main' : 'logs'} ref={logRef} aria-live="polite" hidden={ran && !logOpen}>
            {logs.length ? logs.join('\n') : '暂无日志'}
          </pre>
          {!!task.notes?.length && (
            <div className="notes">
              <strong>已追加的指令</strong>
              <ol>
                {task.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ol>
            </div>
          )}
          {ran && (
            <div className="follow-up">
              <textarea ref={noteRef} rows={3} value={note} onChange={(e) => setNote(e.target.value)} disabled={!canFollowUp} aria-label="追加指令" placeholder="追加指令：告诉代理接下来还要改什么，例如「分项统计也要按树的范围过滤」" />
              <div className="row">
                <small className="muted grow">{followHint}</small>
                <button type="button" className="btn btn-primary" disabled={!canFollowUp || !note.trim() || busy} onClick={() => run(sendNote)}>
                  发送并继续执行
                </button>
              </div>
            </div>
          )}
    </>
  );

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <span className="dot" style={{ background: column.color }} aria-hidden />
          <span id="drawer-title">{statusLabel(project, task.status)}</span>
          <span className="muted">· {task.source === 'feishu' ? '来自飞书' : '手动创建'}</span>
          <span className="grow" />
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="drawer-body">
          {task.error && <div className="notice error">{task.error}</div>}
          {task.status === 'todo' && queue.preflight?.state === 'failed' && (
            <div className="notice error">开工前自检未通过，任务没有执行：{queue.preflight.problems.join('；')}</div>
          )}
          {task.gate && <GatePanel gate={task.gate} />}
          {task.manualChecks && (
            <div className="manual-checks">
              <strong>{task.gate?.verdict === 'pass' ? '部署后核对清单' : '需要人工确认'}</strong>
              <p className="muted">
                {task.gate?.verdict === 'pass'
                  ? '门禁已通过。下面这些需要在浏览器或部署后的环境里看，没有阻断任务；部署后逐条核对，有问题用「追加指令」写明哪里不对。'
                  : '下面这些没有得到自动验证，需要你来确认。逐条核对后点「验收通过」；有问题点「打回重做」，写明哪里不对。'}
              </p>
              {task.gate ? <ManualChecklist gate={task.gate} /> : <p>{task.manualChecks}</p>}
            </div>
          )}
          {task.writeback && (
            <div className={`notice ${task.writeback.state === 'failed' ? 'error' : ''}`}>
              飞书回写{task.writeback.state === 'done' ? '完成' : task.writeback.state === 'skipped' ? '已跳过' : '失败'}：{task.writeback.message}
            </div>
          )}

          {ran && !running && <DiffView taskId={task.id} stamp={task.updatedAt} />}

          {ran ? (
            <>
              {processPanel}
              <details className="fold" onToggle={(e) => setLogOpen(!e.currentTarget.open)}>
                <summary>任务与规格</summary>
                <div className="fold-body">{taskFields}</div>
              </details>
              {results}
            </>
          ) : (
            <>
              {titleField}
              {specBlock}
              <details className="fold" open={detailOpen} onToggle={(e) => setDetailOpen(e.currentTarget.open)}>
                <summary>任务详情与截图{task.attachments?.length ? `（${task.attachments.length} 个附件）` : ''}</summary>
                <div className="fold-body">{detailFields}</div>
              </details>
              {results}
              {processPanel}
            </>
          )}
        </div>

        <footer className="drawer-foot">
          {err && <div className={`${errSoft ? 'muted' : 'error'} grow`}>{err}</div>}
          {task.status !== 'in_progress' && task.status !== 'testing' && (
            <button className="btn btn-danger-text" disabled={busy} onClick={() => run(remove)}>
              删除
            </button>
          )}
          <span className="grow" />
          {editable && dirty && (
            <button className="btn btn-outline" onClick={() => run(save)}>
              保存修改
            </button>
          )}
          {task.status === 'pending_confirm' && (
            <>
              <button className="btn btn-outline" disabled={task.analyzing} onClick={() => run(() => api(`/api/tasks/${task.id}/analyze`, 'POST'))}>
                {task.analysis ? '重新生成规格' : '生成规格'}
              </button>
              <button
                className="btn btn-primary"
                disabled={task.analyzing || openCount > 0 || busy}
                title={openCount > 0 ? `规格里还有 ${openCount} 个问题没有回答，回答后才能确认` : undefined}
                onClick={() =>
                  run(async () => {
                    await action('confirm')();
                    onConfirmed();
                  })
                }
              >
                确认规格，放入{statusLabel(project, 'todo')}
              </button>
            </>
          )}
          {task.status === 'todo' && (
            <>
              <button className="btn btn-outline" disabled={busy} onClick={() => run(action('unconfirm'))}>
                退回待确认
              </button>
              <button
                className="btn btn-primary"
                disabled={!!queue.currentId || queue.preflight?.state === 'checking' || busy}
                title={queue.currentId ? '本项目有任务正在执行，等它结束后再试' : '只执行这一个任务，不启动队列；执行前会先做开工前自检'}
                onClick={() =>
                  run(async () => {
                    await api('/api/tasks/' + task.id + '/run', 'POST');
                    // 发起成功后收起抽屉，回到看板看进度；发起失败则留在抽屉里显示原因
                    onClose();
                  })
                }
              >
                {queue.preflight?.state === 'checking' ? '开工前自检中…' : '立即执行这一个'}
              </button>
            </>
          )}
          {task.status === 'review' && (
            <>
              <button className="btn btn-outline" onClick={reject} title="写明哪里不对，代理在这次改动的基础上继续修改，然后重新验证">
                打回重做
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => run(action('accept'))}>
                验收通过
              </button>
            </>
          )}
          {task.status === 'blocked' && (
            <>
              <button className="btn btn-outline" disabled={busy} onClick={() => run(action('reopen'))}>
                退回待确认
              </button>
              <button className="btn btn-outline" disabled={busy} onClick={() => run(action('resolve'))} title={`问题已由人工处理，直接移到「${statusLabel(project, 'done')}」`}>
                已人工处理完成
              </button>
            </>
          )}
          {canWriteBack && (
            <button className="btn btn-outline" disabled={busy} onClick={() => run(() => api(`/api/tasks/${task.id}/writeback`, 'POST'))}>
              {task.writeback ? '重试回写飞书' : '回写飞书'}
            </button>
          )}
          {['blocked', 'done'].includes(task.status) && (
            <button className="btn btn-outline" disabled={busy} onClick={() => run(action('retry'))} title="按规格从头再执行一遍">
              重新放入{statusLabel(project, 'todo')}
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}

const lines = (items: string[]) => items.join('\n');
const unlines = (text: string) => text.split('\n');

/** 结构化规格：确认前可以逐项修改；验收项编号按顺序生成 */
function SpecEditor({ spec, disabled, onChange }: { spec: Spec; disabled: boolean; onChange: (spec: Spec) => void }) {
  const set = <K extends keyof Spec>(k: K, v: Spec[K]) => onChange({ ...spec, [k]: v });
  const setCriterion = (i: number, patch: Partial<Criterion>) =>
    set(
      'criteria',
      spec.criteria.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    );

  return (
    <div className="spec">
      <label>
        目标
        <input value={spec.goal} onChange={(e) => set('goal', e.target.value)} disabled={disabled} />
      </label>
      <label>
        根因
        <textarea rows={3} value={spec.rootCause} onChange={(e) => set('rootCause', e.target.value)} disabled={disabled} />
      </label>
      <label>
        改动范围（每行一个文件或目录）
        <textarea rows={3} className="mono" value={lines(spec.scope)} onChange={(e) => set('scope', unlines(e.target.value))} disabled={disabled} />
        <small className="muted">实现阶段改了范围以外的文件时，任务会进入待验证由你确认。留空表示不限定。</small>
      </label>
      <label>
        实现步骤（每行一步）
        <textarea rows={4} value={lines(spec.steps)} onChange={(e) => set('steps', unlines(e.target.value))} disabled={disabled} />
      </label>

      <div className="criteria">
        <div className="criteria-head">
          <strong>验收项</strong>
          <small className="muted">验证阶段按编号逐项给结果和依据；全部通过才算通过</small>
        </div>
        {spec.criteria.map((c, i) => (
          <div className="criterion" key={i}>
            <span className="criterion-id">AC{i + 1}</span>
            <select value={c.method} onChange={(e) => setCriterion(i, { method: e.target.value as Criterion['method'] })} disabled={disabled} aria-label={`AC${i + 1} 验证方式`}>
              <option value="auto">自动验证</option>
              <option value="manual">人工验证</option>
            </select>
            {!disabled && (
              <button
                type="button"
                className="icon-btn"
                aria-label={`删除 AC${i + 1}`}
                onClick={() =>
                  set(
                    'criteria',
                    spec.criteria.filter((_, j) => j !== i),
                  )
                }
              >
                ✕
              </button>
            )}
            <textarea rows={2} value={c.text} onChange={(e) => setCriterion(i, { text: e.target.value })} disabled={disabled} aria-label={`AC${i + 1} 内容`} placeholder="一个可以判定是否成立的结果" />
            <textarea rows={2} value={c.how} onChange={(e) => setCriterion(i, { how: e.target.value })} disabled={disabled} aria-label={`AC${i + 1} 怎么验`} placeholder="怎么验：要跑的命令、要看的代码位置，或人工去哪里看、预期是什么" />
          </div>
        ))}
        {!disabled && (
          <button type="button" className="btn btn-outline sm" onClick={() => set('criteria', [...spec.criteria, { id: '', text: '', method: 'auto', how: '' }])}>
            ＋ 添加验收项
          </button>
        )}
      </div>

      <label>
        风险与疑问（每行一条）
        <textarea rows={2} value={lines(spec.risks)} onChange={(e) => set('risks', unlines(e.target.value))} disabled={disabled} />
      </label>
    </div>
  );
}

/** 规格摘要：一屏内看完目标、根因、改动范围和验收项；需要回答的问题直接在这里回答 */
export function SpecSummary({ spec, exec, canAnswer, onChange }: { spec: Spec; exec: ExecConfig; canAnswer: boolean; onChange: (spec: Spec) => void }) {
  const questions = spec.questions ?? [];
  const answer = (i: number, text: string) => onChange({ ...spec, questions: questions.map((q, j) => (j === i ? { ...q, answer: text } : q)) });
  const manual = spec.criteria.filter((c) => c.method === 'manual').length;
  return (
    <div className="spec spec-summary">
      {questions.length > 0 && (
        <div className="questions">
          <strong>
            需要你回答（{questions.filter((q) => q.answer.trim()).length} / {questions.length}）
          </strong>
          {questions.map((q, i) => (
            <label key={i}>
              {q.text}
              <textarea rows={2} value={q.answer} onChange={(e) => answer(i, e.target.value)} disabled={!canAnswer} placeholder="回答后才能确认规格；回答会写进规格，代理按它执行" />
            </label>
          ))}
        </div>
      )}
      <div>
        <span className="spec-key">目标</span>
        {spec.goal}
      </div>
      <div>
        <span className="spec-key">根因</span>
        <Clamp text={spec.rootCause || '（未给出）'} />
      </div>
      <div>
        <span className="spec-key">改动范围</span>
        {spec.scope.length ? (
          spec.scope.map((s) => (
            <code key={s} className="scope-chip">
              {s}
            </code>
          ))
        ) : (
          <span className="muted">未限定</span>
        )}
      </div>
      <div>
        <span className="spec-key">
          验收项 {spec.criteria.length} 条{manual ? `，其中 ${manual} 条需要人工验证` : ''}
        </span>
        <ul className="ac-list">
          {spec.criteria.map((c, i) => {
            const blocked = blockedExecutables(c, exec);
            return (
              <li key={i} title={c.how}>
                <span className="criterion-id">AC{i + 1}</span>
                <span className={`pill ${c.method === 'auto' ? 'ok' : ''}`}>{c.method === 'auto' ? '自动' : '人工'}</span>
                <span>{c.text}</span>
                {blocked.length > 0 && (
                  <small className="warn">当前权限下 {blocked.join('、')} 命令会被拒绝，这一项多半会转为人工确认。可在「项目管理 → 配置 → 执行设置」的「验证命令」里放行。</small>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {spec.risks.length > 0 && (
        <details>
          <summary className="muted">风险提示 {spec.risks.length} 条</summary>
          <ul className="risk-list">
            {spec.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      )}
      {spec.steps.length > 0 && (
        <details>
          <summary className="muted">实现步骤 {spec.steps.length} 步</summary>
          <ol className="risk-list">
            {spec.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/** 长文本默认只显示前几行，点「展开」看全文 */
function Clamp({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= 160) return <>{text}</>;
  return (
    <>
      <span className={open ? 'pre' : 'clamp'}>{text}</span>
      <button type="button" className="link left" onClick={() => setOpen(!open)}>
        {open ? '收起' : '展开全文'}
      </button>
    </>
  );
}

/** 人工确认清单：门禁里没有得到自动验证的验收项，逐条核对 */
function ManualChecklist({ gate }: { gate: GateResult }) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const items = gate.items.filter((i) => i.result === 'unverified');
  const holds = gate.reasons.filter((r) => r.level === 'hold' && !/验收项没有得到自动验证/.test(r.text));
  const done = items.filter((i) => checked[i.id]).length;
  return (
    <div className="checklist">
      {holds.map((r, i) => (
        <div key={i} className="warn">
          {r.text}
        </div>
      ))}
      {items.map((i) => (
        <label key={i.id} className="check-item">
          <input type="checkbox" checked={!!checked[i.id]} onChange={(e) => setChecked({ ...checked, [i.id]: e.target.checked })} />
          <span>
            <span className="criterion-id">{i.id}</span> {i.text}
            {i.how && <small className="muted">怎么验：{i.how}</small>}
            {i.evidence && <small className="muted">没有自动验证的原因：{i.evidence}</small>}
          </span>
        </label>
      ))}
      {items.length > 0 && (
        <small className="muted">
          已核对 {done} / {items.length}
        </small>
      )}
    </div>
  );
}

/** 本次代码改动：验收时直接看 diff，不用去翻日志 */
export function DiffView({ taskId, stamp, defaultOpen }: { taskId: string; stamp: number; defaultOpen?: boolean }) {
  const [diff, setDiff] = useState<string | null | undefined>(undefined);
  const [open, setOpen] = useState(!!defaultOpen);
  useEffect(() => {
    if (!open) return;
    api<{ diff: string | null }>(`/api/tasks/${taskId}/diff`).then(
      (r) => setDiff(r.diff),
      () => setDiff(null),
    );
  }, [open, taskId, stamp]);
  const lines = (diff ?? '').split('\n');
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  const kind = (l: string) =>
    l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') || l.startsWith('diff ') || l.startsWith('--- 新文件') ? 'hunk' : undefined;
  return (
    <details className="fold" open={defaultOpen} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>代码改动{diff ? `（+${added} / -${removed}）` : ''}</summary>
      {diff === undefined ? (
        <div className="fold-body muted">加载中…</div>
      ) : !diff ? (
        <div className="fold-body muted">没有保存这次的改动记录（任务没有产生改动，或是旧版本执行的任务）。</div>
      ) : (
        <pre className="diff">
          {lines.map((l, i) => (
            <span key={i} className={kind(l)}>
              {l + '\n'}
            </span>
          ))}
        </pre>
      )}
    </details>
  );
}

/** 门禁结论：结论、理由、逐项验收结果，全部来自服务端核对的事实 */
function GatePanel({ gate }: { gate: GateResult }) {
  return (
    <section className={`gate gate-${gate.verdict}`} aria-label="门禁结论">
      <div className="gate-head">
        <strong>门禁结论：{gate.verdict === 'pass' ? '通过' : gate.verdict === 'fail' ? '未通过' : '需要人工验收'}</strong>
        <small className="muted">{new Date(gate.at).toLocaleString('zh-CN', { hour12: false })}</small>
      </div>
      {gate.reasons.length > 0 && (
        <ul className="gate-reasons">
          {gate.reasons.map((r, i) => (
            <li key={i} className={`reason-${r.level}`}>
              {r.text}
            </li>
          ))}
        </ul>
      )}
      <ul className="gate-items">
        {gate.items.map((i) => (
          <li key={i.id}>
            <span className={`result result-${i.result}`}>{RESULT_LABEL[i.result]}</span>
            <div>
              <div>
                <span className="criterion-id">{i.id}</span> {i.text}
              </div>
              {i.evidence && <small className="muted">依据：{i.evidence}</small>}
            </div>
          </li>
        ))}
      </ul>
      {gate.changedFiles && gate.changedFiles.length > 0 && (
        <small className="muted mono">
          改动 {gate.changedFiles.length} 个文件：{gate.changedFiles.slice(0, 12).join('、')}
          {gate.changedFiles.length > 12 ? ' …' : ''}
        </small>
      )}
    </section>
  );
}

/** 各阶段会话的事实：来自事件流的工具调用与权限拒绝统计 */
function EvidenceList({ evidence }: { evidence: NonNullable<Task['evidence']> }) {
  const stages = (['analysis', 'implement', 'verify'] as const).filter((s) => evidence[s]);
  if (!stages.length) return null;
  const line = (e: RunEvidence) => {
    const calls = e.toolCalls === null ? '工具调用次数未知' : `工具调用 ${e.toolCalls} 次`;
    const denied = e.denials.length ? `，${e.denials.length} 次被权限拒绝` : '';
    return `${PROVIDER_LABEL[e.provider]}${e.model ? ` · ${e.model}` : ''} · ${calls}${denied} · ${Math.round(e.durationMs / 1000)} 秒`;
  };
  return (
    <div className="evidence">
      <strong>会话记录</strong>
      {stages.map((s) => {
        const e = evidence[s]!;
        return (
          <div key={s}>
            <span className="evidence-stage">{STAGE_LABEL[s]}</span>
            <span className={e.toolCalls === 0 ? 'error' : ''}>{line(e)}</span>
            {e.denials.length > 0 && (
              <details>
                <summary>被拒绝的调用</summary>
                <ul className="mono">
                  {e.denials.slice(0, 20).map((d, i) => (
                    <li key={i}>
                      {d.tool} {d.input}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 任务截图：图片显示缩略图，可编辑时支持上传、粘贴、删除；非图片附件显示为链接 */
function Attachments({ task, editable, onError }: { task: TaskBrief; editable: boolean; onError: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const all = task.attachments ?? [];
  const src = (token: string) => `/api/tasks/${task.id}/attachments/${encodeURIComponent(token)}`;
  const images = all.filter((a) => a.type.startsWith('image/'));
  const others = all.filter((a) => !a.type.startsWith('image/'));

  const add = async (files: File[]) => {
    setBusy(true);
    try {
      for (const f of files) await uploadImage(task.id, f);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (token: string) => {
    const att = all.find((a) => a.token === token);
    if (!att || !confirm(`删除截图「${att.name}」？${att.local ? '' : '（只从本任务移除，不影响飞书）'}`)) return;
    await api(`/api/tasks/${task.id}/attachments/${encodeURIComponent(token)}`, 'DELETE').catch((e) => onError((e as Error).message));
  };

  // 粘贴截图：抽屉内任意位置 Ctrl+V
  useEffect(() => {
    if (!editable) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = imagesFrom(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      add(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [editable, task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <ImagePicker
        items={images.map((a) => ({ key: a.token, src: src(a.token), name: `${a.field}：${a.name}` }))}
        onAdd={editable ? add : undefined}
        onRemove={editable ? remove : undefined}
        busy={busy}
      />
      {others.length > 0 && (
        <div className="attachment-list">
          {others.map((a) => (
            <a key={a.token} className="file-link" href={src(a.token)} target="_blank" rel="noreferrer">
              📎 {a.name}
            </a>
          ))}
        </div>
      )}
    </>
  );
}
