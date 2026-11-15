import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentRequest, Driver, StreamEvent } from './agent.ts';
import { resolveCli } from './shell.ts';

/**
 * Codex CLI 的参数（codex exec，非交互）。提示词经 stdin 传入（最后的 "-"）。
 * 只读阶段固定 read-only 沙箱；可写阶段用项目配置的沙箱。
 */
export function codexArgs(req: Pick<AgentRequest, 'access' | 'exec' | 'cwd' | 'addDirs' | 'images'>, schemaFile?: string): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', req.access === 'read' ? 'read-only' : req.exec.codexSandbox, '-C', req.cwd];
  if (req.exec.codexModel) args.push('-m', req.exec.codexModel);
  for (const d of req.addDirs ?? []) args.push('--add-dir', d);
  // 用 = 写法，避免可变参数把后面的 "-" 吃掉
  for (const img of req.images ?? []) args.push(`--image=${img}`);
  if (schemaFile) args.push('--output-schema', schemaFile);
  args.push('-');
  return args;
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** codex exec --json 的一行事件。只在 item.completed 时计数，避免和 item.started 重复 */
export function parseCodexLine(line: string): StreamEvent {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return { log: line };
  }
  if (msg.type === 'thread.started') return { log: '会话启动（Codex）' };
  if (msg.type === 'turn.failed') return { error: String(msg.error?.message ?? '执行失败'), log: `失败：${msg.error?.message ?? ''}` };
  if (msg.type === 'error') return { error: String(msg.message ?? '执行出错'), log: `错误：${msg.message ?? ''}` };
  if (msg.type === 'turn.completed') return { turns: 1, log: '完成' };
  if (msg.type !== 'item.completed' || !msg.item) return {};

  const item = msg.item;
  switch (item.type) {
    case 'agent_message':
      return typeof item.text === 'string' && item.text.trim() ? { message: item.text, log: item.text.trim() } : {};
    case 'command_execution': {
      const input = clip(String(item.command ?? ''));
      const code = typeof item.exit_code === 'number' ? `（退出码 ${item.exit_code}）` : '';
      return { tools: [{ id: item.id, name: 'command', input }], log: `→ command ${input}${code}` };
    }
    case 'file_change': {
      const input = clip((Array.isArray(item.changes) ? item.changes : []).map((c: any) => c?.path).filter(Boolean).join('、'));
      return { tools: [{ id: item.id, name: 'file_change', input }], log: `→ file_change ${input}` };
    }
    case 'mcp_tool_call': {
      const name = `mcp:${item.server ?? ''}/${item.tool ?? ''}`;
      return { tools: [{ id: item.id, name, input: '' }], log: `→ ${name}` };
    }
    case 'web_search':
      return { tools: [{ id: item.id, name: 'web_search', input: clip(String(item.query ?? '')) }], log: `→ web_search ${clip(String(item.query ?? ''))}` };
    default:
      return {};
  }
}

export const codexDriver: Driver = {
  observable: true,
  plan(req) {
    const cli = resolveCli('codex', 'CODEX_BIN');
    let schemaFile: string | undefined;
    if (req.schema) {
      schemaFile = path.join(os.tmpdir(), `abu-schema-${randomUUID()}.json`);
      fs.writeFileSync(schemaFile, JSON.stringify(req.schema), 'utf8');
    }
    return {
      bin: cli.bin,
      args: [...cli.prefix, ...codexArgs(req, schemaFile)],
      stdin: req.prompt,
      cleanup: schemaFile ? () => fs.rmSync(schemaFile!, { force: true }) : undefined,
    };
  },
  parse: parseCodexLine,
};
