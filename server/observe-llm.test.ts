import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRequest } from './agent.ts';
import { findingsToObservations, reviewRun, shouldReview } from './observe-llm.ts';
import { ObservationStore } from './observe.ts';
import { DEFAULT_OBSERVER_SETTINGS } from './observe-types.ts';
import { Store } from './store.ts';
import type { RunEvidence, Task } from './types.ts';

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  projectId: 'p1',
  title: '任务',
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

describe('shouldReview', () => {
  it('blocked/review/带错误且开启时复盘；done 无错误、关闭、手动停止不复盘', () => {
    expect(shouldReview(task({ status: 'blocked' }), true)).toBe(true);
    expect(shouldReview(task({ status: 'review' }), true)).toBe(true);
    expect(shouldReview(task({ status: 'done', error: 'x' }), true)).toBe(true);
    expect(shouldReview(task({ status: 'done' }), true)).toBe(false);
    expect(shouldReview(task({ status: 'blocked' }), false)).toBe(false);
    expect(shouldReview(task({ status: 'blocked', error: '已手动停止' }), true)).toBe(false);
  });
});

describe('findingsToObservations', () => {
  it('只保留 attribution=tool 的发现，来源标 llm，component 进上下文', () => {
    const structured = {
      skip: false,
      findings: [
        { attribution: 'tool', component: 'prompt', summary: '提示词缺验证命令', detail: '日志第3行', suggestion: '补上' },
        { attribution: 'project', summary: '目标项目测试本身错', detail: 'x', suggestion: 'y' },
        { attribution: 'environment', summary: '网络不通', detail: 'x', suggestion: 'y' },
      ],
    };
    const drafts = findingsToObservations(task({ status: 'blocked' }), structured);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('llm_finding');
    expect(drafts[0].source).toBe('llm');
    expect(drafts[0].severity).toBe('warn');
    expect(drafts[0].title).toBe('提示词缺验证命令');
    expect(drafts[0].context.component).toBe('prompt');
    expect(drafts[0].taskId).toBe('t1');
  });

  it('非法形状与 undefined 丢弃不抛；skip=true 为空（边界锚点）', () => {
    expect(findingsToObservations(task(), undefined)).toEqual([]);
    expect(findingsToObservations(task(), null)).toEqual([]);
    expect(findingsToObservations(task(), { findings: 'x' })).toEqual([]);
    expect(findingsToObservations(task(), { findings: [{ attribution: 'tool' }] })).toEqual([]);
    expect(findingsToObservations(task(), { findings: [{ attribution: '外星', summary: 'x' }] })).toEqual([]);
    expect(findingsToObservations(task(), { skip: true, findings: [{ attribution: 'tool', summary: 'x', detail: 'd', suggestion: 's' }] })).toEqual([]);
  });

  it('detail/suggestion 非字符串不强转；findings 超 20 条截断', () => {
    const d = findingsToObservations(task(), { findings: [{ attribution: 'tool', summary: 'x', detail: { obj: 1 }, suggestion: 42 }] })[0];
    expect(d.detail).not.toContain('[object Object]');
    const many = Array.from({ length: 25 }, (_, i) => ({ attribution: 'tool', summary: `s${i}`, detail: 'd', suggestion: 's' }));
    expect(findingsToObservations(task(), { findings: many })).toHaveLength(20);
  });
});

describe('reviewRun', () => {
  const ev = (stage: RunEvidence['stage']): RunEvidence => ({ stage, provider: 'claude', toolCalls: 2, tools: {}, denials: [], durationMs: 10, at: Date.now() });

  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-llm-'));
    const workdir = path.join(root, 'work');
    fs.mkdirSync(workdir, { recursive: true });
    const store = new Store(path.join(root, 'data'));
    const project = store.createProject({ name: 'p', workdir, exec: { useKnowledge: false } });
    const t = store.create({ projectId: project.id, title: '任务', description: '', source: 'manual' });
    store.setStatus(t.id, 'blocked', { error: '实现失败：x' });
    const observations = new ObservationStore(path.join(root, 'data'));
    const deps = {
      store,
      observations,
      toolRoot: root,
      getSettings: () => ({ observer: { ...DEFAULT_OBSERVER_SETTINGS, enabled: true } }),
    };
    return { root, store, project, t, observations, deps, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  it('成功复盘：tool 发现入台账；请求只读、带 schema、授权目录不含 data', async () => {
    const ctx = setup();
    try {
      let captured: AgentRequest | undefined;
      const run = async (req: AgentRequest) => {
        captured = req;
        return { ok: true, text: '', structured: { skip: false, findings: [{ attribution: 'tool', component: 'gate', summary: '门禁漏判', detail: 'd', suggestion: 's' }] }, evidence: ev('analysis') };
      };
      await reviewRun({ ...ctx.deps, run }, ctx.t.id);
      expect(ctx.observations.list({ kind: 'llm_finding' })).toHaveLength(1);
      expect(captured!.access).toBe('read');
      expect(captured!.stage).toBe('analysis');
      expect(captured!.schema).toBeTruthy();
      expect(captured!.addDirs!.some((d) => d.includes('data'))).toBe(false);
      expect(captured!.addDirs).toContain(path.join(ctx.root, 'server'));
      expect(captured!.addDirs).toContain(path.join(ctx.root, 'client'));
    } finally {
      ctx.observations.flush();
      await new Promise((r) => setTimeout(r, 400));
      ctx.cleanup();
    }
  });

  it('run 失败或抛异常：不 throw、日志记一条、台账无新增（错误路径锚点）', async () => {
    const ctx = setup();
    try {
      await reviewRun({ ...ctx.deps, run: async () => ({ ok: false, text: '会话挂了', evidence: ev('analysis') }) }, ctx.t.id);
      await reviewRun({ ...ctx.deps, run: async () => { throw new Error('炸了'); } }, ctx.t.id);
      expect(ctx.observations.list()).toEqual([]);
      const logs = ctx.store.get(ctx.t.id)!.logs.join('\n');
      expect(logs).toContain('会话挂了');
      expect(logs).toContain('炸了');
    } finally {
      ctx.observations.flush();
      await new Promise((r) => setTimeout(r, 400));
      ctx.cleanup();
    }
  });

  it('任务被删：静默结束不抛（错误路径锚点）', async () => {
    const ctx = setup();
    try {
      ctx.store.remove(ctx.t.id);
      await expect(reviewRun(ctx.deps, ctx.t.id)).resolves.toBeUndefined();
    } finally {
      ctx.observations.flush();
      await new Promise((r) => setTimeout(r, 400));
      ctx.cleanup();
    }
  });

  it('非 tool 归因：只记日志不入台账（错误路径锚点）', async () => {
    const ctx = setup();
    try {
      const run = async () => ({ ok: true, text: '', structured: { skip: false, findings: [{ attribution: 'project', summary: '目标项目的问题', detail: 'd', suggestion: 's' }] }, evidence: ev('analysis') });
      await reviewRun({ ...ctx.deps, run }, ctx.t.id);
      expect(ctx.observations.list()).toEqual([]);
      expect(ctx.store.get(ctx.t.id)!.logs.join('\n')).toContain('目标项目的问题');
    } finally {
      ctx.observations.flush();
      await new Promise((r) => setTimeout(r, 400));
      ctx.cleanup();
    }
  });
});
