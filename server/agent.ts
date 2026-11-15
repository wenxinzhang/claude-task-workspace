import { claudeDriver } from './claude.ts';
import { codexDriver } from './codex.ts';
import { runProcess } from './shell.ts';
import type { ExecConfig, Provider, RunEvidence, Stage } from './types.ts';

/** 一次代理会话的请求。access 是能力声明：read 只读代码，write 可改文件、可执行命令 */
export interface AgentRequest {
  stage: Stage | 'preflight';
  access: 'read' | 'write';
  prompt: string;
  cwd: string;
  exec: ExecConfig;
  /** 本阶段允许调用的 skill（仅 Claude Code 的只读阶段需要显式放行） */
  skills?: string[];
  /** 额外可访问的目录：附件缓存、项目记忆 */
  addDirs?: string[];
  /** 图片附件的绝对路径（Codex 需要显式传入才能看图） */
  images?: string[];
  /** 要求最终输出符合这个 JSON Schema */
  schema?: object;
  /** 接续这个会话继续执行（代理支持时生效） */
  resume?: string;
  timeoutMs: number;
  onLog?: (line: string) => void;
  /** 每次工具调用后回调：用于显示实时进度 */
  onProgress?: (p: { toolCalls: number; lastStep: string }) => void;
  signal?: AbortSignal;
}

/** 事件流里一行能提供的东西；各驱动把自己的格式翻译成这个 */
export interface StreamEvent {
  log?: string;
  tools?: { id?: string; name: string; input: string }[];
  denied?: { id?: string; tool: string }[];
  /** 会话结束时给出的完整拒绝清单；比逐条事件多时以它为准 */
  allDenials?: { tool: string; input: string }[];
  /** 代理的一段文字输出；没有 final 的驱动以最后一段为结果 */
  message?: string;
  model?: string;
  sessionId?: string;
  turns?: number;
  costUsd?: number;
  error?: string;
  final?: { ok: boolean; text: string; structured?: unknown };
}

export interface Driver {
  /** 是否提供工具调用事件；不提供时证据里的调用次数为 null（未知） */
  observable: boolean;
  plan(req: AgentRequest): { bin: string; args: string[]; stdin: string; shell?: boolean; env?: NodeJS.ProcessEnv; cleanup?: () => void };
  parse(line: string): StreamEvent;
}

export interface AgentResult {
  ok: boolean;
  /** 代理的最终文字输出；失败时是错误信息 */
  text: string;
  /** 符合 schema 的结构化输出；没有要求或没有拿到时为 undefined */
  structured?: unknown;
  evidence: RunEvidence;
}

/** 从文本里取出 JSON 对象：优先最后一个 ```json 代码块，其次整段文本，最后是最外层的花括号 */
export function extractJson(text: string): unknown {
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const block of fenced.reverse()) {
    const v = tryParse(block.trim());
    if (v !== undefined) return v;
  }
  const whole = tryParse(text.trim());
  if (whole !== undefined) return whole;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? tryParse(text.slice(start, end + 1)) : undefined;
}

/** 不支持原生结构化输出的代理：把格式要求写进提示词 */
export function schemaInstruction(schema: object): string {
  return `\n\n## 输出格式\n最后必须输出一个 JSON 对象，放在 \`\`\`json 代码块里，结构符合下面的 JSON Schema，不要省略任何必填字段：\n\`\`\`json\n${JSON.stringify(schema)}\n\`\`\``;
}

/**
 * 本地命令行代理：在代码目录下经系统 shell 执行用户配置的命令，提示词从 stdin 传入，stdout 作为结果。
 * 阶段和权限通过环境变量 ABU_STAGE、ABU_ACCESS 告知，由命令自己决定怎么限制只读。
 */
export const customDriver: Driver = {
  observable: false,
  plan(req) {
    if (!req.exec.customCommand) throw new Error('请先在「项目管理 → 配置 → 执行设置」中填写本地代理命令');
    return {
      bin: req.exec.customCommand,
      args: [],
      shell: true,
      stdin: req.schema ? req.prompt + schemaInstruction(req.schema) : req.prompt,
      env: { ...process.env, ABU_STAGE: req.stage, ABU_ACCESS: req.access },
    };
  },
  parse: (line) => ({ message: line, log: line }),
};

export const DRIVERS: Record<Provider, Driver> = { claude: claudeDriver, codex: codexDriver, custom: customDriver };

/** 运行一次代理会话，返回结果和从事件流里统计出的事实 */
export async function runAgent(req: AgentRequest, driver: Driver = DRIVERS[req.exec.provider]): Promise<AgentResult> {
  const started = Date.now();
  const log = req.onLog ?? (() => {});
  const tools: Record<string, number> = {};
  const inputs = new Map<string, string>();
  const denials: RunEvidence['denials'] = [];
  const messages: string[] = [];
  let toolCalls = 0;
  let model: string | undefined;
  let sessionId: string | undefined;
  let turns: number | undefined;
  let costUsd: number | undefined;
  let error: string | undefined;
  let final: StreamEvent['final'];

  const evidence = (): RunEvidence => ({
    stage: req.stage,
    provider: req.exec.provider,
    model,
    sessionId,
    toolCalls: driver.observable ? toolCalls : null,
    tools,
    denials,
    turns,
    costUsd,
    durationMs: Date.now() - started,
    at: Date.now(),
  });

  let plan: ReturnType<Driver['plan']>;
  try {
    plan = driver.plan(req);
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e), evidence: evidence() };
  }

  try {
    const proc = await runProcess({
      bin: plan.bin,
      args: plan.args,
      cwd: req.cwd,
      stdin: plan.stdin,
      shell: plan.shell,
      env: plan.env,
      timeoutMs: req.timeoutMs,
      onLog: log,
      signal: req.signal,
      onLine: (line) => {
        const ev = driver.parse(line);
        if (ev.log) log(ev.log);
        for (const t of ev.tools ?? []) {
          toolCalls++;
          tools[t.name] = (tools[t.name] ?? 0) + 1;
          if (t.id) inputs.set(t.id, t.input);
          req.onProgress?.({ toolCalls, lastStep: `${t.name} ${t.input}`.trim() });
        }
        for (const d of ev.denied ?? []) denials.push({ tool: d.tool, input: (d.id && inputs.get(d.id)) || '' });
        if (ev.allDenials && ev.allDenials.length > denials.length) denials.splice(0, denials.length, ...ev.allDenials);
        if (ev.message) messages.push(ev.message);
        if (ev.model) model = ev.model;
        if (ev.sessionId) sessionId = ev.sessionId;
        if (ev.turns !== undefined) turns = (turns ?? 0) + ev.turns;
        if (ev.costUsd !== undefined) costUsd = ev.costUsd;
        if (ev.error) error = ev.error;
        if (ev.final) final = ev.final;
      },
    });

    if (req.signal?.aborted) return { ok: false, text: '已手动停止', evidence: evidence() };
    if (proc.timedOut) return { ok: false, text: `执行超时（${Math.round(req.timeoutMs / 60000)} 分钟）`, evidence: evidence() };

    if (final) {
      // 要求了结构化输出却没拿到，不算失败：由调用方决定怎么处理（门禁会判为没有结论）
      const structured = req.schema ? (final.structured ?? extractJson(final.text)) : undefined;
      return { ok: final.ok, text: final.text, structured, evidence: evidence() };
    }
    if (error || proc.code !== 0) {
      const detail = error ?? `退出码 ${proc.code}${proc.stderrTail ? `\n${proc.stderrTail}` : ''}`;
      return { ok: false, text: detail, evidence: evidence() };
    }
    // 没有 final 事件的驱动：可观测的取最后一段消息，不可观测的取全部输出
    const text = (driver.observable ? (messages.at(-1) ?? '') : messages.join('\n')).trim();
    if (!text) return { ok: false, text: '代理没有任何输出', evidence: evidence() };
    return { ok: true, text, structured: req.schema ? extractJson(text) : undefined, evidence: evidence() };
  } catch (e) {
    return { ok: false, text: `无法启动代理：${e instanceof Error ? e.message : String(e)}`, evidence: evidence() };
  } finally {
    plan.cleanup?.();
  }
}

/** 证据的一行摘要，写进执行日志 */
export function evidenceLine(e: RunEvidence): string {
  const calls = e.toolCalls === null ? '工具调用次数未知（该代理不提供事件流）' : `工具调用 ${e.toolCalls} 次`;
  const denied = e.denials.length ? `，其中 ${e.denials.length} 次被权限拒绝` : '';
  return `${calls}${denied}，耗时 ${Math.round(e.durationMs / 1000)} 秒`;
}
