import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentRequest, AgentResult } from './agent.ts';
import { snapshot } from './git.ts';
import { commandExecutables } from './shared.ts';
import type { Preflight, Project } from './types.ts';

const PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fileContent', 'commands'],
  properties: {
    fileContent: { type: 'string' },
    commands: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'output'],
        properties: { command: { type: 'string' }, output: { type: 'string' } },
      },
    },
  },
} as const;

const TIMEOUT_MS = 3 * 60_000;

/** 查看版本的命令：试跑用，不改任何东西 */
const versionCommand = (exe: string) => (exe === 'go' ? 'go version' : `${exe} --version`);

/**
 * 开工前自检：用项目的真实执行配置跑一次最小会话，确认代理能读文件、能执行验证命令用到的程序。
 * problems 会拦住队列；notes 只提示（能干活，但结果会受影响）。
 */
export async function runPreflight(
  project: Project,
  run: (req: AgentRequest) => Promise<AgentResult>,
  signal?: AbortSignal,
): Promise<Preflight> {
  const problems: string[] = [];
  const notes: string[] = [];
  const done = (): Preflight => ({ state: problems.length ? 'failed' : 'ok', problems, notes, at: Date.now() });
  const { workdir, exec } = project;

  if (!workdir || !fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    problems.push(`代码目录不存在：${workdir || '（未设置）'}`);
    return done();
  }
  if (!(await snapshot(workdir))) notes.push('代码目录不是 git 仓库：无法核对每个任务的改动，任务都会进入待验证，也不会自动提交');

  // 配置了验证命令：试跑其中用到的每个程序；没配置时只试一条通用命令
  const configured = commandExecutables(exec.verifyCommands).slice(0, 4);
  const probes = configured.length ? configured.map(versionCommand) : ['node --version'];
  if (!configured.length) notes.push('项目没有配置验证命令（项目管理 → 配置 → 执行设置）：代理只能靠读代码验证，需要执行命令的验收项会转为人工确认。可在「项目设置 → 执行设置」里检测并采用建议的验证命令');

  // 探针文件放在临时目录，不弄脏代码目录；访问方式与任务附件相同
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-preflight-'));
  const nonce = `probe-${randomUUID().slice(0, 8)}`;
  const file = path.join(dir, 'probe.txt');
  fs.writeFileSync(file, `${nonce}\n`);
  try {
    const res = await run({
      stage: 'preflight',
      access: 'write',
      prompt: `这是开工前的环境自检，不要修改任何文件。\n1. 读取文件 ${file} ，记下它的内容。\n2. 逐条执行下面的命令，每条单独执行，记下各自的输出：\n${probes.map((c) => `- 执行命令：${c}`).join('\n')}\n按给定结构输出：fileContent 填文件内容；commands 里每条命令一项，command 填命令原文，output 填它的输出。哪一项做不到就填 DENIED，不要猜测。`,
      cwd: workdir,
      exec,
      addDirs: [dir],
      schema: PROBE_SCHEMA,
      timeoutMs: TIMEOUT_MS,
      signal,
    });
    const e = res.evidence;
    if (e.model) notes.push(`实际使用的模型：${e.model}`);
    if (!res.ok) {
      problems.push(`代理会话失败：${res.text}`);
      return done();
    }
    if (e.toolCalls === 0) {
      problems.push('代理没有调用任何工具：当前配置下它读不了文件、也执行不了命令，请检查代理类型、模型和权限设置');
      return done();
    }
    const out = (res.structured && typeof res.structured === 'object' ? res.structured : {}) as { fileContent?: unknown; commands?: unknown };
    const fileContent = typeof out.fileContent === 'string' ? out.fileContent : res.text;
    if (!fileContent.includes(nonce)) problems.push('代理没能读到指定的文件：它将看不到代码和任务截图');

    const outputs = (Array.isArray(out.commands) ? out.commands : []).map((c) => {
      const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      return { command: String(o.command ?? ''), output: String(o.output ?? '').trim() };
    });
    // 版本号里一定有数字；没有输出、写了 DENIED 都算没跑成
    const failed = probes.filter((p) => {
      const hit = outputs.find((o) => o.command.includes(p.split(' ')[0]));
      return !hit || !hit.output || /DENIED/i.test(hit.output) || !/\d/.test(hit.output);
    });
    if (failed.length) {
      const denied = e.denials.length ? `（${e.denials.length} 次调用被权限拒绝）` : '';
      if (configured.length) {
        // 使用者明确配置了验证命令却跑不了：拦下来，否则每个任务都会白跑一遍再转人工
        problems.push(`代理没能执行：${failed.join('、')}${denied}。验证命令用到的程序跑不起来，请确认本机已安装并在 PATH 中，或检查权限模式`);
      } else {
        notes.push(`代理没能执行命令 ${failed.join('、')}${denied}：验证阶段可能无法运行构建和测试，对应的验收项会转为人工确认。请检查权限模式和允许的工具`);
      }
    } else if (configured.length) {
      notes.push(`验证命令可用：${configured.join('、')}`);
    }
    return done();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
