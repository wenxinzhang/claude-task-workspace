import type { Stage, Task, TaskStatus } from './types.ts';

/** 单个阶段的耗时与成本统计：只统计带事实（evidence）的任务，没有样本的阶段不出现 */
export interface StageMetric {
  stage: Stage;
  /** 样本数：有该阶段事实的任务数 */
  n: number;
  medianMs: number;
  maxMs: number;
  /** 有成本记录的样本花费合计（美元）；一个都没有时为 null（未知，不等于 0） */
  costUsd: number | null;
  /** 有成本记录的样本数 */
  costN: number;
  /** 平均工具调用次数，只按有记录的样本算；全都未知时为 null */
  avgToolCalls: number | null;
}

/** 流程指标：全部由任务事实用代码算出，不花 token */
export interface FlowMetrics {
  at: number;
  taskCount: number;
  stages: StageMetric[];
  /** 门禁结论分布：只数有门禁结论的任务 */
  outcomes: { gated: number; pass: number; unverified: number; fail: number };
  /** 转人工的原因分布：按每个任务最近一次门禁里的 hold 理由归并，按任务计数，数量多的在前 */
  holdReasons: { reason: string; n: number }[];
  /** 未完成状态的积压：数量与最久停留时长（按 updatedAt 算） */
  backlog: { status: TaskStatus; n: number; oldestMs: number }[];
  /** 停在待确认且生成规格失败的任务：按失败原因归并，数量多的在前 */
  analyzeStuck: { n: number; reasons: { reason: string; n: number }[] };
}

/** 流程问题草稿：key 是稳定去重键，同一问题未处理时不重复入台账 */
export interface FlowFindingDraft {
  projectId: string;
  kind: 'flow_backlog' | 'flow_gate';
  severity: 'warn';
  title: string;
  detail: string;
  key: string;
}

const BACKLOG_STATUSES: TaskStatus[] = ['pending_confirm', 'todo', 'review', 'blocked'];
const ANALYZE_FAIL_PREFIX = '生成规格失败：';
/** 生成规格失败卡住这么多任务才算流程问题：个别失败由 analyze_fail 逐条采集 */
const STUCK_MIN = 5;
/** 门禁结论至少这么多轮才判断「从未自动通过」，样本太少不下结论 */
const GATED_MIN = 5;

const STAGES: Stage[] = ['analysis', 'implement', 'verify'];

/** 中位数：偶数个取中间两项的均值 */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** 从任务事实计算流程指标 */
export function computeFlowMetrics(tasks: Task[], now: number): FlowMetrics {
  const stages: StageMetric[] = [];
  for (const stage of STAGES) {
    const evs = tasks.map((t) => t.evidence?.[stage]).filter((e): e is NonNullable<typeof e> => !!e && typeof e.durationMs === 'number');
    if (!evs.length) continue;
    const durations = evs.map((e) => e.durationMs).sort((a, b) => a - b);
    const costs = evs.map((e) => e.costUsd).filter((c): c is number => typeof c === 'number');
    const calls = evs.map((e) => e.toolCalls).filter((c): c is number => typeof c === 'number');
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    stages.push({
      stage,
      n: evs.length,
      medianMs: median(durations),
      maxMs: durations[durations.length - 1],
      costUsd: costs.length ? Math.round(sum(costs) * 100) / 100 : null,
      costN: costs.length,
      avgToolCalls: calls.length ? Math.round(sum(calls) / calls.length) : null,
    });
  }
  const outcomes = { gated: 0, pass: 0, unverified: 0, fail: 0 };
  for (const t of tasks) {
    if (!t.gate) continue;
    outcomes.gated++;
    outcomes[t.gate.verdict]++;
  }
  // 转人工的原因：hold 理由尾巴带着文件名/验收项编号，归并时去掉；条数归一成 N；同一任务同一原因只计一次
  const holdCounts = new Map<string, number>();
  for (const t of tasks) {
    const seen = new Set<string>();
    for (const r of t.gate?.reasons ?? []) {
      if (r.level !== 'hold') continue;
      const reason = r.text.split('：')[0].replace(/^\d+/, 'N');
      if (seen.has(reason)) continue;
      seen.add(reason);
      holdCounts.set(reason, (holdCounts.get(reason) ?? 0) + 1);
    }
  }
  const holdReasons = [...holdCounts.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n);
  const backlog: FlowMetrics['backlog'] = [];
  for (const status of BACKLOG_STATUSES) {
    const of = tasks.filter((t) => t.status === status);
    if (of.length) backlog.push({ status, n: of.length, oldestMs: Math.max(...of.map((t) => now - t.updatedAt)) });
  }
  const reasonCounts = new Map<string, number>();
  for (const t of tasks) {
    // 正在重新生成规格的不算卡住
    if (t.status !== 'pending_confirm' || t.analyzing || !t.error?.startsWith(ANALYZE_FAIL_PREFIX)) continue;
    // 代理的回复每个任务都不同，归并前去掉，否则同一类失败永远凑不成一组
    const reason = t.error.slice(ANALYZE_FAIL_PREFIX.length).split('。代理的回复')[0];
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const reasons = [...reasonCounts.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n);
  const analyzeStuck = { n: reasons.reduce((x, r) => x + r.n, 0), reasons };
  return { at: now, taskCount: tasks.length, stages, outcomes, holdReasons, backlog, analyzeStuck };
}

/** 从一个项目的流程指标判出流程问题：只按可数的事实判，不做主观评价 */
export function flowFindings(projectId: string, m: FlowMetrics): FlowFindingDraft[] {
  const drafts: FlowFindingDraft[] = [];
  if (m.analyzeStuck.n >= STUCK_MIN) {
    drafts.push({
      projectId,
      kind: 'flow_backlog',
      severity: 'warn',
      title: `${m.analyzeStuck.n} 个任务因生成规格失败停在待确认`,
      detail: m.analyzeStuck.reasons.slice(0, 5).map((r) => `${r.n} 个：${r.reason}`).join('\n'),
      key: `flow:analyze-stuck:${projectId}`,
    });
  }
  if (m.outcomes.gated >= GATED_MIN && m.outcomes.pass === 0) {
    drafts.push({
      projectId,
      kind: 'flow_gate',
      severity: 'warn',
      title: `${m.outcomes.gated} 个任务的门禁结论里没有一次自动通过`,
      detail: `按每个任务最近一次的门禁结论：需要人工验收 ${m.outcomes.unverified} 个，未通过 ${m.outcomes.fail} 个，通过 0 个。验证阶段的耗时没有换来自动放行，每个任务都要人工再看一遍。`,
      key: `flow:no-pass:${projectId}`,
    });
  }
  return drafts;
}

const STAGE_NAME: Record<Stage, string> = { analysis: '理解', implement: '实现', verify: '验证' };
const STATUS_NAME: Partial<Record<TaskStatus, string>> = { pending_confirm: '待确认', todo: '待修改', review: '待验证', blocked: '异常' };
const sec = (ms: number) => `${Math.round(ms / 1000)} 秒`;
const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} 小时`;

/** 流程体检段落：把各项目的流程指标写成给审查会话看的文字；没有数据返回空串 */
export function flowSection(projects: { name: string; metrics: FlowMetrics }[]): string {
  const blocks = projects
    .filter((p) => p.metrics.taskCount > 0)
    .map(({ name, metrics: m }) => {
      const lines = [`### ${name}（${m.taskCount} 个任务）`];
      for (const s of m.stages) {
        const cost = s.costUsd === null ? '花费未记录' : `花费合计 ${s.costUsd} 美元（${s.costN} 个样本有记录）`;
        const calls = s.avgToolCalls === null ? '工具调用未记录' : `平均 ${s.avgToolCalls} 次工具调用`;
        lines.push(`- ${STAGE_NAME[s.stage]}阶段：${s.n} 个样本，耗时中位 ${sec(s.medianMs)}、最长 ${sec(s.maxMs)}，${calls}，${cost}`);
      }
      const o = m.outcomes;
      if (o.gated) lines.push(`- 门禁结论（每个任务最近一次）${o.gated} 个：通过 ${o.pass}，需要人工验收 ${o.unverified}，未通过 ${o.fail}`);
      if (m.holdReasons.length) lines.push(`- 转人工的原因（最近一次门禁的 hold，按任务计）：${m.holdReasons.slice(0, 5).map((r) => `${r.n} 个：${r.reason}`).join('；')}`);
      for (const b of m.backlog) lines.push(`- 积压：${STATUS_NAME[b.status] ?? b.status} ${b.n} 个，最久已停留 ${hours(b.oldestMs)}`);
      for (const r of m.analyzeStuck.reasons.slice(0, 3)) lines.push(`- 生成规格失败 ${r.n} 个：${r.reason}`);
      return lines.join('\n');
    });
  if (!blocks.length) return '';
  return `\n\n## 流程体检（由任务事实统计，顺利完成的任务也在内）\n${blocks.join('\n\n')}`;
}
