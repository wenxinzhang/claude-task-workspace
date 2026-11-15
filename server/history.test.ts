import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { History, aiRecordFromTask } from './history.ts';
import type { RunEvidence, Task } from './types.ts';

const ev = (stage: RunEvidence['stage'], durationMs: number): RunEvidence => ({
  stage,
  provider: 'claude',
  toolCalls: 3,
  tools: {},
  denials: [],
  durationMs,
  at: 10_000 + durationMs,
});

const task = (over: Partial<Task>): Task => ({
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

describe('aiRecordFromTask', () => {
  it('门禁未通过：记录失败，运行测试步骤标失败，时长按事件流', () => {
    const r = aiRecordFromTask(
      task({
        status: 'blocked',
        evidence: { analysis: ev('analysis', 2100), implement: ev('implement', 6500), verify: ev('verify', 3200) },
        gate: { verdict: 'fail', reasons: [], items: [], outOfScope: [], changedFiles: [], at: 20_000 },
      }),
    );
    expect(r.kind).toBe('ai');
    expect(r.status).toBe('failed');
    expect(r.taskId).toBe('t1');
    expect(r.steps?.map((s) => s.name)).toEqual(['读取修复规格', '修改代码', '运行测试']);
    expect(r.steps?.[2].status).toBe('fail');
    expect(r.steps?.[1].durationMs).toBe(6500);
    expect(r.startedAt).toBe(10_000);
    expect(r.finishedAt).toBe(13_200);
  });

  it('需要人工验收：记录为待验证', () => {
    const r = aiRecordFromTask(
      task({
        evidence: { implement: ev('implement', 1000) },
        gate: { verdict: 'unverified', reasons: [], items: [], outOfScope: [], changedFiles: [], at: 20_000 },
      }),
    );
    expect(r.status).toBe('review');
  });
});

describe('History', () => {
  it('每个项目最多保留 200 条，不影响别的项目', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-'));
    try {
      const h = new History(dir);
      for (let i = 0; i < 210; i++) {
        h.add({ id: `r${i}`, projectId: 'p1', kind: 'sync', title: `s${i}`, status: 'success', startedAt: i, logs: [] });
      }
      h.add({ id: 'other', projectId: 'p2', kind: 'sync', title: 'o', status: 'success', startedAt: 1, logs: [] });
      expect(h.list('p1')).toHaveLength(200);
      expect(h.list('p1')[0].id).toBe('r10');
      expect(h.list('p2')).toHaveLength(1);
      // 重新打开还在
      expect(new History(dir).list('p1')).toHaveLength(200);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backfill 只补一次，不重复', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-'));
    try {
      const h = new History(dir);
      const t = task({ evidence: { implement: ev('implement', 1000) } });
      h.backfillAI([t]);
      h.backfillAI([t]);
      expect(h.list('p1').filter((r) => r.kind === 'ai')).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
