import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_ENV,
  DEFAULT_EXEC,
  DEFAULT_FEISHU_SOURCE,
  DEFAULT_SETTINGS,
  DEFAULT_TEST_ENV,
  type DeployEnv,
  type ExecConfig,
  type FeishuSource,
  type GitConfig,
  type Project,
  type Settings,
  type Task,
  type TaskStatus,
  type TestEnv,
} from './types.ts';

import { normalizeObserver, type ObserverSettingsPatch } from './observe-types.ts';

const MAX_LOG_LINES = 2000;

export interface FeishuCreds {
  appId: string;
  appSecret: string;
  /** 凭证来自项目设置还是全局「飞书连接」 */
  scope: 'project' | 'global';
}

/** 报错时说明用的是哪个应用：权限类错误要对着具体应用去授权 */
export function credsLabel(c: FeishuCreds): string {
  return `当前使用的飞书应用：${c.appId || '未填写'}（来自${c.scope === 'project' ? '本项目的配置' : '全局「飞书连接」'}）`;
}

type ProjectPatch = {
  name?: string;
  workdir?: string;
  feishu?: Partial<FeishuSource>;
  exec?: Partial<ExecConfig>;
  /** 整组替换部署环境，第一项为默认 */
  envs?: DeployEnv[];
  git?: Partial<GitConfig>;
  archived?: boolean;
  /** 队列被使用者手动暂停：只由队列自己写，页面的保存接口不带这一项 */
  queueHeld?: boolean;
};

/** 本地 JSON 持久化：data/tasks.json、data/projects.json 与 data/settings.json */
export class Store extends EventEmitter {
  private tasks: Task[] = [];
  private projects: Project[] = [];
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private dir: string) {
    super();
    fs.mkdirSync(dir, { recursive: true });
    this.tasks = readJson<Task[]>(this.file('tasks'), []);
    const saved = readJson<any>(this.file('settings'), {});
    this.settings = {
      feishu: { appId: saved.feishu?.appId ?? '', appSecret: saved.feishu?.appSecret ?? '' },
      observer: normalizeObserver(saved.observer),
      skills: { libraryDir: typeof saved.skills?.libraryDir === 'string' ? saved.skills.libraryDir : '' },
      models: Array.isArray(saved.models) ? saved.models.filter((m: unknown): m is string => typeof m === 'string') : [],
    };

    const projects = readJson<Project[] | null>(this.file('projects'), null);
    if (projects) {
      this.projects = projects.map(normalizeProject);
    } else {
      this.migrateLegacy(saved);
    }
  }

  /** 旧版本只有单一项目：把旧的目录、飞书链接、执行设置和已有任务迁入「默认项目」 */
  private migrateLegacy(saved: any) {
    const hasLegacy = this.tasks.length > 0 || saved.exec?.workdir || saved.feishu?.url;
    if (hasLegacy) {
      const { workdir = '', ...exec } = saved.exec ?? {};
      const project = normalizeProject({
        id: randomUUID(),
        name: '默认项目',
        workdir,
        feishu: { url: saved.feishu?.url, filterField: saved.feishu?.filterField, filterValues: saved.feishu?.filterValues },
        exec,
        createdAt: Date.now(),
      } as Project);
      this.projects = [project];
      for (const t of this.tasks) t.projectId ??= project.id;
      writeJson(this.file('tasks'), this.tasks);
    }
    writeJson(this.file('projects'), this.projects);
    writeJson(this.file('settings'), this.settings);
  }

  private file(name: string) {
    return path.join(this.dir, `${name}.json`);
  }

  // ---------- settings ----------
  getSettings(): Settings {
    return structuredClone(this.settings);
  }

  updateSettings(patch: { feishu?: Partial<Settings['feishu']>; observer?: ObserverSettingsPatch; skills?: Partial<Settings['skills']>; models?: string[] }) {
    this.settings = {
      feishu: { ...this.settings.feishu, ...patch.feishu },
      observer: patch.observer
        ? { ...this.settings.observer, ...patch.observer, exec: { ...this.settings.observer.exec, ...patch.observer.exec } }
        : this.settings.observer,
      skills: { ...this.settings.skills, ...patch.skills },
      // 整组替换：清单是使用者维护的一份完整列表
      models: patch.models ?? this.settings.models,
    };
    writeJson(this.file('settings'), this.settings);
    return this.getSettings();
  }

  /** 项目读写飞书用的应用凭证：项目单独配置了就用项目的，否则用全局的 */
  feishuCreds(projectId?: string): FeishuCreds {
    const f = projectId ? this.projects.find((p) => p.id === projectId)?.feishu : undefined;
    if (f && (f.appId || f.appSecret)) {
      // 只填了一半时不悄悄退回全局应用，否则读的是哪个应用就说不清了
      if (!f.appId || !f.appSecret) throw new Error('项目配置里的飞书应用需要同时填写 App ID 和 App Secret，或两项都留空使用全局「飞书连接」');
      return { appId: f.appId, appSecret: f.appSecret, scope: 'project' };
    }
    return { ...this.settings.feishu, scope: 'global' };
  }

  // ---------- projects ----------
  listProjects(): Project[] {
    return structuredClone(this.projects);
  }

  getProject(id: string): Project | undefined {
    const p = this.projects.find((x) => x.id === id);
    return p && structuredClone(p);
  }

  createProject(input: { name: string; workdir: string } & ProjectPatch): Project {
    const project = normalizeProject({ ...input, id: randomUUID(), createdAt: Date.now() } as Project);
    this.projects.push(project);
    this.projectsChanged();
    return structuredClone(project);
  }

  updateProject(id: string, patch: ProjectPatch): Project | undefined {
    const p = this.projects.find((x) => x.id === id);
    if (!p) return undefined;
    if (patch.name !== undefined) p.name = patch.name;
    if (patch.workdir !== undefined) p.workdir = patch.workdir;
    p.feishu = { ...p.feishu, ...patch.feishu };
    p.exec = { ...p.exec, ...patch.exec };
    if (patch.envs !== undefined) p.envs = patch.envs.map(normalizeEnv);
    p.git = { ...p.git, ...patch.git };
    if (patch.archived !== undefined) p.archived = patch.archived;
    if (patch.queueHeld !== undefined) p.queueHeld = patch.queueHeld;
    this.projectsChanged();
    return structuredClone(p);
  }

  /** 删除项目及其全部任务 */
  removeProject(id: string) {
    this.projects = this.projects.filter((p) => p.id !== id);
    this.tasks = this.tasks.filter((t) => t.projectId !== id);
    this.projectsChanged();
    this.changed();
  }

  private projectsChanged() {
    writeJson(this.file('projects'), this.projects);
    this.emit('projects');
  }

  // ---------- tasks ----------
  list(projectId?: string): Task[] {
    return projectId ? this.tasks.filter((t) => t.projectId === projectId) : this.tasks;
  }

  get(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  create(input: Pick<Task, 'projectId' | 'title' | 'description' | 'source'> & Partial<Task>): Task {
    const now = Date.now();
    const task: Task = {
      analysis: '',
      analyzing: false,
      status: 'pending_confirm',
      logs: [],
      order: now,
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.push(task);
    this.changed();
    return task;
  }

  update(id: string, patch: Partial<Task>): Task | undefined {
    const task = this.get(id);
    if (!task) return undefined;
    Object.assign(task, patch, { id: task.id, updatedAt: Date.now() });
    this.changed();
    return task;
  }

  setStatus(id: string, status: TaskStatus, extra: Partial<Task> = {}) {
    // 状态真的变了才发 status 事件（参数：任务 id、新状态、原状态），飞书回写挂在这个事件上
    const prev = this.get(id)?.status;
    const task = this.update(id, { ...extra, status });
    if (task && prev !== status) this.emit('status', id, status, prev);
    return task;
  }

  /** 任务的代码改动保存在 data/diffs/<任务 id>.diff：不放进 tasks.json，避免每次推送都带上 */
  private diffFile(id: string) {
    return path.join(this.dir, 'diffs', `${id.replace(/[^A-Za-z0-9-]/g, '')}.diff`);
  }

  saveDiff(id: string, diff: string) {
    fs.mkdirSync(path.join(this.dir, 'diffs'), { recursive: true });
    fs.writeFileSync(this.diffFile(id), diff, 'utf8');
  }

  readDiff(id: string): string | null {
    try {
      return fs.readFileSync(this.diffFile(id), 'utf8');
    } catch {
      return null;
    }
  }

  remove(id: string) {
    fs.rmSync(this.diffFile(id), { force: true });
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length !== before) this.changed();
  }

  appendLog(id: string, line: string) {
    const task = this.get(id);
    if (!task) return;
    const stamped = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`;
    task.logs.push(stamped);
    if (task.logs.length > MAX_LOG_LINES) task.logs.splice(0, task.logs.length - MAX_LOG_LINES);
    this.emit('log', { id, line: stamped });
    this.scheduleSave();
  }

  /** 项目的下一个待执行任务：todo 中 order 最小的 */
  nextTodo(projectId: string): Task | undefined {
    return this.tasks.filter((t) => t.projectId === projectId && t.status === 'todo').sort((a, b) => a.order - b.order)[0];
  }

  /** 服务重启时，未完成的执行视为中断 */
  recoverInterrupted() {
    for (const t of this.tasks) {
      if (t.status === 'in_progress' || t.status === 'testing') {
        t.status = 'blocked';
        t.error = '服务重启，执行被中断';
      }
      t.analyzing = false;
    }
    this.changed();
  }

  private changed() {
    this.emit('tasks');
    this.scheduleSave();
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 300);
  }

  flush() {
    writeJson(this.file('tasks'), this.tasks);
  }
}

/** 补全缺失字段，兼容旧数据与部分输入 */
export function normalizeProject(p: Project): Project {
  const pick = <T extends object>(defaults: T, src: any): T => {
    const out = { ...defaults };
    for (const k of Object.keys(defaults) as (keyof T)[]) if (src?.[k] !== undefined) out[k] = src[k];
    return out;
  };
  // 旧版本只有一个 testEnv：迁成单环境列表，字段原样保留
  const legacy = (p as { testEnv?: Partial<TestEnv> }).testEnv;
  const envs = Array.isArray(p.envs) && p.envs.length ? p.envs.map(normalizeEnv) : [{ ...DEFAULT_ENV, ...pick(DEFAULT_TEST_ENV, legacy) }];
  return {
    id: p.id,
    name: p.name || '未命名项目',
    workdir: p.workdir ?? '',
    feishu: pick(DEFAULT_FEISHU_SOURCE, p.feishu),
    exec: {
      ...pick(DEFAULT_EXEC, p.exec),
      // 旧数据没有验证方式：配置了测试命令的项目原来只跑测试命令，保持不变
      ...(p.exec?.verificationMode === undefined && p.exec?.testCommand ? { verificationMode: 'command' as const } : {}),
    },
    envs,
    git: pick({ username: '', password: '' }, p.git),
    archived: Boolean(p.archived),
    queueHeld: Boolean(p.queueHeld),
    createdAt: p.createdAt ?? Date.now(),
  };
}

export function normalizeEnv(e: Partial<DeployEnv> & { id?: string }): DeployEnv {
  const pick = <T extends object>(defaults: T, src: any): T => {
    const out = { ...defaults };
    for (const k of Object.keys(defaults) as (keyof T)[]) if (src?.[k] !== undefined) out[k] = src[k];
    return out;
  };
  const env = pick(DEFAULT_ENV, e);
  env.id = e.id || randomUUID();
  env.port = Number.isFinite(Number(env.port)) ? Math.min(65535, Math.max(1, Math.round(Number(env.port)))) : 22;
  return env;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
