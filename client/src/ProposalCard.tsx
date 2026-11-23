import { useState } from 'react';
import { api, fmtDayTime, type Observation, type ObserverStatus, type Proposal } from './api.ts';
import { lineDiff } from '../../server/line-diff.ts';
import { canRemoveProposal, canRetryApply } from '../../server/observe-types.ts';

const COMPONENT_LABEL: Record<Proposal['component'], string> = { prompt: '提示词', gate: '门禁', flow: '流程', integration: '集成' };
const STATUS_META: Record<Proposal['status'], { label: string; cls: string }> = {
  pending: { label: '等你批准', cls: 'blue' },
  applying: { label: '应用中', cls: 'amber' },
  applied: { label: '已应用', cls: 'ok' },
  rolled_back: { label: '已回滚', cls: 'err' },
  stale: { label: '已失效 · 需重新生成', cls: 'gray' },
  rejected: { label: '已拒绝', cls: 'gray' },
};
const PROBE_LABEL: Record<NonNullable<Proposal['probe']>['result'], { label: string; cls: string }> = {
  improved: { label: '改善', cls: 'ok' },
  unchanged: { label: '无变化', cls: 'gray' },
  regressed: { label: '退化', cls: 'err' },
};
const VERDICT_LABEL = { pass: '通过', fail: '未通过', unverified: '需人工验收' } as const;
const verdict = (v: keyof typeof VERDICT_LABEL | null) => (v ? VERDICT_LABEL[v] : '无结论');
const isTest = (file: string) => /\.test\.tsx?$/.test(file);

interface Props {
  p: Proposal;
  observations: Observation[];
  status: ObserverStatus | null;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}

/** 应用没成功且文件已还原的提案可以重试（与服务端同一个判据） */
export const canRetry = canRetryApply;

/** 一处替换的行级差异：相同的行灰显，删除与新增分色并带 − / + 记号（不只靠颜色区分） */
function EditDiff({ find, replace }: { find: string; replace: string }) {
  return (
    <pre className="logs diff-block">
      {lineDiff(find, replace).map((l, i) => (
        <span key={i} className={`diff-line diff-${l.type}`}>
          <span className="diff-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
          {l.text || ' '}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/** 一条优化提案：头部一行说明「改什么、风险在哪、等你做什么」，展开看依据与差异；确认面板贴着卡片出现 */
export function ProposalCard({ p, observations, status, busy, open, onToggle, act }: Props) {
  const [confirm, setConfirm] = useState<'probe' | 'rollback' | null>(null);
  const meta = STATUS_META[p.status];
  const linked = observations.filter((o) => p.problemIds.includes(o.id));
  const probeTargets = linked.filter((o) => o.taskId);
  const files = [...new Set(p.edits.map((e) => e.file))];
  const applyDisabled = busy || !!status?.applying;
  const apply = () => void act(() => api(`/api/proposals/${p.id}/apply`, 'POST'));

  return (
    <div className={`proposal-card ${p.status === 'rolled_back' ? 'failed' : ''}`}>
      <div
        className="proposal-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          // 焦点在卡片里的按钮上时不接管按键，否则回车会变成展开卡片而不是触发按钮
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className={`pill ${meta.cls}`}>{p.status === 'applying' && status?.applyMode === 'rollback' ? '回滚中' : p.status === 'applied' && p.auto ? '自动应用' : meta.label}</span>
        <span className="proposal-title">{p.title}</span>
        <span className={`comp-badge comp-${p.component}`}>{COMPONENT_LABEL[p.component]}</span>
        {p.component === 'gate' && <span className="pill err">门禁改动</span>}
        {files.some(isTest) && <span className="pill amber">测试文件</span>}
        <span className="grow" />
        <span className="muted">{fmtDayTime(p.at)}</span>
        {canRemoveProposal(p) && (
          <span className="obs-actions" onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-sm" disabled={busy} onClick={() => void act(() => api(`/api/proposals/${p.id}`, 'DELETE'))} title="从列表里删除这条提案和它的备份">
              删除
            </button>
          </span>
        )}
        {p.status === 'pending' && (
          <span className="obs-actions" onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-sm btn-primary" data-usage="btn-proposal-apply" disabled={applyDisabled} onClick={apply}>应用</button>
            <button className="btn btn-sm" data-usage="btn-proposal-reject" disabled={busy} onClick={() => void act(() => api(`/api/proposals/${p.id}/reject`, 'POST'))}>拒绝</button>
          </span>
        )}
      </div>
      <div className="proposal-meta muted">
        改 {files.length} 个文件、{p.edits.length} 处 · 依据 {linked.length} 条问题
        {linked.length < p.problemIds.length && `（另有 ${p.problemIds.length - linked.length} 条已不在台账）`}
      </div>
      {canRetry(p) && (
        <div className="proposal-note">
          <span>上次应用没有成功，文件已还原：{p.result?.output.split('\n')[0] || '原因未记录'}</span>
          <button className="btn btn-sm" data-usage="btn-proposal-apply" data-usage-kind="retry" disabled={applyDisabled} onClick={apply}>重试应用</button>
          <button className="btn btn-sm" disabled={busy} onClick={() => void act(() => api(`/api/proposals/${p.id}/reject`, 'POST'))}>放弃</button>
        </div>
      )}
      {p.status === 'rolled_back' && p.result?.restored === false && (
        <div className="proposal-note">
          <span>
            上次应用没有成功，也没法确认文件已还原，所以不能重试：{p.result.output.split('\n').find((l) => l.includes('还原')) ?? p.result.output.split('\n')[0]}
            。放弃前先核对涉及的文件；应用前的原文件在 data/observer-backups/{p.id}。
          </span>
          <button className="btn btn-sm" disabled={busy} onClick={() => void act(() => api(`/api/proposals/${p.id}/reject`, 'POST'))}>放弃</button>
        </div>
      )}
      {p.probe && (
        <div className="probe-line">
          复验：{verdict(p.probe.beforeVerdict)} → {verdict(p.probe.afterVerdict)}
          <span className={`pill ${PROBE_LABEL[p.probe.result].cls}`}>{PROBE_LABEL[p.probe.result].label}</span>
        </div>
      )}
      {p.status === 'applied' && !confirm && (
        <div className="obs-actions proposal-actions">
          {!p.probe && probeTargets.length > 0 && <button className="btn btn-sm" disabled={busy} onClick={() => setConfirm('probe')}>用原任务复验</button>}
          {(p.auto || p.probe?.result === 'regressed') && (
            <button className="btn btn-sm" data-usage="btn-proposal-undo" disabled={applyDisabled} onClick={() => setConfirm('rollback')}>
              {p.auto ? '撤销自动应用' : '回滚此提案'}
            </button>
          )}
        </div>
      )}
      {confirm === 'probe' && p.status === 'applied' && (
        <div className="confirm-panel" role="alertdialog" aria-label="复验确认">
          <p>
            将重新执行关联任务（{probeTargets.map((o) => o.taskId!.slice(0, 8)).join('、')}），对比前后门禁结论。这会真实修改目标项目代码；项目开启自动提交时会产生本地提交（不推送）；
            开启飞书回写时任务流转会写飞书；完整的实现与验证会消耗 token。
          </p>
          <div className="obs-actions">
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act(async () => { await api(`/api/proposals/${p.id}/probe`, 'POST', { observationId: probeTargets[0]?.id }); setConfirm(null); })}>确认复验</button>
            <button className="btn btn-sm" onClick={() => setConfirm(null)}>取消</button>
          </div>
        </div>
      )}
      {confirm === 'rollback' && p.status === 'applied' && (
        <div className="confirm-panel" role="alertdialog" aria-label="回滚确认">
          <p>
            {p.auto
              ? `${p.probe?.result === 'regressed' ? '这条提案是自动应用的，且复验显示退化。' : '这条提案是自动应用的。'}撤销会把受影响文件还原到应用前的备份；文件此后被改过时撤销会被拒绝，以保护你的改动。需要队列空闲。`
              : '复验显示退化。回滚会把受影响文件还原到应用前的备份；文件此后被改过时回滚会被拒绝，以保护你的改动。需要队列空闲。'}
          </p>
          <div className="obs-actions">
            <button className="btn btn-sm btn-primary" data-usage="btn-proposal-rollback" disabled={applyDisabled} onClick={() => void act(async () => { await api(`/api/proposals/${p.id}/rollback`, 'POST'); setConfirm(null); })}>确认回滚</button>
            <button className="btn btn-sm" onClick={() => setConfirm(null)}>取消</button>
          </div>
        </div>
      )}
      {open && (
        <div className="proposal-body">
          {linked.length > 0 && (
            <div className="proposal-field">
              <strong>依据的问题</strong>
              <ul className="proposal-problems">
                {linked.map((o) => <li key={o.id}>{o.title}</li>)}
              </ul>
            </div>
          )}
          <div className="proposal-field"><strong>根因</strong><p>{p.rootCause || '未说明'}</p></div>
          <div className="proposal-field"><strong>风险</strong><p>{p.risk || '未说明'}</p></div>
          <div className="proposal-field"><strong>怎么验证</strong><p>{p.verification || '未说明'}</p></div>
          {p.edits.map((e, i) => (
            <div key={i} className="diff-pair">
              <div className="diff-file mono">{e.file}{isTest(e.file) && <span className="pill amber">测试文件改动</span>}</div>
              <EditDiff find={e.find} replace={e.replace} />
            </div>
          ))}
          {p.result && (
            <div className="obs-detail">
              <strong>{p.result.ok ? '执行输出' : '失败输出'}</strong>
              <pre className="logs">{p.result.output || '（无输出）'}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
