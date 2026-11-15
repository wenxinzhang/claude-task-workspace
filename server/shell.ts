import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface Cli {
  bin: string;
  /** 排在用户参数之前的参数（用 node 运行 js 入口时是脚本路径） */
  prefix: string[];
}

const cliCache = new Map<string, Cli>();

/**
 * 找到命令行工具的真实入口。Windows 下 npm 安装的是 .cmd 包装脚本，经 shell 调用会遇到参数转义问题，
 * 所以解析出它指向的 .exe，或指向的 js 入口（改用当前 node 运行）。
 */
export function resolveCli(name: string, envVar: string, pathEnv = process.env.PATH ?? '', platform = process.platform): Cli {
  const override = process.env[envVar];
  if (override) return { bin: override, prefix: [] };
  if (platform !== 'win32') return { bin: name, prefix: [] };
  const key = `${name}\0${pathEnv}`;
  const hit = cliCache.get(key);
  if (hit) return hit;

  const found = (cli: Cli) => {
    cliCache.set(key, cli);
    return cli;
  };
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const exe = path.join(dir, `${name}.exe`);
    if (fs.existsSync(exe)) return found({ bin: exe, prefix: [] });
    const cmd = path.join(dir, `${name}.cmd`);
    if (!fs.existsSync(cmd)) continue;
    const text = fs.readFileSync(cmd, 'utf8');
    const js = /"%dp0%\\([^"]+\.[cm]?js)"/i.exec(text)?.[1];
    if (js && fs.existsSync(path.join(dir, js))) return found({ bin: process.execPath, prefix: [path.join(dir, js)] });
    // 包装脚本里的 node.exe 是解释器，不是工具本身
    for (const m of text.matchAll(/"%dp0%\\([^"]+\.exe)"/gi)) {
      if (path.basename(m[1]).toLowerCase() === 'node.exe') continue;
      const target = path.join(dir, m[1]);
      if (fs.existsSync(target)) return found({ bin: target, prefix: [] });
    }
  }
  throw new Error(`未找到 ${name} 可执行文件，请确认已安装，或设置环境变量 ${envVar}`);
}

export function killTree(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  } else {
    child.kill('SIGTERM');
  }
}

export interface ProcOptions {
  bin: string;
  args: string[];
  cwd: string;
  /** 写入 stdin 后关闭 */
  stdin?: string;
  timeoutMs: number;
  /** stdout 的每一行（已去掉换行，空行不回调） */
  onLine: (line: string) => void;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
  /** 经系统 shell 执行：此时 bin 是完整命令行，args 需要调用方自行加引号 */
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ProcResult {
  code: number | null;
  /** stderr 的最后几行，用于报错 */
  stderrTail: string;
  timedOut: boolean;
}

/** 运行一个子进程，按行回调 stdout；超时或手动停止时结束整个进程树 */
export function runProcess(o: ProcOptions): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(o.bin, o.args, {
        cwd: o.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: o.shell ?? false,
        env: o.env ?? process.env,
      });
    } catch (e) {
      reject(e);
      return;
    }

    const log = o.onLog ?? (() => {});
    let buffer = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      log(`执行超时（${Math.round(o.timeoutMs / 60000)} 分钟），终止进程`);
      killTree(child);
    }, o.timeoutMs);
    const onAbort = () => {
      log('已手动停止');
      killTree(child);
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) o.onLine(line);
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      if (buffer.trim()) o.onLine(buffer.trim());
      resolve({ code, stderrTail: stderr.trim().split('\n').slice(-5).join('\n'), timedOut });
    });

    // 子进程提前退出时写 stdin 会触发 EPIPE，退出原因由 close 事件报告
    child.stdin!.on('error', () => {});
    child.stdin!.end(o.stdin ?? '', 'utf8');
  });
}

/** 经系统 shell 运行用户配置的命令，逐行输出日志，返回退出码（超时/停止时为 null） */
export function runShell(
  command: string,
  opts: { cwd: string; timeoutMs: number; log: (l: string) => void; signal: AbortSignal; label: string; env?: Record<string, string> },
): Promise<number | null> {
  const { cwd, timeoutMs, log, signal, label } = opts;
  return new Promise((resolve) => {
    log(`$ ${command}`);
    // env 里的值（服务器账号密码等）只进子进程的环境变量，不写进日志
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: opts.env ? { ...process.env, ...opts.env } : undefined });
    const timer = setTimeout(() => {
      log(`${label}超时（${Math.round(timeoutMs / 60000)} 分钟），终止进程`);
      killTree(child);
    }, timeoutMs);
    const onAbort = () => killTree(child);
    signal.addEventListener('abort', onAbort, { once: true });

    let pending = '';
    const onData = (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) log(l);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => log(`${label}启动失败：${err.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (pending.trim()) log(pending);
      log(`${label}退出码 ${code}`);
      resolve(code);
    });
  });
}
