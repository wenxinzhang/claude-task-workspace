import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRequest, AgentResult } from './agent.ts';
import { classifyAnalyzeError, classifyRunEnd, isManualStop, wireCollector } from './observe-collect.ts';
import { ObservationStore } from './observe.ts';
import { Queue } from './queue.ts';
import { Store } from './store.ts';
import type { RunEvidence, Task } from './types.ts';

/** 一个任务：形状从 Task 类型抄，缺省为 done 无错误 */
const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  projectId: 'p1',
  title: '标签间距过大',
  description: '',
  analysis: '',
  analyzing: false,
  source: 'manual',
  status: 'done',
  order: 1,
  logs: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('classifyRunEnd', () => {
  it('blocked 带错误且无门禁：记一条 exec_error，带项目/任务/错误详情', () => {
    const drafts = classifyRunEnd(task({ status: 'blocked', error: '实现失败：代理崩溃' }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('exec_error');
    expect(drafts[0].severity).toBe('error');
    expect(drafts[0].projectId).toBe('p1');
    expect(drafts[0].taskId).toBe('t1');
    expect(drafts[0].detail).toContain('实现失败：代理崩溃');
  });

  it('手动停止不算工具问题：直抛与包装形态都排除', () => {
    expect(classifyRunEnd(task({ status: 'blocked', error: '已手动停止' }))).toEqual([]);
    expect(classifyRunEnd(task({ status: 'blocked', error: '实现失败：已手动停止' }))).toEqual([]);
  });

  it('门禁未过：记 gate_fail 而非 exec_error，附门禁理由', () => {
    const t = task({
      status: 'blocked',
      error: '门禁未通过',
      gate: { verdict: 'fail', reasons: [{ level: 'fail', text: '测试命令退出码 1' }], items: [], outOfScope: [], changedFiles: [], at: 2 },
    });
    const drafts = classifyRunEnd(t);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('gate_fail');
    expect(drafts[0].detail).toContain('测试命令退出码 1');
  });

  it('门禁需人工验收：记 gate_unverified，严重度 warn', () => {
    const t = task({
      status: 'review',
      gate: { verdict: 'unverified', reasons: [{ level: 'hold', text: 'AC2 需要浏览器' }], items: [], outOfScope: [], changedFiles: [], at: 2 },
    });
    const drafts = classifyRunEnd(t);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('gate_unverified');
    expect(drafts[0].severity).toBe('warn');
  });

  it('门禁已通过但自动提交失败：记 commit_fail', () => {
    const t = task({
      status: 'done',
      error: '门禁已通过，但自动提交失败：请先配置 git user.name',
      gate: { verdict: 'pass', reasons: [], items: [], outOfScope: [], changedFiles: [], at: 2 },
    });
    const drafts = classifyRunEnd(t);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('commit_fail');
    expect(drafts[0].severity).toBe('error');
  });

  it('证据齐全时上下文带代理/耗时/工具调用数；缺失时不填', () => {
    const ev: RunEvidence = { stage: 'implement', provider: 'claude', model: 'sonnet', toolCalls: 12, tools: {}, denials: [], durationMs: 65000, costUsd: 0.4, at: 9 };
    const d = classifyRunEnd(task({ status: 'blocked', error: '实现失败：x', evidence: { implement: ev } }))[0];
    expect(d.context.provider).toBe('claude');
    expect(d.context.durationMs).toBe(65000);
    expect(d.context.toolCalls).toBe(12);
    expect(d.context.costUsd).toBe(0.4);
    const bare = classifyRunEnd(task({ status: 'blocked', error: '实现失败：x' }))[0];
    expect(bare.context.provider).toBeUndefined();
  });

  it('服务重启中断：记 exec_error 但严重度 note（不当头条、不计阈值）', () => {
    const drafts = classifyRunEnd(task({ status: 'blocked', error: '服务重启，执行被中断' }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('exec_error');
    expect(drafts[0].severity).toBe('note');
  });
});

describe('classifyAnalyzeError', () => {
  it('新出现生成规格失败记一条；相同错误不重复；其他前缀不采', () => {
    const prev = task({ error: undefined });
    const next = task({ error: '生成规格失败：会话无效' });
    const drafts = classifyAnalyzeError(prev, next);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('analyze_fail');
    expect(drafts[0].taskId).toBe('t1');
    expect(classifyAnalyzeError(next, next)).toEqual([]);
    expect(classifyAnalyzeError(prev, task({ error: '其他错误' }))).toEqual([]);
  });
});

describe('isManualStop', () => {
  it('undefined 与空串不是手动停止（边界锚点）', () => {
    expect(isManualStop(undefined)).toBe(false);
    expect(isManualStop('')).toBe(false);
  });
});

// ---------- 接线测试：真实 Store + Queue，run 注入 ----------

const ev = (stage: RunEvidence['stage'], toolCalls: number): RunEvidence => ({
  stage,
  provider: 'claude',
  toolCalls,
  tools: {},
  denials: [],
  durationMs: 10,
  at: Date.now(),
});

const cleanups: (() => void)[] = [];
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 400));
  for (const fn of cleanups.splice(0)) fn();
});

async function waitUntil(cond: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function wireSetup(opts: { enabled?: boolean; analyzeFail?: boolean; preflightFail?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-collect-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const workdir = path.join(root, 'work');
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(path.join(workdir, 'a.ts'), 'export const a = 1;\n');
  const store = new Store(path.join(root, 'data'));
  const project = store.createProject({ name: 'p', workdir, exec: { useKnowledge: false } });
  const observations = new ObservationStore(path.join(root, 'data'));
  const queue = new Queue(store, undefined, async (req): Promise<AgentResult> => {
    if (req.stage === 'preflight') {
      if (opts.preflightFail) return { ok: false, text: '读不了文件', evidence: ev('preflight', 0) };
      const file = /读取文件 (.+?) ，/.exec(req.prompt)![1];
      const commands = [...req.prompt.matchAll(/- 执行命令：(.+)/g)].map((m) => ({ command: m[1].trim(), output: 'v22.22.1' }));
      return { ok: true, text: '', structured: { fileContent: fs.readFileSync(file, 'utf8'), commands }, evidence: ev('preflight', 2) };
    }
    if (req.stage === 'analysis') {
      // toolCalls=0 → sessionProblem → 生成规格失败
      return { ok: true, text: '', evidence: ev('analysis', opts.analyzeFail ? 0 : 3) };
    }
    throw new Error(`测试没有为 ${req.stage} 阶段提供应答`);
  });
  wireCollector({ store, queue, observations, isEnabled: () => opts.enabled !== false });
  return { store, queue, project, observations };
}

describe('wireCollector 接线', () => {
  it('理解失败：台账出现一条 analyze_fail，tasks 多次事件不重复', async () => {
    const ctx = await wireSetup({ analyzeFail: true });
    const t = ctx.store.create({ projectId: ctx.project.id, title: '任务', description: '', source: 'manual' });
    ctx.queue.analyze(t.id);
    await waitUntil(() => !!ctx.store.get(t.id)?.error);
    await new Promise((r) => setTimeout(r, 60));
    const list = ctx.observations.list({ kind: 'analyze_fail' });
    expect(list).toHaveLength(1);
    expect(list[0].taskId).toBe(t.id);
  });

  it('自检失败：status 事件多次推送，按 at 去重只采一条', async () => {
    const ctx = await wireSetup({ preflightFail: true });
    const t = ctx.store.create({ projectId: ctx.project.id, title: '任务', description: '', source: 'manual' });
    ctx.store.setStatus(t.id, 'todo');
    ctx.queue.start(ctx.project.id);
    await waitUntil(() => ctx.queue.status(ctx.project.id).preflight?.state === 'failed');
    await new Promise((r) => setTimeout(r, 60));
    const list = ctx.observations.list({ kind: 'preflight_fail' });
    expect(list).toHaveLength(1);
    expect(list[0].projectId).toBe(ctx.project.id);
    expect(list[0].detail).toContain('读不了文件');
  });

  it('观察者关闭时不采集（边界锚点）', async () => {
    const ctx = await wireSetup({ analyzeFail: true, enabled: false });
    const t = ctx.store.create({ projectId: ctx.project.id, title: '任务', description: '', source: 'manual' });
    ctx.queue.analyze(t.id);
    await waitUntil(() => !!ctx.store.get(t.id)?.error);
    expect(ctx.observations.list()).toEqual([]);
  });

  it('接线时预填基线：重启前已存在的理解失败不重采', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-collect-base-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const workdir = path.join(root, 'work');
    fs.mkdirSync(workdir, { recursive: true });
    const store = new Store(path.join(root, 'data'));
    const project = store.createProject({ name: 'p', workdir, exec: { useKnowledge: false } });
    const t = store.create({ projectId: project.id, title: '任务', description: '', source: 'manual' });
    store.update(t.id, { error: '生成规格失败：旧错误' });
    const observations = new ObservationStore(path.join(root, 'data'));
    const queue = new Queue(store, undefined, async () => ({ ok: true, text: '', evidence: ev('analysis', 3) }));
    wireCollector({ store, queue, observations, isEnabled: () => true });
    store.update(t.id, { title: '改名触发 tasks 事件' });
    await new Promise((r) => setTimeout(r, 30));
    expect(observations.list({ kind: 'analyze_fail' })).toEqual([]);
  });
});
