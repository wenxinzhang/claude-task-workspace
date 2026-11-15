import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRequest, AgentResult } from './agent.ts';
import { canAutoOptimize, normalizeProposals, Optimizer } from './optimize.ts';
import { ObservationStore } from './observe.ts';
import { DEFAULT_OBSERVER_SETTINGS, type Observation } from './observe-types.ts';
import { ProposalStore } from './proposal-store.ts';
import type { RunEvidence } from './types.ts';

const base = { enabled: true, autoOptimize: true, idle: true, newCount: 3, lastRunAt: null, diagnosing: false, applying: null as string | null };
const cfg = { minNewObservations: 3, cooldownHours: 6 };

describe('canAutoOptimize', () => {
  it('全条件满足可触发；任一否决条件都不触发', () => {
    expect(canAutoOptimize(base, 1000, cfg)).toBe(true);
    expect(canAutoOptimize({ ...base, enabled: false }, 1000, cfg)).toBe(false);
    expect(canAutoOptimize({ ...base, autoOptimize: false }, 1000, cfg)).toBe(false);
    expect(canAutoOptimize({ ...base, idle: false }, 1000, cfg)).toBe(false);
    expect(canAutoOptimize({ ...base, diagnosing: true }, 1000, cfg)).toBe(false);
    expect(canAutoOptimize({ ...base, applying: 'p1' }, 1000, cfg)).toBe(false);
  });

  it('阈值边界：差一条不触发，恰好达到触发（边界锚点）', () => {
    expect(canAutoOptimize({ ...base, newCount: 2 }, 1000, cfg)).toBe(false);
    expect(canAutoOptimize({ ...base, newCount: 3 }, 1000, cfg)).toBe(true);
  });

  it('冷却边界：无历史不限；不足不触发；恰好到期触发（边界锚点）', () => {
    const sixH = 6 * 3_600_000;
    expect(canAutoOptimize({ ...base, lastRunAt: null }, 1000, cfg)).toBe(true);
    expect(canAutoOptimize({ ...base, lastRunAt: 1000 }, 1000 + sixH - 1, cfg)).toBe(false);
    expect(canAutoOptimize({ ...base, lastRunAt: 1000 }, 1000 + sixH, cfg)).toBe(true);
  });
});

describe('normalizeProposals', () => {
  const known = new Set(['o1', 'o2']);
  const rawProp = (over: Record<string, unknown> = {}) => ({
    title: '提案',
    component: 'prompt',
    problemIds: ['o1'],
    rootCause: 'rc',
    edits: [{ file: 'server/prompts.ts', find: 'a', replace: 'b' }],
    risk: '低',
    verification: 'v',
    ...over,
  });

  it('合法 raw 归一为草稿；未知 problemIds 过滤、全未知丢弃；空 edits 与白名单外文件丢弃', () => {
    const raw = {
      proposals: [
        rawProp(),
        rawProp({ title: '全未知', problemIds: ['gone'] }),
        rawProp({ title: '空 edits', edits: [] }),
        rawProp({ title: '越界文件', edits: [{ file: 'data/settings.json', find: 'a', replace: 'b' }] }),
        rawProp({ title: 'package.json', edits: [{ file: 'package.json', find: 'a', replace: 'b' }] }),
        rawProp({ title: '测试文件放行', edits: [{ file: 'server/x.test.ts', find: 'a', replace: 'b' }] }),
        rawProp({ title: '部分未知', problemIds: ['o1', 'gone'] }),
      ],
    };
    const drafts = normalizeProposals(raw, known);
    expect(drafts.map((d) => d.title)).toEqual(['提案', '测试文件放行', '部分未知']);
    expect(drafts[2].problemIds).toEqual(['o1']);
  });

  it('component 缺失或非法丢弃；输出按风险秩排序，gate 排最后', () => {
    const raw = {
      proposals: [
        rawProp({ title: '门禁', component: 'gate' }),
        rawProp({ title: '缺组件', component: undefined }),
        rawProp({ title: '非法组件', component: '外星' }),
        rawProp({ title: '提示词', component: 'prompt' }),
        rawProp({ title: '流程', component: 'flow' }),
      ],
    };
    expect(normalizeProposals(raw, known).map((d) => d.title)).toEqual(['提示词', '流程', '门禁']);
  });

  it('超过 3 条截断；非对象输入为空（边界锚点）', () => {
    const raw = { proposals: [rawProp({ title: 'a' }), rawProp({ title: 'b' }), rawProp({ title: 'c' }), rawProp({ title: 'd' })] };
    expect(normalizeProposals(raw, known)).toHaveLength(3);
    expect(normalizeProposals(null, known)).toEqual([]);
    expect(normalizeProposals({ proposals: 'x' }, known)).toEqual([]);
  });
});

describe('Optimizer', () => {
  const ev: RunEvidence = { stage: 'analysis', provider: 'claude', toolCalls: 2, tools: {}, denials: [], durationMs: 10, at: Date.now() };
  const oDraft = (over: Partial<Observation> = {}): Omit<Observation, 'id' | 'at' | 'status'> => ({
    projectId: 'p1',
    kind: 'exec_error',
    severity: 'error',
    title: '问题',
    detail: 'd',
    context: {},
    source: 'code',
    ...over,
  });

  function setup(opts: { enabled?: boolean; autoOptimize?: boolean; idle?: boolean; newCount?: number; structured?: unknown; ok?: boolean } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-opt-'));
    const observations = new ObservationStore(root);
    const proposals = new ProposalStore(root);
    for (let i = 0; i < (opts.newCount ?? 3); i++) observations.add(oDraft({ title: `问题${i}` }));
    let calls = 0;
    let captured: AgentRequest | undefined;
    let structured: unknown = opts.structured ?? { proposals: [] };
    const run = async (req: AgentRequest): Promise<AgentResult> => {
      calls++;
      captured = req;
      return { ok: opts.ok !== false, text: '', structured, evidence: ev };
    };
    const optimizer = new Optimizer({
      observations,
      proposals,
      getSettings: () => ({ observer: { ...DEFAULT_OBSERVER_SETTINGS, enabled: opts.enabled !== false, autoOptimize: opts.autoOptimize !== false } }),
      isIdle: () => opts.idle !== false,
      toolRoot: root,
      run,
    });
    return {
      root,
      observations,
      proposals,
      optimizer,
      setStructured: (s: unknown) => { structured = s; },
      get calls() { return calls; },
      get captured() { return captured; },
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  }

  it('条件不满足 run 零调用；满足恰一次，只读、中性 cwd、产出入库、lastRunAt 更新', async () => {
    const idle = setup({ idle: false });
    try {
      await idle.optimizer.maybeAuto();
      expect(idle.calls).toBe(0);
    } finally {
      idle.observations.flush();
      idle.proposals.flush();
      idle.cleanup();
    }
    const ctx = setup();
    try {
      const problemId = ctx.observations.list()[0].id;
      ctx.setStructured({ proposals: [{ title: '提案X', component: 'prompt', problemIds: [problemId], rootCause: 'rc', edits: [{ file: 'server/prompts.ts', find: 'a', replace: 'b' }], risk: '低', verification: 'v' }] });
      await ctx.optimizer.maybeAuto();
      expect(ctx.calls).toBe(1);
      expect(ctx.captured!.access).toBe('read');
      expect(ctx.captured!.cwd).not.toBe(ctx.root);
      expect(ctx.proposals.list()).toHaveLength(1);
      expect(ctx.proposals.getLastRunAt()).not.toBeNull();
    } finally {
      ctx.observations.flush();
      ctx.proposals.flush();
      ctx.cleanup();
    }
  });

  it('诊断 prompt 含历史提案结局段落（喂回锚点）', async () => {
    const ctx = setup();
    try {
      const problemId = ctx.observations.list()[0].id;
      const p = ctx.proposals.add({ title: '历史提案甲', component: 'prompt', problemIds: [problemId], rootCause: 'rc', edits: [{ file: 'server/prompts.ts', find: 'a', replace: 'b' }], risk: '低', verification: 'v' });
      ctx.proposals.setStatus(p.id, 'applied', { ok: true, output: '', at: 1, mode: 'apply' });
      ctx.proposals.setProbe(p.id, { taskId: 't1', beforeVerdict: 'fail', afterVerdict: 'pass', result: 'improved', at: 2 });
      await ctx.optimizer.maybeAuto();
      expect(ctx.captured!.prompt).toContain('历史提案甲');
      expect(ctx.captured!.prompt).toContain('improved');
    } finally {
      ctx.observations.flush();
      ctx.proposals.flush();
      ctx.cleanup();
    }
  });

  it('runManual：未开启拒绝；run 失败不产出、不抛、lastRunAt 仍更新（错误路径锚点）', async () => {
    const off = setup({ enabled: false });
    try {
      const r = await off.optimizer.runManual();
      expect(r.started).toBe(false);
      expect(off.calls).toBe(0);
    } finally {
      off.observations.flush();
      off.proposals.flush();
      off.cleanup();
    }
    const ctx = setup({ ok: false });
    try {
      const r = await ctx.optimizer.runManual();
      expect(r.started).toBe(true);
      await new Promise((res) => setTimeout(res, 30));
      expect(ctx.proposals.list()).toEqual([]);
      expect(ctx.proposals.getLastRunAt()).not.toBeNull();
    } finally {
      ctx.observations.flush();
      ctx.proposals.flush();
      ctx.cleanup();
    }
  });

  it('台账只有 note 级新问题时不触发自动诊断（阈值语义锚点）', async () => {
    const ctx = setup({ newCount: 0 });
    try {
      ctx.observations.add(oDraft({ severity: 'note' }));
      await ctx.optimizer.maybeAuto();
      expect(ctx.calls).toBe(0);
    } finally {
      ctx.observations.flush();
      ctx.proposals.flush();
      ctx.cleanup();
    }
  });
});
