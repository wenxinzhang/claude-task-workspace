import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createObserver } from './observer.ts';
import { DEFAULT_OBSERVER_SETTINGS, type Observation } from './observe-types.ts';
import { observationReview } from './observation-review.ts';
import { Queue } from './queue.ts';
import { Store } from './store.ts';

const cleanups: (() => void)[] = [];
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 400));
  for (const fn of cleanups.splice(0)) fn();
});

function setup(opts: { enabled?: boolean; usageCollect?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-usage-obs-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const workdir = path.join(root, 'work');
  fs.mkdirSync(workdir, { recursive: true });
  const store = new Store(path.join(root, 'data'));
  const project = store.createProject({ name: 'p', workdir, exec: { useKnowledge: false } });
  const queue = new Queue(store, undefined, async () => {
    throw new Error('本测试不执行任务');
  });
  const observer = createObserver({
    root,
    store,
    queue,
    deployer: { allStatus: () => ({}) },
    getSettings: () => ({ observer: { ...DEFAULT_OBSERVER_SETTINGS, enabled: opts.enabled !== false, usageCollect: opts.usageCollect !== false } }),
    spawnApply: () => {},
  });
  return { root, store, project, queue, observer };
}

/** 造 n 组连点：每组 3 下、间隔 1 秒，组间隔 10 秒（超过 3 秒的连点窗口）。只伪造 Date，定时器保持真实 */
function burstClicks(observer: ReturnType<typeof createObserver>, target: string, bursts: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const start = Date.now();
    for (let b = 0; b < bursts; b++) {
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(start - b * 10_000 - i * 1000);
        expect(observer.usage.add({ kind: 'click', target })).not.toBeNull();
      }
    }
  } finally {
    // 断言失败也要恢复真实时钟，避免伪造的 Date 泄漏进后续用例
    vi.useRealTimers();
  }
}

describe('新台账类型的问题草稿', () => {
  const obs = (kind: Observation['kind']): Observation => ({
    id: 'x', at: 1, projectId: '', kind, severity: 'warn', title: 't', detail: '', context: {}, source: 'code', status: 'new',
  });
  it('usage_friction 与 screenshot_finding 都有可用的默认修改建议', () => {
    for (const kind of ['usage_friction', 'screenshot_finding'] as const) {
      const r = observationReview(obs(kind));
      expect(r.suggestion.length).toBeGreaterThan(0);
    }
  });
});

describe('观察者接入使用观测', () => {
  it('usageMetrics 返回窗口内的点击统计与抽屉停留', () => {
    const { observer } = setup();
    observer.usage.add({ kind: 'click', target: 'btn-start' });
    observer.usage.add({ kind: 'click', target: 'btn-start' });
    observer.usage.add({ kind: 'click', target: 'btn-other' });
    observer.usage.add({ kind: 'close_drawer', target: 'task-drawer', metric: 4000 });
    const m = observer.usageMetrics(7);
    expect(m.eventCount).toBe(4);
    expect(m.topClicks[0]).toEqual({ target: 'btn-start', n: 2 });
    expect(m.drawerDwell).toEqual([{ target: 'task-drawer', n: 1, medianMs: 4000 }]);
  });

  it('collectUsage 把达到阈值的摩擦写进台账，重复调用按 key 去重', () => {
    const { observer } = setup();
    burstClicks(observer, 'btn-x', 3);
    expect(observer.collectUsage()).toBe(1);
    const list = observer.observations.list({ kind: 'usage_friction' });
    expect(list).toHaveLength(1);
    expect(list[0].key).toBe('usage:repeat:btn-x');
    expect(observer.collectUsage()).toBe(0);
    expect(observer.observations.list({ kind: 'usage_friction' })).toHaveLength(1);
  });

  it('观察者关闭时 collectUsage 不入台账', () => {
    const { observer } = setup({ enabled: false });
    burstClicks(observer, 'btn-x', 3);
    expect(observer.collectUsage()).toBe(0);
    expect(observer.observations.list({ kind: 'usage_friction' })).toHaveLength(0);
  });

  it('关闭使用采集后拒收新事件，已有事件仍可查询与清空', () => {
    const { observer } = setup({ usageCollect: false });
    expect(observer.addUsage({ kind: 'click', target: 'x' })).toBeNull();
    expect(observer.usage.list()).toHaveLength(0);
  });

  it('一轮任务结束时顺带采集使用摩擦', () => {
    const { observer, store, project } = setup();
    burstClicks(observer, 'btn-x', 3);
    const t = store.create({ projectId: project.id, title: '任务', description: '', source: 'manual' });
    store.setStatus(t.id, 'blocked', { error: '实现失败：x' });
    observer.onRunEnd(t.id);
    expect(observer.observations.list({ kind: 'usage_friction' })).toHaveLength(1);
  });
});
