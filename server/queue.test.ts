import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRequest, AgentResult } from './agent.ts';
import { git } from './git.ts';
import { Queue } from './queue.ts';
import { normalizeSpec, renderSpec } from './spec.ts';
import { Store } from './store.ts';
import type { RunEvidence, Spec } from './types.ts';

const evidence = (stage: RunEvidence['stage'], toolCalls: number, denied = 0): RunEvidence => ({
  stage,
  provider: 'claude',
  toolCalls,
  tools: {},
  denials: Array.from({ length: denied }, () => ({ tool: 'Bash', input: 'git diff' })),
  durationMs: 10,
  at: Date.now(),
});

type Handler = (req: AgentRequest) => AgentResult | Promise<AgentResult>;
type Script = Partial<Record<AgentRequest['stage'], Handler>>;

/** 自检的默认应答：真的去读提示词里指定的文件 */
const preflightOk: Handler = (req) => {
  const file = /读取文件 (.+?) ，/.exec(req.prompt)![1];
  const commands = [...req.prompt.matchAll(/- 执行命令：(.+)/g)].map((m) => ({ command: m[1].trim(), output: 'v22.22.1' }));
  return { ok: true, text: '', structured: { fileContent: fs.readFileSync(file, 'utf8'), commands }, evidence: evidence('preflight', 2) };
};

const spec: Spec = normalizeSpec({
  goal: '按钮不超出边框',
  rootCause: 'footer 没有换行',
  scope: ['src'],
  steps: ['改样式'],
  criteria: [
    { text: '类型检查通过', method: 'auto', how: 'npx tsc -b' },
    { text: '按钮在边框内', method: 'manual', how: '部署后打开配置窗口' },
  ],
  risks: [],
})!;

const cleanups: (() => void)[] = [];
afterEach(async () => {
  // 等 Store 的延迟落盘结束再删目录
  await new Promise((r) => setTimeout(r, 400));
  for (const fn of cleanups.splice(0)) fn();
});

async function setup(script: Script, opts: { repo?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-queue-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const workdir = path.join(root, 'work');
  fs.mkdirSync(path.join(workdir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workdir, 'src', 'a.ts'), 'export const a = 1;\n');
  if (opts.repo !== false) {
    await git(['init', '-q'], workdir);
    await git(['config', 'user.name', 'test'], workdir);
    await git(['config', 'user.email', 'test@example.com'], workdir);
    await git(['config', 'commit.gpgsign', 'false'], workdir);
    await git(['add', '-A'], workdir);
    await git(['commit', '-q', '-m', 'init'], workdir);
  }

  const store = new Store(path.join(root, 'data'));
  // 关掉项目知识：否则会在用户目录下创建记忆目录
  const project = store.createProject({ name: 'p', workdir, exec: { useKnowledge: false } });
  const calls: AgentRequest['stage'][] = [];
  const queue = new Queue(store, undefined, async (req) => {
    calls.push(req.stage);
    const handler = script[req.stage] ?? (req.stage === 'preflight' ? preflightOk : undefined);
    if (!handler) throw new Error(`测试没有为 ${req.stage} 阶段提供应答`);
    return handler(req);
  });
  const done: string[] = [];
  queue.on('done', (id: string) => done.push(id));

  const addTodo = (withSpec = true) => {
    const t = store.create({ projectId: project.id, title: '恢复默认按钮超出边框', description: '', source: 'manual' });
    if (withSpec) store.update(t.id, { spec, analysis: renderSpec(spec) });
    store.setStatus(t.id, 'todo');
    return t.id;
  };
  const settled = async (id: string) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const s = store.get(id)!.status;
      if (!queue.isBusy(project.id) && s !== 'todo' && s !== 'in_progress' && s !== 'testing') return store.get(id)!;
      if (Date.now() > deadline) throw new Error(`任务没有在限定时间内结束，当前状态 ${s}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { store, queue, project, workdir, calls, done, addTodo, settled };
}

const edit = (workdir: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(workdir, file)), { recursive: true });
  fs.writeFileSync(path.join(workdir, file), content);
};

const report = (items: [string, 'pass' | 'fail' | 'unverified', string][]): Handler => () => ({
  ok: true,
  text: '',
  structured: { items: items.map(([id, result, ev]) => ({ id, result, evidence: ev })), summary: '' },
  evidence: evidence('verify', 6),
});

describe('Queue 执行流程', () => {
  it('实现有改动、验收项全部有依据地通过：已完成，只提交实现阶段的文件', async () => {
    const ctx = await setup({
      implement: (req) => {
        edit(req.cwd, 'src/a.ts', 'export const a = 2;\n');
        return { ok: true, text: '改了 src/a.ts', evidence: evidence('implement', 5) };
      },
      verify: (req) => {
        // 验证阶段留下的临时脚本不应进入提交
        edit(req.cwd, '_tmp/measure.cjs', 'console.log(1)\n');
        return report([
          ['AC1', 'pass', 'npx tsc -b 退出码 0'],
          ['AC2', 'pass', '核对了样式文件'],
        ])(req);
      },
    });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);

    expect(t.status).toBe('done');
    expect(t.gate).toMatchObject({ verdict: 'pass', changedFiles: ['src/a.ts'] });
    expect(t.gate!.reasons.map((r) => r.level)).toEqual(['note']);
    expect(t.commit?.files).toEqual(['src/a.ts']);
    expect((await git(['show', '--name-only', '--format=', 'HEAD'], ctx.workdir)).trim()).toBe('src/a.ts');
    expect(t.evidence?.implement?.toolCalls).toBe(5);
    expect(ctx.calls).toEqual(['preflight', 'implement', 'verify']);
    expect(ctx.done).toEqual([id]);
  }, 40_000);

  it('代理没有调用任何工具、没有改动，却自称完成：判异常，不进入验证，不提交', async () => {
    const ctx = await setup({ implement: () => ({ ok: true, text: '已按要求完成修复，类型检查通过。', evidence: evidence('implement', 0) }) });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);

    expect(t.status).toBe('blocked');
    expect(t.error).toContain('实现会话无效');
    expect(t.error).toContain('没有产生任何代码改动');
    expect(t.commit).toBeUndefined();
    // 第一次没调用工具会自动重试一次，重试仍然没干活才判异常
    expect(ctx.calls).toEqual(['preflight', 'implement', 'implement']);
    expect(ctx.done).toEqual([]);
  }, 40_000);

  it('实现会话没调用任何工具：带着重试说明用同一份规格重试一次，重试干了活就照常验证', async () => {
    const prompts: string[] = [];
    const ctx = await setup({
      implement: (req) => {
        prompts.push(req.prompt);
        if (prompts.length === 1) return { ok: true, text: '消息里没有具体任务，请重发', evidence: evidence('implement', 0) };
        edit(req.cwd, 'src/a.ts', 'export const a = 2;\n');
        return { ok: true, text: '改好了', evidence: evidence('implement', 4) };
      },
      verify: report([
        ['AC1', 'pass', 'tsc 退出码 0'],
        ['AC2', 'unverified', '需要浏览器'],
      ]),
    });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);

    expect(ctx.calls).toEqual(['preflight', 'implement', 'implement', 'verify']);
    expect(prompts[0]).not.toContain('【重试说明】');
    expect(prompts[1].startsWith('【重试说明】')).toBe(true);
    expect(prompts[1]).toContain('恢复默认按钮超出边框');
    expect(t.evidence?.implement?.toolCalls).toBe(4);
    expect(t.status).not.toBe('blocked');
  }, 40_000);

  it('实现会话读了代码却没改文件就结束：接续同一会话让它接着改，改完照常验证', async () => {
    const reqs: AgentRequest[] = [];
    const ctx = await setup({
      implement: (req) => {
        reqs.push(req);
        if (reqs.length === 1) return { ok: true, text: '根因已确认，下一步在 a.ts 里改', evidence: { ...evidence('implement', 5), sessionId: 's-1' } };
        edit(req.cwd, 'src/a.ts', 'export const a = 2;\n');
        return { ok: true, text: '改好了', evidence: { ...evidence('implement', 2), sessionId: 's-1' } };
      },
      verify: report([
        ['AC1', 'pass', 'tsc 退出码 0'],
        ['AC2', 'unverified', '需要浏览器'],
      ]),
    });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);

    expect(ctx.calls).toEqual(['preflight', 'implement', 'implement', 'verify']);
    expect(reqs[0].resume).toBeUndefined();
    expect(reqs[1].resume).toBe('s-1');
    expect(reqs[1].prompt).toContain('还没有修改任何文件');
    expect(t.status).not.toBe('blocked');
  }, 40_000);

  it('实现会话读了代码、没改文件，接续后仍没改：只接续一次，交由门禁判定', async () => {
    const ctx = await setup({
      implement: () => ({ ok: true, text: '这个任务不需要改代码', evidence: { ...evidence('implement', 3), sessionId: 's-2' } }),
    });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);

    expect(ctx.calls).toEqual(['preflight', 'implement', 'implement']);
    expect(t.status).toBe('blocked');
    expect(t.error).toContain('没有产生任何代码改动');
  }, 40_000);

  it('接续那轮没调用工具就回答：保留第一次的记录，按「没有改动」判定而不是「没有调用工具」', async () => {
    const reqs: AgentRequest[] = [];
    const ctx = await setup({
      implement: (req) => {
        reqs.push(req);
        if (reqs.length === 1) return { ok: true, text: '下一步在 a.ts 里改', evidence: { ...evidence('implement', 4), sessionId: 's-3' } };
        return { ok: true, text: '确认不需要改代码', evidence: { ...evidence('implement', 0), sessionId: 's-3' } };
      },
    });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);

    expect(ctx.calls).toEqual(['preflight', 'implement', 'implement']);
    expect(reqs[1].resume).toBe('s-3');
    expect(reqs[1].prompt).toContain('还没有修改任何文件');
    expect(t.evidence?.implement?.toolCalls).toBe(4);
    expect(t.status).toBe('blocked');
    expect(t.error).toContain('没有产生任何代码改动');
  }, 40_000);

  it('没有会话号时不接续', async () => {
    const ctx = await setup({
      implement: () => ({ ok: true, text: '下一步在 a.ts 里改', evidence: evidence('implement', 3) }),
    });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);

    expect(ctx.calls).toEqual(['preflight', 'implement']);
    expect(t.status).toBe('blocked');
  }, 40_000);

  it('有验收项没得到自动验证、改动超出范围：进入待验收并列出要人工确认的事项', async () => {
    const ctx = await setup({
      implement: (req) => {
        edit(req.cwd, 'src/a.ts', 'export const a = 2;\n');
        edit(req.cwd, 'config/app.json', '{}\n');
        return { ok: true, text: '改好了', evidence: evidence('implement', 5) };
      },
      verify: report([
        ['AC1', 'pass', 'tsc 退出码 0'],
        ['AC2', 'unverified', '需要浏览器'],
      ]),
    });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);

    expect(t.status).toBe('review');
    expect(t.gate).toMatchObject({ verdict: 'unverified', outOfScope: ['config/app.json'] });
    expect(t.manualChecks).toContain('改动超出了确认的范围：config/app.json');
    expect(t.manualChecks).toContain('[AC2] 按钮在边框内');
    expect(t.commit?.files.sort()).toEqual(['config/app.json', 'src/a.ts']);
    expect(ctx.done).toEqual([]);
  }, 40_000);

  it('开了「待人工确认也直接通过」：同样的情况不进待验收，直接已通过，人工确认事项仍记在任务上', async () => {
    const ctx = await setup({
      implement: (req) => {
        edit(req.cwd, 'src/a.ts', 'export const a = 2;\n');
        edit(req.cwd, 'config/app.json', '{}\n');
        return { ok: true, text: '改好了', evidence: evidence('implement', 5) };
      },
      verify: report([
        ['AC1', 'pass', 'tsc 退出码 0'],
        ['AC2', 'unverified', '需要浏览器'],
      ]),
    });
    ctx.store.updateProject(ctx.project.id, { exec: { skipReview: true } });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);

    expect(t.status).toBe('done');
    expect(t.gate).toMatchObject({ verdict: 'unverified' });
    expect(t.manualChecks).toContain('改动超出了确认的范围：config/app.json');
    expect(ctx.done).toEqual([id]);
  }, 40_000);

  it('开了「待人工确认也直接通过」：门禁判失败的任务照旧进异常', async () => {
    const ctx = await setup({ implement: () => ({ ok: true, text: '已完成', evidence: evidence('implement', 0) }) });
    ctx.store.updateProject(ctx.project.id, { exec: { skipReview: true } });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);

    expect(t.status).toBe('blocked');
    expect(ctx.done).toEqual([]);
  }, 40_000);

  it('测试命令失败：判异常，不再让代理验证', async () => {
    const ctx = await setup({
      implement: (req) => {
        edit(req.cwd, 'src/a.ts', 'export const a = 2;\n');
        return { ok: true, text: '改好了', evidence: evidence('implement', 5) };
      },
    });
    ctx.store.updateProject(ctx.project.id, { exec: { testCommand: 'exit 3' } });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);

    expect(t.status).toBe('blocked');
    expect(t.error).toBe('测试命令退出码 3');
    expect(t.gate?.testCommand).toEqual({ exitCode: 3 });
    expect(ctx.calls).toEqual(['preflight', 'implement']);
  }, 40_000);

  it('没有规格的旧任务：用一条整体验收项验证', async () => {
    const ctx = await setup({
      implement: (req) => {
        edit(req.cwd, 'README.md', 'x\n');
        return { ok: true, text: '改好了', evidence: evidence('implement', 3) };
      },
      verify: report([['AC1', 'pass', '读了改动并运行了构建']]),
    });
    const id = ctx.addTodo(false);
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);
    expect(t.status).toBe('done');
    expect(t.gate?.items).toHaveLength(1);
  }, 40_000);

  it('代码目录不是 git 仓库：无法核对改动，进入待验收，自检给出提示', async () => {
    const ctx = await setup(
      {
        implement: (req) => {
          edit(req.cwd, 'src/a.ts', 'export const a = 2;\n');
          return { ok: true, text: '改好了', evidence: evidence('implement', 3) };
        },
        verify: report([
          ['AC1', 'pass', 'tsc 退出码 0'],
          ['AC2', 'pass', '已核对'],
        ]),
      },
      { repo: false },
    );
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);
    expect(t.status).toBe('review');
    expect(t.gate?.changedFiles).toBeNull();
    expect(ctx.queue.status(ctx.project.id).preflight?.notes.join()).toContain('不是 git 仓库');
  }, 40_000);
});

describe('开工前自检', () => {
  it('代理读不了文件：队列停下，任务留在待办，不消耗任何任务', async () => {
    const ctx = await setup({ preflight: () => ({ ok: true, text: '当前会话没有可用的 Read 工具', evidence: evidence('preflight', 0) }) });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);

    const deadline = Date.now() + 15_000;
    while (ctx.queue.status(ctx.project.id).preflight?.state !== 'failed') {
      if (Date.now() > deadline) throw new Error('自检没有在限定时间内结束');
      await new Promise((r) => setTimeout(r, 20));
    }
    const status = ctx.queue.status(ctx.project.id);
    expect(status.running).toBe(false);
    expect(status.preflight!.problems[0]).toContain('没有调用任何工具');
    expect(ctx.store.get(id)!.status).toBe('todo');
    expect(ctx.calls).toEqual(['preflight']);
  }, 40_000);

  it('能读文件但命令被拒绝：不拦队列，只提示验证会受影响', async () => {
    const ctx = await setup({
      preflight: (req) => {
        const ok = preflightOk(req) as AgentResult;
        return { ...ok, structured: { ...(ok.structured as object), commands: [{ command: 'node --version', output: 'DENIED' }] }, evidence: evidence('preflight', 2, 1) };
      },
      implement: (req) => {
        edit(req.cwd, 'src/a.ts', 'export const a = 2;\n');
        return { ok: true, text: '改好了', evidence: evidence('implement', 3) };
      },
      verify: report([
        ['AC1', 'pass', 'tsc 退出码 0'],
        ['AC2', 'pass', '已核对'],
      ]),
    });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    expect((await ctx.settled(id)).status).toBe('done');
    const pre = ctx.queue.status(ctx.project.id).preflight!;
    expect(pre.state).toBe('ok');
    expect(pre.notes.join()).toContain('没能执行命令 node --version（1 次调用被权限拒绝）');
  }, 40_000);
});

describe('生成规格', () => {
  const analyzed = async (ctx: Awaited<ReturnType<typeof setup>>, id: string) => {
    const deadline = Date.now() + 15_000;
    while (ctx.store.get(id)!.analyzing) {
      if (Date.now() > deadline) throw new Error('生成规格没有在限定时间内结束');
      await new Promise((r) => setTimeout(r, 20));
    }
    return ctx.store.get(id)!;
  };
  const raw = { goal: 'g', rootCause: 'r', scope: ['src'], steps: ['s'], criteria: [{ text: 'c', method: 'auto', how: 'h' }], risks: [] };

  it('没有读过代码写出来的规格不采用', async () => {
    const ctx = await setup({ analysis: () => ({ ok: true, text: '', structured: raw, evidence: evidence('analysis', 0) }) });
    const t0 = ctx.store.create({ projectId: ctx.project.id, title: 't', description: '', source: 'manual' });
    ctx.queue.analyze(t0.id);
    const t = await analyzed(ctx, t0.id);
    expect(t.spec).toBeUndefined();
    expect(t.analysis).toBe('');
    expect(t.error).toContain('没有调用任何工具');
  }, 40_000);

  it('读过代码的规格保存为结构化规格，并生成文本形式；该阶段只读', async () => {
    let access: string | undefined;
    const ctx = await setup({
      analysis: (req) => {
        access = req.access;
        return { ok: true, text: '', structured: raw, evidence: evidence('analysis', 9) };
      },
    });
    const t0 = ctx.store.create({ projectId: ctx.project.id, title: 't', description: '', source: 'manual' });
    ctx.queue.analyze(t0.id);
    const t = await analyzed(ctx, t0.id);
    expect(access).toBe('read');
    expect(t.error).toBeUndefined();
    expect(t.spec?.criteria).toEqual([{ id: 'AC1', text: 'c', method: 'auto', how: 'h' }]);
    expect(t.analysis).toContain('- [AC1]（自动验证）c');
  }, 40_000);
});

describe('单独执行与定时启动', () => {
  /** 每次实现写入不同内容，保证每个任务都有改动；按提示词里的标题记录执行顺序 */
  const working = (order: string[]): Script => {
    let n = 0;
    return {
      implement: (req) => {
        order.push(/## 任务\n(.+)/.exec(req.prompt)![1]);
        edit(req.cwd, 'src/a.ts', `export const a = ${100 + ++n};\n`);
        return { ok: true, text: '改好了', evidence: evidence('implement', 4) };
      },
      verify: report([
        ['AC1', 'pass', 'tsc 退出码 0'],
        ['AC2', 'pass', '已核对'],
      ]),
    };
  };
  const named = (ctx: Awaited<ReturnType<typeof setup>>, title: string) => {
    const id = ctx.addTodo();
    ctx.store.update(id, { title });
    return id;
  };
  const until = async (what: string, ok: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('单独执行：只跑指定的那一个，不启动队列，其余待办不动', async () => {
    const order: string[] = [];
    const ctx = await setup(working(order));
    const first = named(ctx, '任务甲');
    const second = named(ctx, '任务乙');

    ctx.queue.runOne(second);
    expect((await ctx.settled(second)).status).toBe('done');
    // 给队列一次取下一个任务的机会，确认它没有接着跑
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual(['任务乙']);
    expect(ctx.store.get(first)!.status).toBe('todo');
    expect(ctx.queue.status(ctx.project.id)).toMatchObject({ running: false, currentId: null });
    expect(ctx.calls).toEqual(['preflight', 'implement', 'verify']);
  }, 40_000);

  it('单独执行只接受待办任务；项目有任务在跑时拒绝', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ctx = await setup({
      implement: async (req) => {
        await gate;
        edit(req.cwd, 'src/a.ts', 'export const a = 2;\n');
        return { ok: true, text: '改好了', evidence: evidence('implement', 4) };
      },
      verify: report([
        ['AC1', 'pass', 'tsc 退出码 0'],
        ['AC2', 'pass', '已核对'],
      ]),
    });
    const pending = ctx.store.create({ projectId: ctx.project.id, title: '未确认', description: '', source: 'manual' });
    expect(() => ctx.queue.runOne(pending.id)).toThrow('只有待修改中的任务');
    expect(() => ctx.queue.runOne('no-such-task')).toThrow('任务不存在');

    const a = ctx.addTodo();
    const b = ctx.addTodo();
    ctx.queue.runOne(a);
    await until('任务甲开始执行', () => ctx.queue.isRunningTask(a));
    expect(() => ctx.queue.runOne(b)).toThrow('有任务正在执行');
    release();
    expect((await ctx.settled(a)).status).toBe('done');
    expect(ctx.store.get(b)!.status).toBe('todo');
  }, 40_000);

  it('单独执行时自检没过：任务留在待办，不执行', async () => {
    const ctx = await setup({ preflight: () => ({ ok: true, text: '没有可用的工具', evidence: evidence('preflight', 0) }) });
    const id = ctx.addTodo();
    ctx.queue.runOne(id);
    await until('自检结束', () => ctx.queue.status(ctx.project.id).preflight?.state === 'failed');
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.store.get(id)!.status).toBe('todo');
    expect(ctx.calls).toEqual(['preflight']);
  }, 40_000);

  it('定时启动：按待办顺序逐个执行，清空后自动暂停', async () => {
    const order: string[] = [];
    const ctx = await setup(working(order));
    const first = named(ctx, '任务甲');
    const second = named(ctx, '任务乙');

    ctx.queue.startScheduled(ctx.project.id);
    await until('两个任务都结束', () => ctx.store.get(first)!.status === 'done' && ctx.store.get(second)!.status === 'done');
    await until('队列自动暂停', () => !ctx.queue.status(ctx.project.id).running);
    expect(order).toEqual(['任务甲', '任务乙']);
  }, 60_000);

  it('手动启动的队列清空后保持运行，等待新任务；此时定时触发不改变它', async () => {
    const order: string[] = [];
    const ctx = await setup(working(order));
    const id = named(ctx, '任务甲');
    ctx.queue.start(ctx.project.id);
    expect((await ctx.settled(id)).status).toBe('done');
    ctx.queue.startScheduled(ctx.project.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(ctx.queue.status(ctx.project.id).running).toBe(true);
  }, 40_000);
});

describe('追加指令', () => {
  const NOTE = '分项统计也要按树的范围过滤';
  const passAll = report([
    ['AC1', 'pass', 'tsc 退出码 0'],
    ['AC2', 'pass', '已核对'],
  ]);

  /** 每轮实现都写入不同内容；resumeWorks 为 false 时模拟「会话已不存在」 */
  const script = (reqs: AgentRequest[], resumeWorks: boolean): Script => {
    let n = 0;
    return {
      implement: (req) => {
        reqs.push(req);
        if (req.resume && !resumeWorks) return { ok: false, text: 'No conversation found with session ID', evidence: evidence('implement', 0) };
        edit(req.cwd, 'src/a.ts', `export const a = ${200 + ++n};\n`);
        return { ok: true, text: `第 ${n} 轮改好了`, evidence: { ...evidence('implement', 4), sessionId: 'sess-1' } };
      },
      verify: (req) => {
        reqs.push(req);
        return passAll(req);
      },
    };
  };

  it('接续上一轮的会话继续执行，只给最新的指令，随后重新验证并过门禁', async () => {
    const reqs: AgentRequest[] = [];
    const ctx = await setup(script(reqs, true));
    const id = ctx.addTodo();
    ctx.queue.runOne(id);
    expect((await ctx.settled(id)).status).toBe('done');

    ctx.queue.followUp(id, NOTE);
    const t = await ctx.settled(id);
    expect(t.status).toBe('done');
    expect(t.notes).toEqual([NOTE]);
    expect(t.followUp).toBeUndefined();
    expect(t.summary).toBe('第 2 轮改好了');
    expect(t.commit?.files).toEqual(['src/a.ts']);

    expect(reqs.map((r) => r.stage)).toEqual(['implement', 'verify', 'implement', 'verify']);
    const [first, , second, verify] = reqs;
    expect(first.resume).toBeUndefined();
    expect(second.resume).toBe('sess-1');
    expect(second.prompt).toContain(NOTE);
    // 接续的会话里代理还记得任务，不重复发规格
    expect(second.prompt).not.toContain('## 已确认的规格');
    expect(verify.prompt).toContain('使用者追加的要求');
    expect(verify.prompt).toContain(NOTE);
  }, 60_000);

  it('上一轮的会话接不上时，改为新开会话，并带上任务、规格和上一轮的总结', async () => {
    const reqs: AgentRequest[] = [];
    const ctx = await setup(script(reqs, false));
    const id = ctx.addTodo();
    ctx.queue.runOne(id);
    expect((await ctx.settled(id)).status).toBe('done');

    ctx.queue.followUp(id, NOTE);
    const t = await ctx.settled(id);
    expect(t.status).toBe('done');
    expect(reqs.map((r) => `${r.stage}${r.resume ? ':resume' : ''}`)).toEqual(['implement', 'verify', 'implement:resume', 'implement', 'verify']);
    const fresh = reqs[3];
    expect(fresh.prompt).toContain(NOTE);
    expect(fresh.prompt).toContain('## 已确认的规格');
    expect(fresh.prompt).toContain('第 1 轮改好了');
    expect(t.logs.some((l) => l.includes('无法接续上一轮的会话'))).toBe(true);
  }, 60_000);

  it('这一轮没有产生新的改动：判异常，不沿用上一轮的结论', async () => {
    const reqs: AgentRequest[] = [];
    let n = 0;
    const ctx = await setup({
      implement: (req) => {
        reqs.push(req);
        if (++n === 1) edit(req.cwd, 'src/a.ts', 'export const a = 2;\n');
        return { ok: true, text: '改好了', evidence: { ...evidence('implement', 4), sessionId: 'sess-1' } };
      },
      verify: passAll,
    });
    const id = ctx.addTodo();
    ctx.queue.runOne(id);
    expect((await ctx.settled(id)).status).toBe('done');

    ctx.queue.followUp(id, NOTE);
    const t = await ctx.settled(id);
    expect(t.status).toBe('blocked');
    expect(t.error).toContain('没有产生任何代码改动');
  }, 60_000);

  it('只有跑完一轮的任务可以追加指令', async () => {
    const ctx = await setup({});
    const id = ctx.addTodo();
    expect(() => ctx.queue.followUp(id, NOTE)).toThrow('跑完一轮后才能追加指令');
    expect(() => ctx.queue.followUp('no-such-task', NOTE)).toThrow('任务不存在');
    expect(ctx.store.get(id)!.notes).toBeUndefined();
  }, 40_000);
});

describe('流程调整', () => {
  const implOk: Handler = (req) => {
    edit(req.cwd, 'src/a.ts', 'export const a = 2;\n');
    return { ok: true, text: '改好了', evidence: evidence('implement', 5) };
  };
  const bothPass = report([
    ['AC1', 'pass', 'ok'],
    ['AC2', 'pass', 'ok'],
  ]);

  it('只有人工验收项没验证：按门禁通过处理，核对清单留在任务上', async () => {
    const ctx = await setup({
      implement: implOk,
      verify: report([
        ['AC1', 'pass', 'tsc 退出码 0'],
        ['AC2', 'unverified', '需要人工验证'],
      ]),
    });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);
    expect(t.status).toBe('done');
    expect(t.gate?.verdict).toBe('pass');
    expect(t.manualChecks).toContain('[AC2] 按钮在边框内');
    expect(ctx.done).toEqual([id]);
  }, 40_000);

  it('验证阶段用单独指定的模型，实现阶段不受影响', async () => {
    const models: Record<string, string> = {};
    const ctx = await setup({
      implement: (req) => {
        models.implement = req.exec.model;
        return implOk(req);
      },
      verify: (req) => {
        models.verify = req.exec.model;
        return bothPass(req);
      },
    });
    ctx.store.updateProject(ctx.project.id, { exec: { model: 'opus', verifyModel: 'haiku' } });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    await ctx.settled(id);
    expect(models).toEqual({ implement: 'opus', verify: 'haiku' });
  }, 40_000);

  it('给代理一个仓库外的临时目录写自检脚本，任务结束后清掉', async () => {
    let scratch = '';
    let existed = false;
    let inPrompt = false;
    const ctx = await setup({
      implement: (req) => {
        scratch = (req.addDirs ?? []).find((d) => path.basename(d).startsWith('abu-scratch-')) ?? '';
        existed = !!scratch && fs.existsSync(scratch);
        inPrompt = !!scratch && req.prompt.includes(scratch);
        if (scratch) fs.writeFileSync(path.join(scratch, 'check.cjs'), '1\n');
        return implOk(req);
      },
      verify: bothPass,
    });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);
    expect(existed).toBe(true);
    expect(inPrompt).toBe(true);
    expect(path.resolve(scratch).startsWith(path.resolve(ctx.workdir))).toBe(false);
    expect(t.gate?.outOfScope).toEqual([]);
    expect(fs.existsSync(scratch)).toBe(false);
  }, 40_000);

  it('理解阶段：超时按项目设置，验收项超过 8 条只留前 8 条', async () => {
    const timeouts: number[] = [];
    const ctx = await setup({
      analysis: (req) => {
        timeouts.push(req.timeoutMs ?? 0);
        const criteria = Array.from({ length: 12 }, (_, i) => ({ text: `第 ${i + 1} 项`, method: 'auto', how: '' }));
        return { ok: true, text: '', structured: { goal: 'g', rootCause: 'r', scope: ['src'], steps: ['s'], risks: [], questions: [], criteria }, evidence: evidence('analysis', 3) };
      },
    });
    const analyzed = async (id: string) => {
      const deadline = Date.now() + 10_000;
      while (ctx.store.get(id)!.analyzing || !ctx.store.get(id)!.spec) {
        if (Date.now() > deadline) throw new Error('理解没有结束');
        await new Promise((r) => setTimeout(r, 20));
      }
      return ctx.store.get(id)!;
    };
    const t1 = ctx.store.create({ projectId: ctx.project.id, title: 'a', description: '', source: 'manual' });
    ctx.queue.analyze(t1.id);
    expect((await analyzed(t1.id)).spec!.criteria).toHaveLength(8);
    ctx.store.updateProject(ctx.project.id, { exec: { analyzeTimeoutMinutes: 20 } });
    const t2 = ctx.store.create({ projectId: ctx.project.id, title: 'b', description: '', source: 'manual' });
    ctx.queue.analyze(t2.id);
    await analyzed(t2.id);
    expect(timeouts).toEqual([15 * 60_000, 20 * 60_000]);
  }, 40_000);
});

describe('流转方式：自动确认、自动开工、失败后的改动归属', () => {
  const specOf = (questions: { text: string; answer: string }[]) => ({
    goal: 'g',
    rootCause: 'r',
    scope: ['src'],
    steps: ['s'],
    risks: [],
    questions,
    criteria: [{ text: '类型检查通过', method: 'auto', how: 'npx tsc -b' }],
  });
  const analyzedDone = async (ctx: Awaited<ReturnType<typeof setup>>, id: string) => {
    const deadline = Date.now() + 10_000;
    while (ctx.store.get(id)!.analyzing || !ctx.store.get(id)!.spec) {
      if (Date.now() > deadline) throw new Error('理解没有结束');
      await new Promise((r) => setTimeout(r, 20));
    }
    return ctx.store.get(id)!;
  };

  it('开启自动确认：规格没有待回答的问题时直接进入待修改，并记下确认的规格', async () => {
    const ctx = await setup({ analysis: () => ({ ok: true, text: '', structured: specOf([]), evidence: evidence('analysis', 3) }) });
    ctx.store.updateProject(ctx.project.id, { exec: { autoConfirm: true } });
    const t = ctx.store.create({ projectId: ctx.project.id, title: 'a', description: '', source: 'manual' });
    ctx.queue.analyze(t.id);
    const done = await analyzedDone(ctx, t.id);
    expect(done.status).toBe('todo');
    expect(done.confirmed?.specHash).toBeTruthy();
  }, 40_000);

  it('开启自动确认但规格里有问题没回答：留在待确认等人回答', async () => {
    const ctx = await setup({ analysis: () => ({ ok: true, text: '', structured: specOf([{ text: '要不要改接口？', answer: '' }]), evidence: evidence('analysis', 3) }) });
    ctx.store.updateProject(ctx.project.id, { exec: { autoConfirm: true } });
    const t = ctx.store.create({ projectId: ctx.project.id, title: 'a', description: '', source: 'manual' });
    ctx.queue.analyze(t.id);
    expect((await analyzedDone(ctx, t.id)).status).toBe('pending_confirm');
  }, 40_000);

  it('没开自动确认：规格生成后留在待确认', async () => {
    const ctx = await setup({ analysis: () => ({ ok: true, text: '', structured: specOf([]), evidence: evidence('analysis', 3) }) });
    const t = ctx.store.create({ projectId: ctx.project.id, title: 'a', description: '', source: 'manual' });
    ctx.queue.analyze(t.id);
    expect((await analyzedDone(ctx, t.id)).status).toBe('pending_confirm');
  }, 40_000);

  const implOk: Handler = (req) => {
    edit(req.cwd, 'src/a.ts', 'export const a = 2;\n');
    return { ok: true, text: '改好了', evidence: evidence('implement', 5) };
  };
  const bothPass = report([
    ['AC1', 'pass', 'ok'],
    ['AC2', 'pass', 'ok'],
  ]);

  it('开启自动开工：待修改里有任务就自己开始，不用点启动', async () => {
    const ctx = await setup({ implement: implOk, verify: bothPass });
    ctx.store.updateProject(ctx.project.id, { exec: { autoStart: true } });
    const id = ctx.addTodo();
    ctx.queue.tick();
    expect((await ctx.settled(id)).status).toBe('done');
  }, 40_000);

  it('自动开工时手动暂停过：不会被自动重新启动，直到再次点启动', async () => {
    const ctx = await setup({ implement: implOk, verify: bothPass });
    ctx.store.updateProject(ctx.project.id, { exec: { autoStart: true } });
    ctx.queue.pause(ctx.project.id);
    const id = ctx.addTodo();
    ctx.queue.tick();
    await new Promise((r) => setTimeout(r, 300));
    expect(ctx.store.get(id)!.status).toBe('todo');
    expect(ctx.calls).toEqual([]);
    ctx.queue.start(ctx.project.id);
    expect((await ctx.settled(id)).status).toBe('done');
  }, 40_000);

  it('没开自动开工：待修改里的任务原地等待', async () => {
    const ctx = await setup({ implement: implOk, verify: bothPass });
    const id = ctx.addTodo();
    ctx.queue.tick();
    await new Promise((r) => setTimeout(r, 300));
    expect(ctx.store.get(id)!.status).toBe('todo');
  }, 40_000);

  it('外部占用（部署智能体在改代码目录）期间不取任务，占用解除后再 tick 就接上', async () => {
    const ctx = await setup({ implement: implOk, verify: bothPass });
    let deploying = true;
    ctx.queue.setBlocker((pid) => pid === ctx.project.id && deploying);
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(ctx.store.get(id)!.status).toBe('todo');
    expect(ctx.calls.filter((s) => s !== 'preflight')).toEqual([]);
    deploying = false;
    ctx.queue.tick();
    expect((await ctx.settled(id)).status).toBe('done');
  }, 40_000);

  it('实现中途失败：已经改动的文件记在这个任务上，不留给后面的任务当成「执行前已有的改动」', async () => {
    const ctx = await setup({
      implement: (req) => {
        edit(req.cwd, 'src/a.ts', 'export const a = 3;\n');
        edit(req.cwd, 'src/new.ts', 'export const n = 1;\n');
        return { ok: false, text: '超出了单次会话的花费上限', evidence: evidence('implement', 9) };
      },
    });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);
    expect(t.status).toBe('blocked');
    expect([...(t.leftover ?? [])].sort()).toEqual(['src/a.ts', 'src/new.ts']);
  }, 40_000);
});

describe('验收项截断留痕', () => {
  it('被丢掉的验收项写进规格的风险里，确认时看得到', async () => {
    const ctx = await setup({
      analysis: () => {
        const criteria = Array.from({ length: 10 }, (_, i) => ({ text: `第 ${i + 1} 项`, method: 'auto', how: '' }));
        return { ok: true, text: '', structured: { goal: 'g', rootCause: 'r', scope: ['src'], steps: ['s'], risks: [], questions: [], criteria }, evidence: evidence('analysis', 3) };
      },
    });
    const t = ctx.store.create({ projectId: ctx.project.id, title: 'a', description: '', source: 'manual' });
    ctx.queue.analyze(t.id);
    const deadline = Date.now() + 10_000;
    while (!ctx.store.get(t.id)!.spec) {
      if (Date.now() > deadline) throw new Error('理解没有结束');
      await new Promise((r) => setTimeout(r, 20));
    }
    const risks = ctx.store.get(t.id)!.spec!.risks.join('\n');
    expect(risks).toContain('第 9 项');
    expect(risks).toContain('第 10 项');
    expect(risks).not.toContain('第 8 项');
  }, 40_000);
});

describe('审查意见的回归：暂停持久化、停止时的改动、自动确认只首次', () => {
  it('手动暂停记在项目上：换一个队列实例（相当于服务重启）后自动开工仍不拉起', async () => {
    const ctx = await setup({});
    ctx.store.updateProject(ctx.project.id, { exec: { autoStart: true } });
    ctx.queue.pause(ctx.project.id);
    expect(ctx.store.getProject(ctx.project.id)!.queueHeld).toBe(true);
    const id = ctx.addTodo();
    const calls: string[] = [];
    const q2 = new Queue(ctx.store, undefined, async (req) => {
      calls.push(req.stage);
      throw new Error('不该被调用');
    });
    q2.tick();
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toEqual([]);
    expect(ctx.store.get(id)!.status).toBe('todo');
    q2.start(ctx.project.id);
    expect(ctx.store.getProject(ctx.project.id)!.queueHeld).toBe(false);
    q2.pause(ctx.project.id);
  }, 40_000);

  it('实现途中被手动停止：已经改动的文件记在这个任务上', async () => {
    const ctx = await setup({
      implement: async (req) => {
        edit(req.cwd, 'src/a.ts', 'export const a = 9;\n');
        ctx.queue.stopCurrent(ctx.project.id);
        return { ok: false, text: '已手动停止', evidence: evidence('implement', 3) };
      },
    });
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    const t = await ctx.settled(id);
    expect(t.status).toBe('blocked');
    expect(t.leftover).toEqual(['src/a.ts']);
  }, 40_000);

  it('自动确认只对第一次生成的规格生效：退回后重新生成的留在待确认', async () => {
    const structured = { goal: 'g', rootCause: 'r', scope: ['src'], steps: ['s'], risks: [], questions: [], criteria: [{ text: '类型检查通过', method: 'auto', how: 'npx tsc -b' }] };
    const ctx = await setup({ analysis: () => ({ ok: true, text: '', structured, evidence: evidence('analysis', 3) }) });
    ctx.store.updateProject(ctx.project.id, { exec: { autoConfirm: true } });
    const t = ctx.store.create({ projectId: ctx.project.id, title: 'a', description: '', source: 'manual' });
    ctx.queue.analyze(t.id);
    const until = async (cond: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!cond()) {
        if (Date.now() > deadline) throw new Error('等待超时');
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await until(() => ctx.store.get(t.id)!.status === 'todo');
    // 人把它退回待确认，再重新生成一次规格
    ctx.store.setStatus(t.id, 'pending_confirm', { confirmed: undefined });
    ctx.queue.analyze(t.id);
    await until(() => !ctx.store.get(t.id)!.analyzing && ctx.calls.filter((c) => c === 'analysis').length === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.store.get(t.id)!.status).toBe('pending_confirm');
  }, 40_000);
});

describe('skill 库目录接入会话', () => {
  it('配置了库目录：三个阶段的会话拿到的是库里 skill 的副本，原件碰不到，用完清掉', async () => {
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-skill-lib-'));
    cleanups.push(() => fs.rmSync(lib, { recursive: true, force: true }));
    const original = path.join(lib, '.claude', 'skills', 'tdd', 'SKILL.md');
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.writeFileSync(original, '---\nname: tdd\ndescription: d\n---\n');
    // 库目录下别的东西（比如凭据）不该交给代理
    fs.writeFileSync(path.join(lib, 'secret.txt'), 'x');
    const seen: Record<string, boolean> = {};
    const copies: string[] = [];
    const mark = (req: AgentRequest) => {
      const dirs = req.addDirs ?? [];
      const copy = dirs.find((d) => fs.existsSync(path.join(d, '.claude', 'skills', 'tdd', 'SKILL.md')));
      seen[req.stage] = !!copy && !dirs.includes(lib) && !fs.existsSync(path.join(copy, 'secret.txt'));
      if (copy) {
        copies.push(copy);
        // 代理改了副本，原件不受影响
        fs.writeFileSync(path.join(copy, '.claude', 'skills', 'tdd', 'SKILL.md'), '被代理改掉了');
      }
    };
    const ctx = await setup({
      analysis: (req) => {
        mark(req);
        return { ok: true, text: '', structured: { goal: 'g', rootCause: 'r', scope: ['src'], steps: ['s'], risks: [], questions: [], criteria: [{ text: 'x', method: 'auto', how: '' }] }, evidence: evidence('analysis', 3) };
      },
      implement: (req) => {
        mark(req);
        edit(req.cwd, 'src/a.ts', 'export const a = 2;\n');
        return { ok: true, text: '改好了', evidence: evidence('implement', 5) };
      },
      verify: (req) => {
        mark(req);
        return report([
          ['AC1', 'pass', 'ok'],
          ['AC2', 'pass', 'ok'],
        ])(req);
      },
    });
    ctx.store.updateSettings({ skills: { libraryDir: lib } });
    const t = ctx.store.create({ projectId: ctx.project.id, title: 'a', description: '', source: 'manual' });
    ctx.queue.analyze(t.id);
    const deadline = Date.now() + 10_000;
    while (!ctx.store.get(t.id)!.spec) {
      if (Date.now() > deadline) throw new Error('理解没有结束');
      await new Promise((r) => setTimeout(r, 20));
    }
    const id = ctx.addTodo();
    ctx.queue.start(ctx.project.id);
    await ctx.settled(id);
    expect(seen).toEqual({ analysis: true, implement: true, verify: true });
    expect(fs.readFileSync(original, 'utf8')).toContain('name: tdd');
    expect(copies.some((c) => fs.existsSync(c))).toBe(false);
  }, 40_000);
});
