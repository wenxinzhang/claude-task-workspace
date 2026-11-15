import type { AgentRequest, Driver, StreamEvent } from './agent.ts';
import { resolveCli } from './shell.ts';
import { disabledSkillArgs } from './skills.ts';
import { effectiveAllowedTools, splitTools } from './shared.ts';
import type { ExecConfig } from './types.ts';

export { splitTools };

/** 可写阶段（实现、验证）的权限参数 */
export function implementArgs(exec: ExecConfig): string[] {
  const args = ['--permission-mode', exec.permissionMode];
  if (exec.model) args.push('--model', exec.model);
  // 已确认的验证命令用到的程序一并放行
  const tools = splitTools(effectiveAllowedTools(exec));
  if (tools.length) args.push('--allowedTools', ...tools);
  args.push(...disabledSkillArgs(exec));
  return args;
}

/** 只读阶段：只开放读代码的工具；指定了 skill 时才开放 Skill 工具，skill 内的命令仍受只读限制 */
function readOnlyArgs(exec: ExecConfig, skills: string[]): string[] {
  const args = ['--tools', skills.length ? 'Read,Grep,Glob,Skill' : 'Read,Grep,Glob', '--permission-mode', 'dontAsk'];
  if (skills.length) args.push('--allowedTools', ...skills.map((s) => `Skill(${s})`));
  if (exec.model) args.push('--model', exec.model);
  return args;
}

export function claudeArgs(req: Pick<AgentRequest, 'access' | 'exec' | 'skills' | 'addDirs' | 'schema' | 'resume'>): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none'];
  args.push(...(req.access === 'read' ? readOnlyArgs(req.exec, req.skills ?? []) : implementArgs(req.exec)));
  if (req.addDirs?.length) args.push('--add-dir', ...req.addDirs);
  if (req.exec.budgetUsd > 0) args.push('--max-budget-usd', String(req.exec.budgetUsd));
  if (req.resume) args.push('--resume', req.resume);
  if (req.schema) args.push('--json-schema', JSON.stringify(req.schema));
  return args;
}

/** 结构化输出是通过一个内部工具交回来的，不算代理干的活 */
const OUTPUT_TOOL = 'StructuredOutput';

/** 没有文字结果时的失败原因：超出预算单独说明，其余取事件里的错误信息 */
function resultError(msg: any): string {
  if (msg.subtype === 'error_max_budget_usd') return '超出了单次会话的花费上限，会话已停止。可在「项目管理 → 配置 → 执行设置」里调高「花费上限」';
  const errors = Array.isArray(msg.errors) ? msg.errors.filter((e: unknown) => typeof e === 'string') : [];
  return errors.length ? errors.join('；') : (msg.subtype ?? '');
}

export function summarizeInput(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.description;
  const s = typeof v === 'string' ? v : JSON.stringify(input);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** 把 stream-json 的一行转成日志和事实 */
export function parseClaudeLine(line: string): StreamEvent {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return { log: line };
  }
  if (msg.type === 'result') {
    const ok = msg.subtype === 'success' && !msg.is_error;
    return {
      final: {
        ok,
        text: typeof msg.result === 'string' ? msg.result : resultError(msg),
        structured: msg.structured_output ?? undefined,
      },
      allDenials: Array.isArray(msg.permission_denials)
        ? msg.permission_denials.map((d: any) => ({ tool: String(d?.tool_name ?? ''), input: summarizeInput(d?.tool_input) }))
        : undefined,
      turns: typeof msg.num_turns === 'number' ? msg.num_turns : undefined,
      costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
      log: `完成：${msg.subtype}${msg.num_turns ? `，${msg.num_turns} 轮` : ''}`,
    };
  }
  if (msg.type === 'system' && msg.subtype === 'init') {
    return { model: msg.model, sessionId: typeof msg.session_id === 'string' ? msg.session_id : undefined, log: `会话启动，模型 ${msg.model ?? '默认'}` };
  }
  if (msg.type === 'system' && msg.subtype === 'permission_denied') {
    return { denied: [{ id: msg.tool_use_id, tool: String(msg.tool_name ?? '') }], log: `✕ ${msg.tool_name ?? '工具'} 被权限拒绝` };
  }
  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    const parts: string[] = [];
    const tools: NonNullable<StreamEvent['tools']> = [];
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text?.trim()) parts.push(block.text.trim());
      if (block.type === 'tool_use' && block.name !== OUTPUT_TOOL) {
        const input = summarizeInput(block.input);
        tools.push({ id: block.id, name: block.name, input });
        parts.push(`→ ${block.name} ${input}`);
      }
    }
    return { tools: tools.length ? tools : undefined, log: parts.length ? parts.join('\n') : undefined };
  }
  return {};
}

export const claudeDriver: Driver = {
  observable: true,
  plan(req) {
    const cli = resolveCli('claude', 'CLAUDE_BIN');
    return { bin: cli.bin, args: [...cli.prefix, ...claudeArgs(req)], stdin: req.prompt };
  },
  parse: parseClaudeLine,
};
