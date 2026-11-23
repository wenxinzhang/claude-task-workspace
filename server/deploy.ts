import { EventEmitter } from 'node:events';
import { runShell } from './shell.ts';
import type { DeployStatus, DeployStep } from './types.ts';

const MAX_LINES = 2000;

interface DeployState extends DeployStatus {
  logs: string[];
  steps: DeployStep[];
  abort: AbortController | null;
}

export interface DeployOptions {
  /** 发布服务命令，在代码目录下经系统 shell 执行 */
  command: string;
  cwd: string;
  timeoutMs: number;
  commit?: string;
  /** 构建命令，留空跳过构建步骤 */
  buildCommand?: string;
  /** 健康检查 URL，留空跳过；GET 2xx 视为通过 */
  healthCheck?: string;
  envName?: string;
  /** 传给构建命令与部署命令的环境变量：部署环境里填的服务器地址、账号、密码等，脚本用它连服务器 */
  env?: Record<string, string>;
  /**
   * 部署智能体：某一步失败后调用，让智能体读日志、在代码目录里改问题；返回 true 表示已修好可以重新部署。
   * 不传则失败即结束（保持原来的行为）
   */
  repair?: (ctx: RepairContext) => Promise<boolean>;
  /** 最多自动修复几轮，默认 3 */
  maxRepairs?: number;
}

export interface RepairContext {
  round: number;
  maxRounds: number;
  /** 没通过的步骤：构建产物 / 发布服务 / 健康检查 */
  failedStep: string;
  /** 最近的部署日志（含失败输出） */
  logs: string[];
  log: (line: string) => void;
  signal: AbortSignal;
}

/** 部署智能体的输出格式 */
export const DEPLOY_REPAIR_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'boolean', description: '是否已找到原因并改好，可以重新部署' },
    cause: { type: 'string', description: '失败原因' },
    summary: { type: 'string', description: '做了哪些修改（文件与要点）；没修好时说明卡在哪' },
  },
  required: ['fixed', 'cause', 'summary'],
  additionalProperties: false,
};

/** 把敏感值（密码等）从文本里抹掉，再交给大模型；短于 4 个字符的值不替换，免得误伤普通文本 */
export function redactSecrets(lines: string[], secrets: (string | undefined)[]): string[] {
  const vals = secrets.filter((v): v is string => !!v && v.length >= 4).sort((a, b) => b.length - a.length);
  if (!vals.length) return lines;
  return lines.map((l) => vals.reduce((acc, v) => acc.split(v).join('***'), l));
}

/** 给部署智能体的提示词：只描述事实与边界，不带密码 */
export function deployRepairPrompt(
  ctx: Pick<RepairContext, 'round' | 'maxRounds' | 'failedStep' | 'logs'>,
  info: { envName: string; buildCommand?: string; command: string; healthCheck?: string },
): string {
  return [
    `你是部署智能体。本项目部署到「${info.envName}」时，「${ctx.failedStep}」这一步没通过（第 ${ctx.round}/${ctx.maxRounds} 轮修复）。`,
    '你的任务：读下面的日志找出原因，直接在当前代码目录里改好，让重新部署能通过。改完不要询问，直接给结论。',
    '',
    '## 部署流程（你修完后系统会自动重跑，你不用自己执行部署命令）',
    info.buildCommand ? `- 构建命令：\`${info.buildCommand}\`` : '- 构建命令：无',
    `- 部署命令：\`${info.command}\``,
    info.healthCheck ? `- 健康检查：GET ${info.healthCheck}，2xx 视为通过` : '- 健康检查：无',
    '- 部署脚本通过环境变量拿服务器信息：DEPLOY_HOST、DEPLOY_PORT、DEPLOY_USER、DEPLOY_PASSWORD、DEPLOY_URL、DEPLOY_COMMIT',
    '',
    '## 边界',
    '- 可以改代码、构建配置、部署脚本；可以跑构建、类型检查、测试来确认。',
    '- 不要 git commit / push / 切分支，不要删除与问题无关的文件，不要把密码写进文件。',
    '- 代码改不了的问题（服务器宕机、账号密码错、网络不通），fixed 返回 false，并在 summary 里写清楚需要人做什么。',
    '',
    '## 最近的部署日志',
    '```',
    ...ctx.logs,
    '```',
  ].join('\n');
}

/** 每个项目一个部署进程：构建产物 → 发布服务 → 健康检查，配置了才跑，时长按实际计时 */
export class Deployer extends EventEmitter {
  private states = new Map<string, DeployState>();

  private state(projectId: string): DeployState {
    let s = this.states.get(projectId);
    if (!s) this.states.set(projectId, (s = { running: false, logs: [], steps: [], abort: null }));
    return s;
  }

  status(projectId: string): DeployStatus {
    const { logs: _logs, abort: _abort, ...rest } = this.state(projectId);
    return rest;
  }

  allStatus(): Record<string, DeployStatus> {
    return Object.fromEntries([...this.states.keys()].map((id) => [id, this.status(id)]));
  }

  logs(projectId: string): string[] {
    return [...this.state(projectId).logs];
  }

  start(projectId: string, opts: DeployOptions) {
    const s = this.state(projectId);
    if (s.running) throw new Error('正在部署中');
    Object.assign(s, {
      running: true,
      startedAt: Date.now(),
      finishedAt: undefined,
      ok: undefined,
      commit: opts.commit,
      envName: opts.envName,
      repaired: undefined,
      passStart: undefined,
      aborted: undefined,
      logs: [],
      steps: [],
    });
    s.abort = new AbortController();
    const signal = s.abort.signal;
    const log = (line: string) => {
      const stamped = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`;
      s.logs.push(stamped);
      if (s.logs.length > MAX_LINES) s.logs.splice(0, s.logs.length - MAX_LINES);
      this.emit('log', { projectId, line: stamped });
    };
    this.emit('status');

    log(`===== 开始部署${opts.envName ? ` · ${opts.envName}` : ''}${opts.commit ? `（${opts.commit}）` : ''} =====`);

    /** 跑一步：传入已排好的 pending 步骤就就地改状态，否则追加一条新步骤（如智能体修复） */
    const step = async (name: string, fn: () => Promise<boolean>, planned?: DeployStep) => {
      const st: DeployStep = planned ?? { name, status: 'running' };
      st.status = 'running';
      if (!planned) s.steps.push(st);
      this.emit('status');
      const t0 = Date.now();
      let ok = false;
      try {
        ok = await fn();
      } catch (e) {
        log(`${name}异常：${e instanceof Error ? e.message : String(e)}`);
      }
      st.status = ok && !signal.aborted ? 'ok' : 'fail';
      st.durationMs = Date.now() - t0;
      log(`${name}${st.status === 'ok' ? '完成' : '未通过'}，用时 ${(st.durationMs / 1000).toFixed(1)} s`);
      this.emit('status');
      return st.status === 'ok';
    };

    /** 跑一遍 构建 → 发布 → 健康检查；全部通过返回 undefined，否则返回没通过的那一步 */
    const runPipeline = async (attempt: number): Promise<string | undefined> => {
      const tag = attempt > 0 ? `（第 ${attempt + 1} 次）` : '';
      // 一开始就把这一遍要跑的步骤都排好（pending），前端才知道一共几步、现在第几步
      const names = [opts.buildCommand && '构建产物', '发布服务', opts.healthCheck && '健康检查'].filter((n): n is string => !!n);
      const planned = new Map<string, DeployStep>(names.map((n) => [n, { name: n + tag, status: 'pending' as const }]));
      // 记下这一遍从第几步开始：前端进度只按这一遍算，修复重试时不会往回跳
      s.passStart = s.steps.length;
      s.steps.push(...planned.values());
      this.emit('status');
      const run = async (name: string, fn: () => Promise<boolean>) => {
        const ok = await step(name + tag, fn, planned.get(name));
        if (!ok) {
          // 这一步没通过：后面还没轮到的步骤不会再跑，标成跳过
          for (const p of planned.values()) if (p.status === 'pending') p.status = 'skipped';
          this.emit('status');
        }
        return ok ? undefined : name;
      };
      if (opts.buildCommand) {
        const f = await run('构建产物', async () => (await runShell(opts.buildCommand!, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, log, signal, label: '构建命令', env: opts.env })) === 0);
        if (f || signal.aborted) return f ?? '构建产物';
      }
      const f = await run('发布服务', async () => (await runShell(opts.command, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, log, signal, label: '部署命令', env: opts.env })) === 0);
      if (f || signal.aborted) return f ?? '发布服务';
      if (opts.healthCheck) {
        return run('健康检查', async () => {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 15_000);
          try {
            const res = await fetch(opts.healthCheck!, { signal: ctrl.signal });
            log(`健康检查 ${opts.healthCheck} → ${res.status}`);
            return res.ok;
          } finally {
            clearTimeout(timer);
          }
        });
      }
      return undefined;
    };

    void (async () => {
      const rawMax = opts.repair ? Number(opts.maxRepairs ?? 3) : 0;
      const maxRepairs = Number.isFinite(rawMax) ? Math.max(0, Math.floor(rawMax)) : 0;
      // 名字里带密码/密钥/令牌的环境变量值，交给智能体前从日志里抹掉
      const secrets = Object.entries(opts.env ?? {})
        .filter(([k]) => /PASS|SECRET|TOKEN|KEY/i.test(k))
        .map(([, v]) => v);
      let pipelineStart = s.logs.length;
      let failed = await runPipeline(0);
      let repaired = 0;
      let rounds = 0;
      // 部署智能体：失败后自己读日志、改问题、再部署，直到通过或轮数用完；手动停止立即结束
      for (let round = 1; failed && !signal.aborted && round <= maxRepairs; round++) {
        rounds = round;
        // 只给这一次流水线的日志，避免上一轮智能体的输出挤掉真正的失败信息
        const failLogs = redactSecrets(s.logs.slice(Math.max(pipelineStart, s.logs.length - 300)), secrets);
        log(`===== ${failed}未通过，部署智能体开始第 ${round}/${maxRepairs} 轮排查修复 =====`);
        const failedStep = failed;
        const fixed = await step(`智能体修复（第 ${round} 轮）`, () =>
          opts.repair!({ round, maxRounds: maxRepairs, failedStep, logs: failLogs, log, signal }),
        );
        if (signal.aborted) break;
        if (!fixed) {
          log('部署智能体这一轮没能修好，停止重试');
          break;
        }
        repaired = round;
        log('===== 修复完成，重新部署（工作区含部署智能体未提交的改动） =====');
        pipelineStart = s.logs.length;
        failed = await runPipeline(round);
      }
      // 手动停止等情况下可能留下没轮到的步骤，结束时统一标成跳过
      for (const p of s.steps) if (p.status === 'pending') p.status = 'skipped';
      s.ok = !failed && !signal.aborted;
      s.aborted = signal.aborted || undefined;
      s.repaired = repaired > 0;
      if (signal.aborted) log('部署已手动停止');
      else if (s.ok) log(repaired ? `部署成功（部署智能体修复 ${repaired} 轮后通过，含未提交改动）` : '部署成功');
      else log(rounds ? `部署失败：${failed}未通过，部署智能体共尝试 ${rounds} 轮` : '部署失败');
      // 最后一行重复失败原因，方便只看末尾几行的地方（观察项）拿到真正的失败信息
      if (!s.ok && !signal.aborted && rounds) log(`最初失败的步骤：${failed}，详见上方日志`);
      Object.assign(s, { running: false, finishedAt: Date.now(), abort: null });
      this.emit('status');
    })();
  }

  stop(projectId: string) {
    this.state(projectId).abort?.abort();
  }
}
