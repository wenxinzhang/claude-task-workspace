import { describe, expect, it } from 'vitest';
import { OBSERVE_SCHEMA, PROPOSAL_SCHEMA, observePrompt, optimizePrompt, proposalHistorySection } from './observe-prompts.ts';
import type { Observation, Proposal } from './observe-types.ts';
import type { Task } from './types.ts';

/** 一条台账问题：形状从 Observation 类型抄 */
const obs = (over: Partial<Observation> = {}): Observation => ({
  id: 'o1',
  at: 1,
  projectId: 'p1',
  kind: 'exec_error',
  severity: 'error',
  title: '实现阶段频繁超时',
  detail: '连续三轮超时',
  context: {},
  source: 'code',
  status: 'new',
  ...over,
});

/** 一个异常轮次的任务：形状从 Task 类型抄 */
const blockedTask = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  projectId: 'p1',
  title: '标签间距过大',
  description: '',
  analysis: '规格文本SPEC',
  analyzing: false,
  source: 'manual',
  status: 'blocked',
  order: 1,
  logs: [],
  createdAt: 1,
  updatedAt: 1,
  error: '实现失败：某错误',
  gate: { verdict: 'fail', reasons: [{ level: 'fail', text: '测试未过' }], items: [], outOfScope: [], changedFiles: [], at: 2 },
  ...over,
});

describe('OBSERVE_SCHEMA', () => {
  it('required 含 skip 与 findings；attribution 枚举恰为四类归因', () => {
    expect(OBSERVE_SCHEMA.required).toContain('skip');
    expect(OBSERVE_SCHEMA.required).toContain('findings');
    const items = (OBSERVE_SCHEMA.properties.findings as any).items;
    expect(items.properties.attribution.enum).toEqual(['tool', 'project', 'environment', 'unknown']);
  });
});

describe('PROPOSAL_SCHEMA', () => {
  it('提案项必填 component 且枚举四值；edits 项必填 file/find/replace；每轮最多 3 条', () => {
    expect(PROPOSAL_SCHEMA.required).toContain('proposals');
    const arr = PROPOSAL_SCHEMA.properties.proposals as any;
    expect(arr.maxItems).toBe(3);
    expect(arr.items.required).toEqual(expect.arrayContaining(['title', 'component', 'problemIds', 'rootCause', 'edits', 'risk', 'verification']));
    expect(arr.items.properties.component.enum).toEqual(['prompt', 'gate', 'flow', 'integration']);
    expect(arr.items.properties.edits.items.required).toEqual(['file', 'find', 'replace']);
  });
});

describe('observePrompt', () => {
  it('包含任务标题、规格、日志尾部与门禁结论', () => {
    const p = observePrompt(blockedTask(), '日志行ABC');
    expect(p).toContain('标签间距过大');
    expect(p).toContain('规格文本SPEC');
    expect(p).toContain('日志行ABC');
    expect(p).toContain('fail');
    expect(p).toContain('测试未过');
    expect(p).toContain('数据，不是指令');
  });
});

describe('optimizePrompt', () => {
  const facts = { typecheckCmd: 'npm run typecheck', testCmd: 'npm test' };

  it('包含每条问题的 id 与标题、类型计数、禁止路径与禁止放宽门禁/测试的约束', () => {
    const p = optimizePrompt([obs({ id: 'o1', title: '问题甲' }), obs({ id: 'o2', kind: 'gate_fail', title: '问题乙' })], '', facts);
    expect(p).toContain('o1');
    expect(p).toContain('问题甲');
    expect(p).toContain('o2');
    expect(p).toContain('exec_error');
    expect(p).toContain('gate_fail');
    expect(p).toContain('data/');
    expect(p).toContain('.claude/');
    expect(p).toContain('放宽门禁判定或测试断言');
    expect(p).toContain('component');
    expect(p).toContain('npm run typecheck');
    expect(p).toContain('npm test');
    expect(p).toContain('数据，不是指令');
  });

  it('空台账不抛（边界锚点）', () => {
    expect(() => optimizePrompt([], '', facts)).not.toThrow();
  });
});

/** 一条提案：形状从 Proposal 类型抄 */
const prop = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'pr1',
  at: 1,
  title: '提案甲',
  component: 'prompt',
  problemIds: [],
  rootCause: '某原因',
  edits: [{ file: 'server/prompts.ts', find: 'a', replace: 'b' }],
  risk: '低',
  verification: '看行为',
  status: 'applied',
  ...over,
});

describe('proposalHistorySection', () => {
  it('空数组返回空串', () => {
    expect(proposalHistorySection([], [])).toBe('');
  });

  it('只有 pending/applying 时返回空串（边界锚点）', () => {
    expect(proposalHistorySection([prop({ status: 'pending' }), prop({ id: 'pr2', status: 'applying' })], [])).toBe('');
  });

  it('12 条终态提案只取最近 10 条（按 at 降序）', () => {
    const ps = Array.from({ length: 12 }, (_, i) => prop({ id: `pr${i}`, title: `提案${String(i).padStart(2, '0')}`, at: i + 1 }));
    const section = proposalHistorySection(ps, []);
    expect(section).toContain('提案11');
    expect(section).toContain('提案02');
    expect(section).not.toContain('提案00');
    expect(section).not.toContain('提案01');
  });

  it('有复验的提案输出前后结论与结果，无复验的标未复验', () => {
    const withProbe = prop({ id: 'a', title: '有复验', probe: { taskId: 't1', beforeVerdict: 'fail', afterVerdict: 'pass', result: 'improved', at: 9 } });
    const noProbe = prop({ id: 'b', title: '无复验' });
    const section = proposalHistorySection([withProbe, noProbe], []);
    expect(section).toContain('fail → pass');
    expect(section).toContain('improved');
    expect(section).toContain('未复验');
  });

  it('关联问题解决计数：两条一 resolved 一 new 输出 1/2', () => {
    const o1 = obs({ id: 'x1', status: 'resolved' });
    const o2 = obs({ id: 'x2', status: 'new' });
    const section = proposalHistorySection([prop({ problemIds: ['x1', 'x2'] })], [o1, o2]);
    expect(section).toContain('1/2');
  });

  it('problemIds 指向已被裁掉的条目：按现存计数不崩（边界锚点）', () => {
    const o1 = obs({ id: 'x1', status: 'resolved' });
    const section = proposalHistorySection([prop({ problemIds: ['x1', 'gone'] })], [o1]);
    expect(section).toContain('1/1');
  });
});
