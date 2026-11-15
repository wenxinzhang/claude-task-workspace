import { createHash } from 'node:crypto';
import type { Criterion, Spec } from './types.ts';

const strings = { type: 'array', items: { type: 'string' } } as const;

/** 理解阶段的结构化输出。所有对象都关闭额外属性、字段全部必填，Claude 与 Codex 的严格模式都接受 */
export const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'rootCause', 'scope', 'steps', 'criteria', 'questions', 'risks'],
  properties: {
    goal: { type: 'string' },
    rootCause: { type: 'string' },
    scope: strings,
    steps: strings,
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'method', 'how'],
        properties: {
          text: { type: 'string' },
          method: { type: 'string', enum: ['auto', 'manual'] },
          how: { type: 'string' },
        },
      },
    },
    questions: strings,
    risks: strings,
  },
} as const;

const text = (v: unknown, max = 4000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown, max = 50) => (Array.isArray(v) ? v.map((x) => text(x, 1000)).filter(Boolean).slice(0, max) : []);

/** 范围条目统一成正斜杠、去掉 ./ 前缀和末尾的 /、/*、/** */
export function normalizeScopeEntry(entry: string): string {
  return entry
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/\*{1,2}$/, '')
    .replace(/\/+$/, '');
}

/**
 * 校验并规整规格：去空项、统一路径写法、验收项由系统重新编号。
 * 没有目标或没有任何验收项时返回 null——这样的规格无法用来验证。
 * maxCriteria：验收项上限，超出的丢弃。代理生成的规格收紧到 8 条（验收项越多验证越慢）；使用者手工保存的不传，沿用 30。
 */
export function normalizeSpec(raw: unknown, opts: { maxCriteria?: number } = {}): Spec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const goal = text(r.goal);
  const criteria: Criterion[] = (Array.isArray(r.criteria) ? r.criteria : [])
    .map((c) => {
      const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      return { text: text(o.text, 1000), method: o.method === 'manual' ? ('manual' as const) : ('auto' as const), how: text(o.how, 1000) };
    })
    .filter((c) => c.text)
    .slice(0, opts.maxCriteria ?? 30)
    .map((c, i) => ({ id: `AC${i + 1}`, ...c }));
  if (!goal || !criteria.length) return null;
  return {
    goal,
    rootCause: text(r.rootCause),
    scope: [...new Set(list(r.scope).map(normalizeScopeEntry).filter(Boolean))],
    steps: list(r.steps),
    criteria,
    risks: list(r.risks),
    // 代理给的是问句；页面保存时带上使用者的回答
    questions: (Array.isArray(r.questions) ? r.questions : [])
      .map((q) => {
        const o = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>;
        return typeof q === 'string' ? { text: text(q, 1000), answer: '' } : { text: text(o.text, 1000), answer: text(o.answer, 2000) };
      })
      .filter((q) => q.text)
      .slice(0, 10),
  };
}

const bullets = (items: string[], empty = '无') => (items.length ? items.map((s) => `- ${s}`).join('\n') : empty);

/** 验收项列表，实现与验证提示词共用 */
export function renderCriteria(criteria: Criterion[]): string {
  return criteria
    .map((c) => `- [${c.id}]（${c.method === 'auto' ? '自动验证' : '人工验证'}）${c.text}${c.how ? `\n  验证方式：${c.how}` : ''}`)
    .join('\n');
}

/** 规格的文本形式：写进提示词，也作为任务的 analysis 保存 */
export function renderSpec(spec: Spec): string {
  return [
    `## 目标\n${spec.goal}`,
    `## 根因\n${spec.rootCause || '（未给出）'}`,
    `## 改动范围\n${bullets(spec.scope, '（未限定）')}`,
    `## 实现步骤\n${spec.steps.length ? spec.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : '（未给出）'}`,
    `## 验收项\n${renderCriteria(spec.criteria)}`,
    ...(spec.questions?.length ? [`## 已确认的问题\n${spec.questions.map((q) => `- 问：${q.text}\n  答：${q.answer || '（未回答）'}`).join('\n')}`] : []),
    `## 风险与疑问\n${bullets(spec.risks)}`,
  ].join('\n\n');
}

/** 规格内容的短哈希：记录确认的是哪一版 */
export function specHash(spec: Spec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 12);
}

/**
 * 找出不在确认范围内的改动文件。
 * files 相对 git 仓库根目录；范围条目可能相对仓库根目录，也可能相对代码目录（prefix 是代码目录在仓库中的相对路径），两种都认。
 * 范围为空表示未限定，返回空数组。
 */
export function outOfScope(files: string[], scope: string[], prefix = ''): string[] {
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const base = normalizeScopeEntry(prefix);
  const entries = scope
    .map(normalizeScopeEntry)
    .filter(Boolean)
    .flatMap((e) => (base ? [e, `${base}/${e}`] : [e]))
    .map(fold);
  if (!entries.length) return [];
  return files.filter((f) => {
    const file = fold(f.replace(/\\/g, '/'));
    return !entries.some((e) => file === e || file.startsWith(`${e}/`));
  });
}
