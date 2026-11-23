import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { api, fmtDayTime, type Observation } from './api.ts';
import { effectiveAttribution, type ObservationIssueDraft } from '../../server/observe-types.ts';
import { ISSUE_BODY_LIMIT, ISSUE_TITLE_LIMIT, OBSERVATION_TEXT_LIMIT, observationIssueDraft, observationReview } from '../../server/observation-review.ts';

interface Props {
  observation: Observation;
  projectName: string;
  kindLabel: string;
  statusLabel: string;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}

function useModal(restoreTo?: RefObject<HTMLElement>) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const modal = ref.current;
    const opener = document.activeElement;
    modal?.showModal();
    return () => {
      modal?.close();
      queueMicrotask(() => {
        const target = restoreTo?.current ?? opener;
        if (!modal?.isConnected && target instanceof HTMLElement && target.isConnected) target.focus();
      });
    };
  }, [restoreTo]);
  return ref;
}

export function ObservationDetail({ observation, projectName, kindLabel, statusLabel, onClose, onOpenTask }: Props) {
  const dialog = useModal();
  const [review, setReview] = useState(() => observationReview(observation));
  const [draft, setDraft] = useState<ObservationIssueDraft | null>(null);
  const [receipt, setReceipt] = useState(observation.issue);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error?: string; saved?: boolean }>({});
  const issueButton = useRef<HTMLButtonElement>(null);
  const issueLink = useRef<HTMLAnchorElement>(null);
  const issue = receipt ?? observation.issue;
  const attribution = effectiveAttribution(observation);
  const base = `/api/observations/${observation.id}`;
  const hasReview = !!review.finding.trim() && !!review.suggestion.trim();
  const sourceLabel = observation.kind === 'flow_finding' ? '流程审查' : observation.source === 'llm' ? 'LLM 复盘' : '代码采集';
  useEffect(() => {
    if (issue && !draft && receipt !== observation.issue) issueLink.current?.focus();
  }, [issue, draft, receipt, observation.issue]);
  const updateReview = (next: typeof review) => {
    setReview(next);
    setFeedback({});
  };

  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setFeedback({});
    try {
      await action();
    } catch (error) {
      setFeedback({ error: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      const updated = await api<Observation>(`${base}/review`, 'POST', review);
      setReview(observationReview(updated));
      setFeedback({ saved: true });
    });
  };

  const prepareIssue = () => {
    void perform(async () => {
      const target = await api<ObservationIssueDraft>(`${base}/issue-draft`);
      setDraft(observationIssueDraft(target.repository, target.title, review, observation));
    });
  };

  const closeIssue = () => {
    setDraft(null);
    setFeedback({});
  };

  const submitIssue = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    void perform(async () => {
      const updated = await api<Observation>(`${base}/issue`, 'POST', { ...draft, confirmed: true });
      setReceipt(updated.issue);
      closeIssue();
    });
  };

  return (
    <>
      <dialog
        ref={dialog}
        className="drawer observation-editor"
        aria-labelledby="observation-editor-title"
        onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      >
        <header className="drawer-head">
          <div>
            <h2 id="observation-editor-title">问题详情</h2>
            <p className="muted">问题台账 / {projectName}</p>
          </div>
          <button className="btn" aria-label="关闭问题详情" disabled={busy} onClick={onClose}>×</button>
        </header>
        <form className="observation-form" onSubmit={save}>
          <div className="drawer-body">
            <div className="observation-tags">
              <span className={`pill ${observation.status === 'new' ? 'amber' : 'gray'}`}>{statusLabel}</span>
              <span className="pill gray">{kindLabel}</span>
            </div>
            <h3>{observation.title}</h3>
            <div className="observation-meta muted">
              <span>{sourceLabel} · {fmtDayTime(observation.at)}</span>
              {observation.taskId && (
                <button type="button" className="link" disabled={busy} onClick={() => onOpenTask(observation.taskId!)}>查看关联任务 ↗</button>
              )}
            </div>
            <p className="observation-prefill">
              {observation.review ? '可继续编辑以下内容。' : '观察者已自动填写，可直接编辑下方内容。'}
            </p>
            <label className="observation-field">
              发现的问题
              <textarea value={review.finding} onChange={(e) => updateReview({ ...review, finding: e.target.value })} required maxLength={OBSERVATION_TEXT_LIMIT} disabled={busy} rows={4} />
            </label>
            <label className="observation-field">
              修改建议
              <textarea value={review.suggestion} onChange={(e) => updateReview({ ...review, suggestion: e.target.value })} required maxLength={OBSERVATION_TEXT_LIMIT} disabled={busy} rows={4} />
            </label>
            <details className="observation-source">
              <summary>查看原始观察记录</summary>
              <pre className="logs">{observation.detail || '（无详情）'}</pre>
              <p className="muted">
                {sourceLabel}
                {observation.context.provider && ` · 代理 ${observation.context.provider}`}
                {observation.context.durationMs !== undefined && ` · 耗时 ${Math.round(observation.context.durationMs / 1000)} 秒`}
                {observation.context.toolCalls != null && ` · 工具调用 ${observation.context.toolCalls} 次`}
                {observation.proposalId && ' · 已由提案处理'}
              </p>
            </details>
            {observation.context.screenshotToken && <ScreenshotBlock token={observation.context.screenshotToken} />}
            {issue && <p className="observation-prefill">已提交到 GitHub <a ref={issueLink} href={issue.url} target="_blank" rel="noreferrer">查看 Issue #{issue.number} ↗</a></p>}
            {!draft && feedback.error && <p role="alert" className="error observation-feedback">{feedback.error}</p>}
            {feedback.saved && <p role="status" className="observation-feedback">已保存修改</p>}
          </div>
          <footer className="drawer-foot">
            <button className="btn" disabled={busy || !hasReview}>保存修改</button>
            {!issue && attribution !== 'environment' && <button ref={issueButton} type="button" className="btn btn-primary" disabled={busy || !hasReview} onClick={prepareIssue}>
              {busy && !draft ? '处理中…' : '提交到 GitHub Issues'}
            </button>}
          </footer>
        </form>
      </dialog>
      {draft && (
        <IssueConfirmation
          draft={draft}
          toolRepository={attribution !== 'project'}
          restoreTo={issueButton}
          busy={busy}
          error={feedback.error}
          onChange={setDraft}
          onClose={closeIssue}
          onSubmit={submitIssue}
        />
      )}
    </>
  );
}

/** 截图诊断的原始截图：本地暂存文件，可查看、可删除（删除只删文件，台账记录保留） */
function ScreenshotBlock({ token }: { token: string }) {
  const [deleted, setDeleted] = useState(false);
  // 文件可能已在别的会话里被删：加载失败按已删除展示，不留破图
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (deleted || missing) return <p className="muted observation-feedback">截图文件已删除或不存在</p>;
  return (
    <div className="observation-screenshot">
      <img src={`/api/observations/screenshot/${token}`} alt="用户上传的诊断截图" width={480} height={320} loading="lazy" onError={() => setMissing(true)} />
      <div className="obs-actions">
        {error && <span className="error">{error}</span>}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            api(`/api/observations/screenshot/${token}`, 'DELETE').then(
              () => setDeleted(true),
              (e) => setError((e as Error).message),
            );
          }}
        >
          删除截图文件
        </button>
      </div>
    </div>
  );
}

function IssueConfirmation({ draft, toolRepository, restoreTo, busy, error, onChange, onClose, onSubmit }: {
  draft: ObservationIssueDraft;
  toolRepository: boolean;
  restoreTo: RefObject<HTMLButtonElement>;
  busy: boolean;
  error?: string;
  onChange: (draft: ObservationIssueDraft) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const dialog = useModal(restoreTo);
  return (
    <dialog
      ref={dialog}
      className="dialog observation-confirm"
      aria-labelledby="observation-confirm-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    >
      <header className="drawer-head">
        <div>
          <h2 id="observation-confirm-title">确认提交 GitHub Issue</h2>
          <p className="muted">草稿已填写。请核对发布仓库和内容，删除不宜共享的信息。</p>
        </div>
        <button className="btn" aria-label="关闭提交确认" disabled={busy} onClick={onClose}>×</button>
      </header>
      <form className="observation-form" onSubmit={onSubmit}>
        <div className="drawer-body">
          <div className="observation-field">
            目标仓库
            <div className="observation-repository">
              <code>{draft.repository}</code>
              <span className="muted">{toolRepository ? '观察者工具仓库' : '目标项目仓库'}</span>
            </div>
          </div>
          <label className="observation-field">
            Issue 标题
            <input value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })} required maxLength={ISSUE_TITLE_LIMIT} disabled={busy} />
          </label>
          <label className="observation-field">
            Issue 正文 <span className="muted observation-markdown">Markdown</span>
            <textarea value={draft.body} onChange={(e) => onChange({ ...draft, body: e.target.value })} required maxLength={ISSUE_BODY_LIMIT} disabled={busy} rows={10} />
          </label>
          {error && <p role="alert" className="error observation-feedback">{error}</p>}
        </div>
        <footer className="drawer-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>返回详情</button>
          <button className="btn btn-primary" disabled={busy || !draft.title.trim() || !draft.body.trim()}>{busy ? '正在提交…' : '确认提交 Issue'}</button>
        </footer>
      </form>
    </dialog>
  );
}
