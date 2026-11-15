import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ObservationStore } from './observe.ts';
import { canAbandon, canRetryApply, effectiveAttribution, isActionable, type Observation } from './observe-types.ts';

const dirs: string[] = [];
const newStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-obs-flow-'));
  dirs.push(dir);
  return new ObservationStore(dir);
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const draft = (patch: Partial<Omit<Observation, 'id' | 'at' | 'status'>> = {}): Omit<Observation, 'id' | 'at' | 'status'> => ({
  projectId: 'p1',
  kind: 'flow_backlog',
  severity: 'warn',
  title: '积压',
  detail: '',
  context: {},
  source: 'code',
  ...patch,
});

describe('ObservationStore 按 key 去重', () => {
  it('同 key 的问题还没处理时不重复入库', () => {
    const s = newStore();
    s.add(draft({ key: 'flow:x' }));
    s.add(draft({ key: 'flow:x' }));
    expect(s.list()).toHaveLength(1);
  });

  it('同 key 的问题被忽略后也不再入库', () => {
    const s = newStore();
    const o = s.add(draft({ key: 'flow:x' }));
    s.setStatus(o.id, 'ignored');
    s.add(draft({ key: 'flow:x' }));
    expect(s.list()).toHaveLength(1);
  });

  it('同 key 的问题已解决、过了静默期后再次出现会重新入库', () => {
    const s = newStore();
    const t0 = 1_000_000_000_000;
    const o = s.add(draft({ key: 'flow:x' }), t0);
    s.setStatus(o.id, 'resolved', t0);
    s.add(draft({ key: 'flow:x' }), t0 + 25 * 3_600_000);
    expect(s.list()).toHaveLength(2);
  });

  it('不带 key 的问题不去重', () => {
    const s = newStore();
    s.add(draft());
    s.add(draft());
    expect(s.list()).toHaveLength(2);
  });
});

describe('归因', () => {
  const obs = (patch: Partial<Observation>): Observation => ({ ...draft(), id: 'o1', at: 1, status: 'new', ...patch });

  it('Git 连不上远端归为环境问题', () => {
    const o = obs({ kind: 'git_push', severity: 'error', detail: "git push 失败：fatal: unable to access 'http://h/x.git/': Failed to connect to h port 3030 after 21064 ms: Could not connect to server" });
    expect(effectiveAttribution(o)).toBe('environment');
  });

  it('代码目录不存在归为环境问题', () => {
    expect(effectiveAttribution(obs({ kind: 'analyze_fail', severity: 'error', detail: '生成规格失败：代码目录不存在：E:\\a' }))).toBe('environment');
  });

  it('判不出来的不给归因', () => {
    expect(effectiveAttribution(obs({ kind: 'gate_fail', severity: 'error', detail: '验收项未通过：AC1' }))).toBeUndefined();
  });

  it('显式写了归因就用写的，不再推断', () => {
    expect(effectiveAttribution(obs({ kind: 'git_push', detail: 'Could not connect to server', attribution: 'tool' }))).toBe('tool');
  });

  it('可行动 = 未处理、不是备注、不是环境或项目问题', () => {
    expect(isActionable(obs({ kind: 'gate_unverified', severity: 'warn' }))).toBe(true);
    expect(isActionable(obs({ severity: 'note' }))).toBe(false);
    expect(isActionable(obs({ status: 'resolved' }))).toBe(false);
    expect(isActionable(obs({ attribution: 'environment' }))).toBe(false);
    expect(isActionable(obs({ attribution: 'project' }))).toBe(false);
  });

  it('countNew 不计环境问题', () => {
    const s = newStore();
    s.add(draft({ kind: 'git_push', severity: 'error', detail: 'Could not connect to server' }));
    s.add(draft({ kind: 'gate_fail', severity: 'error', detail: '验收项未通过' }));
    expect(s.countNew()).toBe(1);
  });
});

// ---------- 流程审查会话：发现入台账、提案可引用本次发现、结果留痕 ----------

import type { AgentRequest, AgentResult } from './agent.ts';
import { createObserver } from './observer.ts';
import { DEFAULT_OBSERVER_SETTINGS } from './observe-types.ts';
import { normalizeFindings, Optimizer, resolveRefs } from './optimize.ts';
import { ProposalStore } from './proposal-store.ts';
import { Queue } from './queue.ts';
import { Store } from './store.ts';

describe('normalizeFindings', () => {
  it('只留有标题的发现，非法归因置空，最多 5 条', () => {
    const raw = { findings: [{ title: '验证重复跑测试', detail: 'd', attribution: 'tool', component: 'prompt' }, { title: '  ', detail: 'x' }, { title: '网络', attribution: '乱写' }, ...Array.from({ length: 6 }, (_, i) => ({ title: `f${i}` }))] };
    const out = normalizeFindings(raw);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ title: '验证重复跑测试', detail: 'd', attribution: 'tool', component: 'prompt' });
    expect(out[1].attribution).toBeUndefined();
  });

  it('形状不对给空数组', () => {
    expect(normalizeFindings(null)).toEqual([]);
    expect(normalizeFindings({ findings: 'x' })).toEqual([]);
  });
});

describe('resolveRefs', () => {
  it('把提案里的 F1、F2 换成本次发现的台账 id，其余原样', () => {
    const out = resolveRefs({ proposals: [{ problemIds: ['F2', 'abc', 'F9'] }] }, ['id1', 'id2']) as { proposals: { problemIds: string[] }[] };
    expect(out.proposals[0].problemIds).toEqual(['id2', 'abc', 'F9']);
  });
});

const evidence = { stage: 'analysis' as const, provider: 'claude' as const, toolCalls: 2, tools: {}, denials: [], durationMs: 10, at: 1 };

function optimizerSetup(run: (req: AgentRequest) => Promise<AgentResult>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-opt-flow-'));
  dirs.push(dir);
  const observations = new ObservationStore(dir);
  const proposals = new ProposalStore(dir);
  const optimizer = new Optimizer({
    observations,
    proposals,
    getSettings: () => ({ observer: { ...DEFAULT_OBSERVER_SETTINGS, enabled: true } }),
    isIdle: () => true,
    toolRoot: dir,
    run,
    getFlow: () => '\n\n## 流程体检\nX',
  });
  return { dir, observations, proposals, optimizer };
}

const waitFor = async (cond: () => boolean) => {
  const end = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > end) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('流程审查会话', () => {
  it('发现写入台账，提案可用 F1 引用本次发现，并留下本次结果', async () => {
    fs.mkdirSync(path.join(os.tmpdir()), { recursive: true });
    let prompt = '';
    const ctx = optimizerSetup(async (req) => {
      prompt = req.prompt;
      return {
        ok: true,
        text: '',
        evidence,
        structured: {
          findings: [{ title: '验证阶段重复跑实现阶段的测试', detail: 'd', attribution: 'tool', component: 'prompt' }],
          proposals: [{ title: '改提示词', component: 'prompt', problemIds: ['F1'], rootCause: 'rc', edits: [{ file: 'server/prompts.ts', find: 'a', replace: 'b' }], risk: '', verification: '' }],
        },
      };
    });
    await ctx.optimizer.runManual();
    await waitFor(() => !ctx.optimizer.isDiagnosing());
    expect(prompt).toContain('## 流程体检');
    const obs = ctx.observations.list();
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('flow_finding');
    expect(obs[0].attribution).toBe('tool');
    const ps = ctx.proposals.list();
    expect(ps).toHaveLength(1);
    expect(ps[0].problemIds).toEqual([obs[0].id]);
    expect(ctx.proposals.getLastRun()).toMatchObject({ ok: true, proposals: 1, findings: 1 });
  });

  it('会话失败时留下失败原因，不产出提案', async () => {
    const ctx = optimizerSetup(async () => ({ ok: false, text: '超出预算', evidence }));
    await ctx.optimizer.runManual();
    await waitFor(() => !ctx.optimizer.isDiagnosing());
    expect(ctx.proposals.list()).toEqual([]);
    const last = ctx.proposals.getLastRun()!;
    expect(last.ok).toBe(false);
    expect(last.error).toContain('超出预算');
  });
});

function observerSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-observer-flow-'));
  dirs.push(root);
  const workdir = path.join(root, 'work');
  fs.mkdirSync(workdir, { recursive: true });
  const store = new Store(path.join(root, 'data'));
  const project = store.createProject({ name: 'p', workdir, exec: { useKnowledge: false } });
  const run = async (): Promise<AgentResult> => ({ ok: true, text: '', structured: { proposals: [] }, evidence });
  const queue = new Queue(store, undefined, run);
  const spawned: string[] = [];
  const observer = createObserver({
    root,
    store,
    queue,
    deployer: { allStatus: () => ({}) },
    getSettings: () => ({ observer: { ...DEFAULT_OBSERVER_SETTINGS, enabled: true } }),
    run,
    spawnApply: (mode, id) => spawned.push(`${mode}:${id}`),
  });
  return { root, store, project, observer, spawned };
}

describe('观察者流程采集', () => {
  it('同一原因卡住 5 个任务：台账出一条积压问题，重复采集不重复入库', () => {
    const ctx = observerSetup();
    try {
      for (let i = 0; i < 5; i++) {
        const t = ctx.store.create({ projectId: ctx.project.id, title: `任务${i}`, description: '', source: 'manual' });
        ctx.store.update(t.id, { error: '生成规格失败：模型没有返回规格' });
      }
      ctx.observer.collectFlow();
      ctx.observer.collectFlow();
      const flow = ctx.observer.observations.list({ kind: 'flow_backlog' });
      expect(flow).toHaveLength(1);
      expect(ctx.observer.flow()[ctx.project.id].analyzeStuck.n).toBe(5);
    } finally {
      ctx.observer.dispose();
    }
  });

  it('应用失败被还原的提案可以重试应用', () => {
    const ctx = observerSetup();
    try {
      const p = ctx.observer.proposals.add({ title: '提案', component: 'prompt', problemIds: [], rootCause: '', edits: [{ file: 'server/prompts.ts', find: 'a', replace: 'b' }], risk: '', verification: '' });
      ctx.observer.proposals.setStatus(p.id, 'rolled_back', { ok: false, output: '应用进程中断', at: 1, mode: 'apply' });
      expect(ctx.observer.startApply(p.id).ok).toBe(true);
      expect(ctx.spawned).toEqual([`apply:${p.id}`]);
    } finally {
      ctx.observer.dispose();
    }
  });

  it('手动回滚成功的提案不能重试应用', () => {
    const ctx = observerSetup();
    try {
      const p = ctx.observer.proposals.add({ title: '提案', component: 'prompt', problemIds: [], rootCause: '', edits: [{ file: 'server/prompts.ts', find: 'a', replace: 'b' }], risk: '', verification: '' });
      ctx.observer.proposals.setStatus(p.id, 'rolled_back', { ok: true, output: '已回滚到应用前', at: 1, mode: 'rollback' });
      expect(ctx.observer.startApply(p.id).ok).toBe(false);
    } finally {
      ctx.observer.dispose();
    }
  });

  it('上次应用后文件没能还原的提案不能重试（重试会用改过的文件覆盖唯一的原始备份）', () => {
    const ctx = observerSetup();
    try {
      const p = ctx.observer.proposals.add({ title: '提案', component: 'prompt', problemIds: [], rootCause: '', edits: [{ file: 'server/prompts.ts', find: 'a', replace: 'b' }], risk: '', verification: '' });
      ctx.observer.proposals.setStatus(p.id, 'rolled_back', { ok: false, output: '还原失败', at: 1, mode: 'apply', restored: false });
      expect(ctx.observer.startApply(p.id).ok).toBe(false);
    } finally {
      ctx.observer.dispose();
    }
  });
});

// ---------- 审查意见的回归测试 ----------

import { applyProposal, backupFiles } from './apply-proposal.ts';
import { computeFlowMetrics, flowFindings } from './flow-metrics.ts';
import { proposalHistorySection } from './observe-prompts.ts';
import type { Proposal } from './observe-types.ts';
import type { Task } from './types.ts';

describe('应用提案：备份保护', () => {
  it('留有未完成的旧备份且文件与备份时不一致：拒绝应用，旧备份原样保留', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-apply-guard-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'server'), { recursive: true });
    const file = path.join(root, 'server', 'a.ts');
    fs.writeFileSync(file, 'orig\n', 'utf8');
    const proposal = { id: 'p1', at: 1, status: 'applying', title: 't', component: 'prompt', problemIds: [], rootCause: '', risk: '', verification: '', edits: [{ file: 'server/a.ts', find: 'orig', replace: 'orig\nmore' }] } as Proposal;
    backupFiles(root, 'p1', ['server/a.ts']);
    // 上次应用改了文件却没还原
    fs.writeFileSync(file, 'orig\nmore\n', 'utf8');
    const res = await applyProposal({ root, proposal, runChecks: async () => ({ ok: true, output: '' }) });
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(path.join(root, 'data', 'observer-backups', 'p1', 'server', 'a.ts'), 'utf8')).toBe('orig\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('orig\nmore\n');
  });

  it('检查不过时如实记录文件是否已还原', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-apply-guard-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'server', 'a.ts'), 'orig\n', 'utf8');
    const proposal = { id: 'p2', at: 1, status: 'applying', title: 't', component: 'prompt', problemIds: [], rootCause: '', risk: '', verification: '', edits: [{ file: 'server/a.ts', find: 'orig', replace: 'new' }] } as Proposal;
    const res = await applyProposal({ root, proposal, runChecks: async () => ({ ok: false, output: '测试挂了' }) });
    expect(res).toMatchObject({ ok: false, restored: true });
    expect(fs.readFileSync(path.join(root, 'server', 'a.ts'), 'utf8')).toBe('orig\n');
  });
});

describe('台账：归因只对代码采集的集成类问题推断', () => {
  const base = { id: 'o', at: 1, status: 'new' as const, projectId: 'p1', title: 't', context: {}, severity: 'warn' as const };

  it('LLM 的发现和流程积压里提到网络错误，不被翻成环境问题', () => {
    expect(effectiveAttribution({ ...base, kind: 'llm_finding', source: 'llm', detail: '日志里有 ECONNREFUSED，工具没有重试' })).toBeUndefined();
    expect(effectiveAttribution({ ...base, kind: 'flow_backlog', source: 'code', detail: '5 个：代码目录不存在：E:\\a' })).toBeUndefined();
    expect(effectiveAttribution({ ...base, kind: 'gate_fail', source: 'code', detail: 'Could not connect to server' })).toBeUndefined();
  });

  it('刚标记已解决的带 key 问题一天内不重新入库，过后再出现才算复发', () => {
    const s = newStore();
    const t0 = 1_000_000_000_000;
    const o = s.add(draft({ key: 'flow:x' }), t0);
    s.setStatus(o.id, 'resolved', t0);
    s.add(draft({ key: 'flow:x' }), t0 + 3_600_000);
    expect(s.list()).toHaveLength(1);
    s.add(draft({ key: 'flow:x' }), t0 + 25 * 3_600_000);
    expect(s.list()).toHaveLength(2);
  });
});

describe('流程指标：卡住原因的归并', () => {
  const stuckTask = (i: number, patch: Partial<Task> = {}): Task =>
    ({ id: `s${i}`, projectId: 'p1', status: 'pending_confirm', analyzing: false, updatedAt: 1, createdAt: 1, logs: [], error: `生成规格失败：没有得到可用的规格（缺少目标或验收项）。代理的回复：第 ${i} 种说法`, ...patch }) as Task;

  it('每个任务尾巴不同的同类失败归并成一条原因，凑够 5 个就出问题', () => {
    const m = computeFlowMetrics(Array.from({ length: 5 }, (_, i) => stuckTask(i)), 2);
    expect(m.analyzeStuck.reasons).toEqual([{ reason: '没有得到可用的规格（缺少目标或验收项）', n: 5 }]);
    expect(flowFindings('p1', m)).toHaveLength(1);
  });

  it('正在重新生成规格的任务不算卡住', () => {
    const m = computeFlowMetrics([stuckTask(1, { analyzing: true }), stuckTask(2)], 2);
    expect(m.analyzeStuck.n).toBe(1);
  });
});

describe('流程审查：发现去重', () => {
  it('同一条发现两次审查只入库一次', async () => {
    const ctx = optimizerSetup(async () => ({ ok: true, text: '', evidence, structured: { findings: [{ title: '验证阶段重复跑测试', detail: 'd', attribution: 'tool' }], proposals: [] } }));
    await ctx.optimizer.runManual();
    await waitFor(() => !ctx.optimizer.isDiagnosing());
    await ctx.optimizer.runManual();
    await waitFor(() => !ctx.optimizer.isDiagnosing());
    expect(ctx.observations.list()).toHaveLength(1);
  });

  it('失败原因过长时截断保存', async () => {
    const ctx = optimizerSetup(async () => ({ ok: false, text: 'x'.repeat(2000), evidence }));
    await ctx.optimizer.runManual();
    await waitFor(() => !ctx.optimizer.isDiagnosing());
    expect(ctx.proposals.getLastRun()!.error!.length).toBeLessThanOrEqual(301);
  });
});

describe('应用提案：还原过的备份不再挡住重试', () => {
  const mk = (id: string, replace: string) =>
    ({ id, at: 1, status: 'applying', title: 't', component: 'prompt', problemIds: [], rootCause: '', risk: '', verification: '', edits: [{ file: 'server/a.ts', find: 'orig', replace }] }) as Proposal;
  const setupRoot = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-apply-retry-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'server', 'a.ts'), 'orig\n', 'utf8');
    return root;
  };

  it('上次检查不过但已还原，之后文件被正当改过：重试照常应用，不误报「没有还原」', async () => {
    const root = setupRoot();
    const p = mk('p3', 'orig\nmore');
    await applyProposal({ root, proposal: p, runChecks: async () => ({ ok: false, output: '挂了' }) });
    fs.writeFileSync(path.join(root, 'server', 'a.ts'), 'orig\nlater\n', 'utf8');
    const res = await applyProposal({ root, proposal: p, runChecks: async () => ({ ok: true, output: '' }) });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'server', 'a.ts'), 'utf8')).toBe('orig\nmore\nlater\n');
  });

  it('文件确实没还原、原文片段也已不在：如实报没有还原，而不是「提案已失效」', async () => {
    const root = setupRoot();
    backupFiles(root, 'p4', ['server/a.ts']);
    fs.writeFileSync(path.join(root, 'server', 'a.ts'), 'changed\n', 'utf8');
    const res = await applyProposal({ root, proposal: mk('p4', 'new'), runChecks: async () => ({ ok: true, output: '' }) });
    expect(res).toMatchObject({ ok: false, restored: false });
  });

  it('应用没成功的提案都可以放弃，包括没法重试的', () => {
    const failed = { status: 'rolled_back' as const, result: { ok: false, output: '', at: 1, mode: 'apply' as const, restored: false } };
    expect(canRetryApply(failed)).toBe(false);
    expect(canAbandon(failed)).toBe(true);
    expect(canAbandon({ status: 'pending' })).toBe(true);
    expect(canAbandon({ status: 'applied' })).toBe(false);
    expect(canAbandon({ status: 'rolled_back', result: { ok: true, output: '', at: 1, mode: 'rollback' } })).toBe(false);
  });
});

describe('清理提案', () => {
  const add = (ctx: ReturnType<typeof observerSetup>, status: Proposal['status'], result?: Proposal['result']) => {
    const p = ctx.observer.proposals.add({ title: status, component: 'prompt', problemIds: [], rootCause: '', edits: [{ file: 'server/prompts.ts', find: 'a', replace: 'b' }], risk: '', verification: '' });
    if (status !== 'pending') ctx.observer.proposals.setStatus(p.id, status, result);
    return p.id;
  };

  it('已拒绝、已失效、已回滚的可以删除；待批准、应用中、已应用的不行', () => {
    const ctx = observerSetup();
    try {
      const rejected = add(ctx, 'rejected');
      const stale = add(ctx, 'stale');
      const rolled = add(ctx, 'rolled_back', { ok: true, output: '', at: 1, mode: 'rollback' });
      const pending = add(ctx, 'pending');
      const applying = add(ctx, 'applying');
      const applied = add(ctx, 'applied', { ok: true, output: '', at: 1, mode: 'apply' });
      for (const id of [rejected, stale, rolled]) expect(ctx.observer.removeProposal(id).ok).toBe(true);
      for (const id of [pending, applying, applied]) expect(ctx.observer.removeProposal(id).ok).toBe(false);
      expect(ctx.observer.proposals.list().map((p) => p.id).sort()).toEqual([pending, applying, applied].sort());
    } finally {
      ctx.observer.dispose();
    }
  });

  it('应用没成功且文件没还原的不能删：备份是原文件的唯一副本', () => {
    const ctx = observerSetup();
    try {
      const id = add(ctx, 'rolled_back', { ok: false, output: '', at: 1, mode: 'apply', restored: false });
      expect(ctx.observer.removeProposal(id).ok).toBe(false);
    } finally {
      ctx.observer.dispose();
    }
  });

  it('删除时连同它的备份目录一起清掉', () => {
    const ctx = observerSetup();
    try {
      const id = add(ctx, 'rejected');
      const dir = path.join(ctx.root, 'data', 'observer-backups', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), '{"files":[]}', 'utf8');
      ctx.observer.removeProposal(id);
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      ctx.observer.dispose();
    }
  });

  it('一键清理：删掉所有可删的，返回删了几条', () => {
    const ctx = observerSetup();
    try {
      add(ctx, 'rejected');
      add(ctx, 'stale');
      const keep = add(ctx, 'pending');
      expect(ctx.observer.clearProposals()).toBe(2);
      expect(ctx.observer.proposals.list().map((p) => p.id)).toEqual([keep]);
    } finally {
      ctx.observer.dispose();
    }
  });

  it('台账：已解决和已忽略的可以清掉，待处理的留着', () => {
    const s = newStore();
    const a = s.add(draft());
    const b = s.add(draft());
    const c = s.add(draft());
    s.setStatus(a.id, 'resolved');
    s.setStatus(b.id, 'ignored');
    expect(s.clearHandled()).toBe(2);
    expect(s.list().map((o) => o.id)).toEqual([c.id]);
  });
});

describe('归因：中转网关不可用', () => {
  it('自检因网关 503 失败归为环境问题，不计入审查', () => {
    const o = { id: 'o', at: 1, status: 'new' as const, projectId: 'p1', title: 't', context: {}, severity: 'error' as const, kind: 'preflight_fail' as const, source: 'code' as const, detail: '代理会话失败：API Error: 503 No available channel for model x under group y' };
    expect(effectiveAttribution(o)).toBe('environment');
    expect(isActionable(o)).toBe(false);
  });
});

describe('清理提案：放弃过的、文件没还原的', () => {
  it('可以删，但它的备份留着', () => {
    const ctx = observerSetup();
    try {
      const p = ctx.observer.proposals.add({ title: 't', component: 'prompt', problemIds: [], rootCause: '', edits: [{ file: 'server/prompts.ts', find: 'a', replace: 'b' }], risk: '', verification: '' });
      ctx.observer.proposals.setStatus(p.id, 'rejected', { ok: false, output: '', at: 1, mode: 'apply', restored: false });
      const dir = path.join(ctx.root, 'data', 'observer-backups', p.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), '{"files":[]}', 'utf8');
      expect(ctx.observer.removeProposal(p.id).ok).toBe(true);
      expect(ctx.observer.proposals.get(p.id)).toBeUndefined();
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      ctx.observer.dispose();
    }
  });
});

describe('清理台账：被忽略的流程问题', () => {
  it('带去重键且被忽略的不清掉，否则同一个问题会马上被重新采集', () => {
    const s = newStore();
    const kept = s.add(draft({ key: 'flow:x' }));
    s.setStatus(kept.id, 'ignored');
    const gone = s.add(draft());
    s.setStatus(gone.id, 'ignored');
    expect(s.clearHandled()).toBe(1);
    expect(s.list().map((o) => o.id)).toEqual([kept.id]);
  });
});

describe('清理不关掉安全出口、不删还没决定的', () => {
  it('清理台账：已应用提案关联的问题留着，否则没法复验也就没法回滚', () => {
    const ctx = observerSetup();
    try {
      const o = ctx.observer.observations.add({ projectId: ctx.project.id, taskId: 't1', kind: 'gate_fail', severity: 'error', title: '问题', detail: '', context: {}, source: 'code' });
      const p = ctx.observer.proposals.add({ title: 't', component: 'prompt', problemIds: [o.id], rootCause: '', edits: [{ file: 'server/prompts.ts', find: 'a', replace: 'b' }], risk: '', verification: '' });
      ctx.observer.proposals.setStatus(p.id, 'applied', { ok: true, output: '', at: 1, mode: 'apply' });
      ctx.observer.observations.markResolvedByProposal(p.id, [o.id]);
      const other = ctx.observer.observations.add({ projectId: ctx.project.id, kind: 'gate_fail', severity: 'error', title: '别的', detail: '', context: {}, source: 'code' });
      ctx.observer.observations.setStatus(other.id, 'resolved');
      expect(ctx.observer.clearObservations()).toBe(1);
      expect(ctx.observer.observations.list().map((x) => x.id)).toEqual([o.id]);
    } finally {
      ctx.observer.dispose();
    }
  });

  it('清理台账：刚解决、还在静默期内的流程问题留着', () => {
    const s = newStore();
    const t0 = 1_000_000_000_000;
    const o = s.add(draft({ key: 'flow:x' }), t0);
    s.setStatus(o.id, 'resolved', t0);
    expect(s.clearHandled(new Set(), t0 + 3_600_000)).toBe(0);
    expect(s.clearHandled(new Set(), t0 + 25 * 3_600_000)).toBe(1);
  });

  it('一键清理提案：还能重试的不删', () => {
    const ctx = observerSetup();
    try {
      const mk = () => ctx.observer.proposals.add({ title: 't', component: 'prompt', problemIds: [], rootCause: '', edits: [{ file: 'server/prompts.ts', find: 'a', replace: 'b' }], risk: '', verification: '' });
      const retryable = mk();
      ctx.observer.proposals.setStatus(retryable.id, 'rolled_back', { ok: false, output: '', at: 1, mode: 'apply', restored: true });
      const rejected = mk();
      ctx.observer.proposals.setStatus(rejected.id, 'rejected');
      expect(ctx.observer.clearProposals()).toBe(1);
      expect(ctx.observer.proposals.list().map((x) => x.id)).toEqual([retryable.id]);
    } finally {
      ctx.observer.dispose();
    }
  });
});

describe('删除提案留痕', () => {
  it('删掉的提案留一条简短记录，下次审查的历史里仍看得到它的结局', () => {
    const ctx = observerSetup();
    try {
      const p = ctx.observer.proposals.add({ title: '放宽超时', component: 'flow', problemIds: [], rootCause: '', edits: [{ file: 'server/queue.ts', find: 'a', replace: 'b' }], risk: '', verification: '' });
      ctx.observer.proposals.setStatus(p.id, 'rejected');
      ctx.observer.removeProposal(p.id);
      expect(ctx.observer.proposals.list()).toEqual([]);
      const removed = ctx.observer.proposals.listRemoved();
      expect(removed).toMatchObject([{ title: '放宽超时', component: 'flow', status: 'rejected' }]);
      expect(proposalHistorySection([], [], 10, removed)).toContain('放宽超时');
    } finally {
      ctx.observer.dispose();
    }
  });

  it('留痕最多保留 30 条', () => {
    const ctx = observerSetup();
    try {
      for (let i = 0; i < 32; i++) {
        const p = ctx.observer.proposals.add({ title: `t${i}`, component: 'prompt', problemIds: [], rootCause: '', edits: [{ file: 'server/prompts.ts', find: 'a', replace: 'b' }], risk: '', verification: '' });
        ctx.observer.proposals.setStatus(p.id, 'rejected');
        ctx.observer.removeProposal(p.id);
      }
      const removed = ctx.observer.proposals.listRemoved();
      expect(removed).toHaveLength(30);
      expect(removed[removed.length - 1].title).toBe('t31');
    } finally {
      ctx.observer.dispose();
    }
  });
});
