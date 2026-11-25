import { describe, expect, it } from 'vitest';
import { analysisPrompt, changesSection, implementPrompt, NO_ACTION_RETRY_NOTE, taskRecap, verifyPrompt } from './prompts.ts';
import { shouldRetryNoAction } from './gate.ts';
import type { Criterion, Task } from './types.ts';

const task = { id: 't', projectId: 'p', title: '修复标题', description: '', analysis: '## 目标\n标题与柱子一致', logs: [] } as unknown as Task;
const criteria: Criterion[] = [
  { id: 'AC1', text: '类型检查通过', method: 'auto', how: 'npx tsc -b' },
  { id: 'AC2', text: '柱子合计等于标题总数', method: 'manual', how: '部署后打开 /zhixun/overview' },
];

describe('verifyPrompt', () => {
  it('列出带编号的验收项，附上本次改动，要求逐项给结果', () => {
    const p = verifyPrompt(task, criteria, undefined, undefined, '', { files: ['a.tsx'], skipped: [], diff: '+x' });
    expect(p).toContain('- [AC1]（自动验证）类型检查通过\n  验证方式：npx tsc -b');
    expect(p).toContain('- [AC2]（人工验证）柱子合计等于标题总数');
    expect(p).toContain('无需再运行 git');
    expect(p).toContain('改动的文件：a.tsx');
    expect(p).toContain('```diff\n+x\n```');
    expect(p).toContain('没有浏览器');
    expect(p).toContain('没有验证过的项不能写 pass');
  });

  it('列出执行前就有改动的文件', () => {
    expect(changesSection({ files: [], skipped: ['b.ts'], diff: '' })).toContain('- b.ts');
    expect(changesSection({ files: [], skipped: [], diff: '' })).toContain('没有产生代码改动');
    expect(changesSection(undefined)).toBe('');
  });
});

describe('analysisPrompt', () => {
  it('验收项分自动验证与人工验证，并要求先读代码', () => {
    const p = analysisPrompt(task);
    expect(p).toContain('自动验证');
    expect(p).toContain('人工验证');
    expect(p).toContain('没有浏览器');
    expect(p).toContain('读不到代码时不要编写规格');
  });
});

describe('implementPrompt', () => {
  it('规格限定了改动范围时才提范围要求', () => {
    const spec = { goal: 'g', rootCause: '', scope: ['src/pages'], steps: [], criteria, risks: [] };
    expect(implementPrompt({ ...task, spec } as Task, '')).toContain('只改规格「改动范围」内的文件');
    expect(implementPrompt(task, '')).not.toContain('改动范围」内');
    expect(implementPrompt({ ...task, spec: { ...spec, scope: [] } } as Task, '')).not.toContain('改动范围」内');
  });

  it('开头声明任务就在本条消息里，截断标记与任务无关', () => {
    const p = implementPrompt(task, '');
    const head = p.slice(0, p.indexOf('## 任务'));
    expect(head).toContain('omitted');
    expect(head).toContain('不要据此认为任务缺失');
  });

  it('结尾复述任务标题和规格摘要', () => {
    const p = implementPrompt(task, '附加要求');
    const tail = p.slice(p.lastIndexOf('## 再次确认本次任务'));
    expect(tail).toContain('任务标题：修复标题');
    expect(tail).toContain('标题与柱子一致');
    expect(p.indexOf('- 附加要求')).toBeLessThan(p.lastIndexOf('## 再次确认本次任务'));
  });

  it('规格过长时摘要截短，并指回上文的完整规格', () => {
    const recap = taskRecap({ title: 't', analysis: 'x'.repeat(2000) });
    expect(recap).toContain('完整规格见上文');
    expect(recap.length).toBeLessThan(800);
    expect(taskRecap({ title: 't', analysis: '' })).not.toContain('规格摘要');
  });
});

describe('shouldRetryNoAction', () => {
  it('只在会话成功但一个工具都没调用时重试', () => {
    expect(shouldRetryNoAction({ ok: true, evidence: { toolCalls: 0 } })).toBe(true);
    expect(shouldRetryNoAction({ ok: true, evidence: { toolCalls: 3 } })).toBe(false);
    expect(shouldRetryNoAction({ ok: false, evidence: { toolCalls: 0 } })).toBe(false);
    expect(shouldRetryNoAction({ ok: true, evidence: { toolCalls: null } })).toBe(false);
  });

  it('重试提示词说明上次误判了任务缺失', () => {
    expect(NO_ACTION_RETRY_NOTE).toContain('没有调用任何工具');
    expect(NO_ACTION_RETRY_NOTE).toContain('任务就在本条消息里');
  });
});

describe('流程提速：提示词不让代理做系统已经做过的事', () => {
  it('验证提示词：人工验证项直接记未验证，不为它们读代码或跑命令', () => {
    const p = verifyPrompt(task, criteria);
    expect(p).toMatch(/人工验证.*直接.*unverified/);
  });

  it('验证提示词：不重跑与验收项无关的检查', () => {
    expect(verifyPrompt(task, criteria)).toContain('只运行验收项「验证方式」里写的命令');
  });

  it('实现提示词：改动由系统统计，不必自己跑 git', () => {
    expect(implementPrompt(task, '')).toMatch(/改动.*由系统统计.*git/);
  });

  it('理解提示词：读够就输出', () => {
    expect(analysisPrompt(task)).toContain('读到足以确定根因和改动范围就输出');
  });
});

describe('规格不写「改动范围」类的验收项', () => {
  it('理解提示词：改了哪些文件由系统核对，不要写成验收项', () => {
    expect(analysisPrompt(task)).toMatch(/改动了哪些文件.*由系统.*核对.*不要写成验收项/);
  });
});
