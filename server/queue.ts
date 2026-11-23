import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { evidenceLine, runAgent, type AgentRequest, type AgentResult } from './agent.ts';
import type { AttachmentCache, LocalAttachment } from './attachments.ts';
import { followUpPrompt, notesSection } from './followup.ts';
import { evaluateGate, FALLBACK_CRITERIA, gateError, manualChecksText, normalizeReport, sessionProblem, VERIFY_SCHEMA, type GateInput } from './gate.ts';
import { commitMessage, commitTaskChanges, git, skippedDiff, snapshot, taskChanges, taskDiff, type GitSnapshot, type TaskChanges } from './git.ts';
import { ensureMemoryDir } from './memory.ts';
import { runPreflight } from './preflight.ts';
import { analysisPrompt, historySection, implementPrompt, memorySection, relatedHistory, scratchSection, skillSection, verifyPrompt, verifySection } from './prompts.ts';
import { openQuestions } from './shared.ts';
import { runShell } from './shell.ts';
import { splitSkills, stageSkills } from './skills.ts';
import { normalizeSpec, renderSpec, SPEC_SCHEMA, specHash } from './spec.ts';
import type { Store } from './store.ts';
import { defaultEnv, type ExecConfig, type GateResult, type Preflight, type Project, type QueueStatus, type RunEvidence, type RunProgress, type Stage, type Task } from './types.ts';

export type { QueueStatus };

const PROVIDER_LABEL = { claude: 'Claude Code', codex: 'Codex CLI', custom: '本地命令行代理' } as const;
const VERDICT_LABEL = { pass: '通过', unverified: '需要人工验收', fail: '未通过' } as const;
const REASON_MARK = { fail: '✕', hold: '！', note: '·' } as const;
/** 代理生成的规格最多保留这么多条验收项：每多一条，验证阶段就多核对一项 */
const MAX_AGENT_CRITERIA = 8;

/** 验证阶段的执行设置：指定了验证模型就换上（Claude Code 与 Codex 各用各的模型字段） */
function verifyExec(exec: ExecConfig): ExecConfig {
  if (!exec.verifyModel || exec.provider === 'custom') return exec;
  return exec.provider === 'codex' ? { ...exec, codexModel: exec.verifyModel } : { ...exec, model: exec.verifyModel };
}

function assertWorkdir(dir: string) {
  if (!dir) throw new Error('请先在「项目管理 → 配置」中填写代码目录');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`代码目录不存在：${dir}`);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

interface Runner {
  running: boolean;
  currentId: string | null;
  abort: AbortController | null;
  preflight?: Preflight;
  /** 自检对应的配置；代码目录或执行设置变了就重新自检 */
  preflightKey?: string;
  /** 单独执行的任务：不管队列是否在运行，执行完这一个就停 */
  once?: string;
  /** 本轮由定时启动：待办清空后自动暂停 */
  autoPause?: boolean;
  /** 正在执行的任务的实时进度 */
  progress?: RunProgress;
}

// 定时、流转方式、理解超时不影响代理能不能干活，改它们不需要重新自检
const preflightKey = (p: Project) =>
  JSON.stringify([p.workdir, { ...p.exec, scheduleEnabled: undefined, scheduleTime: undefined, autoConfirm: undefined, autoStart: undefined, analyzeTimeoutMinutes: undefined, skipReview: undefined }]);

/**
 * 每个项目一条串行队列：项目内一次只执行一个任务，不同项目之间互不影响。
 * 事件：status（队列状态变化）、done（任务经门禁通过进入已完成，参数是任务 id）。
 */
export class Queue extends EventEmitter {
  private runners = new Map<string, Runner>();

  private analyzing = new Set<string>();
  private analyzeWaiting: string[] = [];
  private static ANALYZE_CONCURRENCY = 2;

  constructor(
    private store: Store,
    private attachments?: AttachmentCache,
    /** 运行一次代理会话；测试时替换 */
    private run: (req: AgentRequest) => Promise<AgentResult> = runAgent,
  ) {
    super();
  }

  /**
   * 把全局 skill 库里的 skill 复制到 dest/.claude/skills，返回是否复制了。
   * 只给代理副本、且只复制 skills：库目录的原件代理改不到，库目录下别的文件（配置、凭据、钩子）也不会交出去。
   */
  private copySkillLibrary(dest: string, log: (l: string) => void): boolean {
    const dir = this.store.getSettings().skills.libraryDir;
    const src = dir ? path.join(dir, '.claude', 'skills') : '';
    if (!src || !fs.existsSync(src)) return false;
    try {
      // dereference：以链接方式装的 skill 复制成实体，副本不会写穿到原件
      fs.cpSync(src, path.join(dest, '.claude', 'skills'), { recursive: true, dereference: true });
      return true;
    } catch (e) {
      log(`skill 库没能准备好，本次不带库里的 skill：${message(e)}`);
      return false;
    }
  }

  /** 下载任务附件，返回本地文件和需要放行给代理的目录 */
  private async prepareFiles(task: Task, log: (line: string) => void): Promise<{ files: LocalAttachment[]; dirs: string[] }> {
    if (!this.attachments || !task.attachments?.length) return { files: [], dirs: [] };
    const files = await this.attachments.prepare(task, log);
    return { files, dirs: files.length ? [this.attachments.dir] : [] };
  }

  private runner(projectId: string): Runner {
    let r = this.runners.get(projectId);
    if (!r) {
      r = { running: false, currentId: null, abort: null };
      this.runners.set(projectId, r);
    }
    return r;
  }

  status(projectId: string): QueueStatus {
    const r = this.runner(projectId);
    return {
      running: r.running,
      currentId: r.currentId,
      todoCount: this.store.list(projectId).filter((t) => t.status === 'todo').length,
      preflight: r.preflight,
      progress: r.progress,
    };
  }

  /** 所有项目的队列状态，按项目 id 索引 */
  allStatus(): Record<string, QueueStatus> {
    return Object.fromEntries(this.store.listProjects().map((p) => [p.id, this.status(p.id)]));
  }

  isRunningTask(taskId: string): boolean {
    return [...this.runners.values()].some((r) => r.currentId === taskId);
  }

  isBusy(projectId: string): boolean {
    return Boolean(this.runners.get(projectId)?.currentId);
  }

  /** 启动队列：先用当前配置做一次开工前自检，通过后才开始取任务 */
  start(projectId: string, autoPause = false) {
    const r = this.runner(projectId);
    r.running = true;
    r.autoPause = autoPause;
    // 定时启动不解除手动暂停：只有使用者自己点启动才算放开
    if (!autoPause) this.setHeld(projectId, false);
    // 上次自检没过：重新启动时再检一次
    if (r.preflight?.state === 'failed') {
      r.preflight = undefined;
      r.preflightKey = undefined;
    }
    this.emit('status');
    this.tick();
  }

  /** 暂停：不再取新任务，当前任务继续执行完 */
  pause(projectId: string) {
    const r = this.runner(projectId);
    r.running = false;
    r.autoPause = false;
    this.setHeld(projectId, true);
    this.emit('status');
  }

  /** 手动暂停标记存在项目上：服务重启后自动开工仍然不会把队列拉起来 */
  private setHeld(projectId: string, held: boolean) {
    const p = this.store.getProject(projectId);
    if (p && !!p.queueHeld !== held) this.store.updateProject(projectId, { queueHeld: held });
  }

  /** 定时启动：按待办顺序逐个执行，待办清空后自动暂停。队列已在运行时不做改动 */
  startScheduled(projectId: string) {
    if (this.runner(projectId).running) return;
    this.start(projectId, true);
  }

  /** 单独执行一个待办任务：不启动队列，执行完这一个就停 */
  runOne(taskId: string) {
    const task = this.store.get(taskId);
    if (!task) throw new Error('任务不存在');
    if (task.status !== 'todo') throw new Error('只有待修改中的任务可以单独执行');
    const r = this.runner(task.projectId);
    if (r.currentId) throw new Error('该项目有任务正在执行，请等它结束或先停止当前任务');
    r.once = taskId;
    // 上次自检没过：再检一次
    if (r.preflight?.state === 'failed') {
      r.preflight = undefined;
      r.preflightKey = undefined;
    }
    this.emit('status');
    this.tick();
  }

  /** 追加指令：让代理在上一轮的基础上继续，随后重新验证并过门禁。只接受已经跑完一轮的任务 */
  followUp(taskId: string, text: string) {
    const task = this.store.get(taskId);
    if (!task) throw new Error('任务不存在');
    if (!['review', 'blocked', 'done'].includes(task.status)) throw new Error('任务跑完一轮后才能追加指令；执行中的任务请先停止');
    if (this.runner(task.projectId).currentId) throw new Error('该项目有任务正在执行，请等它结束或先停止当前任务');
    this.store.setStatus(taskId, 'todo', { notes: [...(task.notes ?? []), text], followUp: true, order: Date.now(), error: undefined, manualChecks: undefined });
    this.runOne(taskId);
  }

  stopCurrent(projectId: string) {
    this.runners.get(projectId)?.abort?.abort();
  }

  /** 失败/被拦的任务留下未提交改动时暂停队列：这些文件会被后续任务当成「执行前已有的改动」，
   * 碰到它们的任务都会被门禁 hold 转人工验收。先处理（提交或还原）再启动，避免整批任务被污染 */
  private holdForLeftover(runner: Runner, projectId: string, files: string[] | undefined, log: (l: string) => void) {
    if (!files?.length) return;
    runner.running = false;
    runner.autoPause = false;
    this.setHeld(projectId, true);
    log(`队列已暂停：本任务留下了 ${files.length} 个未提交的改动文件（${files.slice(0, 8).join('、')}${files.length > 8 ? ' 等' : ''}）。请先在代码目录里提交或还原它们，再启动队列；否则后续任务改到这些文件时都会因「执行前已有改动」转人工验收`);
  }

  forget(projectId: string) {
    this.runners.delete(projectId);
  }

  /** 外部占用判断（例如部署智能体正在改代码目录）：返回 true 时这个项目暂不开始新任务，等占用结束后再 tick */
  private blocker?: (projectId: string) => boolean;

  setBlocker(fn: (projectId: string) => boolean) {
    this.blocker = fn;
  }

  tick() {
    setImmediate(() => {
      // 自动开工：待修改里有任务、队列没在跑、使用者也没手动暂停过，就把队列拉起来
      for (const p of this.store.listProjects()) {
        if (!p.exec.autoStart || p.archived) continue;
        const r = this.runner(p.id);
        // 自检没过且配置没变：不反复拉起；配置改过了就允许再试一次
        const stuck = r.preflight?.state === 'failed' && r.preflightKey === preflightKey(p);
        if (r.running || p.queueHeld || r.currentId || stuck) continue;
        if (r.preflight?.state === 'failed') {
          r.preflight = undefined;
          r.preflightKey = undefined;
        }
        if (!this.store.nextTodo(p.id)) continue;
        r.running = true;
        this.emit('status');
      }
      for (const [projectId, r] of this.runners) {
        if (r.currentId) continue;
        // 部署智能体等外部占用期间不取任务：两个写权限智能体不能同时改同一个代码目录
        if (this.blocker?.(projectId)) continue;
        const next = this.pick(projectId, r);
        if (!next || !this.ready(projectId, r)) continue;
        if (r.once === next.id) r.once = undefined;
        void this.process(r, next);
      }
    });
  }

  /** 下一个要执行的任务：单独执行的任务优先，其次是运行中队列里最靠前的待办 */
  private pick(projectId: string, r: Runner): Task | undefined {
    if (r.once) {
      const t = this.store.get(r.once);
      if (t?.status === 'todo') return t;
      // 任务已被退回或删除
      r.once = undefined;
    }
    if (!r.running) return undefined;
    const next = this.store.nextTodo(projectId);
    if (!next && r.autoPause) {
      // 定时启动的这一轮已经清空待办
      r.running = false;
      r.autoPause = false;
      this.emit('status');
    }
    return next;
  }

  /** 自检是否已用当前配置通过；没做过或配置变了就发起一次 */
  private ready(projectId: string, r: Runner): boolean {
    const project = this.store.getProject(projectId);
    if (!project) return false;
    const key = preflightKey(project);
    if (r.preflightKey === key && r.preflight) return r.preflight.state === 'ok';

    r.preflightKey = key;
    r.preflight = { state: 'checking', problems: [], notes: [], at: Date.now() };
    this.emit('status');
    runPreflight(project, this.run)
      .catch((e): Preflight => ({ state: 'failed', problems: [`自检无法运行：${message(e)}`], notes: [], at: Date.now() }))
      .then((result) => {
        // 自检期间项目被删除或配置又变了：结果作废
        if (this.runners.get(projectId) !== r || r.preflightKey !== key) return;
        r.preflight = result;
        // 自检没过就停下队列，避免整批任务空跑
        if (result.state === 'failed') {
          r.running = false;
          r.autoPause = false;
          r.once = undefined;
        }
        this.emit('status');
        this.tick();
      });
    return false;
  }

  private touchTimer: NodeJS.Timeout | null = null;

  /** 进度变化很频繁：最多每秒推送一次队列状态 */
  private touch() {
    if (this.touchTimer) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      this.emit('status');
    }, 1000);
    this.touchTimer.unref();
  }

  private saveEvidence(id: string, stage: Stage, evidence: RunEvidence) {
    this.store.update(id, { evidence: { ...this.store.get(id)?.evidence, [stage]: evidence } });
  }

  private async process(runner: Runner, task: Task) {
    const id = task.id;
    runner.currentId = id;
    runner.abort = new AbortController();
    const signal = runner.abort.signal;
    const log = (line: string) => this.store.appendLog(id, line);
    const stopIfAborted = () => {
      if (signal.aborted) throw new Error('已手动停止');
    };
    // 本任务上一轮改动了但没提交的文件，和这一轮实现阶段改动的文件
    let leftover: string[] = [];
    let changed: string[] | undefined;
    const startedAt = Date.now();
    let cost = 0;
    // 仓库外的临时目录：代理的自检脚本写这里，任务结束后清掉
    let scratch = '';
    const enter = (stage: Stage) => {
      runner.progress = { stage, startedAt, stageStartedAt: Date.now(), toolCalls: 0, lastStep: '', lastAt: Date.now(), costUsd: cost };
      this.emit('status');
    };
    const onProgress = (p: { toolCalls: number; lastStep: string }) => {
      if (!runner.progress) return;
      Object.assign(runner.progress, { toolCalls: p.toolCalls, lastStep: p.lastStep, lastAt: Date.now() });
      this.touch();
    };
    this.emit('status');

    try {
      const project = this.store.getProject(task.projectId);
      if (!project) throw new Error('任务所属项目不存在');
      const { exec, workdir } = project;
      assertWorkdir(workdir);
      // 追加指令的一轮：接着上一轮的会话和改动继续，而不是从头实现。这几项要在状态重置前取出
      const notes = task.notes ?? [];
      const follow = !!task.followUp && notes.length > 0;
      const priorSummary = task.summary;
      const priorSession = task.evidence?.implement?.sessionId;
      leftover = task.leftover ?? [];
      this.store.setStatus(id, 'in_progress', {
        followUp: undefined,
        leftover: undefined,
        error: undefined,
        summary: undefined,
        commit: undefined,
        resolvedManually: undefined,
        manualChecks: undefined,
        gate: undefined,
        writeback: undefined,
        evidence: task.evidence?.analysis ? { analysis: task.evidence.analysis } : undefined,
      });
      log(follow ? '===== 追加指令，继续执行 =====' : '===== 开始执行 =====');
      if (follow) log('追加指令：' + notes[notes.length - 1]);
      log(`代理：${PROVIDER_LABEL[exec.provider]}${task.confirmed?.specHash ? `，按已确认的规格 ${task.confirmed.specHash} 执行` : ''}`);

      if (exec.useBranch) {
        const branch = `claude-task/${id.slice(0, 8)}`;
        await git(['checkout', '-b', branch], workdir);
        log(`已切换到新分支 ${branch}`);
      }

      // 记录执行前的工作区：门禁据此核对本任务的改动，提交时只带上本任务改的文件
      const snap = await snapshot(workdir);
      // 本任务上一轮留下、还没提交的改动仍算作本任务的改动，不当成「执行前已有的改动」
      if (snap) for (const file of leftover) snap.dirty.delete(file);
      if (!snap) log('代码目录不是 git 仓库：无法核对本任务的改动，也不会自动提交');
      else if (snap.dirty.size) log(`执行前已有 ${snap.dirty.size} 个未提交的改动，这些文件不会算作本任务的改动`);

      const { files, dirs } = await this.prepareFiles(this.store.get(id)!, log);
      const images = files.filter((f) => f.isImage).map((f) => f.path);
      // 项目记忆是 Claude Code 的机制（记忆目录在仓库外，不会被自动提交）；其他代理只附历史任务
      const mem = exec.useKnowledge && exec.provider === 'claude' ? await this.memory(workdir, log) : { section: '', dirs: [] };
      const history = exec.useKnowledge ? historySection(this.history(this.store.get(id)!, log)) : '';
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-scratch-'));
      // 库里的 skill 放进同一个临时目录：它本来就是附加目录，任务结束一起清掉
      this.copySkillLibrary(scratch, log);
      const base = { cwd: workdir, exec, images, addDirs: [...dirs, ...mem.dirs, scratch], onLog: log, onProgress, signal };
      const verifyHint = verifySection(exec) + scratchSection(scratch);

      // ---------- 实现 ----------
      const knowledge = history + mem.section + this.skills(exec, 'implement', log) + verifyHint;
      enter('implement');
      // 新开会话：追加指令的一轮带上任务、规格和上一轮的总结；普通执行带上之前追加过的要求
      const fresh = (): AgentRequest => ({
        ...base,
        stage: 'implement',
        access: 'write',
        prompt: follow
          ? followUpPrompt(this.store.get(id)!, notes, { resumed: false, extra: exec.extraPrompt, priorSummary, env: defaultEnv(project), files, knowledge })
          : implementPrompt(this.store.get(id)!, exec.extraPrompt, defaultEnv(project), files, knowledge + notesSection(notes)),
        timeoutMs: exec.timeoutMinutes * 60_000,
      });
      // 只有 Claude Code 能接续会话：代理还记得任务和自己的改动，只需要给最新的指令
      const resume = follow && exec.provider === 'claude' ? priorSession : undefined;
      let impl = resume
        ? await this.run({ ...fresh(), resume, prompt: followUpPrompt(this.store.get(id)!, notes.slice(-1), { resumed: true, extra: exec.extraPrompt }) + scratchSection(scratch) })
        : await this.run(fresh());
      if (resume && !impl.ok && impl.evidence.toolCalls === 0 && !signal.aborted) {
        log('无法接续上一轮的会话，改为新开会话继续');
        impl = await this.run(fresh());
      }
      this.saveEvidence(id, 'implement', impl.evidence);
      cost += impl.evidence.costUsd ?? 0;
      log(`实现阶段：${evidenceLine(impl.evidence)}`);
      // 中途失败或被手动停止，也把已经改动的文件记到这个任务上：重试时它们仍算本任务的改动。
      // 别的任务仍会把这些文件看成「执行前已有的改动」，所以失败任务留下的改动要先处理再继续跑队列
      if ((!impl.ok || signal.aborted) && snap) changed = (await taskChanges(snap).catch(() => null))?.files;
      stopIfAborted();
      if (!impl.ok) throw new Error(`实现失败：${impl.text}`);
      this.store.update(id, { summary: impl.text });

      const implChanges = snap ? await this.changes(snap, log) : null;
      changed = implChanges?.files;
      // 保存本次改动，验收时直接看 diff；验证阶段也用同一份
      let diff = snap && implChanges ? await taskDiff(snap, implChanges).catch((e) => `（无法生成 diff：${message(e)}）`) : undefined;
      // 执行前已改动、本任务又改过的文件：把执行期间的变化也交给验证，否则验证看不到本任务在这些文件里做了什么
      if (diff !== undefined && snap && implChanges && implChanges.skipped.length) {
        const sd = await skippedDiff(snap, implChanges.skipped).catch((e) => `（无法生成执行前已改动文件的 diff：${message(e)}）`);
        if (sd) diff = `${diff}\n${sd}`;
      }
      if (diff !== undefined) this.store.saveDiff(id, diff);

      // ---------- 验证 ----------
      this.store.setStatus(id, 'testing');
      enter('verify');
      log('===== 开始验证 =====');
      const current = this.store.get(id)!;
      const input: GateInput = {
        criteria: current.spec?.criteria.length ? current.spec.criteria : FALLBACK_CRITERIA,
        scope: current.spec?.scope ?? [],
        scopePrefix: snap ? path.relative(snap.root, workdir).replace(/\\/g, '/') : '',
        changes: implChanges && { files: implChanges.files, skipped: implChanges.skipped },
        implement: impl.evidence,
        mode: exec.verificationMode,
      };

      const nothingToVerify = !!sessionProblem(impl.evidence) || (!!implChanges && !implChanges.files.length && !implChanges.skipped.length);
      if (nothingToVerify) {
        log('实现阶段没有可验证的结果，跳过验证');
      } else {
        if (exec.testCommand) {
          const exitCode = await runShell(exec.testCommand, { cwd: workdir, timeoutMs: exec.testTimeoutMinutes * 60_000, log, signal, label: '测试命令' });
          stopIfAborted();
          input.testCommand = { exitCode };
        }
        // 测试命令没过就不必再让代理验证；只跑命令的模式但没配命令时，仍由代理验证
        const byAgent = exec.verificationMode === 'agent' || !exec.testCommand;
        if (byAgent && (!input.testCommand || input.testCommand.exitCode === 0)) {
          if (exec.verificationMode === 'command') log('未配置测试命令，改由代理验证');
          input.mode = 'agent';
          const res = await this.run({
            ...base,
            exec: verifyExec(exec),
            stage: 'verify',
            access: 'write',
            schema: VERIFY_SCHEMA,
            prompt: verifyPrompt(
              current,
              input.criteria,
              defaultEnv(project),
              files,
              // 项目记忆只在实现阶段写：验证阶段再写一遍会让每轮多花约一分钟，且验证不该产生文件
              this.skills(exec, 'verify', log) + notesSection(notes) + verifyHint,
              implChanges && diff !== undefined ? { files: implChanges.files, skipped: implChanges.skipped, diff } : undefined,
            ),
            timeoutMs: exec.timeoutMinutes * 60_000,
          });
          this.saveEvidence(id, 'verify', res.evidence);
          log(`验证阶段：${evidenceLine(res.evidence)}`);
          stopIfAborted();
          input.verify = { ok: res.ok, error: res.ok ? undefined : res.text, evidence: res.evidence, report: res.ok ? normalizeReport(res.structured) : null };

          // 验证阶段不该改代码：找出它新留下的文件，和它动过的实现文件
          const after = snap && implChanges ? await taskChanges(snap).catch(() => null) : null;
          if (after && implChanges) {
            const implFiles = new Set(implChanges.files);
            input.verifyLeftovers = after.files.filter((f) => !implFiles.has(f));
            input.verifyTouched = implChanges.files.filter((f) => after.states.get(f) !== implChanges.states.get(f));
          }
        }
      }

      // ---------- 门禁 ----------
      const gate = evaluateGate(input);
      this.store.update(id, { gate });
      this.logGate(gate, log);

      if (gate.verdict === 'fail') {
        this.store.setStatus(id, 'blocked', { error: gateError(gate), leftover: changed });
        this.holdForLeftover(runner, task.projectId, changed, log);
        return;
      }
      // 需要人工验收时也提交（只提交到本地）：否则这些改动会被队列里的下一个任务当成执行前已有的改动
      const commitError = snap && implChanges && exec.autoCommit ? await this.commit(id, snap, implChanges.files, log) : undefined;
      // 没有提交成功（或没开自动提交）时，这些文件仍留在工作区
      const left = this.store.get(id)?.commit ? undefined : changed;
      if (gate.verdict === 'unverified' && !exec.skipReview) {
        this.store.setStatus(id, 'review', { error: commitError, manualChecks: manualChecksText(gate) || '详见门禁结论', leftover: left });
      } else {
        // 项目开了「待人工确认也直接通过」：不拦，但把原本要人工确认的事项照旧记在任务上
        if (gate.verdict === 'unverified') log('门禁结论为待人工确认；项目设置为不进入待验证，按「门禁通过后」的设置流转');
        // 门禁通过但还有人工验收项：清单留在任务上，部署后核对，不阻断流转
        this.store.setStatus(id, exec.passTarget, { error: commitError, manualChecks: manualChecksText(gate) || undefined, leftover: left });
        if (exec.passTarget === 'done') this.emit('done', id);
      }
      // 没提交成功的改动同样会被后续任务当成「执行前已有的改动」：与失败路径一致，先暂停让使用者处理
      this.holdForLeftover(runner, task.projectId, left, log);
    } catch (e) {
      const msg = message(e);
      log(`错误：${msg}`);
      this.store.setStatus(id, 'blocked', { error: msg, leftover: changed ?? (leftover.length ? leftover : undefined) });
      // 手动停止不暂停：使用者在场，自行决定是否继续；失败留下的改动要先处理再跑后续任务
      if (!signal.aborted) this.holdForLeftover(runner, task.projectId, changed ?? (leftover.length ? leftover : undefined), log);
    } finally {
      try {
        if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
      } catch {
        // 代理残留文件句柄（Windows EBUSY）时删不掉，留给系统临时目录清理
      }
      runner.currentId = null;
      runner.abort = null;
      runner.progress = undefined;
      this.emit('status');
      // 一轮执行结束（无论成败）：上层据此落一条 AI 修复执行记录
      this.emit('run-end', id);
      this.tick();
    }
  }

  private logGate(gate: GateResult, log: (l: string) => void) {
    const lines = [
      `===== 门禁结论：${VERDICT_LABEL[gate.verdict]} =====`,
      ...gate.reasons.map((r) => `${REASON_MARK[r.level]} ${r.text}`),
      ...gate.items.map((i) => `[${i.id}] ${VERDICT_LABEL[i.result]}：${i.text}${i.evidence ? `\n    依据：${clip(i.evidence.replace(/\s*\n\s*/g, ' '), 300)}` : ''}`),
    ];
    log(lines.join('\n'));
  }

  /** 本阶段的 skill 段落（skill 是 Claude Code 的机制）；理解阶段只读，不提禁用（没有提交类操作） */
  private skills(exec: ExecConfig, stage: Stage, log: (l: string) => void): string {
    if (exec.provider !== 'claude') return '';
    const use = stageSkills(exec, stage);
    if (use.length) log(`本阶段指定 skill：${use.join('、')}`);
    return skillSection(use, stage === 'analysis' ? [] : splitSkills(exec.disabledSkills));
  }

  /** 同项目已完成的相关任务 */
  private history(task: Task, log: (l: string) => void): Task[] {
    const list = relatedHistory(task, this.store.list());
    if (list.length) log(`附上 ${list.length} 个相关的已完成任务供参考`);
    return list;
  }

  /** 项目记忆目录 + 提示词段落；失败时只记日志，不影响任务 */
  private async memory(workdir: string, log: (l: string) => void): Promise<{ section: string; dirs: string[] }> {
    try {
      const dir = await ensureMemoryDir(workdir);
      return { section: memorySection(dir), dirs: [dir] };
    } catch (e) {
      log(`无法准备项目记忆目录，本次不写经验：${message(e)}`);
      return { section: '', dirs: [] };
    }
  }

  /** 提交实现阶段的改动；失败不影响任务结果，返回错误信息显示在任务上 */
  private async commit(id: string, snap: GitSnapshot, files: string[], log: (l: string) => void): Promise<string | undefined> {
    const task = this.store.get(id)!;
    try {
      const res = await commitTaskChanges(snap, commitMessage(task.title, task.summary), files);
      if (res.committed) {
        log(`已提交 ${res.hash}：${res.files.length} 个文件\n${res.files.map((f) => `  ${f}`).join('\n')}`);
        this.store.update(id, { commit: { hash: res.hash!, files: res.files } });
      } else log('没有可自动提交的文件');
      if (res.skipped.length) {
        log(`以下文件执行前就有未提交的改动，本任务又修改了它们，为避免混入你的改动未自动提交，请手动处理：\n${res.skipped.map((f) => `  ${f}`).join('\n')}`);
      }
      return undefined;
    } catch (e) {
      const msg = message(e);
      const hint = /user\.(name|email)|Please tell me who you are/i.test(msg) ? '（请先配置 git user.name 和 user.email）' : '';
      log(`自动提交失败${hint}：${msg}`);
      return `门禁已通过，但自动提交失败${hint}：${msg}`;
    }
  }

  /** 实现阶段的改动；计算失败时返回 null，门禁按「无法核对」处理 */
  private async changes(snap: GitSnapshot, log: (l: string) => void): Promise<TaskChanges | null> {
    try {
      const c = await taskChanges(snap);
      log(`本任务改动了 ${c.files.length} 个文件${c.files.length ? `：${c.files.slice(0, 20).join('、')}` : ''}`);
      return c;
    } catch (e) {
      log(`无法计算本任务的改动：${message(e)}`);
      return null;
    }
  }

  // ---------- 任务理解（只读分析，可并发） ----------
  analyze(id: string) {
    if (this.analyzing.has(id) || this.analyzeWaiting.includes(id)) return;
    this.store.update(id, { analyzing: true });
    this.analyzeWaiting.push(id);
    this.pumpAnalyze();
  }

  private pumpAnalyze() {
    while (this.analyzing.size < Queue.ANALYZE_CONCURRENCY && this.analyzeWaiting.length) {
      const id = this.analyzeWaiting.shift()!;
      this.analyzing.add(id);
      void this.runAnalyze(id).finally(() => {
        this.analyzing.delete(id);
        this.pumpAnalyze();
      });
    }
  }

  private async runAnalyze(id: string) {
    const task = this.store.get(id);
    if (!task) return;
    const log = (line: string) => this.store.appendLog(id, line);
    // 理解阶段的临时目录：只用来放 skill 库的副本
    let skillTmp = '';
    try {
      const project = this.store.getProject(task.projectId);
      if (!project) throw new Error('任务所属项目不存在');
      const { exec, workdir } = project;
      assertWorkdir(workdir);
      log('===== 生成任务规格 =====');
      const hadSpec = !!task.spec || !!task.confirmed;
      const { files, dirs } = await this.prepareFiles(task, log);
      skillTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-skills-'));
      const skillDirs = this.copySkillLibrary(skillTmp, log) ? [skillTmp] : [];
      // 理解阶段只读，只附历史任务，不要求写记忆
      const history = exec.useKnowledge ? historySection(this.history(task, log)) : '';
      const res = await this.run({
        stage: 'analysis',
        access: 'read',
        prompt: analysisPrompt(task, files, history + this.skills(exec, 'analysis', log) + verifySection(exec)),
        cwd: workdir,
        exec,
        skills: exec.provider === 'claude' ? stageSkills(exec, 'analysis') : [],
        addDirs: [...dirs, ...skillDirs],
        images: files.filter((f) => f.isImage).map((f) => f.path),
        schema: SPEC_SCHEMA,
        timeoutMs: exec.analyzeTimeoutMinutes * 60_000,
        onLog: log,
      });
      this.saveEvidence(id, 'analysis', res.evidence);
      log(`理解阶段：${evidenceLine(res.evidence)}`);
      if (!res.ok) throw new Error(res.text);
      // 没读过代码的规格只是对标题的猜测，不能交给人确认
      const problem = sessionProblem(res.evidence);
      if (problem) throw new Error(`会话无效：${problem}`);
      const spec = normalizeSpec(res.structured, { maxCriteria: MAX_AGENT_CRITERIA });
      // 只数有内容的验收项：空项本来就会被丢掉，不算截断
      const rawCriteria = (res.structured as { criteria?: unknown } | undefined)?.criteria;
      const given = Array.isArray(rawCriteria) ? rawCriteria.filter((c) => typeof (c as { text?: unknown } | null)?.text === 'string' && (c as { text: string }).text.trim()).length : 0;
      if (spec && given > spec.criteria.length) log(`规格给了 ${given} 条验收项，只保留前 ${spec.criteria.length} 条`);
      if (!spec) throw new Error(`没有得到可用的规格（缺少目标或验收项）${res.text ? `。代理的回复：${clip(res.text.trim(), 300)}` : ''}`);
      // 被丢掉的验收项写进风险里：确认规格时看得到，不只留在日志
      if (given > spec.criteria.length && Array.isArray(rawCriteria)) {
        const dropped = rawCriteria
          .map((c) => (typeof (c as { text?: unknown } | null)?.text === 'string' ? (c as { text: string }).text.trim() : ''))
          .filter(Boolean)
          .slice(spec.criteria.length);
        spec.risks = [...spec.risks, `代理给了 ${given} 条验收项，超出上限的 ${dropped.length} 条没有保留：${dropped.map((t) => clip(t, 40)).join('；')}`];
      }
      // 成功后清掉之前失败留下的错误信息
      this.store.update(id, { spec, analysis: renderSpec(spec), analyzing: false, error: undefined });
      // 自动确认：没有待回答的问题就直接进入待修改
      // 只对第一次生成的规格自动确认：被退回后重新生成的，由人看过再确认
      if (exec.autoConfirm && !hadSpec && !openQuestions(spec).length && this.store.get(id)?.status === 'pending_confirm') {
        log('规格没有待回答的问题，已按项目设置自动确认');
        this.store.setStatus(id, 'todo', { order: Date.now(), confirmed: { at: Date.now(), specHash: specHash(spec) } });
      }
    } catch (e) {
      const msg = message(e);
      log(`生成规格失败：${msg}`);
      this.store.update(id, { analyzing: false, error: `生成规格失败：${msg}` });
    } finally {
      try {
        if (skillTmp) fs.rmSync(skillTmp, { recursive: true, force: true });
      } catch {
        // 删不掉就留给系统临时目录清理
      }
    }
  }
}
