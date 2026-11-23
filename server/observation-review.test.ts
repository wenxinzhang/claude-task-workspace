import { describe, expect, it } from 'vitest';
import { cleanSections, ISSUE_BODY_LIMIT, observationIssueDraft, observationReview, observationSections } from './observation-review.ts';
import type { Observation } from './observe-types.ts';

const obs = (over: Partial<Observation> = {}): Observation => ({
  id: 'o1', at: 1, projectId: 'p1', kind: 'exec_error', severity: 'error',
  title: '执行失败', detail: 'SECRET-CODE-CONTENT 内部路径 E:/客户项目', context: {}, source: 'code', status: 'new',
  ...over,
});

describe('observationIssueDraft 增强建议包（4A）', () => {
  it('带 observation 时附证据摘要与影响范围：只含结构化事实，不含原始 detail 与远端 URL', () => {
    const o = obs({
      attribution: 'tool',
      taskId: 'abcd1234-5678-90ab-cdef-1234567890ab',
      context: { provider: 'claude', model: 'sonnet', durationMs: 65_000, toolCalls: 12, costUsd: 0.42, branch: 'main', upstream: 'https://user:token@github.com/x/y', envName: '测试环境' },
    });
    const d = observationIssueDraft('owner/tool', '标题', { finding: '发现的问题描述', suggestion: '修改建议' }, o);
    expect(d.body).toContain('## 证据摘要');
    expect(d.body).toContain('claude');
    expect(d.body).toContain('sonnet');
    expect(d.body).toContain('65 秒');
    // 锚整行：裸 '12' 会被 taskId 里的子串满足，toolCalls 行删掉也绿（假阳性通道）
    expect(d.body).toContain('工具调用：12 次');
    expect(d.body).toContain('0.42');
    expect(d.body).toContain('abcd1234');
    expect(d.body).toContain('## 影响范围');
    expect(d.body).toContain('工具自身');
    expect(d.body).toContain('## 验收标准');
    // 脱敏边界：原始 detail（可能含代码/客户路径）与可能带凭据的远端 URL 一律不进 Issue
    expect(d.body).not.toContain('SECRET-CODE-CONTENT');
    expect(d.body).not.toContain('客户项目');
    expect(d.body).not.toContain('token@');
    expect(d.body).not.toContain('github.com/x/y');
    expect(d.body.length).toBeLessThanOrEqual(ISSUE_BODY_LIMIT);
  });

  it('截图诊断的记录注明截图本地保存、不随 Issue 上传', () => {
    const o = obs({ kind: 'screenshot_finding', source: 'llm', context: { screenshotToken: 'local_abc' } });
    const d = observationIssueDraft('owner/tool', '标题', { finding: 'f', suggestion: 's' }, o);
    expect(d.body).toContain('截图');
    expect(d.body).not.toContain('local_abc');
  });

  it('不带 observation 保持原三段结构（向后兼容）', () => {
    const d = observationIssueDraft('owner/tool', '标题', { finding: 'f', suggestion: 's' });
    expect(d.body).toContain('## 发现的问题');
    expect(d.body).toContain('## 修改建议');
    expect(d.body).toContain('## 验收标准');
    expect(d.body).not.toContain('## 证据摘要');
  });

  it('超长 finding/suggestion 截断后总长仍在正文上限内', () => {
    const long = 'a'.repeat(30_000);
    const d = observationIssueDraft('owner/tool', '标题', { finding: long, suggestion: long }, obs());
    expect(d.body.length).toBeLessThanOrEqual(ISSUE_BODY_LIMIT);
  });
});

describe('observationSections 旧记录兼容映射', () => {
  it('有 sections 直接用', () => {
    expect(observationSections(obs({ sections: { problem: 'p', goal: 'g' } }))).toEqual({ problem: 'p', goal: 'g' });
  });

  it('用户保存过的 review：发现的问题 → 问题是什么，修改建议 → 处理方案；其余留空不生成', () => {
    const s = observationSections(obs({ review: { finding: '实现失败', suggestion: '补充重试' } }));
    expect(s).toEqual({ problem: '实现失败', plan: '补充重试' });
  });

  it('代码采集的报错：detail 不进章节（原文在详情页单独显示），也不套按类型的通用建议', () => {
    expect(observationSections(obs())).toEqual({});
  });

  it('旧 LLM 复盘：按「建议：」拆成问题是什么 / 处理方案', () => {
    const s = observationSections(obs({ kind: 'llm_finding', source: 'llm', detail: '失败后继续启动下一项\n建议：暂停队列' }));
    expect(s).toEqual({ problem: '失败后继续启动下一项', plan: '暂停队列' });
  });
});

describe('cleanSections', () => {
  it('只收五个已知键的非空字符串，超长报错', () => {
    expect(cleanSections({ problem: ' a ', goal: '', x: 'y', plan: 3 })).toEqual({ problem: 'a' });
    expect(cleanSections(null)).toEqual({});
    expect(() => cleanSections({ problem: 'a'.repeat(10_001) })).toThrow(/问题是什么/);
  });
});

describe('Issue 草稿使用问题目录的章节', () => {
  it('没有 review 但有 sections：问题、影响、目标进「发现的问题」，处理方案进「修改建议」，验收标准替换固定文案', () => {
    const o = obs({ kind: 'manual', title: '标题', detail: '', sections: { problem: '门禁转人工', impact: '交付变慢', goal: '计划内文件通过', plan: '理解阶段写入范围', verification: '加一个计划外文件仍被拦' } });
    const d = observationIssueDraft('owner/tool', o.title, observationReview(o), o);
    expect(d.body).toContain('门禁转人工');
    expect(d.body).toContain('影响范围：交付变慢');
    expect(d.body).toContain('要解决什么：计划内文件通过');
    expect(d.body).toContain('理解阶段写入范围');
    expect(d.body).toContain('加一个计划外文件仍被拦');
    expect(d.body).not.toContain('按上述问题场景复验');
  });

  it('用户保存过 review 时仍以 review 为准（原流程不变）', () => {
    const o = obs({ review: { finding: 'F', suggestion: 'S' }, sections: { problem: 'P', plan: 'X' } });
    expect(observationReview(o)).toEqual({ finding: 'F', suggestion: 'S' });
  });
});
