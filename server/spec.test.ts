import { describe, expect, it } from 'vitest';
import { normalizeSpec } from './spec.ts';

describe('normalizeSpec 问题的建议回答', () => {
  const base = { goal: 'g', rootCause: 'r', scope: [], steps: [], risks: [], criteria: [{ text: 'x', method: 'auto', how: '' }] };
  it('代理生成时用建议作回答初稿，并保留建议', () => {
    const s = normalizeSpec({ ...base, questions: [{ text: '只统计当前树吗？', suggestion: '只统计当前树' }] });
    expect(s?.questions).toEqual([{ text: '只统计当前树吗？', answer: '只统计当前树', suggestion: '只统计当前树' }]);
  });
  it('页面保存时以使用者的回答为准，清空也保留为空', () => {
    const s = normalizeSpec({ ...base, questions: [{ text: 'q', answer: '', suggestion: 'a' }, { text: 'q2', answer: '改过', suggestion: 'b' }] });
    expect(s?.questions?.map((q) => q.answer)).toEqual(['', '改过']);
  });
  it('旧格式的纯问句没有初稿', () => {
    expect(normalizeSpec({ ...base, questions: ['q'] })?.questions).toEqual([{ text: 'q', answer: '' }]);
  });
});
