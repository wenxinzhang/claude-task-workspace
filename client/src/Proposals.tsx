import { useRef, useState } from 'react';
import { api, fmtDayTime, fmtDuration, useNow, type Observation, type ObserverStatus, type Proposal } from './api.ts';
import { canRemoveProposal, componentRiskRank } from '../../server/observe-types.ts';
import { canRetry, ProposalCard } from './ProposalCard.tsx';

interface Props {
  proposals: Proposal[];
  observations: Observation[];
  status: ObserverStatus | null;
}

/** 为什么现在不能审查：一句话告诉使用者要等什么 */
function blockedReason(status: ObserverStatus | null): string | null {
  if (!status?.enabled) return '观察者未开启，请在「项目管理 → 全局设置」中启用';
  if (status.diagnosing) return null;
  if (status.applying) return '有提案正在应用，结束后可审查';
  if (status.probing) return '复验进行中，结束后可审查';
  if (!status.idle) return '有任务在执行，队列空闲后可审查';
  return null;
}

/** 最近一次审查的结果：成功说产出了什么，失败给原因 */
function LastRun({ status }: { status: ObserverStatus }) {
  const run = status.lastRun;
  if (!run) return status.lastRunAt ? <span className="muted">上次审查 {fmtDayTime(status.lastRunAt)}</span> : null;
  const cost = run.costUsd !== undefined ? `，花费 $${run.costUsd.toFixed(2)}` : '';
  if (!run.ok) {
    return <span className="error">上次审查（{fmtDayTime(run.at)}）失败：{run.error || '原因未记录'}</span>;
  }
  return (
    <span className="muted">
      上次审查 {fmtDayTime(run.at)}：{run.findings} 条流程发现、{run.proposals} 条提案，用时 {fmtDuration(run.durationMs)}{cost}
    </span>
  );
}

/** 优化提案：等你批准的在前，其余收进「已处理」；审查进行中显示已用时 */
export function Proposals({ proposals, observations, status }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const diagnosing = !!status?.diagnosing;
  const now = useNow(diagnosing);

  const byRisk = (a: Proposal, b: Proposal) => componentRiskRank(a.component) - componentRiskRank(b.component) || b.at - a.at;
  // 等你处理：待批准、应用中、应用没成功（可重试的，以及文件没还原要人工处理的）、复验退化待回滚、已应用还能复验的；其余收进「已处理」
  const canProbe = (p: Proposal) => p.status === 'applied' && !p.probe && observations.some((o) => p.problemIds.includes(o.id) && o.taskId);
  const unrestored = (p: Proposal) => p.status === 'rolled_back' && p.result?.restored === false;
  const waitingNow = (p: Proposal) => p.status === 'pending' || p.status === 'applying' || canRetry(p) || unrestored(p) || p.probe?.result === 'regressed' || canProbe(p);
  // 本次打开页面期间处理过的提案留在上方：刚点完「应用」就收进折叠区，会看不到它成没成
  const seen = useRef(new Set<string>());
  for (const p of proposals) if (waitingNow(p)) seen.current.add(p.id);
  // 拒绝掉的不再留在上方：它已经没有结果可看
  const needsYou = (p: Proposal) => waitingNow(p) || (seen.current.has(p.id) && p.status !== 'rejected');
  const rank = (p: Proposal) => (p.status === 'pending' || p.status === 'applying' ? 0 : 1);
  const waiting = proposals.filter(needsYou).sort((a, b) => rank(a) - rank(b) || byRisk(a, b));
  const done = proposals.filter((p) => !needsYou(p)).sort((a, b) => b.at - a.at);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setMsg(null);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const blocked = blockedReason(status);
  const card = (p: Proposal) => (
    <ProposalCard key={p.id} p={p} observations={observations} status={status} busy={busy} open={expanded === p.id} onToggle={() => setExpanded(expanded === p.id ? null : p.id)} act={act} />
  );

  return (
    <div className="proposals">
      <div className="records-toolbar">
        <button
          className="btn btn-primary"
          disabled={!!blocked || diagnosing || busy}
          onClick={() => {
            setStartedAt(Date.now());
            void act(() => api('/api/optimize/run', 'POST'));
          }}
        >
          {diagnosing ? '审查中…' : '审查流程'}
        </button>
        {diagnosing ? (
          <span className="muted" role="status">
            正在读流程体检与工具代码{startedAt ? `，已用 ${fmtDuration(now - startedAt)}` : ''}（最长 10 分钟）
          </span>
        ) : blocked ? (
          <span className="muted">{blocked}</span>
        ) : (
          status && <LastRun status={status} />
        )}
        <span className="grow" />
        {msg && <span className="error" role="alert">{msg}</span>}
      </div>
      {waiting.length === 0 && (
        <div className="table-card observer-empty">
          <p><strong>没有等你处理的提案</strong></p>
          <p className="muted">点「审查流程」让观察者按流程体检和问题台账找不合理的环节；开启自动审查后，问题积累够了且队列空闲时会自己跑。提案经你确认后才会应用。</p>
        </div>
      )}
      {waiting.map(card)}
      {done.length > 0 && (
        <>
          <button className={`chip-tab proposals-done-toggle ${showDone ? 'active' : ''}`} aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
            已处理（{done.length}）
          </button>
          {showDone && done.some(canRemoveProposal) && (
            <button className="link proposals-clear" disabled={busy} onClick={() => void act(() => api('/api/proposals/clear', 'POST'))} title="删除已拒绝、已失效、已回滚的提案；已应用的保留">
              清理已拒绝与已回滚的
            </button>
          )}
          {showDone && done.map(card)}
        </>
      )}
    </div>
  );
}
