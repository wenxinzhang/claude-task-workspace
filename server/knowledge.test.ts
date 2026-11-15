import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { memoryDirFor } from './memory.ts';
import { historySection, implementPrompt, memorySection, moduleOf, relatedHistory } from './prompts.ts';
import type { Task } from './types.ts';

let n = 0;
const task = (p: Partial<Task>): Task => ({
  id: `t${++n}`,
  projectId: 'p1',
  title: `任务${n}`,
  description: '',
  analysis: '',
  analyzing: false,
  source: 'feishu',
  status: 'done',
  order: 0,
  logs: [],
  createdAt: 0,
  updatedAt: n,
  ...p,
});

describe('moduleOf', () => {
  it('取「所属模块」字段', () => {
    expect(moduleOf('所属模块：后台-总览\n类型：bug')).toBe('后台-总览');
    expect(moduleOf('所属模块: 系统配置')).toBe('系统配置');
    expect(moduleOf('无模块')).toBe('');
  });
});

describe('relatedHistory', () => {
  const current = task({ id: 'cur', status: 'todo', description: '所属模块：后台-总览' });
  const sameOld = task({ title: '同模块旧', description: '所属模块：后台-总览', updatedAt: 1 });
  const otherNew = task({ title: '别的模块新', description: '所属模块：系统配置', updatedAt: 100 });
  const notDone = task({ title: '未完成', description: '所属模块：后台-总览', status: 'blocked', updatedAt: 200 });
  const otherProject = task({ title: '别的项目', projectId: 'p2', description: '所属模块：后台-总览', updatedAt: 300 });

  it('只取同项目已完成的，同模块优先，其次按完成时间', () => {
    const list = relatedHistory(current, [current, sameOld, otherNew, notDone, otherProject]);
    expect(list.map((t) => t.title)).toEqual(['同模块旧', '别的模块新']);
  });

  it('限制数量', () => {
    const many = Array.from({ length: 8 }, () => task({}));
    expect(relatedHistory(current, many)).toHaveLength(5);
  });
});

describe('historySection', () => {
  it('包含标题、提交、文件，并标注人工处理', () => {
    const s = historySection([
      task({ title: '修复遮挡', description: '所属模块：后台-总览', commit: { hash: 'abc1234', files: ['a.tsx', 'b.less'] }, summary: '改了\n两处' }),
      task({ title: '人工的', resolvedManually: true }),
    ]);
    expect(s).toContain('### 修复遮挡（后台-总览）');
    expect(s).toContain('提交：abc1234');
    expect(s).toContain('改动文件：a.tsx、b.less');
    expect(s).toContain('总结：改了 两处');
    expect(s).toContain('由人工处理完成');
    expect(s).toContain('不要把之前的修复改回去');
  });

  it('总结过长时截断，没有历史时为空', () => {
    expect(historySection([task({ summary: 'x'.repeat(1000) })])).toContain(`${'x'.repeat(400)}…`);
    expect(historySection([])).toBe('');
  });

  it('附加到执行提示词中', () => {
    const p = implementPrompt(task({}), '', undefined, undefined, historySection([task({ title: '旧任务' })]) + memorySection('/m'));
    expect(p).toContain('### 旧任务');
    expect(p).toContain('长期记忆目录：/m');
  });
});

describe('memoryDirFor', () => {
  it('与 Claude Code 的项目目录命名一致', () => {
    const dir = memoryDirFor('E:\\workspace\\demo\\sample-app', 'C:\\Users\\u');
    if (process.platform === 'win32') {
      expect(dir).toBe(path.join('C:\\Users\\u', '.claude', 'projects', 'E--workspace-demo-sample-app', 'memory'));
    } else {
      expect(dir.endsWith(path.join('projects', path.resolve('E:\\workspace\\demo\\sample-app').replace(/[^A-Za-z0-9]/g, '-'), 'memory'))).toBe(true);
    }
  });
});
