import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ObservationStore } from './observe.ts';
import { ProposalStore } from './proposal-store.ts';
import { componentRiskRank, DEFAULT_OBSERVER_SETTINGS, normalizeObserver, type ApplyResult, type Observation, type ProbeRecord, type Proposal } from './observe-types.ts';
import { DEFAULT_EXEC } from './types.ts';

/** 一条问题草稿：形状从 Observation 类型抄，缺省值只用于测试 */
const draft = (over: Partial<Observation> = {}): Omit<Observation, 'id' | 'at' | 'status'> => ({
  projectId: 'p1',
  kind: 'exec_error',
  severity: 'error',
  title: '实现失败',
  detail: '某错误',
  context: {},
  source: 'code',
  ...over,
});

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'observe-'));

describe('normalizeObserver', () => {
  it('未配置时归一为全默认：默认关闭、阈值 3、冷却 6 小时、会话预算 2 美元', () => {
    const s = normalizeObserver(undefined);
    expect(s.enabled).toBe(false);
    expect(s.autoOptimize).toBe(false);
    expect(s.minNewObservations).toBe(3);
    expect(s.cooldownHours).toBe(6);
    expect(s.exec.provider).toBe(DEFAULT_EXEC.provider);
    expect(s.exec.budgetUsd).toBe(2);
    expect(Object.keys(s.exec).sort()).toEqual(Object.keys(DEFAULT_EXEC).sort());
  });

  it('阈值与冷却越界时夹取到边界', () => {
    const low = normalizeObserver({ minNewObservations: -5, cooldownHours: 0.1 });
    expect(low.minNewObservations).toBe(1);
    expect(low.cooldownHours).toBe(0.5);
    const high = normalizeObserver({ minNewObservations: 100, cooldownHours: 999 });
    expect(high.minNewObservations).toBe(50);
    expect(high.cooldownHours).toBe(168);
  });

  it('阈值是小数时取整', () => {
    expect(normalizeObserver({ minNewObservations: 2.7 }).minNewObservations).toBe(3);
  });

  it('exec 非法值净化：budgetUsd 非数值回退 2、负数归 0；provider/permissionMode 非法回退默认', () => {
    const s = normalizeObserver({ exec: { budgetUsd: '999', provider: '外星', permissionMode: '乱来' } });
    expect(s.exec.budgetUsd).toBe(2);
    expect(s.exec.provider).toBe(DEFAULT_EXEC.provider);
    expect(s.exec.permissionMode).toBe(DEFAULT_EXEC.permissionMode);
    expect(normalizeObserver({ exec: { budgetUsd: -5 } }).exec.budgetUsd).toBe(0);
  });
});

describe('DEFAULT_OBSERVER_SETTINGS', () => {
  it('默认关闭观察者与自动诊断，预算 2 美元、阈值 3、冷却 6 小时', () => {
    expect(DEFAULT_OBSERVER_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_OBSERVER_SETTINGS.autoOptimize).toBe(false);
    expect(DEFAULT_OBSERVER_SETTINGS.exec.budgetUsd).toBe(2);
    expect(DEFAULT_OBSERVER_SETTINGS.minNewObservations).toBe(3);
    expect(DEFAULT_OBSERVER_SETTINGS.cooldownHours).toBe(6);
    expect(normalizeObserver(undefined)).toEqual(DEFAULT_OBSERVER_SETTINGS);
  });
});

describe('componentRiskRank', () => {
  it('风险从低到高：提示词、集成、流程、门禁', () => {
    const ranks = (['prompt', 'integration', 'flow', 'gate'] as const).map(componentRiskRank);
    expect(ranks[0]).toBeLessThan(ranks[1]);
    expect(ranks[1]).toBeLessThan(ranks[2]);
    expect(ranks[2]).toBeLessThan(ranks[3]);
  });
});

describe('ObservationStore', () => {
  it('空目录新建：list 返回空数组', () => {
    const dir = tmpDir();
    try {
      expect(new ObservationStore(dir).list()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('add：返回带 id/at/status=new 的记录，list 能取回同内容', () => {
    const dir = tmpDir();
    try {
      const s = new ObservationStore(dir);
      const o = s.add(draft({ title: '门禁未过', kind: 'gate_fail' }));
      expect(o.id).toBeTruthy();
      expect(o.at).toBeGreaterThan(0);
      expect(o.status).toBe('new');
      expect(s.list()).toHaveLength(1);
      expect(s.list()[0].title).toBe('门禁未过');
      expect(s.list()[0].kind).toBe('gate_fail');
      s.flush();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('持久化：add 后新实例读同一目录记录仍在', () => {
    const dir = tmpDir();
    try {
      const s = new ObservationStore(dir);
      s.add(draft({ title: '落盘验证' }));
      s.flush();
      const reopened = new ObservationStore(dir);
      expect(reopened.list()).toHaveLength(1);
      expect(reopened.list()[0].title).toBe('落盘验证');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('全局上限 500：超出丢最旧，最新仍在', () => {
    const dir = tmpDir();
    try {
      const s = new ObservationStore(dir);
      for (let i = 0; i < 510; i++) s.add(draft({ title: `o${i}` }));
      expect(s.list()).toHaveLength(500);
      expect(s.list()[0].title).toBe('o10');
      expect(s.list()[499].title).toBe('o509');
      s.flush();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('setStatus：三态更新返回记录；不存在的 id 返回 undefined', () => {
    const dir = tmpDir();
    try {
      const s = new ObservationStore(dir);
      const o = s.add(draft());
      expect(s.setStatus(o.id, 'ignored')?.status).toBe('ignored');
      expect(s.setStatus(o.id, 'resolved')?.status).toBe('resolved');
      expect(s.setStatus(o.id, 'new')?.status).toBe('new');
      expect(s.setStatus('missing', 'ignored')).toBeUndefined();
      s.flush();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('markResolvedByProposal：只把关联且 new 的标 resolved 并记录提案，ignored 与无关不动', () => {
    const dir = tmpDir();
    try {
      const s = new ObservationStore(dir);
      const a = s.add(draft({ title: 'A' }));
      const b = s.add(draft({ title: 'B' }));
      const c = s.add(draft({ title: 'C' }));
      s.setStatus(b.id, 'ignored');
      s.markResolvedByProposal('prop1', [a.id, b.id]);
      const byId = (id: string) => s.list().find((r) => r.id === id);
      expect(byId(a.id)?.status).toBe('resolved');
      expect(byId(a.id)?.proposalId).toBe('prop1');
      expect(byId(b.id)?.status).toBe('ignored');
      expect(byId(c.id)?.status).toBe('new');
      s.flush();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reopenByProposal：回滚后该提案自动解决的退回 new，手动解决的不动', () => {
    const dir = tmpDir();
    try {
      const s = new ObservationStore(dir);
      const a = s.add(draft({ title: '自动解决' }));
      const manual = s.add(draft({ title: '手动解决' }));
      s.markResolvedByProposal('prop1', [a.id]);
      s.setStatus(manual.id, 'resolved');
      s.reopenByProposal('prop1');
      const byId = (id: string) => s.list().find((r) => r.id === id);
      expect(byId(a.id)?.status).toBe('new');
      expect(byId(a.id)?.proposalId).toBeUndefined();
      expect(byId(manual.id)?.status).toBe('resolved');
      s.flush();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('countNew：只数 new 且 error/warn 的问题，note 与已处理不计', () => {
    const dir = tmpDir();
    try {
      const s = new ObservationStore(dir);
      s.add(draft({ severity: 'error' }));
      s.add(draft({ severity: 'warn' }));
      s.add(draft({ severity: 'note' }));
      const done = s.add(draft({ severity: 'error' }));
      s.setStatus(done.id, 'resolved');
      expect(s.countNew()).toBe(2);
      s.flush();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('list：按项目/状态/类型组合过滤，返回副本不影响内部', () => {
    const dir = tmpDir();
    try {
      const s = new ObservationStore(dir);
      const a = s.add(draft({ projectId: 'p1', kind: 'exec_error' }));
      s.add(draft({ projectId: 'p2', kind: 'exec_error' }));
      s.add(draft({ projectId: 'p1', kind: 'gate_fail' }));
      s.setStatus(a.id, 'ignored');
      expect(s.list({ projectId: 'p1' })).toHaveLength(2);
      expect(s.list({ projectId: 'p1', kind: 'gate_fail' })).toHaveLength(1);
      expect(s.list({ status: 'ignored' })).toHaveLength(1);
      const copy = s.list();
      copy[0].title = '被篡改';
      expect(s.list()[0].title).not.toBe('被篡改');
      s.flush();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('change 事件：add 与 setStatus 各触发一次', () => {
    const dir = tmpDir();
    try {
      const s = new ObservationStore(dir);
      let n = 0;
      s.on('change', () => n++);
      const o = s.add(draft());
      expect(n).toBe(1);
      s.setStatus(o.id, 'ignored');
      expect(n).toBe(2);
      s.flush();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('节流：窗口内多次 add 只落盘一次（既有行为锚点）', () => {
    vi.useFakeTimers();
    const dir = tmpDir();
    try {
      const s = new ObservationStore(dir);
      const spy = vi.spyOn(fs, 'writeFileSync');
      s.add(draft());
      s.add(draft());
      s.add(draft());
      vi.advanceTimersByTime(350);
      const writes = spy.mock.calls.filter((c) => String(c[0]).endsWith('observations.json.tmp'));
      expect(writes).toHaveLength(1);
      spy.mockRestore();
      s.flush();
    } finally {
      vi.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('损坏的 JSON：回退空列表不抛（既有行为锚点）', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'observations.json'), '{bad', 'utf8');
      expect(new ObservationStore(dir).list()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('合法 JSON 但非数组：回退空列表（边界锚点）', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'observations.json'), '{}', 'utf8');
      expect(new ObservationStore(dir).list()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** 一条提案草稿：形状从 Proposal 类型抄 */
const pDraft = (over: Partial<Proposal> = {}): Omit<Proposal, 'id' | 'at' | 'status'> => ({
  title: '修复提示词弱点',
  component: 'prompt',
  problemIds: ['o1'],
  rootCause: '某原因',
  edits: [{ file: 'server/prompts.ts', find: 'a', replace: 'b' }],
  risk: '低',
  verification: 'npm test',
  ...over,
});

describe('ProposalStore', () => {
  it('add：返回带 id/at/status=pending 的提案，list 能取回', () => {
    const dir = tmpDir();
    try {
      const s = new ProposalStore(dir);
      const p = s.add(pDraft({ title: '提案A' }));
      expect(p.id).toBeTruthy();
      expect(p.at).toBeGreaterThan(0);
      expect(p.status).toBe('pending');
      expect(s.list()).toHaveLength(1);
      expect(s.list()[0].title).toBe('提案A');
      s.flush();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('持久化：add 后新实例读同一目录提案仍在', () => {
    const dir = tmpDir();
    try {
      const s = new ProposalStore(dir);
      s.add(pDraft({ title: '落盘提案' }));
      s.flush();
      expect(new ProposalStore(dir).list()[0].title).toBe('落盘提案');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('全局上限 50：超出丢最旧，最新仍在', () => {
    const dir = tmpDir();
    try {
      const s = new ProposalStore(dir);
      for (let i = 0; i < 55; i++) s.add(pDraft({ title: `p${i}` }));
      expect(s.list()).toHaveLength(50);
      expect(s.list()[0].title).toBe('p5');
      expect(s.list()[49].title).toBe('p54');
      s.flush();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('setStatus：更新状态与结果并落盘；get 按 id 取回；不存在返回 undefined', () => {
    const dir = tmpDir();
    try {
      const s = new ProposalStore(dir);
      const p = s.add(pDraft());
      const result: ApplyResult = { ok: true, output: '通过', at: 123, mode: 'apply' };
      const updated = s.setStatus(p.id, 'applied', result);
      expect(updated?.status).toBe('applied');
      expect(updated?.result?.ok).toBe(true);
      expect(s.get(p.id)?.status).toBe('applied');
      expect(s.setStatus('missing', 'rejected')).toBeUndefined();
      expect(s.get('missing')).toBeUndefined();
      s.flush();
      expect(new ProposalStore(dir).get(p.id)?.result?.mode).toBe('apply');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('setProbe：复验结论落盘往返；不存在的 id 返回 undefined', () => {
    const dir = tmpDir();
    try {
      const s = new ProposalStore(dir);
      const p = s.add(pDraft());
      const probe: ProbeRecord = { taskId: 't1', beforeVerdict: 'fail', afterVerdict: 'pass', result: 'improved', at: 456 };
      const updated = s.setProbe(p.id, probe);
      expect(updated?.probe?.result).toBe('improved');
      expect(s.setProbe('missing', probe)).toBeUndefined();
      s.flush();
      expect(new ProposalStore(dir).get(p.id)?.probe?.afterVerdict).toBe('pass');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lastRunAt：默认 null，设置后落盘往返', () => {
    const dir = tmpDir();
    try {
      const s = new ProposalStore(dir);
      expect(s.getLastRunAt()).toBeNull();
      s.setLastRunAt(789);
      expect(s.getLastRunAt()).toBe(789);
      s.flush();
      expect(new ProposalStore(dir).getLastRunAt()).toBe(789);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
