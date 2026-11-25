import { outOfScope } from './spec.ts';
import type { Criterion, CriterionResult, GateReason, GateResult, ItemResult, RunEvidence } from './types.ts';

/** 验证阶段的结构化输出：按验收项编号逐项给结果和依据 */
export const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'summary'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'result', 'evidence'],
        properties: {
          id: { type: 'string' },
          result: { type: 'string', enum: ['pass', 'fail', 'unverified'] },
          evidence: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
} as const;

export interface VerifyReport {
  items: { id: string; result: ItemResult; evidence: string }[];
  summary: string;
}

export function normalizeReport(raw: unknown): VerifyReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) return null;
  const items = r.items.flatMap((x) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim().toUpperCase() : '';
    if (!id || (o.result !== 'pass' && o.result !== 'fail' && o.result !== 'unverified')) return [];
    return [{ id, result: o.result as ItemResult, evidence: typeof o.evidence === 'string' ? o.evidence.trim().slice(0, 2000) : '' }];
  });
  return { items, summary: typeof r.summary === 'string' ? r.summary.trim() : '' };
}

/** 没有规格的任务（旧数据、手写理解）用这一条验收项兜住整体结论 */
export const FALLBACK_CRITERIA: Criterion[] = [
  { id: 'AC1', text: '实现符合任务描述与已确认的任务理解', method: 'auto', how: '阅读本次改动与相关代码，运行项目已有的构建、类型检查或测试' },
];

/**
 * 一次会话是否根本没有干活。toolCalls 为 null 表示该代理不提供事件流，无从判断。
 * 返回原因；会话有效时返回 null。
 */
export function sessionProblem(e: RunEvidence): string | null {
  if (e.toolCalls === null) return null;
  if (e.toolCalls === 0) return '没有调用任何工具（没有读文件，也没有执行命令）';
  if (e.denials.length >= e.toolCalls) return `${e.toolCalls} 次工具调用全部被权限拒绝`;
  return null;
}

/**
 * 实现会话正常结束却一个工具都没调用：多半是模型误判了任务缺失（例如被上下文里的截断标记误导），
 * 值得用同一份规格自动重试一次。toolCalls 为 null 表示代理不提供事件流，无从判断，不重试
 */
export function shouldRetryNoAction(impl: { ok: boolean; evidence: { toolCalls: number | null } }): boolean {
  return impl.ok && impl.evidence.toolCalls === 0;
}

export interface GateInput {
  criteria: Criterion[];
  scope: string[];
  /** 代码目录在 git 仓库中的相对路径，范围条目两种写法都认 */
  scopePrefix: string;
  /** 实现阶段的改动；null 表示无法核对（不是 git 仓库或计算失败） */
  changes: { files: string[]; skipped: string[] } | null;
  /** 验证阶段新出现的改动文件（不会被自动提交） */
  verifyLeftovers?: string[];
  /** 验证阶段又改动过的实现文件：验证结论对应的已不是实现阶段的代码 */
  verifyTouched?: string[];
  implement: RunEvidence;
  mode: 'agent' | 'command';
  /** 配置了测试命令且已运行时提供 */
  testCommand?: { exitCode: number | null };
  /** 进行了代理验证时提供 */
  verify?: { ok: boolean; error?: string; evidence: RunEvidence; report: VerifyReport | null };
}

const list = (files: string[], max = 8) => `${files.slice(0, max).join('、')}${files.length > max ? ` 等 ${files.length} 个` : ''}`;

/**
 * 证据门禁：任务的结论只由事实决定——改动、退出码、事件流里的工具调用、逐项验收结果。
 * 代理写的总结和它自己给的总体结论不参与判定。
 */
export function evaluateGate(input: GateInput, now = Date.now()): GateResult {
  const reasons: GateReason[] = [];
  const fail = (text: string) => reasons.push({ level: 'fail', text });
  const hold = (text: string) => reasons.push({ level: 'hold', text });
  const note = (text: string) => reasons.push({ level: 'note', text });

  // ---- 实现阶段 ----
  const implProblem = sessionProblem(input.implement);
  if (implProblem) fail(`实现会话无效：${implProblem}`);
  else if (input.implement.toolCalls === null) note('该代理不提供事件流，无法核对它实际做了哪些操作');

  const { changes } = input;
  let outside: string[] = [];
  if (!changes) {
    hold('无法核对本任务的改动（代码目录不是 git 仓库，或改动计算失败）');
  } else if (!changes.files.length && !changes.skipped.length) {
    fail('实现阶段没有产生任何代码改动');
  } else {
    if (changes.skipped.length) hold(`这些文件执行前就有未提交的改动，分不清哪些是本任务改的：${list(changes.skipped)}`);
    outside = outOfScope(changes.files, input.scope, input.scopePrefix);
    if (outside.length) hold(`改动超出了确认的范围：${list(outside)}`);
  }
  // 权限拒绝只作为事实展示，不单独拦截：被拒一两条无关命令很常见，拦了就是误拦
  if (!implProblem && input.implement.denials.length) note(`实现会话有 ${input.implement.denials.length} 次工具调用被权限拒绝`);

  // ---- 测试命令 ----
  const test = input.testCommand;
  if (test && test.exitCode !== 0) fail(test.exitCode === null ? '测试命令超时或被停止' : `测试命令退出码 ${test.exitCode}`);

  // ---- 逐项验收 ----
  const unverifiedAll = (evidence: string): CriterionResult[] => input.criteria.map((c) => ({ ...c, result: 'unverified', evidence }));
  let items: CriterionResult[];
  const v = input.verify;
  if (v) {
    const problem = v.ok ? sessionProblem(v.evidence) : null;
    if (!v.ok) {
      fail(`验证会话失败：${v.error || '未知错误'}`);
      items = unverifiedAll('验证会话失败');
    } else if (problem) {
      fail(`验证会话无效：${problem}`);
      items = unverifiedAll('验证会话无效');
    } else if (!v.report) {
      fail('验证没有给出结构化结论');
      items = unverifiedAll('验证没有给出结论');
    } else {
      const byId = new Map(v.report.items.map((i) => [i.id, i]));
      items = input.criteria.map((c) => {
        const r = byId.get(c.id.toUpperCase());
        if (!r) return { ...c, result: 'unverified' as const, evidence: '验证没有给出这一项的结果' };
        // 判通过必须有依据，否则只是一句断言
        if (r.result === 'pass' && !r.evidence) return { ...c, result: 'unverified' as const, evidence: '判为通过但没有给出依据' };
        return { ...c, result: r.result, evidence: r.evidence };
      });
      if (v.evidence.denials.length) note(`验证会话有 ${v.evidence.denials.length} 次工具调用被权限拒绝`);
    }
  } else if (input.mode === 'command' && test) {
    items =
      test.exitCode === 0
        ? input.criteria.map((c) =>
            c.method === 'auto'
              ? { ...c, result: 'pass' as const, evidence: '测试命令退出码 0（按配置只运行测试命令，未逐项核对）' }
              : { ...c, result: 'unverified' as const, evidence: '需要人工确认' },
          )
        : unverifiedAll('测试命令未通过');
  } else {
    items = unverifiedAll('未进行验证');
  }

  const failed = items.filter((i) => i.result === 'fail');
  const pending = items.filter((i) => i.result === 'unverified');
  // 人工验证的项本来就不能在本机验：留作部署后的核对清单，不阻断；该自动验证却没验到的才转人工
  const pendingAuto = pending.filter((i) => i.method !== 'manual');
  const pendingManual = pending.filter((i) => i.method === 'manual');
  if (failed.length) fail(`验收项未通过：${failed.map((i) => i.id).join('、')}`);
  if (pendingAuto.length) {
    // 按原因分组转人工：体检里的转人工原因分布才能分清是验证模型漏报、没给依据，还是验收项本身在本机不可验
    const groups = new Map<string, string[]>();
    for (const i of pendingAuto) {
      const ev = i.evidence ?? '';
      const cause =
        ev === '验证没有给出这一项的结果'
          ? '验证漏报'
          : ev === '判为通过但没有给出依据'
            ? '判通过但无依据'
            : ev.startsWith('本机不可验')
              ? '本机不可验，标为自动验证但需部署或浏览器'
              : '验证未能完成';
      groups.set(cause, [...(groups.get(cause) ?? []), i.id]);
    }
    for (const [cause, ids] of groups) hold(`${ids.length} 个验收项没有得到自动验证（${cause}）：${ids.join('、')}`);
  }
  if (pendingManual.length) note(`${pendingManual.length} 个人工验收项留待部署后核对：${pendingManual.map((i) => i.id).join('、')}`);
  // 一条自动验证的验收项都没有：放行就等于什么都没验，交人工看一眼
  if (items.length && !reasons.some((r) => r.level === 'fail') && !items.some((i) => i.method !== 'manual')) hold('验收项全部是人工验证，没有自动验证的项');
  if (input.verifyTouched?.length) hold(`验证阶段改动了实现的文件：${list(input.verifyTouched)}`);
  if (input.verifyLeftovers?.length) note(`验证阶段新产生了文件，未纳入提交：${list(input.verifyLeftovers)}`);

  const verdict: ItemResult = reasons.some((r) => r.level === 'fail') ? 'fail' : reasons.some((r) => r.level === 'hold') ? 'unverified' : 'pass';
  return {
    verdict,
    reasons,
    items,
    outOfScope: outside,
    changedFiles: changes ? [...changes.files, ...changes.skipped] : null,
    testCommand: test,
    at: now,
  };
}

/** 需要人工确认的事项：门禁里所有「待人工」的理由和未验证的验收项 */
export function manualChecksText(gate: GateResult): string {
  const lines = [
    ...gate.reasons.filter((r) => r.level === 'hold').map((r) => `- ${r.text}`),
    ...gate.items
      .filter((i) => i.result === 'unverified')
      .map((i) => `- [${i.id}] ${i.text}${i.how ? `\n  怎么验：${i.how}` : ''}${i.evidence ? `\n  未验证原因：${i.evidence}` : ''}`),
  ];
  return lines.join('\n');
}

/** 写在任务上的一句话原因 */
export function gateError(gate: GateResult): string {
  return gate.reasons
    .filter((r) => r.level === 'fail')
    .map((r) => r.text)
    .join('；');
}
