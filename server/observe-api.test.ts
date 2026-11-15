import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { AgentRequest, AgentResult } from './agent.ts';
import { registerObserverRoutes } from './observe-api.ts';
import { applyProposal, backupFiles, resultPath, runningPath } from './apply-proposal.ts';
import { compareProbe, createObserver } from './observer.ts';
import { DEFAULT_OBSERVER_SETTINGS, type Proposal } from './observe-types.ts';
import { Queue } from './queue.ts';
import { Store } from './store.ts';
import type { GateResult, ItemResult, RunEvidence } from './types.ts';

const gate = (verdict: ItemResult, items: [string, ItemResult][] = []): GateResult => ({
  verdict,
  reasons: [],
  items: items.map(([id, result]) => ({ id, text: '', method: 'auto' as const, how: '', result, evidence: '' })),
  outOfScope: [],
  changedFiles: [],
  at: 1,
});

describe('compareProbe', () => {
  it('verdict 提升为 improved，下降为 regressed', () => {
    expect(compareProbe(gate('fail'), gate('pass'))).toBe('improved');
    expect(compareProbe(gate('unverified'), gate('pass'))).toBe('improved');
    expect(compareProbe(gate('pass'), gate('fail'))).toBe('regressed');
  });

  it('同 verdict 比逐项：fail 减少 improved、增多 regressed、全同 unchanged', () => {
    expect(compareProbe(gate('fail', [['AC1', 'fail']]), gate('fail', [['AC1', 'pass']]))).toBe('improved');
    expect(compareProbe(gate('pass', [['AC1', 'pass']]), gate('pass', [['AC1', 'fail']]))).toBe('regressed');
    expect(compareProbe(gate('pass'), gate('pass'))).toBe('unchanged');
  });

  it('无门禁按 fail 秩 0 项；双 undefined 为 unchanged（边界锚点）', () => {
    expect(compareProbe(undefined, gate('fail'))).toBe('unchanged');
    expect(compareProbe(undefined, gate('pass'))).toBe('improved');
    expect(compareProbe(undefined, undefined)).toBe('unchanged');
  });
});

// ---------- 编排器测试：真实 Store/Queue，run/spawn 注入 ----------

const ev = (stage: RunEvidence['stage'], toolCalls = 2): RunEvidence => ({ stage, provider: 'claude', toolCalls, tools: {}, denials: [], durationMs: 10, at: Date.now() });

const cleanups: (() => void)[] = [];
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 400));
  for (const fn of cleanups.splice(0)) fn();
});

function obsSetup(opts: { deployRunning?: boolean; enabled?: boolean; implementDelay?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-observer-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const workdir = path.join(root, 'work');
  fs.mkdirSync(workdir, { recursive: true });
  const store = new Store(path.join(root, 'data'));
  const project = store.createProject({ name: 'p', workdir, exec: { useKnowledge: false } });
  const fakeRun = async (req: AgentRequest): Promise<AgentResult> => {
    if (req.stage === 'preflight') {
      const file = /读取文件 (.+?) ，/.exec(req.prompt)![1];
      const commands = [...req.prompt.matchAll(/- 执行命令：(.+)/g)].map((m) => ({ command: m[1].trim(), output: 'v22' }));
      return { ok: true, text: '', structured: { fileContent: fs.readFileSync(file, 'utf8'), commands }, evidence: ev('preflight') };
    }
    if (req.stage === 'implement' && opts.implementDelay) await new Promise((r) => setTimeout(r, opts.implementDelay));
    return { ok: true, text: 'done', structured: { skip: true, findings: [], proposals: [] }, evidence: ev(req.stage === 'analysis' ? 'analysis' : 'implement') };
  };
  const queue = new Queue(store, undefined, fakeRun);
  const deployer = { allStatus: () => (opts.deployRunning ? { [project.id]: { running: true } } : {}) };
  const spawned: { mode: string; proposalId: string }[] = [];
  const observer = createObserver({
    root,
    store,
    queue,
    deployer,
    getSettings: () => ({ observer: { ...DEFAULT_OBSERVER_SETTINGS, enabled: opts.enabled !== false } }),
    run: fakeRun,
    spawnApply: (mode, proposalId) => spawned.push({ mode, proposalId }),
  });
  // 与 index.ts 相同的接线：一轮结束通知观察者
  queue.on('run-end', (id: string) => observer.onRunEnd(id));
  return { root, store, project, queue, observer, spawned };
}

async function waitUntil(cond: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('createObserver 空闲检测', () => {
  it('全空闲为 true；git 忙碌、理解中、部署中都不空闲', () => {
    const ctx = obsSetup();
    expect(ctx.observer.isIdle()).toBe(true);
    ctx.observer.gitBusy.add(ctx.project.id);
    expect(ctx.observer.isIdle()).toBe(false);
    ctx.observer.gitBusy.delete(ctx.project.id);
    const t = ctx.store.create({ projectId: ctx.project.id, title: '任务', description: '', source: 'manual' });
    ctx.store.update(t.id, { analyzing: true });
    expect(ctx.observer.isIdle()).toBe(false);
    ctx.store.update(t.id, { analyzing: false });
    expect(ctx.observer.isIdle()).toBe(true);
    const dep = obsSetup({ deployRunning: true });
    expect(dep.observer.isIdle()).toBe(false);
  });
});

describe('onRunEnd', () => {
  it('执行失败的任务：台账记一条 exec_error，任务状态不受影响', () => {
    const ctx = obsSetup();
    const t = ctx.store.create({ projectId: ctx.project.id, title: '任务', description: '', source: 'manual' });
    ctx.store.setStatus(t.id, 'blocked', { error: '实现失败：x' });
    ctx.observer.onRunEnd(t.id);
    const list = ctx.observer.observations.list({ kind: 'exec_error' });
    expect(list).toHaveLength(1);
    expect(list[0].taskId).toBe(t.id);
    expect(ctx.store.get(t.id)!.status).toBe('blocked');
  });

  it('观察者关闭时不采集（边界锚点）', () => {
    const ctx = obsSetup({ enabled: false });
    const t = ctx.store.create({ projectId: ctx.project.id, title: '任务', description: '', source: 'manual' });
    ctx.store.setStatus(t.id, 'blocked', { error: '实现失败：x' });
    ctx.observer.onRunEnd(t.id);
    expect(ctx.observer.observations.list()).toEqual([]);
  });
});

const pDraft = (over: Partial<Proposal> = {}): Omit<Proposal, 'id' | 'at' | 'status'> => ({
  title: '提案',
  component: 'prompt',
  problemIds: [],
  rootCause: 'rc',
  edits: [{ file: 'server/prompts.ts', find: 'a', replace: 'b' }],
  risk: '低',
  verification: 'v',
  ...over,
});

describe('startApply', () => {
  it('pending 且空闲：置 applying 并 spawn；重复应用与不空闲拒绝', () => {
    const ctx = obsSetup();
    const p = ctx.observer.proposals.add(pDraft());
    const r = ctx.observer.startApply(p.id);
    expect(r.ok).toBe(true);
    expect(ctx.observer.proposals.get(p.id)!.status).toBe('applying');
    expect(ctx.spawned).toEqual([{ mode: 'apply', proposalId: p.id }]);
    expect(ctx.observer.startApply(p.id).ok).toBe(false);
    const p2 = ctx.observer.proposals.add(pDraft());
    ctx.observer.gitBusy.add(ctx.project.id);
    expect(ctx.observer.startApply(p2.id).ok).toBe(false);
    expect(ctx.observer.proposals.get(p2.id)!.status).toBe('pending');
  });
});

describe('结果消费', () => {
  const oDraft = () => ({ projectId: 'p1', kind: 'exec_error' as const, severity: 'error' as const, title: '问题', detail: 'd', context: {}, source: 'code' as const });

  it('apply 成功：提案 applied，关联问题 resolved；失败：rolled_back 且问题不动', () => {
    const ctx = obsSetup();
    const o = ctx.observer.observations.add(oDraft());
    const p = ctx.observer.proposals.add(pDraft({ problemIds: [o.id] }));
    ctx.observer.startApply(p.id);
    fs.mkdirSync(path.dirname(resultPath(ctx.root, p.id)), { recursive: true });
    fs.writeFileSync(resultPath(ctx.root, p.id), JSON.stringify({ ok: true, output: '通过', at: Date.now(), mode: 'apply' }), 'utf8');
    ctx.observer.consumeResults();
    expect(ctx.observer.proposals.get(p.id)!.status).toBe('applied');
    expect(ctx.observer.observations.list()[0].status).toBe('resolved');

    const o2 = ctx.observer.observations.add(oDraft());
    const p2 = ctx.observer.proposals.add(pDraft({ problemIds: [o2.id] }));
    ctx.observer.startApply(p2.id);
    fs.writeFileSync(resultPath(ctx.root, p2.id), JSON.stringify({ ok: false, output: '测试挂了', at: Date.now(), mode: 'apply' }), 'utf8');
    ctx.observer.consumeResults();
    expect(ctx.observer.proposals.get(p2.id)!.status).toBe('rolled_back');
    expect(ctx.observer.observations.list().find((x) => x.id === o2.id)!.status).toBe('new');
  });
});

describe('startProbe', () => {
  const oDraft = (taskId?: string) => ({ projectId: 'p1', kind: 'exec_error' as const, severity: 'error' as const, title: '问题', detail: 'd', context: {}, source: 'code' as const, taskId });

  it('applied 提案 + 带任务的关联问题 + 项目空闲：任务重跑，复验结论落库', async () => {
    const ctx = obsSetup();
    const t = ctx.store.create({ projectId: ctx.project.id, title: '任务', description: '', source: 'manual' });
    ctx.store.setStatus(t.id, 'blocked', { error: 'x', gate: gate('fail') });
    const o = ctx.observer.observations.add(oDraft(t.id));
    const p = ctx.observer.proposals.add(pDraft({ problemIds: [o.id] }));
    ctx.observer.proposals.setStatus(p.id, 'applied');
    const r = ctx.observer.startProbe(p.id, o.id);
    expect(r.ok).toBe(true);
    await waitUntil(() => !ctx.queue.isBusy(ctx.project.id) && !['todo', 'in_progress', 'testing'].includes(ctx.store.get(t.id)!.status));
    const probe = ctx.observer.proposals.get(p.id)!.probe;
    expect(probe).toBeTruthy();
    expect(probe!.taskId).toBe(t.id);
    expect(probe!.beforeVerdict).toBe('fail');
    expect(['improved', 'unchanged']).toContain(probe!.result);
  });

  it('前置校验：非 applied、问题无任务、不在 problemIds、项目忙碌都拒绝', () => {
    const ctx = obsSetup();
    const t = ctx.store.create({ projectId: ctx.project.id, title: '任务', description: '', source: 'manual' });
    ctx.store.setStatus(t.id, 'blocked', { error: 'x' });
    const o = ctx.observer.observations.add(oDraft(t.id));
    const oNoTask = ctx.observer.observations.add(oDraft());
    const p = ctx.observer.proposals.add(pDraft({ problemIds: [o.id] }));
    expect(ctx.observer.startProbe(p.id, o.id).ok).toBe(false); // pending 非 applied
    ctx.observer.proposals.setStatus(p.id, 'applied');
    expect(ctx.observer.startProbe(p.id, oNoTask.id).ok).toBe(false); // 不在 problemIds
    const p2 = ctx.observer.proposals.add(pDraft({ problemIds: [oNoTask.id] }));
    ctx.observer.proposals.setStatus(p2.id, 'applied');
    expect(ctx.observer.startProbe(p2.id, oNoTask.id).ok).toBe(false); // 无 taskId
    ctx.store.setStatus(t.id, 'in_progress');
    expect(ctx.observer.startProbe(p.id, o.id).ok).toBe(false); // 任务正在执行
  });

  it('复验轮被手动停止：不写 probe，pending 清除（错误路径锚点）', async () => {
    const ctx = obsSetup({ implementDelay: 150 });
    const t = ctx.store.create({ projectId: ctx.project.id, title: '任务', description: '', source: 'manual' });
    ctx.store.setStatus(t.id, 'blocked', { error: 'x', gate: gate('fail') });
    const o = ctx.observer.observations.add(oDraft(t.id));
    const p = ctx.observer.proposals.add(pDraft({ problemIds: [o.id] }));
    ctx.observer.proposals.setStatus(p.id, 'applied');
    expect(ctx.observer.startProbe(p.id, o.id).ok).toBe(true);
    // 等任务真正进入执行（abort 控制器已建好）再停，否则停止信号会落在自检阶段丢失
    await waitUntil(() => ctx.store.get(t.id)!.status === 'in_progress');
    await new Promise((r) => setTimeout(r, 20));
    ctx.queue.stopCurrent(ctx.project.id);
    await waitUntil(() => !ctx.queue.isBusy(ctx.project.id) && !['todo', 'in_progress', 'testing'].includes(ctx.store.get(t.id)!.status));
    expect(ctx.observer.proposals.get(p.id)!.probe, `task.error=${ctx.store.get(t.id)!.error} status=${ctx.store.get(t.id)!.status}`).toBeUndefined();
    expect(ctx.store.get(t.id)!.logs.join('\n')).toContain('复验被停止');
  });
});

describe('startRollback', () => {
  const oDraft = () => ({ projectId: 'p1', kind: 'exec_error' as const, severity: 'error' as const, title: '问题', detail: 'd', context: {}, source: 'code' as const });

  it('regressed 提案 + 空闲：spawn rollback；成功结果消费后 rolled_back 且问题 reopen', () => {
    const ctx = obsSetup();
    const o = ctx.observer.observations.add(oDraft());
    const p = ctx.observer.proposals.add(pDraft({ problemIds: [o.id] }));
    ctx.observer.proposals.setStatus(p.id, 'applied');
    ctx.observer.proposals.setProbe(p.id, { taskId: 't1', beforeVerdict: 'pass', afterVerdict: 'fail', result: 'regressed', at: 1 });
    ctx.observer.observations.markResolvedByProposal(p.id, [o.id]);
    const r = ctx.observer.startRollback(p.id);
    expect(r.ok).toBe(true);
    expect(ctx.spawned).toEqual([{ mode: 'rollback', proposalId: p.id }]);
    fs.mkdirSync(path.dirname(resultPath(ctx.root, p.id)), { recursive: true });
    fs.writeFileSync(resultPath(ctx.root, p.id), JSON.stringify({ ok: true, output: '已回滚', at: Date.now(), mode: 'rollback' }), 'utf8');
    ctx.observer.consumeResults();
    expect(ctx.observer.proposals.get(p.id)!.status).toBe('rolled_back');
    expect(ctx.observer.observations.list()[0].status).toBe('new');
  });

  it('非 regressed 或非 applied 拒绝（边界锚点）', () => {
    const ctx = obsSetup();
    const p = ctx.observer.proposals.add(pDraft());
    expect(ctx.observer.startRollback(p.id).ok).toBe(false); // pending
    ctx.observer.proposals.setStatus(p.id, 'applied');
    expect(ctx.observer.startRollback(p.id).ok).toBe(false); // 无 probe
    ctx.observer.proposals.setProbe(p.id, { taskId: 't1', beforeVerdict: 'fail', afterVerdict: 'pass', result: 'improved', at: 1 });
    expect(ctx.observer.startRollback(p.id).ok).toBe(false); // improved
  });
});

describe('collect 系列', () => {
  it('部署失败采集；运行中与手动停止不采（边界锚点）', () => {
    const ctx = obsSetup();
    ctx.observer.collectDeployResult(ctx.project.id, { running: false, ok: false }, ['步骤失败']);
    expect(ctx.observer.observations.list({ kind: 'deploy_fail' })).toHaveLength(1);
    ctx.observer.collectDeployResult(ctx.project.id, { running: false, ok: false }, ['部署已手动停止']);
    ctx.observer.collectDeployResult(ctx.project.id, { running: true }, []);
    expect(ctx.observer.observations.list({ kind: 'deploy_fail' })).toHaveLength(1);
  });

  it('导入/回写/git 失败各记一条（锚点）', () => {
    const ctx = obsSetup();
    const t = ctx.store.create({ projectId: ctx.project.id, title: '任务', description: '', source: 'manual' });
    ctx.observer.collectImportFailure(ctx.project.id, new Error('接口 500'));
    ctx.observer.collectWritebackFailure(t.id, { state: 'failed', at: 1, field: '状态', value: '测试通过', message: '无权限' });
    ctx.observer.collectGitFailure(ctx.project.id, 'git_sync', new Error('conflict'), 'warn');
    ctx.observer.collectGitFailure(ctx.project.id, 'git_push', new Error('rejected'));
    const kinds = ctx.observer.observations.list().map((o) => o.kind);
    expect(kinds).toEqual(['feishu_import', 'feishu_writeback', 'git_sync', 'git_push']);
    expect(ctx.observer.observations.list({ kind: 'git_sync' })[0].severity).toBe('warn');
  });
});

// ---------- REST 路由集成：express + listen(0) + 真实 fetch ----------

function apiSetup() {
  const ctx = obsSetup();
  const app = express();
  app.use(express.json());
  registerObserverRoutes(app, ctx.observer);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return { ...ctx, base: `http://127.0.0.1:${port}` };
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

describe('观察者路由', () => {
  it('GET observations 空/有；status 端点合法更新、非法值 400', async () => {
    const ctx = apiSetup();
    expect(await (await fetch(`${ctx.base}/api/observations`)).json()).toEqual([]);
    const o = ctx.observer.observations.add({ projectId: 'p1', kind: 'exec_error', severity: 'error', title: '问题', detail: 'd', context: {}, source: 'code' });
    expect(await (await fetch(`${ctx.base}/api/observations`)).json()).toHaveLength(1);
    const ok = await post(`${ctx.base}/api/observations/${o.id}/status`, { status: 'ignored' });
    expect(ok.status).toBe(200);
    expect(ctx.observer.observations.list()[0].status).toBe('ignored');
    expect((await post(`${ctx.base}/api/observations/${o.id}/status`, { status: '外星' })).status).toBe(400);
    expect((await post(`${ctx.base}/api/observations/missing/status`, { status: 'ignored' })).status).toBe(400);
  });

  it('提案路由：reject 只接受 pending；apply 空闲启动、忙碌 400；optimize/run 可手动触发', async () => {
    const ctx = apiSetup();
    const p = ctx.observer.proposals.add(pDraft());
    expect((await post(`${ctx.base}/api/proposals/${p.id}/apply`)).status).toBe(200);
    expect(ctx.observer.proposals.get(p.id)!.status).toBe('applying');
    expect((await post(`${ctx.base}/api/proposals/${p.id}/reject`)).status).toBe(400); // applying 不可拒绝
    const p2 = ctx.observer.proposals.add(pDraft());
    expect((await post(`${ctx.base}/api/proposals/${p2.id}/reject`)).status).toBe(200);
    expect(ctx.observer.proposals.get(p2.id)!.status).toBe('rejected');
    const p3 = ctx.observer.proposals.add(pDraft());
    ctx.observer.gitBusy.add(ctx.project.id);
    expect((await post(`${ctx.base}/api/proposals/${p3.id}/apply`)).status).toBe(400); // 不空闲
    ctx.observer.gitBusy.delete(ctx.project.id);
    // 先消费掉 p 的应用结果，释放单飞锁，手动诊断才能启动
    fs.mkdirSync(path.dirname(resultPath(ctx.root, p.id)), { recursive: true });
    fs.writeFileSync(resultPath(ctx.root, p.id), JSON.stringify({ ok: true, output: '', at: Date.now(), mode: 'apply' }), 'utf8');
    ctx.observer.consumeResults();
    const run = await post(`${ctx.base}/api/optimize/run`);
    expect(run.status).toBe(200);
    expect(await (await fetch(`${ctx.base}/api/proposals`)).json()).toHaveLength(3);
  });
});

describe('重启恢复', () => {
  const reobserve = (ctx: ReturnType<typeof obsSetup>) => {
    // 节流落盘尚未发生，新实例会读到旧文件——重启模拟前先 flush
    ctx.observer.proposals.flush();
    ctx.observer.observations.flush();
    return createObserver({
      root: ctx.root,
      store: ctx.store,
      queue: ctx.queue,
      deployer: { allStatus: () => ({}) },
      getSettings: () => ({ observer: { ...DEFAULT_OBSERVER_SETTINGS, enabled: true } }),
      spawnApply: () => {},
    });
  };

  it('子进程存活时重启：恢复单飞锁，阻止并发应用，结果随后被消费', () => {
    const ctx = obsSetup();
    const p = ctx.observer.proposals.add(pDraft());
    ctx.observer.proposals.setStatus(p.id, 'applying');
    fs.mkdirSync(path.dirname(runningPath(ctx.root, p.id)), { recursive: true });
    fs.writeFileSync(runningPath(ctx.root, p.id), JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: 'apply' }), 'utf8');
    const ob2 = reobserve(ctx);
    try {
      expect(ob2.status().applying).toBe(p.id);
      const p2 = ob2.proposals.add(pDraft());
      expect(ob2.startApply(p2.id).ok).toBe(false);
      fs.writeFileSync(resultPath(ctx.root, p.id), JSON.stringify({ ok: true, output: '', at: Date.now(), mode: 'apply' }), 'utf8');
      ob2.consumeResults();
      expect(ob2.proposals.get(p.id)!.status).toBe('applied');
    } finally {
      ob2.dispose();
    }
  });

  it('无 marker 给启动宽限：不立即兜底回滚', () => {
    const ctx = obsSetup();
    const p = ctx.observer.proposals.add(pDraft());
    ctx.observer.proposals.setStatus(p.id, 'applying');
    const ob2 = reobserve(ctx);
    try {
      expect(ob2.proposals.get(p.id)!.status).toBe('applying');
      expect(ob2.status().applying).toBe(p.id);
    } finally {
      ob2.dispose();
    }
  });

  it('rollback 中断且文件已漂移：保持 applied，不覆盖用户改动', async () => {
    const ctx = obsSetup();
    fs.mkdirSync(path.join(ctx.root, 'server'), { recursive: true });
    fs.writeFileSync(path.join(ctx.root, 'server', 'a.ts'), 'orig\n', 'utf8');
    const p = ctx.observer.proposals.add(pDraft({ edits: [{ file: 'server/a.ts', find: 'orig', replace: 'changed' }] }));
    await applyProposal({ root: ctx.root, proposal: p, runChecks: async () => ({ ok: true, output: '' }) });
    fs.writeFileSync(path.join(ctx.root, 'server', 'a.ts'), 'user-hotfix\n', 'utf8');
    ctx.observer.proposals.setStatus(p.id, 'applying');
    fs.mkdirSync(path.dirname(runningPath(ctx.root, p.id)), { recursive: true });
    fs.writeFileSync(runningPath(ctx.root, p.id), JSON.stringify({ pid: 999999, startedAt: Date.now() - 31 * 60_000, mode: 'rollback' }), 'utf8');
    const ob2 = reobserve(ctx);
    try {
      expect(ob2.proposals.get(p.id)!.status).toBe('applied');
      expect(fs.readFileSync(path.join(ctx.root, 'server', 'a.ts'), 'utf8')).toBe('user-hotfix\n');
    } finally {
      ob2.dispose();
    }
  });

  it('损坏结果文件 + 死进程：兜底处理并清理脏文件，锁不泄漏', () => {
    const ctx = obsSetup();
    const p = ctx.observer.proposals.add(pDraft());
    ctx.observer.proposals.setStatus(p.id, 'applying');
    fs.mkdirSync(path.dirname(resultPath(ctx.root, p.id)), { recursive: true });
    fs.writeFileSync(resultPath(ctx.root, p.id), '{half json', 'utf8');
    fs.writeFileSync(runningPath(ctx.root, p.id), JSON.stringify({ pid: 999999, startedAt: Date.now() - 31 * 60_000, mode: 'apply' }), 'utf8');
    ctx.observer.consumeResults();
    expect(ctx.observer.proposals.get(p.id)!.status).toBe('rolled_back');
    expect(fs.existsSync(resultPath(ctx.root, p.id))).toBe(false);
    expect(ctx.observer.status().applying).toBeNull();
  });

  it('损坏结果文件 + 存活进程：继续等待并恢复锁（瞬时竞态锚点）', () => {
    const ctx = obsSetup();
    const p = ctx.observer.proposals.add(pDraft());
    ctx.observer.proposals.setStatus(p.id, 'applying');
    fs.mkdirSync(path.dirname(resultPath(ctx.root, p.id)), { recursive: true });
    fs.writeFileSync(resultPath(ctx.root, p.id), '{half json', 'utf8');
    fs.writeFileSync(runningPath(ctx.root, p.id), JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: 'apply' }), 'utf8');
    ctx.observer.consumeResults();
    expect(ctx.observer.proposals.get(p.id)!.status).toBe('applying');
    expect(ctx.observer.status().applying).toBe(p.id);
  });

  it('apply 中断（无 afterHash）：无条件还原并 rolled_back', () => {
    const ctx = obsSetup();
    fs.mkdirSync(path.join(ctx.root, 'server'), { recursive: true });
    fs.writeFileSync(path.join(ctx.root, 'server', 'a.ts'), 'orig\n', 'utf8');
    const p = ctx.observer.proposals.add(pDraft());
    backupFiles(ctx.root, p.id, ['server/a.ts']);
    fs.writeFileSync(path.join(ctx.root, 'server', 'a.ts'), 'changed\n', 'utf8');
    ctx.observer.proposals.setStatus(p.id, 'applying');
    fs.mkdirSync(path.dirname(runningPath(ctx.root, p.id)), { recursive: true });
    fs.writeFileSync(runningPath(ctx.root, p.id), JSON.stringify({ pid: 999999, startedAt: Date.now() - 31 * 60_000, mode: 'apply' }), 'utf8');
    const ob2 = reobserve(ctx);
    try {
      expect(ob2.proposals.get(p.id)!.status).toBe('rolled_back');
      expect(fs.readFileSync(path.join(ctx.root, 'server', 'a.ts'), 'utf8')).toBe('orig\n');
    } finally {
      ob2.dispose();
    }
  });
});
