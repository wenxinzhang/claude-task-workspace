import { fmtDuration, STAGE_LABEL, type FlowMetrics, type Project } from './api.ts';

const BACKLOG_LABEL: Record<string, string> = { pending_confirm: '待确认', todo: '待修改', review: '待验证', blocked: '异常' };
const RERUN_LABEL: Record<string, string> = { 'no-action-retry': '零工具调用重试', 'continue-no-change': '无改动接续', 'resume-failed': '接续失败' };
const hours = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} 小时` : fmtDuration(ms));

interface Props {
  flow: Record<string, FlowMetrics>;
  projects: Project[];
}

/** 流程体检：各项目三阶段的耗时与花费、门禁结论分布、积压。数字全部来自任务事实，没有记录的写「未记录」 */
export function FlowHealth({ flow, projects }: Props) {
  const rows = projects.filter((p) => !p.archived && flow[p.id]?.taskCount).map((p) => ({ project: p, m: flow[p.id] }));
  if (!rows.length) return null;
  return (
    <section className="flow-health" aria-label="流程体检">
      {rows.map(({ project, m }) => {
        const longest = Math.max(1, ...m.stages.map((s) => s.medianMs));
        const o = m.outcomes;
        return (
          <div key={project.id} className="flow-card">
            <header className="flow-card-head">
              <strong>{project.name}</strong>
              <span className="muted">{m.taskCount} 个任务</span>
            </header>
            {m.stages.length === 0 ? (
              <p className="muted flow-none">还没有执行过的任务，暂无阶段数据</p>
            ) : (
              <table className="flow-table">
                <thead>
                  <tr><th>阶段</th><th>中位耗时</th><th className="num">最长</th><th className="num">工具调用</th><th className="num">花费</th><th className="num">样本</th></tr>
                </thead>
                <tbody>
                  {m.stages.map((s) => (
                    <tr key={s.stage}>
                      <td>{STAGE_LABEL[s.stage]}</td>
                      <td>
                        <span className="flow-bar" aria-hidden><i style={{ width: `${Math.round((s.medianMs / longest) * 100)}%` }} /></span>
                        {fmtDuration(s.medianMs)}
                      </td>
                      <td className="num">{fmtDuration(s.maxMs)}</td>
                      <td className="num">{s.avgToolCalls === null ? '未记录' : `平均 ${s.avgToolCalls} 次`}</td>
                      <td className="num">{s.costUsd === null ? '未记录' : `$${s.costUsd.toFixed(2)}`}</td>
                      <td className="num">{s.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="flow-facts">
              {o.gated > 0 && (
                <span className={o.pass === 0 ? 'flow-fact warn' : 'flow-fact'}>
                  门禁 {o.gated} 轮：自动通过 {o.pass}，需人工验收 {o.unverified}，未通过 {o.fail}
                </span>
              )}
              {m.backlog.map((b) => (
                <span key={b.status} className="flow-fact">{BACKLOG_LABEL[b.status] ?? b.status} {b.n} 个，最久 {hours(b.oldestMs)}</span>
              ))}
              {m.analyzeStuck.reasons.slice(0, 2).map((r) => (
                <span key={r.reason} className="flow-fact warn" title={r.reason}>{r.n} 个任务生成规格失败：{r.reason}</span>
              ))}
              {m.reruns.map((r) => (
                <span key={r.reason} className="flow-fact warn">
                  自动重跑 {r.n} 次（{RERUN_LABEL[r.reason] ?? r.reason}）{r.costUsd === null ? '，花费未记录' : `，花费 $${r.costUsd.toFixed(2)}`}
                </span>
              ))}
              {m.holdReasons.slice(0, 3).map((r) => (
                <span key={r.reason} className="flow-fact warn" title={r.reason}>{r.n} 个任务转人工：{r.reason}</span>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
