// @cli-output 服务入口：启动地址与定时启动队列的记录打到启动它的终端，是运行日志不是调试输出
import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { credsLabel, Store } from './store.ts';
import { Queue } from './queue.ts';
import { AttachmentCache, MAX_UPLOAD_BYTES } from './attachments.ts';
import { Deployer, DEPLOY_REPAIR_SCHEMA, deployRepairPrompt } from './deploy.ts';
import { runAgent } from './agent.ts';
import { History, aiRecordFromTask } from './history.ts';
import { listLibrarySkills, listSkills, skillLibraryProblem } from './skills.ts';
import { authArgs, branches, checkout, commitsBetween, git, repoInfo, setRemote, syncRemote, type RepoInfo, type SyncResult } from './git.ts';
import { lastDeployed } from './deploy-check.ts';
import { defaultEnv } from './types.ts';
import { openQuestions } from './shared.ts';
import { detectVerifyKit } from './verifykit.ts';
import { fetchRecords, filterRecords } from './feishu.ts';
import { normalizeSpec, renderSpec, specHash } from './spec.ts';
import { pullFeishuStatus, writeBackTask } from './writeback.ts';
import { dayKey, dueProjects } from './schedule.ts';
import { validateProjectPatch, validateSettingsPatch } from './validate.ts';
import { STATUSES, type Project, type Task, type TaskStatus } from './types.ts';
import { createObserver } from './observer.ts';
import { registerObserverRoutes } from './observe-api.ts';
import { githubRepository } from './observation-issue.ts';
import { effectiveAttribution } from './observe-types.ts';
import { registerScreenshotRoutes, ScreenshotDiagnoser } from './screenshot-diagnose.ts';

const PORT = Number(process.env.PORT ?? 5174);
const HOST = '127.0.0.1'; // 仅本机访问，无鉴权
const root = process.cwd();

const store = new Store(path.join(root, 'data'));
store.recoverInterrupted();
const attachments = new AttachmentCache(path.join(root, 'data', 'attachments'), (projectId) => store.feishuCreds(projectId));
const queue = new Queue(store, attachments);
const deployer = new Deployer();
// 部署进行中（含部署智能体修代码）时队列不取新任务：两个写权限智能体不能同时改同一个代码目录；
// 部署结束时下面的 status 监听会再 tick 一次，把等着的任务接上
queue.setBlocker((projectId) => deployer.status(projectId).running);
const history = new History(path.join(root, 'data'));
history.backfillAI(store.list());

// ---------- 实时推送 ----------
// clients 必须先于 createObserver 声明：观察者初始化时的重启恢复会同步广播状态
const clients = new Set<Response>();
function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(payload);
}
const observer = createObserver({ root, store, queue, deployer, onBroadcast: broadcast });

const app = express();
app.use(express.json({ limit: '1mb' }));

const brief = (t: Task) => ({ ...t, logs: undefined, logCount: t.logs.length });

const SECRET_MASK = '********';

function publicSettings() {
  const s = store.getSettings();
  return { ...s, feishu: { ...s.feishu, appSecret: s.feishu.appSecret ? SECRET_MASK : '' } };
}

/** 发给页面的项目信息：飞书 App Secret、Git 密码只告知是否已填 */
const publicProject = <T extends Project | undefined>(p: T): T =>
  p ? { ...p, feishu: { ...p.feishu, appSecret: p.feishu.appSecret ? SECRET_MASK : '' }, git: { ...p.git, password: p.git.password ? SECRET_MASK : '' } } : p;
const publicProjects = () => store.listProjects().map(publicProject);

/** 页面原样传回的掩码不是新密钥，丢弃后保留已保存的值 */
function dropMaskedSecret<T extends { feishu?: { appSecret?: string }; git?: { password?: string } }>(patch: T): T {
  if (patch.feishu?.appSecret === SECRET_MASK) delete patch.feishu.appSecret;
  if (patch.git?.password === SECRET_MASK) delete patch.git.password;
  return patch;
}

function wrap(fn: (req: Request, res: Response) => Promise<unknown> | unknown) {
  return async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  };
}

function mustGet(id: string) {
  const t = store.get(id);
  if (!t) throw new Error('任务不存在');
  return t;
}

function mustGetProject(id: string) {
  const p = store.getProject(id);
  if (!p) throw new Error('项目不存在');
  return p;
}

let tasksTimer: NodeJS.Timeout | null = null;
const pushTasks = () => {
  if (tasksTimer) return;
  tasksTimer = setTimeout(() => {
    tasksTimer = null;
    broadcast('tasks', store.list().map(brief));
    broadcast('queue', queue.allStatus());
  }, 100);
};
store.on('tasks', () => {
  pushTasks();
  queue.tick(); // 新任务进入待办时，若队列在运行则自动开始
});
store.on('projects', () => {
  broadcast('projects', publicProjects());
  broadcast('queue', queue.allStatus());
  // 勾选自动开工、或改了配置后，不必等下一次任务变化才生效
  queue.tick();
});
store.on('log', (e) => broadcast('log', e));
history.on('change', (projectId: string) => broadcast('history', { projectId, records: history.list(projectId) }));

// 部署状态同步到执行记录：运行中更新步骤，结束后落结论与日志
const deployRecordIds = new Map<string, string>();
deployer.on('status', () => {
  broadcast('deploy', deployer.allStatus());
  for (const [pid, st] of Object.entries(deployer.allStatus())) {
    const rid = deployRecordIds.get(pid);
    if (!rid) continue;
    if (st.running) {
      history.update(rid, { steps: st.steps });
    } else {
      // 记录状态没有「已停止」一档：手动停止仍记 failed，但在 error 里写明，执行记录页能看出不是真失败
      history.update(rid, {
        status: st.ok ? 'success' : 'failed',
        finishedAt: st.finishedAt,
        steps: st.steps,
        repaired: st.repaired,
        logs: deployer.logs(pid).slice(-200),
        ...(st.aborted ? { error: '已手动停止' } : {}),
      });
      deployRecordIds.delete(pid);
      observer.collectDeployResult(pid, st, deployer.logs(pid));
    }
  }
  // 部署结束后解除队列占用：让部署期间等着的任务开始
  queue.tick();
});
deployer.on('log', (e) => {
  broadcast('deploy-log', e);
  const rid = deployRecordIds.get(e.projectId);
  if (rid) history.appendLog(rid, e.line);
});
queue.on('status', () => broadcast('queue', queue.allStatus()));
// 一轮 AI 修复结束：按任务事实落执行记录；早期失败（没有实现阶段事实）不记
queue.on('run-end', (id: string) => {
  const t = store.get(id);
  if (t?.evidence?.implement) history.add(aiRecordFromTask(t));
  observer.onRunEnd(id);
});
// 任务每次换阶段都按新阶段回写飞书（项目开启回写时）；没有对应取值的阶段不写
store.on('status', (id: string) =>
  void writeBackTask(store, id).then((wb) => {
    if (wb?.state === 'failed') observer.collectWritebackFailure(id, wb);
  }),
);

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  res.write(`event: projects\ndata: ${JSON.stringify(publicProjects())}\n\n`);
  res.write(`event: tasks\ndata: ${JSON.stringify(store.list().map(brief))}\n\n`);
  res.write(`event: queue\ndata: ${JSON.stringify(queue.allStatus())}\n\n`);
  res.write(`event: deploy\ndata: ${JSON.stringify(deployer.allStatus())}\n\n`);
  for (const [ev, data] of observer.snapshot()) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

// ---------- 设置 ----------
app.get('/api/settings', wrap(() => publicSettings()));
app.put(
  '/api/settings',
  wrap((req) => {
    const patch = validateSettingsPatch(req.body);
    if (patch.feishu?.appSecret === SECRET_MASK) delete patch.feishu.appSecret;
    store.updateSettings(patch);
    return publicSettings();
  }),
);

// ---------- 项目 ----------
app.get('/api/projects', wrap(() => publicProjects()));

app.post(
  '/api/projects',
  wrap((req) => {
    const patch = dropMaskedSecret(validateProjectPatch(req.body));
    if (!patch.name) throw new Error('项目名称不能为空');
    if (!patch.workdir) throw new Error('请填写代码目录');
    return publicProject(store.createProject({ ...patch, name: patch.name, workdir: patch.workdir }));
  }),
);

app.put(
  '/api/projects/:id',
  wrap((req) => {
    const p = mustGetProject(req.params.id);
    return publicProject(store.updateProject(p.id, dropMaskedSecret(validateProjectPatch(req.body))));
  }),
);

app.delete(
  '/api/projects/:id',
  wrap((req) => {
    const p = mustGetProject(req.params.id);
    if (queue.isBusy(p.id)) throw new Error('该项目有任务正在执行，请先停止');
    queue.forget(p.id);
    store.removeProject(p.id);
  }),
);

// ---------- 飞书导入 ----------
app.post(
  '/api/projects/:id/import',
  wrap(async (req) => {
    try {
    const project = mustGetProject(req.params.id);
    // 链接与过滤条件随导入一起保存到项目，下次打开看板沿用
    const patch = validateProjectPatch({
      feishu: {
        ...(typeof req.body?.url === 'string' && req.body.url.trim() ? { url: req.body.url } : {}),
        ...(typeof req.body?.filterField === 'string' ? { filterField: req.body.filterField } : {}),
        ...(typeof req.body?.filterValues === 'string' ? { filterValues: req.body.filterValues } : {}),
        ...(typeof req.body?.assigneeField === 'string' ? { assigneeField: req.body.assigneeField } : {}),
        ...(typeof req.body?.assigneeValues === 'string' ? { assigneeValues: req.body.assigneeValues } : {}),
      },
    });
    const merged = { ...project.feishu, ...patch.feishu };
    if (!merged.url) throw new Error('请输入飞书多维表格链接');
    store.updateProject(project.id, patch);

    const creds = store.feishuCreds(project.id);
    const all = await fetchRecords({ appId: creds.appId, appSecret: creds.appSecret, url: merged.url }).catch((e: Error) => {
      // 带上应用标识：授权、开权限都要对着具体的应用去做
      throw new Error(`${e.message}。${credsLabel(creds)}`);
    });
    // 两个条件同时满足
    const records = filterRecords(
      filterRecords(all, merged.filterField, merged.filterValues),
      merged.assigneeField,
      merged.assigneeValues,
    );
    if (all.length && !records.length) {
      for (const [field, values] of [
        [merged.filterField, merged.filterValues],
        [merged.assigneeField, merged.assigneeValues],
      ]) {
        if (field.trim() && values.trim() && !all.some((r) => r.fields[field.trim()] !== undefined)) {
          throw new Error(`表格中没有名为「${field.trim()}」的字段，或该字段全部为空`);
        }
      }
    }

    // 只在本项目内去重；副本表格的 record_id 会变，按 record_id 或标题去重
    const byId = new Map<string, Task>();
    const byTitle = new Map<string, Task>();
    for (const t of store.list(project.id)) {
      if (t.sourceId) byId.set(t.sourceId, t);
      byTitle.set(t.title.trim(), t);
    }
    let created = 0;
    for (const r of records) {
      const existing = byId.get(r.recordId) ?? byTitle.get(r.title.trim());
      if (existing) {
        // 已导入的任务补上附件信息（旧版本导入时没有保存）
        if (r.attachments.length && !existing.attachments?.length) store.update(existing.id, { attachments: r.attachments });
        // 补上记录定位信息，回写时使用
        if (r.sourceKey && existing.sourceId === r.recordId && existing.sourceKey !== r.sourceKey) store.update(existing.id, { sourceKey: r.sourceKey });
        continue;
      }
      const task = store.create({
        projectId: project.id,
        title: r.title,
        description: r.description,
        source: 'feishu',
        sourceId: r.recordId,
        sourceKey: r.sourceKey,
        attachments: r.attachments,
      });
      byTitle.set(r.title.trim(), task);
      created++;
      if (merged.autoAnalyze) queue.analyze(task.id);
    }
    // 反方向同步：飞书上已是测试通过、或被退回待修改的任务，在看板上跟着移动
    const synced = pullFeishuStatus(store, mustGetProject(project.id), all);
    return { total: all.length, matched: records.length, created, skipped: records.length - created, synced };
    } catch (e) {
      observer.collectImportFailure(req.params.id, e);
      throw e;
    }
  }),
);

// ---------- 任务 ----------
app.get('/api/tasks/:id', wrap((req) => mustGet(req.params.id)));

// 上传截图：请求体是图片原始内容，文件名放在 X-File-Name（URL 编码）
app.post(
  '/api/tasks/:id/attachments',
  express.raw({ type: 'image/*', limit: MAX_UPLOAD_BYTES }),
  wrap((req) => {
    const t = mustGet(req.params.id);
    if (t.status === 'in_progress' || t.status === 'testing') throw new Error('执行中的任务不能修改');
    if (!Buffer.isBuffer(req.body)) throw new Error('请上传图片文件');
    let name = 'image';
    try {
      name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'image'));
    } catch {
      // 文件名编码异常时用默认名
    }
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
    const att = attachments.saveUpload(req.body, name, type);
    return brief(store.update(t.id, { attachments: [...(t.attachments ?? []), att] })!);
  }),
);

app.delete(
  '/api/tasks/:id/attachments/:token',
  wrap((req) => {
    const t = mustGet(req.params.id);
    if (t.status === 'in_progress' || t.status === 'testing') throw new Error('执行中的任务不能修改');
    const att = t.attachments?.find((a) => a.token === req.params.token);
    if (!att) throw new Error('附件不存在');
    attachments.removeUpload(att);
    return brief(store.update(t.id, { attachments: t.attachments!.filter((a) => a !== att) })!);
  }),
);

// 飞书附件：首次访问时下载并缓存到 data/attachments
app.get('/api/tasks/:id/attachments/:token', async (req, res) => {
  try {
    const task = mustGet(req.params.id);
    const att = task.attachments?.find((a) => a.token === req.params.token);
    if (!att) throw new Error('附件不存在');
    const file = await attachments.ensure(att, task.projectId);
    res.setHeader('Content-Type', att.type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(att.name)}`);
    res.sendFile(file);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post(
  '/api/projects/:id/tasks',
  wrap((req) => {
    const project = mustGetProject(req.params.id);
    const title = String(req.body?.title ?? '').trim();
    if (!title) throw new Error('标题不能为空');
    return brief(store.create({ projectId: project.id, title, description: String(req.body?.description ?? ''), source: 'manual' }));
  }),
);

app.patch(
  '/api/tasks/:id',
  wrap((req) => {
    const t = mustGet(req.params.id);
    if (t.status === 'in_progress' || t.status === 'testing') throw new Error('执行中的任务不能修改');
    // 确认即冻结：待办中的任务按确认时的规格执行，要改先退回待确认
    if (t.status === 'todo') throw new Error('任务已确认，规格已冻结；请先「退回待确认」再修改');
    const patch: Partial<Task> = {};
    for (const k of ['title', 'description'] as const) {
      if (typeof req.body?.[k] === 'string') patch[k] = req.body[k];
    }
    if (req.body?.spec === null) {
      // 改回自由文本
      patch.spec = undefined;
    } else if (req.body?.spec !== undefined) {
      const spec = normalizeSpec(req.body.spec);
      if (!spec) throw new Error('规格需要有目标和至少一条验收项');
      patch.spec = spec;
      patch.analysis = renderSpec(spec);
    }
    // 有结构化规格时，文本由规格生成，不单独修改
    const hasSpec = 'spec' in patch ? !!patch.spec : !!t.spec;
    if (!hasSpec && typeof req.body?.analysis === 'string') patch.analysis = req.body.analysis;
    return brief(store.update(t.id, patch)!);
  }),
);

app.delete(
  '/api/tasks/:id',
  wrap((req) => {
    const t = mustGet(req.params.id);
    if (queue.isRunningTask(t.id)) throw new Error('请先停止正在执行的任务');
    for (const a of t.attachments ?? []) attachments.removeUpload(a);
    store.remove(t.id);
  }),
);

app.post(
  '/api/tasks/:id/analyze',
  wrap((req) => {
    const t = mustGet(req.params.id);
    if (t.status !== 'pending_confirm') throw new Error('只有待确认的任务可以生成理解');
    queue.analyze(t.id);
  }),
);

// 本次代码改动：执行时保存的 diff；旧任务没有保存时从提交里取
app.get(
  '/api/tasks/:id/diff',
  wrap(async (req) => {
    const t = mustGet(req.params.id);
    const saved = store.readDiff(t.id);
    if (saved !== null) return { diff: saved };
    const workdir = store.getProject(t.projectId)?.workdir;
    if (!t.commit || !workdir) return { diff: null };
    const diff = await git(['show', '--format=', t.commit.hash], workdir).catch(() => null);
    return { diff: diff && diff.length > 60_000 ? `${diff.slice(0, 60_000)}\n…（已截断）` : diff };
  }),
);

// 追加指令：让代理在上一轮的基础上继续执行
app.post(
  '/api/tasks/:id/follow-up',
  wrap((req) => {
    const t = mustGet(req.params.id);
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) throw new Error('请填写要追加的指令');
    if (text.length > 4000) throw new Error('追加的指令不能超过 4000 字');
    queue.followUp(t.id, text);
    return brief(mustGet(t.id));
  }),
);

// 单独执行一个待办任务：不启动队列，执行完这一个就停
app.post(
  '/api/tasks/:id/run',
  wrap((req) => {
    const t = mustGet(req.params.id);
    queue.runOne(t.id);
    return brief(mustGet(t.id));
  }),
);

// 重试飞书回写：回写失败过，或任务换阶段时项目还没有开启回写
app.post(
  '/api/tasks/:id/writeback',
  wrap(async (req) => {
    const t = mustGet(req.params.id);
    const wb = await writeBackTask(store, t.id);
    if (wb?.state === 'failed') observer.collectWritebackFailure(t.id, wb);
    if (!wb) throw new Error('该任务不需要回写：不是从飞书导入的任务、项目配置里没有开启飞书回写，或任务当前所在的阶段没有填写对应的飞书取值');
    return brief(mustGet(t.id));
  }),
);

/** 状态流转：确认入待办 / 退回 / 重试 / 验收 */
const TRANSITIONS: Record<string, { from: TaskStatus[]; to: TaskStatus }> = {
  // 看板拖拽也走这几条：待确认→待修改是 confirm，待修改→待确认是 unconfirm，异常→待修改是 retry
  confirm: { from: ['pending_confirm'], to: 'todo' },
  unconfirm: { from: ['todo'], to: 'pending_confirm' },
  retry: { from: ['blocked', 'review', 'done'], to: 'todo' },
  accept: { from: ['review'], to: 'done' },
  reopen: { from: ['blocked'], to: 'pending_confirm' },
  resolve: { from: ['blocked'], to: 'done' },
};

app.post(
  '/api/tasks/:id/:action',
  wrap((req) => {
    const rule = TRANSITIONS[req.params.action];
    if (!rule) throw new Error('未知操作');
    const t = mustGet(req.params.id);
    if (!rule.from.includes(t.status)) throw new Error(`当前状态不支持该操作`);
    // 规格还在生成时不能确认：否则生成完会把规格写到已经确认甚至在执行的任务上
    if (req.params.action === 'confirm' && t.analyzing) throw new Error('规格还在生成，生成完再确认');
    if (req.params.action === 'confirm' && t.spec) {
      const open = openQuestions(t.spec);
      if (open.length) throw new Error(`规格里还有 ${open.length} 个问题没有回答，回答后才能确认`);
    }
    // 验收通过或重新执行后，之前的人工确认事项不再适用
    const extra: Partial<Task> = { error: undefined, manualChecks: undefined, followUp: undefined };
    if (rule.to === 'todo') {
      extra.order = Date.now();
      // 进入待办即确认：记下确认的是哪一版规格
      extra.confirmed = { at: Date.now(), specHash: t.spec && specHash(t.spec) };
    }
    if (rule.to === 'pending_confirm') extra.confirmed = undefined;
    if (req.params.action === 'resolve') {
      store.appendLog(t.id, '已人工处理完成，任务标记为已通过');
      extra.resolvedManually = true;
    }
    // 飞书回写由 store 的 status 事件触发；结果记在任务上，失败可重试
    return brief(store.setStatus(t.id, rule.to, extra)!);
  }),
);

app.post(
  '/api/projects/:id/confirm-all',
  wrap((req) => {
    const project = mustGetProject(req.params.id);
    let n = 0;
    const pending = store.list(project.id).filter((x) => x.status === 'pending_confirm' && !x.analyzing);
    // 还有问题没回答的任务不批量确认
    const ready = pending.filter((x) => !x.spec || !openQuestions(x.spec).length);
    for (const t of ready) {
      store.setStatus(t.id, 'todo', { order: Date.now() + n++, error: undefined, confirmed: { at: Date.now(), specHash: t.spec && specHash(t.spec) } });
    }
    return { confirmed: n, skipped: pending.length - ready.length };
  }),
);

app.post(
  '/api/projects/:id/analyze-all',
  wrap((req) => {
    const project = mustGetProject(req.params.id);
    const list = store.list(project.id).filter((t) => t.status === 'pending_confirm' && !t.analysis && !t.analyzing);
    list.forEach((t) => queue.analyze(t.id));
    return { queued: list.length };
  }),
);

// ---------- 队列（按项目） ----------
const queueAction = (fn: (projectId: string) => void) =>
  wrap((req) => {
    const project = mustGetProject(req.params.id);
    fn(project.id);
    return queue.status(project.id);
  });
app.post('/api/projects/:id/queue/start', queueAction((id) => queue.start(id)));
app.post('/api/projects/:id/queue/pause', queueAction((id) => queue.pause(id)));
app.post('/api/projects/:id/queue/stop-current', queueAction((id) => queue.stopCurrent(id)));

// ---------- 验证命令建议 ----------
app.get(
  '/api/projects/:id/verify-kit',
  wrap((req) => {
    const p = mustGetProject(req.params.id);
    if (!p.workdir || !fs.existsSync(p.workdir)) throw new Error('代码目录不存在');
    return detectVerifyKit(p.workdir, p.exec.allowedTools);
  }),
);

// ---------- Git 仓库 ----------
app.get(
  '/api/projects/:id/git',
  wrap(async (req) => {
    const p = mustGetProject(req.params.id);
    return { repo: p.workdir && fs.existsSync(p.workdir) ? await repoInfo(p.workdir) : null };
  }),
);
/** 同步远端并记一条执行记录。同步按钮和推送前的自动同步共用；调用方负责 gitBusy 的置位与清除 */
async function syncAndRecord(p: Project, before: RepoInfo): Promise<SyncResult> {
  const startedAt = Date.now();
  const base = { projectId: p.id, kind: 'sync' as const, startedAt, branch: before.branch, upstream: before.upstream, before: before.head };
  try {
    const r = await syncRemote(p.workdir, authArgs(p.git, before.remote));
    if (r.status === 'conflict') observer.collectGitFailure(p.id, 'git_sync', r.error ?? '分叉或合并失败', 'warn');
    const done = r.merged ? `本地也有新提交，已自动合并远端的 ${r.pulled} 个提交` : `快进合并 ${r.pulled} 个提交`;
    history.add({
      ...base,
      id: randomUUID(),
      title: `同步远端 · ${r.repo.branch}`,
      status: r.status,
      finishedAt: Date.now(),
      after: r.repo.head,
      count: r.pulled,
      logs: ['获取远端更新', r.status === 'success' ? done : r.status === 'uptodate' ? '本地已是最新' : '未自动合并', ...(r.error ? [r.error] : []), '同步完成'],
      error: r.error,
    });
    return r;
  } catch (e) {
    history.add({ ...base, id: randomUUID(), title: `同步远端 · ${before.branch}`, status: 'failed', finishedAt: Date.now(), logs: [(e as Error).message], error: (e as Error).message });
    observer.collectGitFailure(p.id, 'git_sync', e);
    throw e;
  }
}
// 同步远端：fetch 后能快进就快进；本地也有新提交时自动合并，合不了报冲突，不改动本地代码
app.post(
  '/api/projects/:id/git/fetch',
  wrap(async (req) => {
    const p = mustGetProject(req.params.id);
    if (queue.isBusy(p.id)) throw new Error('有任务正在执行，请等它结束后再同步');
    // 首个 await 之前置位：消除并发请求的检查-置位窗口；外层 finally 覆盖所有出口
    observer.gitBusy.add(p.id);
    try {
      const before = await repoInfo(p.workdir);
      if (!before) throw new Error('代码目录不是 git 仓库');
      const r = await syncAndRecord(p, before);
      return { repo: r.repo, sync: { status: r.status, pulled: r.pulled, merged: r.merged, error: r.error } };
    } finally {
      observer.gitBusy.delete(p.id);
    }
  }),
);
// 推送代码：先同步远端（有新提交就合并进来），再把当前分支推到它的上游。只由使用者在页面上点击触发
app.post(
  '/api/projects/:id/git/push',
  wrap(async (req) => {
    const p = mustGetProject(req.params.id);
    if (queue.isBusy(p.id)) throw new Error('有任务正在执行，请等它结束后再推送');
    // 首个 await 之前置位：消除并发请求的检查-置位窗口；外层 finally 覆盖所有出口
    observer.gitBusy.add(p.id);
    try {
      const first = await repoInfo(p.workdir);
      if (!first) throw new Error('代码目录不是 git 仓库');
      if (!first.upstream) throw new Error(`分支 ${first.branch} 没有设置上游，请先在终端里推送一次并设置上游`);
      // 远端有本地没有的提交时推送一定被拒：先同步合并。合不了就停在这里，不推送
      const sync = await syncAndRecord(p, first);
      if (sync.status === 'conflict') throw new Error(`没有推送：${sync.error ?? '远端的新提交没能自动合并'}`);
      const before = sync.repo;
      const commits = await commitsBetween(p.workdir, `${before.upstream}..HEAD`);
      const startedAt = Date.now();
      const base = { projectId: p.id, kind: 'push' as const, startedAt, branch: before.branch, upstream: before.upstream, before: before.head };
      try {
        try {
          await git([...authArgs(p.git, before.remote), 'push'], p.workdir);
        } catch (e) {
          // 同步和推送之间远端又进了新提交（共用仓库常见）：再同步一次并重试一回；仍被拒就放弃，绝不强推
          if (!/\[rejected\]|fetch first|non-fast-forward/i.test((e as Error).message)) throw e;
          const again = await syncAndRecord(p, before);
          if (again.status === 'conflict') throw new Error(`没有推送：${again.error ?? '远端的新提交没能自动合并'}`);
          await git([...authArgs(p.git, before.remote), 'push'], p.workdir);
        }
        const after = await repoInfo(p.workdir);
        history.add({
          ...base,
          id: randomUUID(),
          title: `推送代码 · ${before.branch}`,
          status: 'success',
          finishedAt: Date.now(),
          after: after?.head ?? before.head,
          count: commits.length,
          commits,
          logs: ['远端分支已更新', '推送完成'],
        });
        return { repo: after, sync: { status: sync.status, pulled: sync.pulled, merged: sync.merged } };
      } catch (e) {
        history.add({ ...base, id: randomUUID(), title: `推送代码 · ${before.branch}`, status: 'failed', finishedAt: Date.now(), count: commits.length, commits, logs: [(e as Error).message], error: (e as Error).message });
        observer.collectGitFailure(p.id, 'git_push', e);
        throw e;
      }
    } finally {
      observer.gitBusy.delete(p.id);
    }
  }),
);
// 分支列表与切换：切换只接受本地已有分支；执行中不允许切
app.get(
  '/api/projects/:id/git/branches',
  wrap(async (req) => {
    const p = mustGetProject(req.params.id);
    const repo = p.workdir && fs.existsSync(p.workdir) ? await repoInfo(p.workdir) : null;
    return { branches: repo ? await branches(p.workdir) : [], current: repo?.branch ?? null };
  }),
);
app.post(
  '/api/projects/:id/git/checkout',
  wrap(async (req) => {
    const p = mustGetProject(req.params.id);
    if (queue.isBusy(p.id)) throw new Error('有任务正在执行，请等它结束后再切换分支');
    const branch = typeof req.body?.branch === 'string' ? req.body.branch : '';
    observer.gitBusy.add(p.id);
    try {
      await checkout(p.workdir, branch);
      return { repo: await repoInfo(p.workdir), branches: await branches(p.workdir) };
    } finally {
      observer.gitBusy.delete(p.id);
    }
  }),
);
// 修改 origin 地址
app.post(
  '/api/projects/:id/git/remote',
  wrap(async (req) => {
    const p = mustGetProject(req.params.id);
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!url) throw new Error('请填写远端仓库地址');
    await setRemote(p.workdir, url);
    return { repo: await repoInfo(p.workdir) };
  }),
);
// 测试 Git 连接：带凭据 ls-remote，能列出远端分支即通过
app.post(
  '/api/projects/:id/git/test',
  wrap(async (req) => {
    const p = mustGetProject(req.params.id);
    const repo = await repoInfo(p.workdir);
    if (!repo) throw new Error('代码目录不是 git 仓库');
    if (!repo.remote) throw new Error('还没有配置 origin 远端');
    const out = await git([...authArgs(p.git, repo.remote), 'ls-remote', '--heads', 'origin'], p.workdir);
    return { ok: true, refs: out.split('\n').filter(Boolean).length };
  }),
);

// ---------- 执行记录 ----------
app.get(
  '/api/history',
  wrap(() => history.list()),
);

// ---------- 观察者（问题台账 / 优化提案） ----------
registerObserverRoutes(app, observer, {
  projectExists: (id) => {
    const p = store.getProject(id);
    return !!p && !p.archived;
  },
  resolveRepository: (observation) => githubRepository(
    effectiveAttribution(observation) === 'project' ? store.getProject(observation.projectId)?.workdir : root,
  ),
});
// 截图诊断：只产出诊断与建议入台账，不改代码；截图本地暂存、可查看可删除
const screenshotDiagnoser = new ScreenshotDiagnoser({
  observations: observer.observations,
  getSettings: () => store.getSettings(),
  toolRoot: root,
  attachmentDir: attachments.dir,
});
registerScreenshotRoutes(app, observer, { attachments, diagnoser: screenshotDiagnoser });
// 流程体检：任务变化后节流推送各项目的流程指标，并做一次零成本的流程采集
let flowTimer: NodeJS.Timeout | null = null;
store.on('tasks', () => {
  if (flowTimer) return;
  flowTimer = setTimeout(() => {
    flowTimer = null;
    observer.collectFlow();
    broadcast('flow', observer.flow());
  }, 5000);
  flowTimer.unref();
});
// 启动时先采一次：已有的积压不必等下一次任务变化才进台账
observer.collectFlow();

// ---------- Skill ----------
// skill 库目录的检查结果：全局设置页据此告诉使用者填得对不对、里面有几个
app.get(
  '/api/skills/library',
  wrap(() => {
    const dir = store.getSettings().skills.libraryDir;
    return { dir, problem: skillLibraryProblem(dir), skills: listLibrarySkills(dir) };
  }),
);
app.get(
  '/api/projects/:id/skills',
  wrap((req) => listSkills(mustGetProject(req.params.id).workdir, undefined, store.getSettings().skills.libraryDir)),
);

// ---------- 部署到测试服务器 ----------
app.get(
  '/api/projects/:id/deploy',
  wrap((req) => {
    const project = mustGetProject(req.params.id);
    return { ...deployer.status(project.id), logs: deployer.logs(project.id) };
  }),
);
/** 当前代码是不是已经成功部署在这个环境上了 */
async function deployCheck(project: Project, envName: string) {
  const commit = await git(['log', '-1', '--format=%h %s'], project.workdir).then(
    (s) => s.trim(),
    () => undefined,
  );
  // 只数已跟踪文件的改动：未跟踪的多是脚本和临时文件，算进去会永远判成「有改动」
  const dirty = await git(['status', '--porcelain', '--untracked-files=no'], project.workdir).then(
    (s) => s.split('\n').filter(Boolean).length,
    () => 0,
  );
  return { current: commit, ...lastDeployed(history.list(project.id), envName, commit, dirty) };
}
app.get(
  '/api/projects/:id/deploy/check',
  wrap(async (req) => {
    const project = mustGetProject(req.params.id);
    const env = project.envs.find((e) => e.id === req.query.envId) ?? defaultEnv(project);
    if (!project.workdir || !fs.existsSync(project.workdir)) throw new Error('代码目录不存在');
    return deployCheck(project, env.name);
  }),
);
app.post(
  '/api/projects/:id/deploy',
  wrap(async (req) => {
    const project = mustGetProject(req.params.id);
    const env = project.envs.find((e) => e.id === req.body?.envId) ?? defaultEnv(project);
    const command = env.deployCommand;
    if (!command) throw new Error(`请先在「项目管理 → 配置 → 部署环境 → ${env.name}」中填写部署命令`);
    if (!project.workdir || !fs.existsSync(project.workdir)) throw new Error('代码目录不存在');
    // 任务执行中代码处于中间状态，部署出去的版本不可靠
    if (queue.status(project.id).currentId) throw new Error('有任务正在执行，请等它完成或先暂停队列后再部署');
    const check = await deployCheck(project, env.name);
    // 这个版本已经成功部署过：不重复部署。使用者看过提醒仍要重新部署时带 force
    if (check.upToDate && req.body?.force !== true) throw new Error(`「${env.name}」上已经是最新版本（${check.commit}），不用部署`);
    const commit = check.current;
    // 必须在写执行记录之前拦，且和写记录之间不能再有 await：否则第二次请求虽然被部署器拒绝，
    // 却已经多写了一条永远「运行中」的记录，并把记录指针指向它，正在进行的那次部署就再也收不到结束状态
    if (deployer.status(project.id).running) throw new Error('正在部署中，请等它结束或先停止部署');
    // 反方向同理：任务正在改代码目录时不让部署智能体进来改
    if (queue.isBusy(project.id)) throw new Error('有任务正在执行，请等它结束后再部署');
    const rec = history.add({
      id: randomUUID(),
      projectId: project.id,
      kind: 'deploy',
      title: `一键部署 · ${env.name}`,
      status: 'running',
      startedAt: Date.now(),
      envName: env.name,
      commit,
      logs: [],
    });
    deployRecordIds.set(project.id, rec.id);
    deployer.start(project.id, {
      command,
      cwd: project.workdir,
      timeoutMs: project.exec.timeoutMinutes * 60_000,
      commit,
      buildCommand: env.buildCommand || undefined,
      healthCheck: env.healthCheck || undefined,
      envName: env.name,
      // 部署环境里填的服务器信息交给部署脚本：脚本靠它连服务器，不用把密码再写进脚本或命令里
      env: {
        DEPLOY_ENV_NAME: env.name,
        DEPLOY_HOST: env.host,
        DEPLOY_PORT: String(env.port),
        DEPLOY_USER: env.username,
        DEPLOY_PASSWORD: env.password,
        DEPLOY_URL: env.url,
        DEPLOY_COMMIT: commit ?? '',
      },
      // 部署智能体：用项目「执行设置」里配置的大模型代理（Claude Code / Codex / 本地命令），不依赖任何外部服务
      maxRepairs: 3,
      repair: async (ctx) => {
        const prompt = deployRepairPrompt(ctx, {
          envName: env.name,
          buildCommand: env.buildCommand || undefined,
          command,
          healthCheck: env.healthCheck || undefined,
        });
        const result = await runAgent({
          stage: 'implement',
          access: 'write',
          prompt,
          cwd: project.workdir,
          exec: project.exec,
          schema: DEPLOY_REPAIR_SCHEMA,
          timeoutMs: project.exec.timeoutMinutes * 60_000,
          onLog: (line) => ctx.log(`[智能体] ${line}`),
          signal: ctx.signal,
        });
        const out = (result.structured ?? {}) as { fixed?: boolean; cause?: string; summary?: string };
        if (!result.ok) ctx.log(`部署智能体运行失败：${result.text}`);
        if (out.cause) ctx.log(`部署智能体判断原因：${out.cause}`);
        if (out.summary) ctx.log(`部署智能体结论：${out.summary}`);
        return result.ok && out.fixed === true;
      },
    });
    return deployer.status(project.id);
  }),
);

// ---------- 连接测试 / 目录浏览 ----------
// 飞书测试连接：用项目（或全局）凭证读一次表格，返回记录数
app.post(
  '/api/projects/:id/feishu/test',
  wrap(async (req) => {
    const project = mustGetProject(req.params.id);
    const url = (typeof req.body?.url === 'string' && req.body.url.trim()) || project.feishu.url;
    if (!url) throw new Error('请先填写飞书多维表格链接');
    const creds = store.feishuCreds(project.id);
    const all = await fetchRecords({ appId: creds.appId, appSecret: creds.appSecret, url }).catch((e: Error) => {
      throw new Error(`${e.message}。${credsLabel(creds)}`);
    });
    return { ok: true, count: all.length };
  }),
);
// 部署环境测试连接：TCP 连一下 SSH 端口，可达即通过
app.post(
  '/api/projects/:id/envs/:envId/test',
  wrap(async (req) => {
    const project = mustGetProject(req.params.id);
    const saved = project.envs.find((e) => e.id === req.params.envId);
    // 未保存的草稿环境：用请求体里的地址测试
    const host = (typeof req.body?.host === 'string' && req.body.host.trim()) || saved?.host || '';
    const port = Number(req.body?.port ?? saved?.port ?? 22);
    if (!host) throw new Error('请先填写 IP 地址');
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect({ host, port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`连接 ${host}:${port} 超时（5 秒）`));
      }, 5000);
      sock.once('connect', () => {
        clearTimeout(timer);
        sock.destroy();
        resolve();
      });
      sock.once('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`无法连接 ${host}:${port}：${e.message}`));
      });
    });
    return { ok: true };
  }),
);
// 目录浏览：只列目录，供「浏览」选择代码目录；空路径时 Windows 列盘符
app.get(
  '/api/fs/dirs',
  wrap((req) => {
    const raw = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    if (!raw && process.platform === 'win32') {
      const dirs: string[] = [];
      for (let i = 65; i <= 90; i++) {
        const drive = `${String.fromCharCode(i)}:\\`;
        if (fs.existsSync(drive)) dirs.push(drive);
      }
      return { path: '', parent: null, dirs };
    }
    const dir = path.resolve(raw || os.homedir());
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`目录不存在：${dir}`);
    const dirs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const parent = path.dirname(dir);
    // 已经在盘符根（或系统根）时：Windows 上的上一级是盘符列表，用空串表示；其它系统没有上一级。
    // 原先这里一律给 null，进了某个盘之后「上级」就不可用，只能关掉弹窗重来才能换盘
    const up = parent !== dir ? parent : process.platform === 'win32' ? '' : null;
    return { path: dir, parent: up, dirs };
  }),
);
app.post(
  '/api/projects/:id/deploy/stop',
  wrap((req) => {
    const project = mustGetProject(req.params.id);
    deployer.stop(project.id);
    return deployer.status(project.id);
  }),
);

// ---------- 定时启动队列 ----------
// 每 20 秒看一次有没有到点的项目；每个项目每天只触发一次
const scheduleFired = new Map<string, string>();
setInterval(() => {
  const now = new Date();
  for (const p of dueProjects(store.listProjects(), now, scheduleFired)) {
    scheduleFired.set(p.id, dayKey(now));
    console.log('[' + now.toLocaleString('zh-CN', { hour12: false }) + '] 定时启动队列：' + p.name);
    queue.startScheduled(p.id);
  }
}, 20_000);

// ---------- 生产模式静态文件 ----------
const dist = path.join(root, 'dist', 'client');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, HOST, () => {
  console.log(`任务工作台服务已启动：http://${HOST}:${PORT}`);
  console.log(`状态列：${STATUSES.join(' → ')}`);
});

const shutdown = () => {
  observer.flush();
  observer.dispose();
  store.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
