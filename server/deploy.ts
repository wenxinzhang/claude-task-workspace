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

    const step = async (name: string, fn: () => Promise<boolean>) => {
      const st: DeployStep = { name, status: 'running' };
      s.steps.push(st);
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

    void (async () => {
      let ok = true;
      if (opts.buildCommand) {
        ok = await step('构建产物', async () => (await runShell(opts.buildCommand!, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, log, signal, label: '构建命令', env: opts.env })) === 0);
      }
      if (ok && !signal.aborted) {
        ok = await step('发布服务', async () => (await runShell(opts.command, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, log, signal, label: '部署命令', env: opts.env })) === 0);
      }
      if (ok && !signal.aborted && opts.healthCheck) {
        ok = await step('健康检查', async () => {
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
      s.ok = ok && !signal.aborted;
      log(signal.aborted ? '部署已手动停止' : s.ok ? '部署成功' : '部署失败');
      Object.assign(s, { running: false, finishedAt: Date.now(), abort: null });
      this.emit('status');
    })();
  }

  stop(projectId: string) {
    this.state(projectId).abort?.abort();
  }
}
