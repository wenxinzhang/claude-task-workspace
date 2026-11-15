import type { Observation, ObservationContext } from './observe-types.ts';
import type { ObservationStore } from './observe.ts';
import type { Queue } from './queue.ts';
import type { Store } from './store.ts';
import type { Task } from './types.ts';

/** 一条待入库的问题（id/at/status 由 ObservationStore 补） */
export type ObservationDraft = Omit<Observation, 'id' | 'at' | 'status'>;

/** 手动停止是用户动作不是工具问题；覆盖直抛与「实现失败：已手动停止」包装形态 */
export function isManualStop(error?: string): boolean {
  return !!error && error.includes('已手动停止');
}

/** 一轮执行结束时的硬事实分类：只按任务上的事实判定，不采信代理自述 */
export function classifyRunEnd(t: Task): ObservationDraft[] {
  const drafts: ObservationDraft[] = [];
  const base = { projectId: t.projectId, taskId: t.id, source: 'code' as const };
  const reasonsText = (gate: NonNullable<Task['gate']>) => gate.reasons.map((r) => `[${r.level}] ${r.text}`).join('\n');
  // 现场事实取自最近一个阶段的证据；缺失的阶段不填（不用 0 回填）
  const ev = t.evidence?.implement ?? t.evidence?.verify ?? t.evidence?.analysis;
  const context: ObservationContext = ev
    ? { stage: ev.stage, provider: ev.provider, model: ev.model, durationMs: ev.durationMs, toolCalls: ev.toolCalls, costUsd: ev.costUsd }
    : {};
  if (t.gate?.verdict === 'fail') {
    drafts.push({ ...base, kind: 'gate_fail', severity: 'error', title: '门禁未通过', detail: reasonsText(t.gate) || t.error || '', context: { ...context, gateVerdict: 'fail' } });
    return drafts;
  }
  if (t.error?.startsWith('门禁已通过，但自动提交失败')) {
    drafts.push({ ...base, kind: 'commit_fail', severity: 'error', title: '自动提交失败', detail: t.error, context });
  }
  if (t.gate?.verdict === 'unverified') {
    drafts.push({ ...base, kind: 'gate_unverified', severity: 'warn', title: '门禁需要人工验收', detail: reasonsText(t.gate) || t.manualChecks || '', context: { ...context, gateVerdict: 'unverified' } });
  }
  if (!drafts.length && t.status === 'blocked' && t.error && !isManualStop(t.error)) {
    // 服务重启中断保留事实但降为 note：开发期重启频繁，不当头条、不计入诊断阈值
    const severity = t.error === '服务重启，执行被中断' ? 'note' : 'error';
    drafts.push({ ...base, kind: 'exec_error', severity, title: '任务执行失败', detail: t.error, context });
  }
  return drafts;
}

/**
 * 事件接线：理解失败走 store tasks 差分，自检失败走 queue status（按 at 去重）。
 * 执行/门禁/提交类全部由 observer.onRunEnd 走 run-end 采集，避免双源重复。
 */
export function wireCollector(deps: { store: Store; queue: Queue; observations: ObservationStore; isEnabled: () => boolean }): void {
  const { store, queue, observations, isEnabled } = deps;
  // 理解失败：tasks 事件差分，每个任务记住上一次的 error，只在错误新出现时采
  const prevErrors = new Map<string, string | undefined>();
  // 预填基线：接线前（如重启前）已存在的失败不重采，避免 countNew 虚增
  for (const t of store.list()) prevErrors.set(t.id, t.error);
  store.on('tasks', () => {
    if (!isEnabled()) return;
    for (const t of store.list()) {
      const prevError = prevErrors.get(t.id);
      prevErrors.set(t.id, t.error);
      if (prevError === t.error) continue;
      for (const d of classifyAnalyzeError({ ...t, error: prevError }, t)) observations.add(d);
    }
  });
  // 自检失败：status 事件每秒多次，按 projectId+at 去重
  const seenPreflight = new Map<string, number>();
  queue.on('status', () => {
    if (!isEnabled()) return;
    for (const [pid, st] of Object.entries(queue.allStatus())) {
      const pf = st.preflight;
      if (pf?.state !== 'failed' || seenPreflight.get(pid) === pf.at) continue;
      seenPreflight.set(pid, pf.at);
      observations.add({
        projectId: pid,
        kind: 'preflight_fail',
        severity: 'error',
        title: '开工前自检未通过',
        detail: pf.problems.join('\n'),
        context: {},
        source: 'code',
      });
    }
  });
}

/** 理解阶段失败的差分检出：tasks 事件频繁，只在错误新出现时采一条 */
export function classifyAnalyzeError(prev: Task | undefined, next: Task): ObservationDraft[] {
  const err = next.error;
  if (!err?.startsWith('生成规格失败：')) return [];
  if (prev?.error === err) return [];
  const ev = next.evidence?.analysis;
  return [
    {
      projectId: next.projectId,
      taskId: next.id,
      kind: 'analyze_fail',
      severity: 'error',
      title: '生成任务规格失败',
      detail: err,
      context: ev ? { stage: ev.stage, provider: ev.provider, durationMs: ev.durationMs, toolCalls: ev.toolCalls } : {},
      source: 'code',
    },
  ];
}
