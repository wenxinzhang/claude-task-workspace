import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { customDriver, extractJson, runAgent, type AgentRequest, type Driver } from './agent.ts';
import { claudeArgs, parseClaudeLine } from './claude.ts';
import { codexArgs, parseCodexLine } from './codex.ts';
import { resolveCli } from './shell.ts';
import { DEFAULT_EXEC } from './types.ts';

const json = (o: unknown) => JSON.stringify(o);

describe('parseClaudeLine', () => {
  it('result：取出结构化输出、轮数和完整的权限拒绝清单', () => {
    const r = parseClaudeLine(
      json({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '{"a":1}',
        structured_output: { a: 1 },
        num_turns: 6,
        total_cost_usd: 0.12,
        permission_denials: [{ tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'git --version' } }],
      }),
    );
    expect(r.final).toEqual({ ok: true, text: '{"a":1}', structured: { a: 1 } });
    expect(r.turns).toBe(6);
    expect(r.costUsd).toBe(0.12);
    expect(r.allDenials).toEqual([{ tool: 'Bash', input: 'git --version' }]);
  });

  it('错误 result', () => {
    expect(parseClaudeLine(json({ type: 'result', subtype: 'error_max_turns', is_error: true })).final?.ok).toBe(false);
  });

  it('assistant：统计工具调用，交回结构化输出的内部工具不算', () => {
    const r = parseClaudeLine(
      json({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '我来看看' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
            { type: 'tool_use', id: 't9', name: 'StructuredOutput', input: { a: 1 } },
          ],
        },
      }),
    );
    expect(r.tools).toEqual([{ id: 't1', name: 'Read', input: 'a.ts' }]);
    expect(r.log).toBe('我来看看\n→ Read a.ts');
  });

  it('权限拒绝、会话启动、非 JSON', () => {
    expect(parseClaudeLine(json({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't2' })).denied).toEqual([{ id: 't2', tool: 'Bash' }]);
    expect(parseClaudeLine(json({ type: 'system', subtype: 'init', model: 'claude-x' })).model).toBe('claude-x');
    expect(parseClaudeLine('hello')).toEqual({ log: 'hello' });
  });
});

describe('claudeArgs', () => {
  const head = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none'];

  it('只读阶段只开放读代码的工具，并带上输出结构', () => {
    const args = claudeArgs({ access: 'read', exec: { ...DEFAULT_EXEC, model: 'sonnet' }, schema: { type: 'object' } });
    expect(args).toEqual([...head, '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk', '--model', 'sonnet', '--json-schema', '{"type":"object"}']);
  });

  it('只读阶段指定了 skill 时才开放 Skill 工具', () => {
    const args = claudeArgs({ access: 'read', exec: DEFAULT_EXEC, skills: ['qa-test'] });
    expect(args.slice(head.length)).toEqual(['--tools', 'Read,Grep,Glob,Skill', '--permission-mode', 'dontAsk', '--allowedTools', 'Skill(qa-test)']);
  });

  it('可写阶段用项目的权限设置，附加目录放在最后', () => {
    const args = claudeArgs({ access: 'write', exec: { ...DEFAULT_EXEC, allowedTools: 'Bash(npm *)', disabledSkills: '' }, addDirs: ['E:\\att'] });
    expect(args.slice(head.length)).toEqual(['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(npm *)', '--add-dir', 'E:\\att']);
  });
});

describe('Codex', () => {
  it('codexArgs：只读阶段固定 read-only，可写阶段用配置的沙箱', () => {
    const exec = { ...DEFAULT_EXEC, provider: 'codex' as const, codexSandbox: 'workspace-write' as const, codexModel: 'gpt-x' };
    expect(codexArgs({ access: 'read', exec, cwd: 'E:\\proj' })).toEqual(['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', 'E:\\proj', '-m', 'gpt-x', '-']);
    expect(codexArgs({ access: 'write', exec, cwd: 'E:\\proj', addDirs: ['E:\\att'], images: ['E:\\att\\a.png'] }, 'E:\\tmp\\s.json')).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '-C',
      'E:\\proj',
      '-m',
      'gpt-x',
      '--add-dir',
      'E:\\att',
      '--image=E:\\att\\a.png',
      '--output-schema',
      'E:\\tmp\\s.json',
      '-',
    ]);
  });

  it('parseCodexLine：只在 item.completed 时计一次工具调用', () => {
    const cmd = { id: 'i1', type: 'command_execution', command: 'npm test', exit_code: 0 };
    expect(parseCodexLine(json({ type: 'item.started', item: cmd }))).toEqual({});
    expect(parseCodexLine(json({ type: 'item.completed', item: cmd })).tools).toEqual([{ id: 'i1', name: 'command', input: 'npm test' }]);
    expect(parseCodexLine(json({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }] } })).tools).toEqual([
      { id: 'i2', name: 'file_change', input: 'a.ts' },
    ]);
    expect(parseCodexLine(json({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: '改好了' } })).message).toBe('改好了');
    expect(parseCodexLine(json({ type: 'item.completed', item: { id: 'i4', type: 'reasoning', text: '…' } }))).toEqual({});
    expect(parseCodexLine(json({ type: 'turn.failed', error: { message: 'boom' } })).error).toBe('boom');
  });
});

describe('extractJson', () => {
  it('优先最后一个 json 代码块，其次整段文本或最外层花括号', () => {
    expect(extractJson('说明\n```json\n{"a":1}\n```\n更正\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('{"a":3}')).toEqual({ a: 3 });
    expect(extractJson('结果是 {"a":4} 。')).toEqual({ a: 4 });
    expect(extractJson('VERDICT: PASS')).toBeUndefined();
    expect(extractJson('42')).toBeUndefined();
  });
});

/** 用真实子进程模拟代理：node 运行一段脚本，按行输出事件 */
function scripted(source: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-agent-'));
  const file = path.join(dir, 'agent.cjs');
  fs.writeFileSync(file, source);
  const driver: Driver = { observable: true, plan: (req) => ({ bin: process.execPath, args: [file], stdin: req.prompt }), parse: parseClaudeLine };
  return { dir, file, driver, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const request = (over: Partial<AgentRequest> = {}): AgentRequest => ({
  stage: 'implement',
  access: 'write',
  prompt: '修复按钮',
  cwd: os.tmpdir(),
  exec: DEFAULT_EXEC,
  timeoutMs: 20_000,
  ...over,
});

const emit = (events: unknown[]) => events.map((e) => `console.log(${JSON.stringify(JSON.stringify(e))});`).join('\n');

describe('runAgent', () => {
  it('从事件流统计工具调用和权限拒绝，取出结构化输出', async () => {
    const s = scripted(
      emit([
        { type: 'system', subtype: 'init', model: 'm1' },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
              { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'git diff' } },
            ],
          },
        },
        { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't2' },
        { type: 'result', subtype: 'success', is_error: false, result: '改好了', num_turns: 3, structured_output: { a: 1 } },
      ]),
    );
    try {
      const logs: string[] = [];
      const res = await runAgent(request({ schema: { type: 'object' }, onLog: (l) => logs.push(l) }), s.driver);
      expect(res).toMatchObject({ ok: true, text: '改好了', structured: { a: 1 } });
      expect(res.evidence).toMatchObject({ stage: 'implement', model: 'm1', toolCalls: 2, tools: { Read: 1, Bash: 1 }, denials: [{ tool: 'Bash', input: 'git diff' }], turns: 3 });
      expect(logs).toContain('→ Read a.ts\n→ Bash git diff');
    } finally {
      s.cleanup();
    }
  });

  it('只输出文字、没有调用工具的会话：结果是成功，但证据里工具调用为 0', async () => {
    const s = scripted(emit([{ type: 'assistant', message: { content: [{ type: 'text', text: '已完成修复' }] } }, { type: 'result', subtype: 'success', is_error: false, result: '已完成修复', num_turns: 1 }]));
    try {
      const res = await runAgent(request(), s.driver);
      expect(res.ok).toBe(true);
      expect(res.evidence.toolCalls).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  it('进程异常退出且没有结果：失败，带上退出码和 stderr', async () => {
    const s = scripted(`console.error('boom: no api key'); process.exit(2);`);
    try {
      const res = await runAgent(request(), s.driver);
      expect(res.ok).toBe(false);
      expect(res.text).toContain('退出码 2');
      expect(res.text).toContain('boom: no api key');
    } finally {
      s.cleanup();
    }
  });

  it('超时会结束进程并报告失败', async () => {
    const s = scripted(`setTimeout(() => {}, 60000);`);
    try {
      const res = await runAgent(request({ timeoutMs: 800 }), s.driver);
      expect(res.ok).toBe(false);
      expect(res.text).toContain('超时');
    } finally {
      s.cleanup();
    }
  });

  it('本地命令行代理：提示词走 stdin，阶段和权限走环境变量，调用次数记为未知', async () => {
    const s = scripted(
      `let input = ''; process.stdin.on('data', (c) => (input += c)); process.stdin.on('end', () => {
        console.log('stage=' + process.env.ABU_STAGE + ' access=' + process.env.ABU_ACCESS + ' schema=' + input.includes('JSON Schema'));
        console.log('\`\`\`json'); console.log(JSON.stringify({ goal: 'g' })); console.log('\`\`\`');
      });`,
    );
    try {
      const exec = { ...DEFAULT_EXEC, provider: 'custom' as const, customCommand: `node "${s.file}"` };
      const res = await runAgent(request({ stage: 'analysis', access: 'read', exec, schema: { type: 'object' } }), customDriver);
      expect(res.ok).toBe(true);
      expect(res.text).toContain('stage=analysis access=read schema=true');
      expect(res.structured).toEqual({ goal: 'g' });
      expect(res.evidence.toolCalls).toBeNull();
    } finally {
      s.cleanup();
    }
  });

  it('没有填写本地代理命令时直接报错', async () => {
    const res = await runAgent(request({ exec: { ...DEFAULT_EXEC, provider: 'custom' } }), customDriver);
    expect(res).toMatchObject({ ok: false });
    expect(res.text).toContain('本地代理命令');
  });
});

describe.runIf(process.platform === 'win32')('resolveCli', () => {
  it('解析 .cmd 包装脚本指向的 js 入口或 exe，跳过 node.exe', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-cli-'));
    try {
      fs.mkdirSync(path.join(dir, 'node_modules', 'pkg', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'bin', 'tool.js'), '');
      fs.writeFileSync(path.join(dir, 'node.exe'), '');
      fs.writeFileSync(path.join(dir, 'jstool.cmd'), '@IF EXIST "%dp0%\\node.exe" (\r\n  "%dp0%\\node.exe"  "%dp0%\\node_modules\\pkg\\bin\\tool.js" %*\r\n)');
      expect(resolveCli('jstool', 'ABU_TEST_NO_SUCH_VAR', dir, 'win32')).toEqual({ bin: process.execPath, prefix: [path.join(dir, 'node_modules', 'pkg', 'bin', 'tool.js')] });

      fs.mkdirSync(path.join(dir, 'vendor'));
      fs.writeFileSync(path.join(dir, 'vendor', 'native.exe'), '');
      fs.writeFileSync(path.join(dir, 'exetool.cmd'), '"%dp0%\\node.exe" --version\r\n"%dp0%\\vendor\\native.exe" %*');
      expect(resolveCli('exetool', 'ABU_TEST_NO_SUCH_VAR', dir, 'win32')).toEqual({ bin: path.join(dir, 'vendor', 'native.exe'), prefix: [] });

      expect(() => resolveCli('missing-tool', 'ABU_TEST_NO_SUCH_VAR', dir, 'win32')).toThrow('未找到 missing-tool');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
