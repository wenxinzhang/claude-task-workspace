import { COLUMNS, fmtDuration, type Project, type RunEvidence, type TaskBrief } from './api.ts';

const time = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** 执行记录：执行过的任务各花了多少时间和费用、结果如何，用来判断这套流程是否值得 */
export function History({ project, tasks, onOpen }: { project: Project; tasks: TaskBrief[]; onOpen: (id: string) => void }) {
  const ran = tasks.filter((t) => t.evidence?.implement).sort((a, b) => b.updatedAt - a.updatedAt);
  const stages = (t: TaskBrief) => [t.evidence?.implement, t.evidence?.verify].filter((e): e is RunEvidence => !!e);
  const sum = (t: TaskBrief, pick: (e: RunEvidence) => number) => stages(t).reduce((n, e) => n + pick(e), 0);

  const totalCost = ran.reduce((n, t) => n + sum(t, (e) => e.costUsd ?? 0), 0);
  const totalMs = ran.reduce((n, t) => n + sum(t, (e) => e.durationMs), 0);
  const passed = ran.filter((t) => t.gate?.verdict === 'pass').length;
  const manual = ran.filter((t) => t.gate?.verdict === 'unverified').length;

  return (
    <>
      <div className="crumb">项目 / {project.name} / 执行记录</div>
      <header className="page-head">
        <div>
          <h1>执行记录</h1>
          <p className="muted">每个任务最近一次执行的用时、花费和门禁结论。数字来自代理的事件流，只含实现和验证两个阶段。</p>
        </div>
      </header>

      {ran.length === 0 ? (
        <div className="notice">还没有执行过任务。</div>
      ) : (
        <>
          <div className="stats">
            <div>
              <strong>{ran.length}</strong>
              <small className="muted">执行过的任务</small>
            </div>
            <div>
              <strong>{passed}</strong>
              <small className="muted">门禁直接通过</small>
            </div>
            <div>
              <strong>{manual}</strong>
              <small className="muted">转人工验收</small>
            </div>
            <div>
              <strong>{fmtDuration(totalMs / ran.length)}</strong>
              <small className="muted">平均用时</small>
            </div>
            <div>
              <strong>${(totalCost / ran.length).toFixed(2)}</strong>
              <small className="muted">平均花费</small>
            </div>
          </div>

          <table className="history">
            <thead>
              <tr>
                <th>任务</th>
                <th>当前阶段</th>
                <th>门禁结论</th>
                <th className="num">用时</th>
                <th className="num">花费</th>
                <th className="num">工具调用</th>
                <th className="num">被拒绝</th>
                <th>提交</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {ran.map((t) => {
                const col = COLUMNS.find((c) => c.key === t.status)!;
                const verdict = t.gate?.verdict;
                const calls = stages(t).some((e) => e.toolCalls === null) ? '未知' : String(sum(t, (e) => e.toolCalls ?? 0));
                return (
                  <tr key={t.id}>
                    <td>
                      <button className="link left" onClick={() => onOpen(t.id)} title={t.title}>
                        {t.title}
                      </button>
                    </td>
                    <td>
                      <span className="dot" style={{ background: col.color }} aria-hidden /> {col.label}
                    </td>
                    <td>{verdict === 'pass' ? '通过' : verdict === 'unverified' ? '需要人工验收' : verdict === 'fail' ? '未通过' : '没有结论'}</td>
                    <td className="num">{fmtDuration(sum(t, (e) => e.durationMs))}</td>
                    <td className="num">${sum(t, (e) => e.costUsd ?? 0).toFixed(2)}</td>
                    <td className="num">{calls}</td>
                    <td className="num">{sum(t, (e) => e.denials.length)}</td>
                    <td className="mono">{t.commit?.hash ?? '未提交'}</td>
                    <td>{time(t.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
