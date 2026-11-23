import type { UsageEvent } from './usage-event.ts';
import type { ObservationDraft } from './observe-collect.ts';

/** 一次使用摩擦分析的结果：全部由事件计数算出，不花 token */
export interface UsageMetrics {
  at: number;
  /** 统计窗口内的天数 */
  windowDays: number;
  eventCount: number;
  /** 点击最频繁的控件：点击数高说明入口显眼或用户反复找它 */
  topClicks: { target: string; n: number }[];
  /** 短时间内的重复点击：同一个控件在一次操作里被连点，通常意味着没反应或难用 */
  repeatedClicks: { target: string; repeats: number }[];
  /** 前端捕获的操作错误：按控件归并 */
  errorTargets: { target: string; n: number }[];
  /** 抽屉停留中位数：纯计数函数不算它（要读存储），由 observer.usageMetrics 补上 */
  drawerDwell?: { target: string; n: number; medianMs: number | null }[];
}

/** 同一控件连续点击间隔小于这个值就算「重复点击」 */
const REPEAT_WINDOW_MS = 3_000;
/** 连续重复至少这么多次才记一笔 */
const REPEAT_MIN = 3;
/** 单个控件重复点击至少这么多回才入台账 */
const REPEAT_ALERT_MIN = 2;

/**
 * 从使用事件算摩擦指标。窗口内事件不足时照实返回小样本结果，不放大成结论。
 * 这里只做可复算的计数与分组，不做推断——推断交给诊断会话。
 */
export function computeUsageMetrics(events: UsageEvent[], windowDays: number, now = Date.now()): UsageMetrics {
  const since = now - windowDays * 24 * 3_600_000;
  const inWindow = events.filter((e) => e.at >= since);

  const clickCounts = new Map<string, number>();
  const errorCounts = new Map<string, number>();
  const repeats = new Map<string, number>();

  // 重复点击：按 target 分组、按时间排序，相邻两条间隔在窗口内就算连点
  const byTarget = new Map<string, number[]>();
  for (const e of inWindow) {
    if (e.kind === 'click') {
      clickCounts.set(e.target, (clickCounts.get(e.target) ?? 0) + 1);
      const arr = byTarget.get(e.target) ?? [];
      arr.push(e.at);
      byTarget.set(e.target, arr);
    }
    if (e.kind === 'error') errorCounts.set(e.target, (errorCounts.get(e.target) ?? 0) + 1);
  }
  for (const [target, times] of byTarget) {
    times.sort((a, b) => a - b);
    let run = 1;
    let bursts = 0;
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] <= REPEAT_WINDOW_MS) run++;
      else {
        if (run >= REPEAT_MIN) bursts++;
        run = 1;
      }
    }
    if (run >= REPEAT_MIN) bursts++;
    if (bursts > 0) repeats.set(target, bursts);
  }

  const top = (m: Map<string, number>) =>
    [...m.entries()].map(([target, n]) => ({ target, n })).sort((a, b) => b.n - a.n).slice(0, 10);

  return {
    at: now,
    windowDays,
    eventCount: inWindow.length,
    topClicks: top(clickCounts),
    repeatedClicks: [...repeats.entries()].map(([target, repeats]) => ({ target, repeats })).sort((a, b) => b.repeats - a.repeats),
    errorTargets: top(errorCounts),
  };
}

/**
 * 摩擦指标 → 台账草稿。key 稳定：同一控件的同一类摩擦在未处理时不重复入库。
 * 只对达到阈值的项入库，避免每次分析都刷一堆噪音。
 */
export function usageFindings(m: UsageMetrics): ObservationDraft[] {
  const drafts: ObservationDraft[] = [];
  const base = { projectId: '', kind: 'usage_friction' as const, severity: 'warn' as const, source: 'code' as const, context: {} };
  for (const r of m.repeatedClicks) {
    if (r.repeats < REPEAT_ALERT_MIN) continue;
    drafts.push({
      ...base,
      title: `「${r.target}」被反复点击 ${r.repeats} 次`,
      detail: `最近 ${m.windowDays} 天里，「${r.target}」出现 ${r.repeats} 次连续快速点击（间隔不到 ${REPEAT_WINDOW_MS / 1000} 秒、每次至少连点 ${REPEAT_MIN} 下）。通常意味着点击后没有可见反馈或操作没有生效。`,
      key: `usage:repeat:${r.target}`,
    });
  }
  for (const e of m.errorTargets) {
    if (e.n < 2) continue;
    drafts.push({
      ...base,
      title: `「${e.target}」上的操作出错 ${e.n} 次`,
      detail: `最近 ${m.windowDays} 天里，在「${e.target}」上捕获到 ${e.n} 次操作错误。`,
      key: `usage:error:${e.target}`,
    });
  }
  return drafts;
}
