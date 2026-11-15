import fs from 'node:fs';
import path from 'node:path';
import { SCHEDULE_TIME } from './schedule.ts';
import { CODEX_SANDBOXES, PERMISSION_MODES, PROVIDERS, type DeployEnv, type ExecConfig, type FeishuSource, type GitConfig, type Settings } from './types.ts';
import { normalizeEnv } from './store.ts';
import type { ObserverSettingsPatch } from './observe-types.ts';

export type SettingsPatch = { feishu?: Partial<Settings['feishu']>; vault?: Partial<Settings['vault']>; observer?: ObserverSettingsPatch; skills?: Partial<Settings['skills']>; models?: string[] };
export type ProjectPatch = {
  name?: string;
  workdir?: string;
  feishu?: Partial<FeishuSource>;
  exec?: Partial<ExecConfig>;
  envs?: DeployEnv[];
  git?: Partial<GitConfig>;
  archived?: boolean;
};

const str = (v: unknown, max = 2000) => {
  if (typeof v !== 'string') throw new Error('参数类型错误');
  if (v.length > max) throw new Error('参数过长');
  return v.trim();
};

/** skill 名称列表：只保留合法名称（字母数字、-、_、:），规范成空格分隔 */
const skillList = (v: unknown) =>
  str(v, 1000)
    .split(/[\s,，、]+/)
    .filter((s) => /^[\w:.-]{1,80}$/.test(s))
    .join(' ');

/** 模型名会作为代理命令的参数：只接受字母数字与 . _ - [ ] */
const MODEL_NAME = /^[A-Za-z0-9._\-\[\]]+$/;
const MAX_MODELS = 50;

/** 可用模型清单：逐个校验名称，去重并保持使用者填写的顺序。清单里的名称不允许以 - 开头（那是命令行参数的写法） */
function modelList(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error('模型清单格式不正确');
  if (v.length > MAX_MODELS) throw new Error(`模型清单最多 ${MAX_MODELS} 个`);
  const out: string[] = [];
  for (const item of v) {
    const name = str(item, 100);
    if (!name) continue;
    if (!MODEL_NAME.test(name) || name.startsWith('-')) throw new Error(`模型名称格式不正确：${name.slice(0, 40)}`);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export function validateSettingsPatch(body: any): SettingsPatch {
  const patch: SettingsPatch = {};
  if (body?.feishu) {
    const f = body.feishu;
    patch.feishu = {};
    if (f.appId !== undefined) patch.feishu.appId = str(f.appId, 200);
    if (f.appSecret !== undefined) patch.feishu.appSecret = str(f.appSecret, 200);
  }
  if (body?.vault) {
    patch.vault = {};
    if (body.vault.path !== undefined) patch.vault.path = str(body.vault.path, 500);
    if (body.vault.enabled !== undefined) patch.vault.enabled = Boolean(body.vault.enabled);
  }
  if (body?.skills) {
    patch.skills = {};
    if (body.skills.libraryDir !== undefined) {
      const raw = str(body.skills.libraryDir, 500);
      // 留空表示不用库；填了就必须是本机上存在的绝对路径（不接受网络共享路径）
      if (raw && (!path.isAbsolute(raw) || raw.startsWith('\\') || !fs.existsSync(raw) || !fs.statSync(raw).isDirectory())) throw new Error('skill 库目录需要是本机上已存在的目录的绝对路径');
      patch.skills.libraryDir = raw ? path.resolve(raw) : '';
    }
  }
  if (body?.models !== undefined) patch.models = modelList(body.models);
  if (body?.observer) {
    const o = body.observer;
    patch.observer = {};
    if (o.enabled !== undefined) patch.observer.enabled = Boolean(o.enabled);
    if (o.autoOptimize !== undefined) patch.observer.autoOptimize = Boolean(o.autoOptimize);
    if (o.minNewObservations !== undefined) {
      const n = Number(o.minNewObservations);
      if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('诊断阈值需在 1-50 之间');
      patch.observer.minNewObservations = n;
    }
    if (o.cooldownHours !== undefined) {
      const n = Number(o.cooldownHours);
      if (!Number.isFinite(n) || n < 0.5 || n > 168) throw new Error('冷却需在 0.5-168 小时之间');
      patch.observer.cooldownHours = n;
    }
    if (o.exec !== undefined) patch.observer.exec = validateExec(o.exec);
  }
  return patch;
}

/** 代码目录必须是已存在的绝对路径 */
export function checkWorkdir(dir: string): string {
  if (!dir) throw new Error('请填写代码目录');
  if (!path.isAbsolute(dir)) throw new Error('代码目录需要是绝对路径');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`代码目录不存在：${dir}`);
  return path.resolve(dir);
}

export function validateProjectPatch(body: any): ProjectPatch {
  const patch: ProjectPatch = {};
  if (body?.name !== undefined) {
    patch.name = str(body.name, 100);
    if (!patch.name) throw new Error('项目名称不能为空');
  }
  if (body?.workdir !== undefined) patch.workdir = checkWorkdir(str(body.workdir, 500));
  if (body?.feishu) {
    const f = body.feishu;
    patch.feishu = {};
    if (f.url !== undefined) patch.feishu.url = str(f.url);
    if (f.name !== undefined) patch.feishu.name = str(f.name, 100);
    if (f.appId !== undefined) patch.feishu.appId = str(f.appId, 200);
    if (f.appSecret !== undefined) patch.feishu.appSecret = str(f.appSecret, 200);
    if (f.filterField !== undefined) patch.feishu.filterField = str(f.filterField, 100);
    if (f.filterValues !== undefined) patch.feishu.filterValues = str(f.filterValues, 1000);
    if (f.assigneeField !== undefined) patch.feishu.assigneeField = str(f.assigneeField, 100);
    if (f.assigneeValues !== undefined) patch.feishu.assigneeValues = str(f.assigneeValues, 1000);
    if (f.autoAnalyze !== undefined) patch.feishu.autoAnalyze = Boolean(f.autoAnalyze);
    if (f.writeBack !== undefined) patch.feishu.writeBack = Boolean(f.writeBack);
    if (f.writeBackField !== undefined) patch.feishu.writeBackField = str(f.writeBackField, 100);
    for (const k of ['writeBackTodoValue', 'writeBackReviewValue', 'writeBackDoneValue'] as const) {
      if (f[k] !== undefined) patch.feishu[k] = str(f[k], 100);
    }
  }
  if (body?.exec) patch.exec = validateExec(body.exec);
  if (body?.git) {
    const g = body.git;
    patch.git = {};
    if (g.username !== undefined) patch.git.username = str(g.username, 200);
    if (g.password !== undefined) patch.git.password = str(g.password, 200);
  }
  if (body?.archived !== undefined) patch.archived = Boolean(body.archived);
  if (body?.envs !== undefined) patch.envs = validateEnvs(body.envs);
  return patch;
}

/** 部署环境整组校验：1-10 个，名称必填，端口范围合法 */
function validateEnvs(list: unknown): DeployEnv[] {
  if (!Array.isArray(list) || list.length < 1 || list.length > 10) throw new Error('部署环境需要 1-10 个');
  return list.map((e: any) => {
    const name = str(e?.name, 100);
    if (!name) throw new Error('环境名称不能为空');
    const port = e?.port === undefined || e?.port === '' ? 22 : Number(e.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口号需在 1-65535 之间');
    const env = normalizeEnv({
      id: typeof e?.id === 'string' ? e.id.slice(0, 64) : undefined,
      name,
      host: str(e?.host ?? '', 200),
      port,
      url: str(e?.url ?? '', 1000),
      username: str(e?.username ?? '', 200),
      password: str(e?.password ?? '', 200),
      server: str(e?.server ?? '', 4000),
      notes: str(e?.notes ?? '', 4000),
      shareWithClaude: e?.shareWithClaude === undefined ? true : Boolean(e.shareWithClaude),
      deployCommand: str(e?.deployCommand ?? '', 2000),
      buildCommand: str(e?.buildCommand ?? '', 2000),
      healthCheck: str(e?.healthCheck ?? '', 1000),
    });
    if (env.healthCheck && !/^https?:\/\//.test(env.healthCheck)) throw new Error('健康检查需要是 http(s) 地址');
    return env;
  });
}

/** 执行配置会作为 claude 命令行参数，必须白名单化 */
function validateExec(e: any): Partial<ExecConfig> {
  const out: Partial<ExecConfig> = {};
  if (e.provider !== undefined) {
    if (!PROVIDERS.includes(e.provider)) throw new Error('不支持的代理类型');
    out.provider = e.provider;
  }
  if (e.verificationMode !== undefined) {
    if (e.verificationMode !== 'agent' && e.verificationMode !== 'command') throw new Error('verificationMode 取值错误');
    out.verificationMode = e.verificationMode;
  }
  if (e.codexSandbox !== undefined) {
    if (!CODEX_SANDBOXES.includes(e.codexSandbox)) throw new Error('不支持的 Codex 沙箱模式');
    out.codexSandbox = e.codexSandbox;
  }
  if (e.codexModel !== undefined) {
    const v = str(e.codexModel, 100);
    if (v && !/^[A-Za-z0-9._\-\[\]]+$/.test(v)) throw new Error('模型名称格式不正确');
    out.codexModel = v;
  }
  // 本地代理命令和测试命令、部署命令一样，由使用者填写并经系统 shell 执行
  if (e.customCommand !== undefined) out.customCommand = str(e.customCommand, 2000);
  if (e.verifyCommands !== undefined) {
    const v = str(e.verifyCommands, 2000);
    // 每行的第一个词会成为放行的程序名，只接受程序名本身
    for (const line of v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      if (!/^[A-Za-z][\w.-]*(\s|$)/.test(line)) throw new Error(`验证命令需要以程序名开头，例如 python、npm：${line.slice(0, 40)}`);
    }
    out.verifyCommands = v;
  }
  if (e.budgetUsd !== undefined) {
    const n = Number(e.budgetUsd);
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error('花费上限需在 0-1000 美元之间，0 表示不限');
    out.budgetUsd = Math.round(n * 100) / 100;
  }
  if (e.testTimeoutMinutes !== undefined) {
    const n = Number(e.testTimeoutMinutes);
    if (!Number.isFinite(n) || n < 1 || n > 240) throw new Error('超时需在 1-240 分钟之间');
    out.testTimeoutMinutes = Math.round(n);
  }
  if (e.testCommand !== undefined) out.testCommand = str(e.testCommand, 500);
  if (e.extraPrompt !== undefined) out.extraPrompt = str(e.extraPrompt, 4000);
  if (e.allowedTools !== undefined) {
    const v = str(e.allowedTools, 1000);
    if (/^-/.test(v) || /\s-/.test(v)) throw new Error('allowedTools 不能包含命令行参数');
    out.allowedTools = v;
  }
  if (e.permissionMode !== undefined) {
    if (!PERMISSION_MODES.includes(e.permissionMode)) throw new Error('不支持的权限模式');
    out.permissionMode = e.permissionMode;
  }
  if (e.model !== undefined) {
    const v = str(e.model, 100);
    if (v && !/^[A-Za-z0-9._\-\[\]]+$/.test(v)) throw new Error('模型名称格式不正确');
    out.model = v;
  }
  if (e.scheduleEnabled !== undefined) out.scheduleEnabled = Boolean(e.scheduleEnabled);
  if (e.scheduleTime !== undefined) {
    const v = str(e.scheduleTime, 5);
    if (!SCHEDULE_TIME.test(v)) throw new Error('定时启动的时间格式应为 HH:MM，例如 22:00');
    out.scheduleTime = v;
  }
  if (e.useBranch !== undefined) out.useBranch = Boolean(e.useBranch);
  if (e.autoCommit !== undefined) out.autoCommit = Boolean(e.autoCommit);
  if (e.useKnowledge !== undefined) out.useKnowledge = Boolean(e.useKnowledge);
  if (e.autoConfirm !== undefined) out.autoConfirm = Boolean(e.autoConfirm);
  if (e.autoStart !== undefined) out.autoStart = Boolean(e.autoStart);
  for (const key of ['analysisSkills', 'implementSkills', 'verifySkills', 'disabledSkills'] as const) {
    if (e[key] !== undefined) out[key] = skillList(e[key]);
  }
  if (e.passTarget !== undefined) {
    if (e.passTarget !== 'done' && e.passTarget !== 'review') throw new Error('passTarget 取值错误');
    out.passTarget = e.passTarget;
  }
  if (e.timeoutMinutes !== undefined) {
    const n = Number(e.timeoutMinutes);
    if (!Number.isFinite(n) || n < 1 || n > 240) throw new Error('超时需在 1-240 分钟之间');
    out.timeoutMinutes = Math.round(n);
  }
  if (e.analyzeTimeoutMinutes !== undefined) {
    const n = Number(e.analyzeTimeoutMinutes);
    if (!Number.isFinite(n) || n < 1 || n > 60) throw new Error('生成规格的超时需在 1-60 分钟之间');
    out.analyzeTimeoutMinutes = Math.round(n);
  }
  if (e.verifyModel !== undefined) {
    const v = str(e.verifyModel, 100);
    if (v && !/^[A-Za-z0-9._\-\[\]]+$/.test(v)) throw new Error('验证模型名称格式不正确');
    out.verifyModel = v;
  }
  if (e.skipReview !== undefined) out.skipReview = Boolean(e.skipReview);
  return out;
}
