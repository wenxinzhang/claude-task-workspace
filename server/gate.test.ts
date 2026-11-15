import { describe, expect, it } from 'vitest';
import { evaluateGate, gateError, manualChecksText, normalizeReport, sessionProblem, type GateInput, type VerifyReport } from './gate.ts';
import { normalizeSpec, outOfScope, renderSpec, specHash } from './spec.ts';
import type { Criterion, RunEvidence } from './types.ts';

const ev = (toolCalls: number | null, denials = 0, stage: RunEvidence['stage'] = 'implement'): RunEvidence => ({
  stage,
  provider: 'claude',
  toolCalls,
  tools: {},
  denials: Array.from({ length: denials }, () => ({ tool: 'Bash', input: 'git diff' })),
  durationMs: 1000,
  at: 0,
});

const criteria: Criterion[] = [
  { id: 'AC1', text: '类型检查通过', method: 'auto', how: 'npx tsc -b' },
  { id: 'AC2', text: '按钮完整显示在边框内', method: 'manual', how: '部署后打开配置窗口查看' },
];

const report = (items: VerifyReport['items']): VerifyReport => ({ items, summary: '' });
const allPass = report([
  { id: 'AC1', result: 'pass', evidence: 'npx tsc -b 退出码 0' },
  { id: 'AC2', result: 'pass', evidence: '核对了 overview.module.less 第 270 行' },
]);

const input = (over: Partial<GateInput> = {}): GateInput => ({
  criteria,
  scope: ['src/pages'],
  scopePrefix: '',
  changes: { files: ['src/pages/a.tsx'], skipped: [] },
  implement: ev(12),
  mode: 'agent',
  verify: { ok: true, evidence: ev(8, 0, 'verify'), report: allPass },
  ...over,
});

const levels = (i: GateInput, level: string) => evaluateGate(i).reasons.filter((r) => r.level === level).map((r) => r.text);

describe('evaluateGate', () => {
  it('所有验收项都有依据地通过，才判通过', () => {
    const g = evaluateGate(input());
    expect(g.verdict).toBe('pass');
    expect(g.reasons).toEqual([]);
    expect(g.items.map((i) => i.result)).toEqual(['pass', 'pass']);
    expect(g.changedFiles).toEqual(['src/pages/a.tsx']);
  });

  it('实现会话没有调用任何工具：判未通过，不管验证报告怎么写', () => {
    const g = evaluateGate(input({ implement: ev(0), changes: { files: [], skipped: [] } }));
    expect(g.verdict).toBe('fail');
    expect(gateError(g)).toContain('实现会话无效');
    expect(gateError(g)).toContain('没有产生任何代码改动');
  });

  it('没有改动就不能通过', () => {
    expect(evaluateGate(input({ changes: { files: [], skipped: [] } })).verdict).toBe('fail');
  });

  it('工具调用全部被权限拒绝等同于没干活；只被拒绝一部分只记为事实', () => {
    expect(sessionProblem(ev(3, 3))).toContain('全部被权限拒绝');
    expect(evaluateGate(input({ implement: ev(3, 3) })).verdict).toBe('fail');
    const partial = input({ implement: ev(12, 2) });
    expect(evaluateGate(partial).verdict).toBe('pass');
    expect(levels(partial, 'note')).toEqual(['实现会话有 2 次工具调用被权限拒绝']);
  });

  it('验证会话无效、失败或没有结构化结论：都判未通过', () => {
    expect(evaluateGate(input({ verify: { ok: true, evidence: ev(0, 0, 'verify'), report: allPass } })).verdict).toBe('fail');
    expect(evaluateGate(input({ verify: { ok: false, error: '执行超时', evidence: ev(4, 0, 'verify'), report: null } })).verdict).toBe('fail');
    const noReport = evaluateGate(input({ verify: { ok: true, evidence: ev(4, 0, 'verify'), report: null } }));
    expect(noReport.verdict).toBe('fail');
    expect(noReport.items.every((i) => i.result === 'unverified')).toBe(true);
  });

  it('自动验证的验收项没得到验证：仍然进入人工验收', () => {
    const unverifiedAuto = input({
      verify: {
        ok: true,
        evidence: ev(8, 0, 'verify'),
        report: report([
          { id: 'AC1', result: 'unverified', evidence: '命令被拒绝' },
          { id: 'AC2', result: 'unverified', evidence: '需要人工验证' },
        ]),
      },
    });
    expect(evaluateGate(unverifiedAuto).verdict).toBe('unverified');
    expect(levels(unverifiedAuto, 'hold').join()).toContain('AC1');
  });

  it('人工验收项被判未通过：照样判未通过', () => {
    const g = evaluateGate(
      input({
        verify: {
          ok: true,
          evidence: ev(8, 0, 'verify'),
          report: report([
            { id: 'AC1', result: 'pass', evidence: 'tsc 退出码 0' },
            { id: 'AC2', result: 'fail', evidence: '样式里没有换行规则' },
          ]),
        },
      }),
    );
    expect(g.verdict).toBe('fail');
  });

  it('只有人工验收项没验证：不阻断，判通过，清单照样列出怎么验', () => {
    const g = evaluateGate(
      input({
        verify: {
          ok: true,
          evidence: ev(8, 0, 'verify'),
          report: report([
            { id: 'AC1', result: 'pass', evidence: 'tsc 退出码 0' },
            { id: 'AC2', result: 'unverified', evidence: '需要浏览器' },
          ]),
        },
      }),
    );
    expect(g.verdict).toBe('pass');
    expect(g.reasons.filter((r) => r.level === 'hold')).toEqual([]);
    expect(g.reasons.some((r) => r.level === 'note' && r.text.includes('AC2'))).toBe(true);
    const text = manualChecksText(g);
    expect(text).toContain('[AC2] 按钮完整显示在边框内');
    expect(text).toContain('怎么验：部署后打开配置窗口查看');
    expect(text).toContain('未验证原因：需要浏览器');
  });

  it('任一验收项未通过：判未通过', () => {
    const g = evaluateGate(
      input({
        verify: {
          ok: true,
          evidence: ev(8, 0, 'verify'),
          report: report([
            { id: 'AC1', result: 'fail', evidence: 'tsc 报错 TS2322' },
            { id: 'AC2', result: 'pass', evidence: '已核对' },
          ]),
        },
      }),
    );
    expect(g.verdict).toBe('fail');
    expect(gateError(g)).toBe('验收项未通过：AC1');
  });

  it('判通过但没有依据、或报告漏了某一项：按未验证处理', () => {
    const g = evaluateGate(input({ verify: { ok: true, evidence: ev(8, 0, 'verify'), report: report([{ id: 'AC1', result: 'pass', evidence: '' }]) } }));
    expect(g.verdict).toBe('unverified');
    expect(g.items.map((i) => i.evidence)).toEqual(['判为通过但没有给出依据', '验证没有给出这一项的结果']);
  });

  it('改动超出确认的范围、或和执行前的改动混在一起：进入人工验收', () => {
    const outside = evaluateGate(input({ changes: { files: ['src/pages/a.tsx', 'src/api/user.ts'], skipped: [] } }));
    expect(outside.verdict).toBe('unverified');
    expect(outside.outOfScope).toEqual(['src/api/user.ts']);
    expect(levels(input({ changes: { files: ['src/pages/a.tsx'], skipped: ['src/pages/b.tsx'] } }), 'hold')[0]).toContain('src/pages/b.tsx');
  });

  it('验证阶段改了实现的文件：进入人工验收；只留下临时文件：记为事实', () => {
    expect(evaluateGate(input({ verifyTouched: ['src/pages/a.tsx'] })).verdict).toBe('unverified');
    const leftovers = input({ verifyLeftovers: ['_tmp/measure.cjs'] });
    expect(evaluateGate(leftovers).verdict).toBe('pass');
    expect(levels(leftovers, 'note')[0]).toContain('_tmp/measure.cjs');
  });

  it('测试命令：非 0 或超时判未通过；只跑命令时人工验证的项留作核对清单，不阻断', () => {
    expect(gateError(evaluateGate(input({ verify: undefined, mode: 'command', testCommand: { exitCode: 1 } })))).toBe('测试命令退出码 1');
    expect(evaluateGate(input({ verify: undefined, mode: 'command', testCommand: { exitCode: null } })).verdict).toBe('fail');
    const g = evaluateGate(input({ verify: undefined, mode: 'command', testCommand: { exitCode: 0 } }));
    expect(g.verdict).toBe('pass');
    expect(g.items.map((i) => i.result)).toEqual(['pass', 'unverified']);
    expect(evaluateGate(input({ verify: undefined, mode: 'command', testCommand: { exitCode: 0 }, criteria: [criteria[0]] })).verdict).toBe('pass');
  });

  it('无法核对的情况如实标注：不是 git 仓库进入人工验收，不提供事件流的代理不判失败', () => {
    const noGit = evaluateGate(input({ changes: null }));
    expect(noGit.verdict).toBe('unverified');
    expect(noGit.changedFiles).toBeNull();
    const blind = input({ implement: { ...ev(null), provider: 'custom' } });
    expect(sessionProblem(blind.implement)).toBeNull();
    expect(evaluateGate(blind).verdict).toBe('pass');
    expect(levels(blind, 'note')[0]).toContain('不提供事件流');
  });
});

describe('normalizeReport', () => {
  it('编号统一大写，丢弃取值不合法的项', () => {
    const r = normalizeReport({ items: [{ id: ' ac1 ', result: 'pass', evidence: ' ok ' }, { id: 'AC2', result: 'maybe' }, { result: 'pass' }], summary: ' s ' });
    expect(r).toEqual({ items: [{ id: 'AC1', result: 'pass', evidence: 'ok' }], summary: 's' });
    expect(normalizeReport('VERDICT: PASS')).toBeNull();
    expect(normalizeReport({ summary: '没有 items' })).toBeNull();
  });
});

describe('规格', () => {
  const raw = {
    goal: ' 恢复默认按钮不超出边框 ',
    rootCause: 'footer 没有换行',
    scope: ['.\\src\\pages\\Runtime\\', 'src/styles/**', '', 'src/styles'],
    steps: ['改 less'],
    criteria: [
      { text: '类型检查通过', method: 'auto', how: 'npx tsc -b' },
      { text: '  ', method: 'auto', how: '' },
      { text: '按钮在边框内', method: 'manual', how: '打开配置窗口' },
    ],
    risks: [],
  };

  it('normalizeSpec：去空项、统一路径写法、验收项由系统编号', () => {
    const spec = normalizeSpec(raw)!;
    expect(spec.goal).toBe('恢复默认按钮不超出边框');
    expect(spec.scope).toEqual(['src/pages/Runtime', 'src/styles']);
    expect(spec.criteria.map((c) => [c.id, c.method])).toEqual([
      ['AC1', 'auto'],
      ['AC2', 'manual'],
    ]);
  });

  it('normalizeSpec：可限定验收项上限，超出的丢弃；不限定时保留全部', () => {
    const many = { ...raw, criteria: Array.from({ length: 12 }, (_, i) => ({ text: `第 ${i + 1} 项`, method: 'auto', how: '' })) };
    expect(normalizeSpec(many, { maxCriteria: 8 })!.criteria.map((c) => c.id)).toEqual(['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7', 'AC8']);
    expect(normalizeSpec(many)!.criteria).toHaveLength(12);
  });

  it('没有目标或没有验收项的规格不可用', () => {
    expect(normalizeSpec({ ...raw, goal: '' })).toBeNull();
    expect(normalizeSpec({ ...raw, criteria: [] })).toBeNull();
    expect(normalizeSpec('一段文字')).toBeNull();
  });

  it('renderSpec 带编号和验证方式；specHash 随内容变化', () => {
    const spec = normalizeSpec(raw)!;
    const text = renderSpec(spec);
    expect(text).toContain('- [AC1]（自动验证）类型检查通过\n  验证方式：npx tsc -b');
    expect(text).toContain('- [AC2]（人工验证）按钮在边框内');
    expect(specHash(spec)).toBe(specHash(normalizeSpec(raw)!));
    expect(specHash({ ...spec, goal: '改了' })).not.toBe(specHash(spec));
  });

  it('outOfScope：按目录前缀匹配，不做名称的部分匹配；范围相对代码目录或仓库根目录都认', () => {
    expect(outOfScope(['src/pages/a.tsx', 'src/pages2/b.tsx', 'README.md'], ['src/pages'])).toEqual(['src/pages2/b.tsx', 'README.md']);
    expect(outOfScope(['src/a.ts'], ['src/a.ts'])).toEqual([]);
    expect(outOfScope(['web/src/pages/a.tsx', 'server/x.ts'], ['src/pages'], 'web')).toEqual(['server/x.ts']);
    expect(outOfScope(['web/src/pages/a.tsx'], ['web/src/pages'], 'web')).toEqual([]);
    expect(outOfScope(['anything.ts'], [])).toEqual([]);
  });
});

describe('验收项全是人工验证', () => {
  const manualOnly: Criterion[] = [{ id: 'AC1', text: '按钮完整显示在边框内', method: 'manual', how: '部署后打开配置窗口查看' }];

  it('没有任何一项得到自动验证：不放行，交人工', () => {
    const g = evaluateGate(input({ criteria: manualOnly, verify: { ok: true, evidence: ev(8, 0, 'verify'), report: report([{ id: 'AC1', result: 'unverified', evidence: '需要人工验证' }]) } }));
    expect(g.verdict).toBe('unverified');
    expect(g.reasons.some((r) => r.level === 'hold' && r.text.includes('全部是人工验证'))).toBe(true);
  });

  it('只要有一条自动验证项通过，人工项仍不阻断', () => {
    const g = evaluateGate(input({ verify: { ok: true, evidence: ev(8, 0, 'verify'), report: report([{ id: 'AC1', result: 'pass', evidence: 'tsc 退出码 0' }, { id: 'AC2', result: 'unverified', evidence: '需要人工验证' }]) } }));
    expect(g.verdict).toBe('pass');
  });
});
