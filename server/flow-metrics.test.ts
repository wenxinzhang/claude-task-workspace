import { describe, expect, it } from 'vitest';
import { computeFlowMetrics, flowFindings, flowSection } from './flow-metrics.ts';
import type { RunEvidence, Stage, Task } from './types.ts';

const NOW = 1_800_000_000_000;

const ev = (stage: Stage, durationMs: number, extra: Partial<RunEvidence> = {}): RunEvidence => ({
  stage,
  provider: 'claude',
  toolCalls: 10,
  tools: {},
  denials: [],
  durationMs,
  at: NOW,
  ...extra,
});

let seq = 0;
const task = (patch: Partial<Task> = {}): Task => ({
  id: `t${++seq}`,
  projectId: 'p1',
  title: '任务',
  description: '',
  analysis: '',
  analyzing: false,
  source: 'manual',
  status: 'done',
  order: 0,
  logs: [],
  createdAt: NOW - 3_600_000,
  updatedAt: NOW - 3_600_000,
  ...patch,
});

describe('computeFlowMetrics 阶段统计', () => {
  it('按阶段给出样本数、中位与最大耗时；没有样本的阶段不出现', () => {
    const m = computeFlowMetrics(
      [
        task({ evidence: { analysis: ev('analysis', 100_000), implement: ev('implement', 400_000) } }),
        task({ evidence: { analysis: ev('analysis', 300_000) } }),
        task({ evidence: { analysis: ev('analysis', 200_000) } }),
        task(),
      ],
      NOW,
    );
    expect(m.taskCount).toBe(4);
    expect(m.stages.map((s) => s.stage)).toEqual(['analysis', 'implement']);
    const a = m.stages[0];
    expect(a.n).toBe(3);
    expect(a.medianMs).toBe(200_000);
    expect(a.maxMs).toBe(300_000);
  });

  it('成本只对有记录的样本求和并报出样本数；工具调用未知（null）不当 0 计入均值', () => {
    const m = computeFlowMetrics(
      [
        task({ evidence: { implement: ev('implement', 1000, { costUsd: 1.5, toolCalls: 40 }) } }),
        task({ evidence: { implement: ev('implement', 1000, { costUsd: 2.5, toolCalls: null }) } }),
        task({ evidence: { implement: ev('implement', 1000, { toolCalls: 20 }) } }),
      ],
      NOW,
    );
    const s = m.stages[0];
    expect(s.costUsd).toBe(4);
    expect(s.costN).toBe(2);
    expect(s.avgToolCalls).toBe(30);
  });

  it('没有任何成本或工具调用记录时给 null，不用 0 回填', () => {
    const m = computeFlowMetrics([task({ evidence: { verify: ev('verify', 1000, { toolCalls: null }) } })], NOW);
    expect(m.stages[0].costUsd).toBeNull();
    expect(m.stages[0].costN).toBe(0);
    expect(m.stages[0].avgToolCalls).toBeNull();
  });
});

const gate = (verdict: 'pass' | 'fail' | 'unverified') => ({ verdict, reasons: [], items: [], outOfScope: [], changedFiles: [], at: NOW });

describe('computeFlowMetrics 结论与积压', () => {
  it('门禁结论按有结论的任务计数', () => {
    const m = computeFlowMetrics([task({ gate: gate('unverified') }), task({ gate: gate('unverified') }), task({ gate: gate('fail') }), task()], NOW);
    expect(m.outcomes).toEqual({ gated: 3, pass: 0, unverified: 2, fail: 1 });
  });

  it('积压只列未完成且有任务的状态，给出数量与最久停留时长', () => {
    const m = computeFlowMetrics(
      [
        task({ status: 'pending_confirm', updatedAt: NOW - 7_200_000 }),
        task({ status: 'pending_confirm', updatedAt: NOW - 3_600_000 }),
        task({ status: 'todo', updatedAt: NOW - 60_000 }),
        task({ status: 'done' }),
      ],
      NOW,
    );
    expect(m.backlog).toEqual([
      { status: 'pending_confirm', n: 2, oldestMs: 7_200_000 },
      { status: 'todo', n: 1, oldestMs: 60_000 },
    ]);
  });

  it('待确认里生成规格失败的任务单独计数，并按原因归并', () => {
    const m = computeFlowMetrics(
      [
        task({ status: 'pending_confirm', error: '生成规格失败：代码目录不存在：E:\\a' }),
        task({ status: 'pending_confirm', error: '生成规格失败：代码目录不存在：E:\\a' }),
        task({ status: 'pending_confirm', error: '生成规格失败：超时' }),
        task({ status: 'pending_confirm' }),
      ],
      NOW,
    );
    expect(m.analyzeStuck.n).toBe(3);
    expect(m.analyzeStuck.reasons[0]).toEqual({ reason: '代码目录不存在：E:\\a', n: 2 });
  });
});

describe('flowFindings', () => {
  const stuck = (n: number, error: string) => Array.from({ length: n }, () => task({ status: 'pending_confirm', error }));

  it('同一原因卡住 5 个及以上任务时出一条积压问题，带稳定去重键', () => {
    const drafts = flowFindings('p1', computeFlowMetrics(stuck(5, '生成规格失败：代码目录不存在：E:\\a'), NOW));
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('flow_backlog');
    expect(drafts[0].key).toBe('flow:analyze-stuck:p1');
    expect(drafts[0].projectId).toBe('p1');
  });

  it('不足 5 个不出问题', () => {
    expect(flowFindings('p1', computeFlowMetrics(stuck(4, '生成规格失败：超时'), NOW))).toEqual([]);
  });

  it('有 5 轮以上门禁结论却从未自动通过时出一条门禁问题', () => {
    const tasks = [...Array.from({ length: 4 }, () => task({ gate: gate('unverified') })), task({ gate: gate('fail') })];
    const drafts = flowFindings('p1', computeFlowMetrics(tasks, NOW));
    expect(drafts.map((d) => d.kind)).toEqual(['flow_gate']);
    expect(drafts[0].key).toBe('flow:no-pass:p1');
  });

  it('有过自动通过就不出门禁问题', () => {
    const tasks = [...Array.from({ length: 5 }, () => task({ gate: gate('unverified') })), task({ gate: gate('pass') })];
    expect(flowFindings('p1', computeFlowMetrics(tasks, NOW))).toEqual([]);
  });
});

describe('flowSection', () => {
  it('没有任何项目数据时返回空串', () => {
    expect(flowSection([])).toBe('');
  });

  it('写出阶段耗时、门禁分布、积压与卡住原因，未知成本写「未记录」', () => {
    const tasks = [
      task({ evidence: { verify: ev('verify', 297_000, { toolCalls: 22 }) }, gate: gate('unverified') }),
      task({ status: 'pending_confirm', error: '生成规格失败：代码目录不存在：E:\a' }),
    ];
    const text = flowSection([{ name: '项目甲', metrics: computeFlowMetrics(tasks, NOW) }]);
    expect(text).toContain('## 流程体检');
    expect(text).toContain('项目甲');
    expect(text).toContain('验证');
    expect(text).toContain('297 秒');
    expect(text).toContain('未记录');
    expect(text).toContain('需要人工验收 1');
    expect(text).toContain('代码目录不存在');
  });
});
