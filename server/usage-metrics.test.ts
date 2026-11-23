import { describe, expect, it } from 'vitest';
import { parseUsageEvent, UsageEventStore, USAGE_KINDS } from './usage-event.ts';
import { computeUsageMetrics, usageFindings } from './usage-metrics.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'abu-usage-'));

describe('parseUsageEvent 形状校验', () => {
  it('接受白名单内的合法事件', () => {
    const ev = parseUsageEvent({ kind: 'click', target: 'btn-start-queue', projectId: 'p1', metric: 120 });
    expect(ev).toMatchObject({ kind: 'click', target: 'btn-start-queue', projectId: 'p1', metric: 120 });
    expect(ev!.id).toBeTruthy();
    expect(typeof ev!.at).toBe('number');
  });
  it('拒绝非法 kind、空 target、超长 target、含空白或中文的 target', () => {
    expect(parseUsageEvent({ kind: 'evil', target: 'x' })).toBeNull();
    expect(parseUsageEvent({ kind: 'click', target: '' })).toBeNull();
    expect(parseUsageEvent({ kind: 'click', target: 'a'.repeat(65) })).toBeNull();
    expect(parseUsageEvent({ kind: 'click', target: 'a b' })).toBeNull();
    expect(parseUsageEvent({ kind: 'click', target: '按钮' })).toBeNull();
    expect(parseUsageEvent(null)).toBeNull();
    expect(parseUsageEvent({ kind: 'click' })).toBeNull();
  });
  it('metric 超出合理范围或非数字时不写入', () => {
    expect(parseUsageEvent({ kind: 'click', target: 'x', metric: -1 })!.metric).toBeUndefined();
    expect(parseUsageEvent({ kind: 'click', target: 'x', metric: 1e12 })!.metric).toBeUndefined();
    expect(parseUsageEvent({ kind: 'click', target: 'x', metric: Number.NaN })!.metric).toBeUndefined();
  });
  it('每个白名单 kind 都能通过', () => {
    for (const k of USAGE_KINDS) expect(parseUsageEvent({ kind: k, target: 'x' })).not.toBeNull();
  });
  it('projectId 只收短标识：自由文本不落盘，合法 id 保留', () => {
    expect(parseUsageEvent({ kind: 'click', target: 'x', projectId: '任务标题片段' })!.projectId).toBeUndefined();
    expect(parseUsageEvent({ kind: 'click', target: 'x', projectId: 'p1' })!.projectId).toBe('p1');
  });
});

describe('UsageEventStore 存储', () => {
  it('落盘后能重新读出；写盘是原子的（不残留 .tmp）', () => {
    const dir = tmpDir();
    const s = new UsageEventStore(dir);
    s.add({ kind: 'click', target: 'a' });
    s.flush();
    expect(fs.existsSync(path.join(dir, 'usage-events.json.tmp'))).toBe(false);
    const s2 = new UsageEventStore(dir);
    expect(s2.list()).toHaveLength(1);
    expect(s2.list()[0].target).toBe('a');
  });
  it('非法事件不落库，add 返回 null', () => {
    const s = new UsageEventStore(tmpDir());
    expect(s.add({ kind: 'bad', target: 'x' })).toBeNull();
    expect(s.list()).toHaveLength(0);
  });
  it('超过上限时丢最旧的，长度不超过上限', () => {
    const s = new UsageEventStore(tmpDir());
    for (let i = 0; i < 520; i++) s.add({ kind: 'click', target: 'x' });
    expect(s.list().length).toBe(500);
  });
  it('clear 返回清掉的条数并清空', () => {
    const s = new UsageEventStore(tmpDir());
    s.add({ kind: 'click', target: 'a' });
    s.add({ kind: 'view', target: 'b' });
    expect(s.clear()).toBe(2);
    expect(s.list()).toHaveLength(0);
  });
  it('损坏的 JSON 文件回退空列表，不抛异常', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'usage-events.json'), '{不是数组', 'utf8');
    expect(new UsageEventStore(dir).list()).toHaveLength(0);
  });
});

describe('UsageEventStore 聚合', () => {
  it('clickCounts 按控件归并并从多到少排序', () => {
    const s = new UsageEventStore(tmpDir());
    s.add({ kind: 'click', target: 'b' });
    for (let i = 0; i < 3; i++) s.add({ kind: 'click', target: 'a' });
    s.add({ kind: 'view', target: 'c' });
    expect(s.clickCounts(24 * 3_600_000)).toEqual([{ target: 'a', n: 3 }, { target: 'b', n: 1 }]);
  });
  it('drawerDwellMs 用 close_drawer 携带的停留时长算中位数，未配对的不计', () => {
    const s = new UsageEventStore(tmpDir());
    s.add({ kind: 'open_drawer', target: 'task' });
    s.add({ kind: 'close_drawer', target: 'task', metric: 1000 });
    s.add({ kind: 'close_drawer', target: 'task', metric: 3000 });
    s.add({ kind: 'close_drawer', target: 'task', metric: 2000 });
    s.add({ kind: 'open_drawer', target: 'other' });
    expect(s.drawerDwellMs(24 * 3_600_000)).toEqual([{ target: 'task', n: 3, medianMs: 2000 }]);
  });
});

describe('computeUsageMetrics 摩擦指标', () => {
  const now = Date.now();
  const ev = (kind: string, target: string, at: number) => ({ id: 'x', at, kind, target }) as never;

  it('统计点击次数并从多到少排序', () => {
    const events = [ev('click', 'a', now - 1000), ev('click', 'a', now - 2000), ev('click', 'b', now - 3000)];
    const m = computeUsageMetrics(events, 7, now);
    expect(m.topClicks[0]).toEqual({ target: 'a', n: 2 });
    expect(m.eventCount).toBe(3);
  });

  it('识别短时间内连续点击：间隔 3 秒内至少连点 3 下算一次', () => {
    const events = [ev('click', 'a', now - 5000), ev('click', 'a', now - 4000), ev('click', 'a', now - 3000)];
    const m = computeUsageMetrics(events, 7, now);
    expect(m.repeatedClicks).toEqual([{ target: 'a', repeats: 1 }]);
  });

  it('间隔超过窗口不算连点', () => {
    const events = [ev('click', 'a', now - 9000), ev('click', 'a', now - 4000), ev('click', 'a', now - 1000)];
    expect(computeUsageMetrics(events, 7, now).repeatedClicks).toHaveLength(0);
  });

  it('窗口外的事件不计入', () => {
    const events = [ev('click', 'a', now - 8 * 24 * 3_600_000)];
    expect(computeUsageMetrics(events, 7, now).eventCount).toBe(0);
  });

  it('空事件集不报错，返回零值', () => {
    const m = computeUsageMetrics([], 7, now);
    expect(m).toMatchObject({ eventCount: 0, topClicks: [], repeatedClicks: [], errorTargets: [] });
  });
});

describe('usageFindings 生成台账草稿', () => {
  const now = Date.now();
  const metrics = (over: Partial<ReturnType<typeof computeUsageMetrics>>) =>
    ({ at: now, windowDays: 7, eventCount: 0, topClicks: [], repeatedClicks: [], errorTargets: [], ...over });

  it('反复点击达到阈值才入台账，且 key 稳定可去重', () => {
    const low = usageFindings(metrics({ repeatedClicks: [{ target: 'a', repeats: 1 }] }));
    expect(low).toHaveLength(0);
    const high = usageFindings(metrics({ repeatedClicks: [{ target: 'a', repeats: 3 }] }));
    expect(high).toHaveLength(1);
    expect(high[0].kind).toBe('usage_friction');
    expect(high[0].key).toBe('usage:repeat:a');
    expect(high[0].title).toContain('a');
    expect(high[0].severity).toBe('warn');
  });

  it('错误目标至少两次才入台账', () => {
    expect(usageFindings(metrics({ errorTargets: [{ target: 'x', n: 1 }] }))).toHaveLength(0);
    const one = usageFindings(metrics({ errorTargets: [{ target: 'x', n: 2 }] }));
    expect(one).toHaveLength(1);
    expect(one[0].key).toBe('usage:error:x');
  });

  it('没有摩擦时给空数组', () => {
    expect(usageFindings(metrics({}))).toHaveLength(0);
  });
});
