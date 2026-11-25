import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AgentRequest, AgentResult } from './agent.ts';
import { manifestHasAfterHash, removeBackup, resultPath, restoreBackup, runningPath } from './apply-proposal.ts';
import { classifyRunEnd, isManualStop, wireCollector } from './observe-collect.ts';
import { computeFlowMetrics, flowFindings, flowSection, type FlowMetrics } from './flow-metrics.ts';
import { ObservationStore } from './observe.ts';
import { canRemoveProposal, fixRoute, type BatchFixPlan, canRetryApply, DEFAULT_OBSERVER_SETTINGS, type BatchFixState, type ApplyResult, type ObserverSettings, type ObserverStatus, type ProbeRecord } from './observe-types.ts';
import { Optimizer } from './optimize.ts';
import { ProposalStore } from './proposal-store.ts';
import { UsageEventStore, type UsageEvent } from './usage-event.ts';
import { computeUsageMetrics, usageFindings, type UsageMetrics } from './usage-metrics.ts';
import type { Queue } from './queue.ts';
import { specHash } from './spec.ts';
import type { Store } from './store.ts';
import type { GateResult, Task, Writeback } from './types.ts';

/** Probe 复验对比：先比 verdict 秩（fail<unverified<pass，无门禁按 fail 秩），同秩比逐项 pass−fail 增减 */
export function compareProbe(before: GateResult | undefined, after: GateResult | undefined): ProbeRecord['result'] {
  const rank = (g?: GateResult) => (g ? { fail: 0, unverified: 1, pass: 2 }[g.verdict] : 0);
  const score = (g?: GateResult) => (g ? g.items.filter((i) => i.result === 'pass').length - g.items.filter((i) => i.result === 'fail').length : 0);
  const rb = rank(before);
  const ra = rank(after);
  if (ra > rb) return 'improved';
  if (ra < rb) return 'regressed';
  const sb = score(before);
  const sa = score(after);
  if (sa > sb) return 'improved';
  if (sa < sb) return 'regressed';
  return 'unchanged';
}

/** 编排器依赖：deployer 只需 allStatus；spawnApply/run 可注入便于测试 */
export interface ObserverDeps {
  root: string;
  store: Store;
  queue: Queue;
  deployer: { allStatus: () => Record<string, { running: boolean }> };
  getSettings?: () => { observer?: ObserverSettings };
  run?: (req: AgentRequest) => Promise<AgentResult>;
  spawnApply?: (mode: 'apply' | 'rollback', proposalId: string) => void;
  /** SSE 广播注入（index.ts 的 broadcast）；不注入则不广播（测试用） */
  onBroadcast?: (event: string, data: unknown) => void;
}

export interface Observer {
  observations: ObservationStore;
  proposals: ProposalStore;
  optimizer: Optimizer;
  /** 使用事件存储：查询与清空直接用它；新增事件走 addUsage（受采集开关约束） */
  usage: UsageEventStore;
  addUsage: (raw: unknown) => UsageEvent | null;
  usageMetrics: (windowDays?: number) => UsageMetrics;
  /** 使用摩擦采集：把达到阈值的摩擦写进台账（按 key 去重），返回新增条数 */
  collectUsage: () => number;
  gitBusy: Set<string>;
  isIdle: () => boolean;
  onRunEnd: (id: string) => void;
  collectImportFailure: (projectId: string, e: unknown) => void;
  collectWritebackFailure: (taskId: string, wb: Writeback) => void;
  collectGitFailure: (projectId: string, kind: 'git_sync' | 'git_push', e: unknown, severity?: 'warn' | 'error') => void;
  collectDeployResult: (projectId: string, st: { ok?: boolean; running: boolean }, logs: string[]) => void;
  startApply: (proposalId: string) => { ok: boolean; reason?: string };
  startRollback: (proposalId: string) => { ok: boolean; reason?: string };
  startProbe: (proposalId: string, observationId: string) => { ok: boolean; reason?: string };
  /** 一键修复（目标项目问题）：把问题关联的任务放回待修改并单独执行一次 */
  rerunTask: (observationId: string) => { ok: boolean; reason?: string };
  /** 页头一键修复：把可修的未处理问题排成队，逐条依次修，上一条结束才开始下一条 */
  startBatchFix: () => { ok: boolean; reason?: string; total?: number };
  /** 停止一键修复：正在修的这一条照常收尾，后面的不再开始 */
  stopBatchFix: () => { ok: boolean; reason?: string };
  /** 一键修复开始前的确认信息：各种处理方式各几条、最长耗时 */
  planBatchFix: () => BatchFixPlan;
  /** 详情页单条修复（重跑或复查）：启动后由轮询核对证据，有证据才标为已解决；resolved 表示已经能证明好了、不用再跑 */
  fixOne: (observationId: string) => { ok: boolean; reason?: string; resolved?: boolean };
  consumeResults: () => void;
  status: () => ObserverStatus;
  /** 流程采集：把可数的流程问题写进台账 */
  collectFlow: () => void;
  /** 删除一条已有结局的提案（连同它的备份） */
  removeProposal: (proposalId: string) => { ok: boolean; reason?: string };
  /** 清掉所有可删的提案，返回删了几条 */
  clearProposals: () => number;
  /** 清掉已处理的台账记录（保留仍有用的），返回清了几条 */
  clearObservations: () => number;
  /** 各项目的流程指标（按项目 id） */
  flow: () => Record<string, FlowMetrics>;
  snapshot: () => [string, unknown][];
  flush: () => void;
  dispose: () => void;
}

/** 组装观察者：台账/提案存储、采集接线、复盘、优化器、应用与复验编排 */
export function createObserver(deps: ObserverDeps): Observer {
  const { root, store, queue, deployer } = deps;
  const getSettings = deps.getSettings ?? (() => store.getSettings() as { observer?: ObserverSettings });
  const observations = new ObservationStore(path.join(root, 'data'));
  const proposals = new ProposalStore(path.join(root, 'data'));
  const usage = new UsageEventStore(path.join(root, 'data'));
  const gitBusy = new Set<string>();
  let applying: string | null = null;
  let applyMode: 'apply' | 'rollback' | null = null;
  /** 页头「一键修复」：待修队列与当前这一条的执行方式。纯内存态，服务器重启后停止，已修的不受影响 */
  let batch: { state: BatchFixState; queue: string[]; mode: 'diagnose' | 'rerun' | 'recheck' | null; taskId?: string; itemStartedAt: number; envBlocked?: string } | null = null;
  // 在 self 之后才定义：先占位，接口里转调
  let planBatchFixImpl: () => BatchFixPlan = () => ({ diagnose: 0, rerun: 0, recheck: 0, manual: 0, maxMinutes: 0 });
  let fixOneImpl: (id: string) => { ok: boolean; reason?: string; resolved?: boolean } = () => ({ ok: false, reason: '未就绪' });
  /** 详情页单条修复的待收尾项：跑完后核对证据。纯内存态，服务器重启后不再收尾（问题保持待处理） */
  const singles = new Map<string, { mode: 'rerun' | 'recheck'; taskId: string; startedAt: number }>();
  const spawnApply =
    deps.spawnApply ??
    ((mode: 'apply' | 'rollback', proposalId: string) => {
      const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const child = spawn(process.execPath, [tsx, 'server/apply-proposal.ts', mode, proposalId], { cwd: root, detached: true, windowsHide: true, stdio: 'ignore' });
      child.unref();
      // 服务器预写 marker：子进程冷启动期间也有存活凭据，避免被误判超时
      fs.mkdirSync(path.dirname(runningPath(root, proposalId)), { recursive: true });
      fs.writeFileSync(runningPath(root, proposalId), JSON.stringify({ pid: child.pid, startedAt: Date.now(), mode }), 'utf8');
    });
  const isEnabled = () => (getSettings().observer ?? DEFAULT_OBSERVER_SETTINGS).enabled;
  /** 全局空闲：无任务在跑、无自检/理解会话、无部署、无 git 同步推送 */
  const isIdle = (): boolean => {
    const qs = Object.values(queue.allStatus());
    if (qs.some((s) => s.currentId || s.preflight?.state === 'checking')) return false;
    if (store.list().some((t) => t.analyzing)) return false;
    if (Object.values(deployer.allStatus()).some((s) => s.running)) return false;
    if (gitBusy.size) return false;
    return true;
  };
  const projectMetrics = () =>
    store
      .listProjects()
      .filter((p) => !p.archived)
      .map((p) => ({ id: p.id, name: p.name, metrics: computeFlowMetrics(store.list().filter((t) => t.projectId === p.id), Date.now()) }));
  /** 流程采集：按项目算指标，把可数的流程问题写进台账（按 key 去重，重复调用不重复入库） */
  const collectFlow = () => {
    if (!isEnabled()) return;
    for (const p of projectMetrics()) {
      for (const d of flowFindings(p.id, p.metrics)) {
        observations.add({ projectId: d.projectId, kind: d.kind, severity: d.severity, title: d.title, detail: d.detail, context: {}, source: 'code', key: d.key });
      }
    }
  };
  /** 使用摩擦采集：与 collectFlow 同款——算指标、按 key 去重入台账，重复调用不重复入库 */
  const collectUsage = (): number => {
    if (!isEnabled()) return 0;
    const known = new Set(observations.list().map((o) => o.id));
    let added = 0;
    for (const d of usageFindings(usageMetrics())) {
      const rec = observations.add({ projectId: d.projectId, kind: d.kind, severity: d.severity, title: d.title, detail: d.detail, context: {}, source: 'code', key: d.key });
      if (!known.has(rec.id)) added++;
    }
    return added;
  };
  const usageMetrics = (windowDays = 7): UsageMetrics => ({
    ...computeUsageMetrics(usage.list(), windowDays),
    drawerDwell: usage.drawerDwellMs(windowDays * 24 * 3_600_000),
  });
  /** 应用提案（手动与自动共用）：单飞锁 + 空闲检查 + 清旧结果 + 脱离进程应用器 */
  const startApply = (proposalId: string): { ok: boolean; reason?: string } => {
    const p = proposals.get(proposalId);
    // 应用没成功、文件已还原的提案可以重试（如应用途中机器休眠或进程被打断）；手动回滚的、文件没还原的不行
    if (!p || (p.status !== 'pending' && !canRetryApply(p))) return { ok: false, reason: '只有待确认或应用未成功的提案可以应用' };
    if (applying) return { ok: false, reason: '已有提案正在应用' };
    if (!isIdle()) return { ok: false, reason: '队列不空闲，请等任务结束后再应用' };
    applying = proposalId;
    applyMode = 'apply';
    proposals.setStatus(proposalId, 'applying');
    // 上一次应用留下的结果文件不能被当成这一次的结果
    fs.rmSync(resultPath(root, proposalId), { force: true });
    // 应用子进程从磁盘读提案：先落盘再 spawn，避免自动应用时 300ms 节流窗口内读不到新提案
    proposals.flush();
    spawnApply('apply', proposalId);
    emitStatus();
    return { ok: true };
  };
  const optimizer = new Optimizer({
    observations,
    proposals,
    getSettings,
    isIdle,
    toolRoot: root,
    run: deps.run,
    getApplying: () => applying,
    onStateChange: () => {
      emitStatus();
      // 一键修复：诊断一结束就尽快接下一条（轮询兜底）
      setTimeout(() => stepBatch(), 0);
    },
    getFlow: () => flowSection(projectMetrics()),
    onAutoApply: (id) => startApply(id).ok,
  });
  wireCollector({ store, queue, observations, isEnabled });
  /** 进行中的复验：taskId → 提案与复验前门禁。
   * 纯内存态：服务器重启会丢失，该次复验不写结论（方向安全，不会误判 regressed），用户可重新发起。 */
  const pendingProbes = new Map<string, { proposalId: string; beforeGate: GateResult | undefined }>();
  const onRunEnd = (id: string) => {
    const t = store.get(id);
    if (!t) return;
    if (isEnabled()) {
      for (const d of classifyRunEnd(t)) observations.add(d);
      // 每轮结束只做零成本的流程采集；LLM 审查统一由流程审查会话在空闲时做，不再每个异常轮次各起一次
      collectFlow();
      collectUsage();
      // 一键修复进行中时不起自动诊断：两者共用诊断单飞锁，会把排队的那一条挤成「正在诊断中」
      if (!batch || batch.state.endedAt !== null) void optimizer.maybeAuto().catch(() => {});
    }
    // 一键修复的重新执行这一条结束了：尽快接下一条（轮询兜底）
    setTimeout(() => stepBatch(), 0);
    const pending = pendingProbes.get(id);
    if (pending) {
      pendingProbes.delete(id);
      if (isManualStop(t.error)) {
        // 手动停止的复验轮不写结论：afterVerdict=null 会被误判 regressed 诱导错误回滚
        store.appendLog(id, '复验被停止，不记录复验结论');
      } else {
        proposals.setProbe(pending.proposalId, {
          taskId: id,
          beforeVerdict: pending.beforeGate?.verdict ?? null,
          afterVerdict: t.gate?.verdict ?? null,
          result: compareProbe(pending.beforeGate, t.gate),
          at: Date.now(),
        });
      }
    }
  };
  const status = (): ObserverStatus => ({
    enabled: isEnabled(),
    autoOptimize: (getSettings().observer ?? DEFAULT_OBSERVER_SETTINGS).autoOptimize,
    idle: isIdle(),
    diagnosing: optimizer.isDiagnosing(),
    applying,
    applyMode,
    probing: pendingProbes.size ? [...pendingProbes.values()][0].proposalId : null,
    newCount: observations.countNew(),
    pendingProposals: proposals.list().filter((p) => p.status === 'pending').length,
    lastRunAt: proposals.getLastRunAt(),
    lastRun: proposals.getLastRun(),
    batchFix: batch ? { ...batch.state, failed: [...batch.state.failed] } : null,
  });
  const emitStatus = () => deps.onBroadcast?.('observer', status());
  if (deps.onBroadcast) {
    observations.on('change', () => deps.onBroadcast!('observations', observations.list()));
    proposals.on('change', () => {
      deps.onBroadcast!('proposals', proposals.list());
      // 审查结果（lastRun）也随提案库变化，状态一并推送
      emitStatus();
    });
  }
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** 无 marker 的启动宽限起点（子进程冷启动可能慢于轮询间隔） */
  const noMarkerSince = new Map<string, number>();
  /** 消费应用/回滚结果；存活则恢复单飞锁；死亡/超时则按 apply/rollback 中断分别兜底 */
  const consumeResults = () => {
    let changed = false;
    for (const p of proposals.list()) {
      if (p.status !== 'applying') continue;
      changed = true;
      const rp = resultPath(root, p.id);
      if (fs.existsSync(rp)) {
        let res: ApplyResult | null = null;
        try {
          res = JSON.parse(fs.readFileSync(rp, 'utf8')) as ApplyResult;
        } catch {
          res = null;
        }
        if (res) {
          fs.rmSync(rp, { force: true });
          fs.rmSync(runningPath(root, p.id), { force: true });
          noMarkerSince.delete(p.id);
          // 只释放属于本提案的锁，避免误清正在运行的新应用
          if (applying === p.id) {
            applying = null;
            applyMode = null;
          }
          if (res.mode === 'rollback') {
            proposals.setStatus(p.id, res.ok ? 'rolled_back' : 'applied', res);
            if (res.ok) observations.reopenByProposal(p.id);
          } else {
            proposals.setStatus(p.id, res.ok ? 'applied' : 'rolled_back', res);
            if (res.ok) observations.markResolvedByProposal(p.id, p.problemIds);
          }
          continue;
        }
        // 损坏的结果文件：不跳过，落入下方 marker/超时判定，避免单飞锁永久泄漏
      }
      let marker: { pid: number; startedAt: number; mode?: 'apply' | 'rollback' } | null = null;
      try {
        marker = JSON.parse(fs.readFileSync(runningPath(root, p.id), 'utf8'));
      } catch {
        marker = null;
      }
      const alive = marker ? isAlive(marker.pid) : false;
      let timedOut: boolean;
      if (marker) {
        noMarkerSince.delete(p.id);
        timedOut = Date.now() - marker.startedAt > 30 * 60_000;
      } else {
        const since = noMarkerSince.get(p.id) ?? Date.now();
        noMarkerSince.set(p.id, since);
        timedOut = Date.now() - since > 60_000;
      }
      if (!timedOut && (alive || !marker)) {
        // 重启后子进程仍存活（或正在冷启动）：恢复内存单飞锁，继续等结果
        applying = p.id;
        applyMode = marker?.mode ?? 'apply';
        continue;
      }
      // 兜底：apply 中断（无 afterHash）无条件还原；rollback 中断（有 afterHash）走漂移校验，不覆盖用户改动
      if (manifestHasAfterHash(root, p.id)) {
        const r = restoreBackup(root, p.id, { checkDrift: true });
        if (r.ok) {
          proposals.setStatus(p.id, 'rolled_back', { ok: true, output: '回滚进程中断，已还原备份', at: Date.now(), mode: 'rollback' });
          observations.reopenByProposal(p.id);
        } else {
          proposals.setStatus(p.id, 'applied', { ok: false, output: `回滚进程中断，文件已漂移，保持应用状态：${r.reason ?? ''}`, at: Date.now(), mode: 'rollback' });
        }
      } else {
        const r = restoreBackup(root, p.id);
        proposals.setStatus(p.id, 'rolled_back', { ok: false, output: r.ok ? '应用进程中断，已还原备份' : `应用进程中断，还原失败：${r.reason ?? '无备份'}`, at: Date.now(), mode: 'apply', restored: r.ok });
      }
      fs.rmSync(runningPath(root, p.id), { force: true });
      fs.rmSync(resultPath(root, p.id), { force: true });
      noMarkerSince.delete(p.id);
      if (applying === p.id) {
        applying = null;
        applyMode = null;
      }
    }
    if (changed) emitStatus();
  };
  const removeProposal = (proposalId: string) => {
    const p = proposals.get(proposalId);
    if (!p) return { ok: false, reason: '提案不存在' };
    if (!canRemoveProposal(p)) {
      return { ok: false, reason: p.result?.restored === false ? '这条提案应用时文件没有还原，请先点「放弃」再删除' : '只有已拒绝、已失效、已回滚的提案可以删除' };
    }
    // 文件没还原过的：备份可能是原文件的唯一副本，删提案时留着它
    if (p.result?.restored !== false) removeBackup(root, proposalId);
    proposals.remove(proposalId);
    return { ok: true };
  };
  // 无条件轮询：重启恢复依赖它发现存活的 applying 提案（提案量小，开销可忽略）
  const pollTimer = setInterval(() => consumeResults(), 5000);
  pollTimer.unref();
  // 重启恢复：上一轮进程留下的 applying 在这里收敛
  consumeResults();
  const self: Observer = {
    observations,
    proposals,
    optimizer,
    usage,
    addUsage: (raw: unknown) => ((getSettings().observer ?? DEFAULT_OBSERVER_SETTINGS).usageCollect === false ? null : usage.add(raw)),
    usageMetrics,
    collectUsage,
    gitBusy,
    isIdle,
    onRunEnd,
    collectImportFailure: (projectId: string, e: unknown) => {
      if (!isEnabled()) return;
      observations.add({ projectId, kind: 'feishu_import', severity: 'error', title: '飞书导入失败', detail: e instanceof Error ? e.message : String(e), context: {}, source: 'code' });
    },
    collectWritebackFailure: (taskId: string, wb: Writeback) => {
      const t = store.get(taskId);
      if (!isEnabled() || !t) return;
      observations.add({ projectId: t.projectId, taskId, kind: 'feishu_writeback', severity: 'error', title: '飞书回写失败', detail: wb.message, context: {}, source: 'code' });
    },
    collectGitFailure: (projectId: string, kind: 'git_sync' | 'git_push', e: unknown, severity: 'warn' | 'error' = 'error') => {
      if (!isEnabled()) return;
      observations.add({ projectId, kind, severity, title: kind === 'git_sync' ? 'Git 同步失败' : 'Git 推送失败', detail: e instanceof Error ? e.message : String(e), context: {}, source: 'code' });
    },
    collectDeployResult: (projectId: string, st: { ok?: boolean; running: boolean }, logs: string[]) => {
      if (!isEnabled() || st.running || st.ok !== false) return;
      if (logs.some((l) => l.includes('部署已手动停止'))) return;
      observations.add({ projectId, kind: 'deploy_fail', severity: 'error', title: '部署失败', detail: logs.slice(-5).join('\n'), context: {}, source: 'code' });
    },
    startApply,
    startRollback: (proposalId: string) => {
      const p = proposals.get(proposalId);
      if (!p || p.status !== 'applied') return { ok: false, reason: '只有已应用的提案可以回滚' };
      // 自动应用过的提案可一键撤销，不必等复验退化；手动应用的仍只有复验退化才回滚
      if (!p.auto && p.probe?.result !== 'regressed') return { ok: false, reason: '只有复验退化或自动应用的提案可以回滚' };
      if (applying) return { ok: false, reason: '已有提案正在应用' };
      if (!isIdle()) return { ok: false, reason: '队列不空闲，请等任务结束后再回滚' };
      applying = proposalId;
      applyMode = 'rollback';
      proposals.setStatus(proposalId, 'applying');
      spawnApply('rollback', proposalId);
      emitStatus();
      return { ok: true };
    },
    startProbe: (proposalId: string, observationId: string) => {
      const p = proposals.get(proposalId);
      if (!p || p.status !== 'applied') return { ok: false, reason: '只有已应用的提案可以复验' };
      const o = observations.list().find((x) => x.id === observationId);
      if (!o || !p.problemIds.includes(o.id)) return { ok: false, reason: '关联问题不存在' };
      if (!o.taskId) return { ok: false, reason: '该问题没有关联任务，无法复验' };
      const t = store.get(o.taskId);
      if (!t || !['blocked', 'review', 'done'].includes(t.status)) return { ok: false, reason: '任务当前状态不支持复验' };
      if (queue.isBusy(t.projectId)) return { ok: false, reason: '该项目有任务正在执行' };
      if (applying) return { ok: false, reason: '有提案正在应用，请稍后再复验' };
      if (pendingProbes.has(t.id)) return { ok: false, reason: '该任务已有复验在进行' };
      // 先快照 beforeGate 并注册 pending，再重跑，避免竞态
      pendingProbes.set(t.id, { proposalId, beforeGate: t.gate });
      store.setStatus(t.id, 'todo', {
        order: Date.now(),
        error: undefined,
        manualChecks: undefined,
        followUp: undefined,
        confirmed: { at: Date.now(), specHash: t.spec && specHash(t.spec) },
      });
      queue.runOne(t.id);
      emitStatus();
      return { ok: true };
    },
    rerunTask: (observationId: string) => {
      const o = observations.get(observationId);
      if (!o) return { ok: false, reason: '问题不存在' };
      if (!o.taskId) return { ok: false, reason: '该问题没有关联任务，无法重新执行' };
      const t = store.get(o.taskId);
      if (!t) return { ok: false, reason: '关联任务已不存在' };
      if (!['todo', 'blocked', 'review', 'done'].includes(t.status)) return { ok: false, reason: '关联任务当前状态不支持重新执行' };
      if (queue.isBusy(t.projectId)) return { ok: false, reason: '该项目有任务正在执行' };
      if (pendingProbes.has(t.id)) return { ok: false, reason: '该任务正在复验' };
      // 与复验、看板「重试」同款的状态复位：清掉上一轮的报错与人工确认事项
      const before = { status: t.status, order: t.order, error: t.error, manualChecks: t.manualChecks, followUp: t.followUp, confirmed: t.confirmed };
      if (t.status !== 'todo') {
        store.setStatus(t.id, 'todo', {
          order: Date.now(),
          error: undefined,
          manualChecks: undefined,
          followUp: undefined,
          confirmed: { at: Date.now(), specHash: t.spec && specHash(t.spec) },
        });
      }
      try {
        queue.runOne(t.id);
      } catch (e) {
        // 没跑起来就把任务还原成点按钮之前的样子，不留一个被清掉报错的待办
        if (before.status !== 'todo') {
          const { status, ...rest } = before;
          store.setStatus(t.id, status, rest);
        }
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
      emitStatus();
      return { ok: true };
    },
    consumeResults,
    status,
    collectFlow,
    removeProposal,
    // 批量清理只动已有最终结局的：还能重试的留给使用者自己决定
    clearProposals: () => proposals.list().filter((p) => !canRetryApply(p) && removeProposal(p.id).ok).length,
    // 已应用提案关联的问题留着：复验要用它们，复验退化才能回滚
    clearObservations: () => observations.clearHandled(new Set(proposals.list().filter((p) => p.status === 'applied').map((p) => p.id))),
    flow: () => Object.fromEntries(projectMetrics().map((p) => [p.id, p.metrics])),
    snapshot: () => [
      ['observations', observations.list()],
      ['proposals', proposals.list()],
      ['observer', status()],
      ['flow', Object.fromEntries(projectMetrics().map((p) => [p.id, p.metrics]))],
    ],
    flush: () => {
      observations.flush();
      proposals.flush();
      usage.flush();
    },
    dispose: () => {
      clearInterval(pollTimer);
    },
    startBatchFix: () => startBatchFix(),
    planBatchFix: () => planBatchFixImpl(),
    fixOne: (id: string) => fixOneImpl(id),
    stopBatchFix: () => {
      if (!batch || batch.state.endedAt !== null) return { ok: false, reason: '没有正在进行的一键修复' };
      // 只是不再开始下一条：正在诊断、应用或执行的这一条照常收尾，不强行打断
      // 没开始的不算进总数：结束摘要里各项加起来才等于总数
      batch.state.total -= batch.queue.length;
      batch.queue = [];
      batch.state.stopped = true;
      emitStatus();
      return { ok: true };
    },
  };

  const finishBatch = () => {
    if (!batch) return;
    batch.state.current = null;
    batch.state.endedAt = Date.now();
    batch.state.waiting = false;
    batch.mode = null;
  };
  const clearCurrent = () => {
    if (!batch) return;
    batch.state.current = null;
    batch.mode = null;
    batch.taskId = undefined;
  };
  /** 重新生成规格：环境问题（模型网关等）的实际复查。只读、不改代码；already 表示任务已有规格、故障已不在 */
  const recheck = (observationId: string): { ok: boolean; reason?: string; already?: boolean } => {
    const o = observations.get(observationId);
    if (!o) return { ok: false, reason: '问题不存在' };
    const t = o.taskId ? store.get(o.taskId) : undefined;
    if (!t) return { ok: false, reason: '关联任务已不存在' };
    if (t.analyzing) return { ok: false, reason: '关联任务正在生成规格' };
    if (recovered(t)) return { ok: true, already: true };
    if (t.status !== 'pending_confirm') return { ok: false, reason: '关联任务已不在待确认，无法重新生成规格' };
    queue.analyze(t.id);
    return { ok: true };
  };
  /** 当前这一条有没有结束；结束了就记结果。返回 true 表示可以开始下一条 */
  const settleCurrent = (): boolean => {
    if (!batch || !batch.state.current) return true;
    const id = batch.state.current;
    const o = observations.get(id);
    const elapsed = Date.now() - batch.itemStartedAt;
    let reason = '处理结束后问题仍未解决';
    if (batch.mode === 'diagnose') {
      // 诊断结束且它发起的应用也收尾了，才算这一条做完
      if (optimizer.isDiagnosing() || applying) return false;
    } else if (batch.mode === 'rerun' || batch.mode === 'recheck') {
      const t = batch.taskId ? store.get(batch.taskId) : undefined;
      // 重跑：刚放回待修改、队列还没接手的几秒里不能误判为已结束；自检阶段也算还在跑
      const running =
        batch.mode === 'rerun'
          ? !!t && (queue.isBusy(t.projectId) || !!t.analyzing || queue.allStatus()[t.projectId]?.preflight?.state === 'checking' || (t.status === 'todo' && elapsed < 30_000))
          : !!t && !!t.analyzing;
      // 单条等待上限：超时记为没修好并继续下一条，任务本身不被打断
      const limit = batch.mode === 'rerun' ? RERUN_LIMIT_MIN : RECHECK_LIMIT_MIN;
      if (running && elapsed < limit * 60_000) return false;
      if (running) {
        // 复查卡住不返回也是故障还在：后面同样报错的不再各等一遍
        if (batch.mode === 'recheck') batch.envBlocked = o?.detail;
        batch.state.finished++;
        batch.state.failed.push({ id, reason: `${label(o)}关联任务 ${limit} 分钟还没结束，先跳过，任务继续在跑` });
        clearCurrent();
        return true;
      }
      if (!t) reason = '关联任务已不存在';
      else if (batch.mode === 'rerun') {
        // 同一任务挂着的其他问题逐条核对证据：有证据的一并解决，不为同一个任务重跑第二遍
        for (const x of observations.list({ status: 'new' })) {
          if (x.id === id || x.taskId !== t.id || fixRoute(x)?.mode !== 'rerun') continue;
          const queued = batch.queue.indexOf(x.id);
          const why = rerunUnproven(x, t);
          if (!why) observations.setStatus(x.id, 'resolved');
          // 排在队里的直接记结果并摘掉：不为同一个任务重跑第二遍
          if (queued >= 0) {
            batch.queue.splice(queued, 1);
            batch.state.finished++;
            if (why) batch.state.failed.push({ id: x.id, reason: label(x) + why });
            else batch.state.fixed++;
          }
        }
        // 这一条本身：有证据才标已解决
        const unproven = o ? rerunUnproven(o, t) : null;
        if (unproven) reason = unproven;
        else if (o?.status === 'new') observations.setStatus(id, 'resolved');
      } else {
        const fail = t.error?.startsWith(ANALYZE_FAIL) ? t.error : null;
        if (recovered(t)) {
          // 规格生成成功：网关已恢复的直接证据
          if (o?.status === 'new') observations.setStatus(id, 'resolved');
        } else {
          reason = `重新生成规格仍失败：${clipReason(fail ?? '没有得到规格')}`;
          // 记下这个故障：后面同样报错的不再逐条重试，省得每条都等一遍
          batch.envBlocked = fail ?? o?.detail;
        }
      }
    }
    const after = observations.get(id);
    batch.state.finished++;
    if (after && after.status === 'resolved') {
      batch.state.fixed++;
    } else if (after && after.status === 'reviewing') {
      batch.state.reviewing = (batch.state.reviewing ?? 0) + 1;
    } else if (!after || after.status === 'ignored') {
      // 修的过程中被手动忽略或清理：不算没修好
      batch.state.total--;
      batch.state.finished--;
    } else {
      if (batch.mode === 'diagnose') {
        // 只看这一条开始后产生的提案与诊断记录，不拿历史结果冒充本次原因
        const since = batch.itemStartedAt;
        const related = proposals.list().filter((p) => p.problemIds.includes(id) && p.at >= since);
        const last = related[related.length - 1];
        const run = proposals.getLastRun();
        if (run && run.at >= since && !run.ok) reason = `诊断失败：${run.error ?? '原因未知'}`;
        else if (!last) reason = '诊断没有产出修改方案';
        else if (last.status === 'rolled_back') reason = `修改应用后验证没通过，已还原：${clipReason(last.result?.output)}`;
        else if (last.status === 'pending') reason = '修改方案没能自动应用，留在优化提案页等你确认';
      }
      batch.state.failed.push({ id, reason: label(after) + reason });
    }
    clearCurrent();
    return true;
  };
  /** 推进一键修复：上一条收尾后才开始下一条。由轮询与任务结束事件驱动 */
  const stepBatch = () => {
    // 在定时器里调用：出错不能抛出去拖垮进程，记到当前这一条上，下一轮继续
    try {
      stepBatchUnsafe();
    } catch (e) {
      if (!batch || batch.state.endedAt !== null) return;
      const id = batch.state.current;
      if (id) {
        batch.state.finished++;
        batch.state.failed.push({ id, reason: label(observations.get(id)) + `处理出错：${clipReason(e instanceof Error ? e.message : String(e))}` });
        clearCurrent();
      }
    }
  };
  const stepBatchUnsafe = () => {
    if (!batch || batch.state.endedAt !== null) return;
    if (!settleCurrent()) return;
    while (batch.queue.length) {
      // 等前一条的余波（重新执行触发的自检、其他任务）停下再开始，不把「队列不空闲」记成失败
      if (!isIdle() || applying || optimizer.isDiagnosing()) {
        batch.state.waiting = true;
        emitStatus();
        return;
      }
      batch.state.waiting = false;
      const id = batch.queue.shift()!;
      const o = observations.get(id);
      const route = o ? fixRoute(o) : null;
      // 排队期间可能已被手动处理，或被前一条一并解决
      if (!o || !route || route.mode === 'manual') {
        batch.state.total--;
        continue;
      }
      batch.state.current = id;
      batch.itemStartedAt = Date.now();
      let started: { ok: boolean; reason?: string };
      if (route.mode === 'rerun') {
        batch.mode = 'rerun';
        batch.taskId = o.taskId;
        const t = o.taskId ? store.get(o.taskId) : undefined;
        if (t && t.status === 'done' && !rerunUnproven(o, t)) {
          observations.setStatus(id, 'resolved');
          batch.state.fixed++;
          batch.state.finished++;
          clearCurrent();
          continue;
        }
        started = self.rerunTask(id);
      } else if (route.mode === 'recheck') {
        batch.mode = 'recheck';
        batch.taskId = o.taskId;
        if (batch.envBlocked && sameFault(o.detail, batch.envBlocked)) {
          started = { ok: false, reason: `同样的故障刚复查过还没排除，先跳过：${clipReason(batch.envBlocked)}` };
        } else {
          const r = recheck(id);
          if (r.ok && r.already) {
            observations.setStatus(id, 'resolved');
            batch.state.fixed++;
            batch.state.finished++;
            clearCurrent();
            continue;
          }
          started = r;
        }
      } else {
        batch.mode = 'diagnose';
        const r = optimizer.runForObservation(id);
        started = { ok: r.started, reason: r.reason };
      }
      if (started.ok) break;
      batch.state.failed.push({ id, reason: label(o) + (started.reason ?? '无法开始') });
      batch.state.finished++;
      clearCurrent();
    }
    if (!batch.queue.length && !batch.state.current) finishBatch();
    emitStatus();
  };
  /** 待处理的问题按编号排好，分成要修的与需要人工的 */
  const sortBatch = () => {
    const ids: string[] = [];
    const manual: { id: string; reason: string }[] = [];
    const plan: BatchFixPlan = { diagnose: 0, rerun: 0, recheck: 0, manual: 0, maxMinutes: 0 };
    // 按编号从小到大：先报的先修
    for (const o of observations.list({ status: 'new' }).sort((a, b) => (a.number ?? 0) - (b.number ?? 0))) {
      const r = fixRoute(o);
      if (!r) continue;
      plan[r.mode]++;
      if (r.mode === 'manual') manual.push({ id: o.id, reason: label(o) + r.reason });
      else ids.push(o.id);
    }
    plan.maxMinutes = plan.diagnose * DIAGNOSE_LIMIT_MIN + plan.rerun * RERUN_LIMIT_MIN + plan.recheck * RECHECK_LIMIT_MIN;
    return { ids, manual, plan };
  };
  planBatchFixImpl = () => sortBatch().plan;
  const startBatchFix = (): { ok: boolean; reason?: string; total?: number } => {
    if (!isEnabled()) return { ok: false, reason: '观察者未开启' };
    if (batch && batch.state.endedAt === null) return { ok: false, reason: '一键修复正在进行' };
    if (optimizer.isDiagnosing()) return { ok: false, reason: '正在诊断中' };
    if (applying) return { ok: false, reason: '有提案正在应用' };
    const { ids, manual } = sortBatch();
    if (!ids.length && !manual.length) return { ok: false, reason: '没有可以修复的问题' };
    const now = Date.now();
    batch = {
      state: { total: ids.length, finished: 0, current: null, fixed: 0, reviewing: 0, failed: [], manual, waiting: false, startedAt: now, endedAt: ids.length ? null : now },
      // 复制一份：开始第一条时会从队列里取走，不能连带改掉返回给页面的总数
      queue: [...ids],
      mode: null,
      itemStartedAt: 0,
    };
    stepBatch();
    return { ok: true, total: ids.length };
  };
  fixOneImpl = (id: string) => {
    if (batch && batch.state.endedAt === null) return { ok: false, reason: '一键修复正在进行：等它结束，或先停止' };
    if (singles.has(id)) return { ok: false, reason: '这一条已经在修了' };
    const o = observations.get(id);
    const route = o ? fixRoute(o) : null;
    if (!o || !route || !o.taskId || (route.mode !== 'rerun' && route.mode !== 'recheck')) return { ok: false, reason: '这一条不能重跑或复查' };
    const t = store.get(o.taskId);
    if (!t) return { ok: false, reason: '关联任务已不存在' };
    if (route.mode === 'rerun') {
      // 已经能证明好了：直接标已解决，不白跑一轮
      if (t.status === 'done' && !rerunUnproven(o, t)) {
        observations.setStatus(id, 'resolved');
        return { ok: true, resolved: true };
      }
      const r = self.rerunTask(id);
      if (!r.ok) return r;
    } else {
      const r = recheck(id);
      if (!r.ok) return r;
      if (r.already) {
        observations.setStatus(id, 'resolved');
        return { ok: true, resolved: true };
      }
    }
    singles.set(id, { mode: route.mode, taskId: t.id, startedAt: Date.now() });
    return { ok: true };
  };
  /** 单条修复收尾：跑完核对证据，有证据标已解决，没有就保持待处理（原因看任务详情） */
  const settleSingles = () => {
    for (const [id, s] of singles) {
      const o = observations.get(id);
      const t = store.get(s.taskId);
      if (!o || o.status !== 'new' || !t) {
        singles.delete(id);
        continue;
      }
      const elapsed = Date.now() - s.startedAt;
      const running =
        s.mode === 'rerun'
          ? queue.isBusy(t.projectId) || !!t.analyzing || queue.allStatus()[t.projectId]?.preflight?.state === 'checking' || (t.status === 'todo' && elapsed < 30_000)
          : !!t.analyzing;
      const limit = s.mode === 'rerun' ? RERUN_LIMIT_MIN : RECHECK_LIMIT_MIN;
      if (running && elapsed < limit * 60_000) continue;
      singles.delete(id);
      if (running) continue;
      if (s.mode === 'rerun' ? !rerunUnproven(o, t) : recovered(t)) observations.setStatus(id, 'resolved');
    }
  };
  const batchTimer = setInterval(() => {
    stepBatch();
    try {
      settleSingles();
      observations.settleReviews();
    } catch {
      // 定时器里不能抛出去拖垮进程：下一轮再试
    }
  }, 3000);
  batchTimer.unref();
  const baseDispose = self.dispose;
  self.dispose = () => {
    clearInterval(batchTimer);
    baseDispose();
  };
  return self;
}

/** 原因前面带上问题编号：多条没修好时分得清是哪条 */
const label = (o?: { number?: number }) => (o?.number !== undefined ? `#${o.number}：` : '');

const clipReason = (s?: string) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 120)}…` : t || '未给出原因';
};

const ANALYZE_FAIL = '生成规格失败：';
/** 复查成功：有规格，且任务上没有任何报错（报错被别的阶段覆盖时，旧规格不能当作已恢复） */
const recovered = (t: Task) => !!t.spec && !t.error && !t.analyzing;
/** 单条等待上限（分钟）：诊断由优化器自己限时，这里只用于开始前估算耗时 */
const DIAGNOSE_LIMIT_MIN = 10;
const RERUN_LIMIT_MIN = 60;
const RECHECK_LIMIT_MIN = 20;

/** 同一个环境故障：去掉前缀后比开头一段，模型名、状态码一致即视为同一个 */
const sameFault = (a: string, b: string) => {
  const head = (x: string) => x.replace(ANALYZE_FAIL, '').replace(/\s+/g, ' ').trim().slice(0, 48);
  return head(a) === head(b);
};

/**
 * 任务重跑后，这条问题有没有证据证明好了：有就返回 null，没有就返回原因。
 * 任务完成只是前提；回写、门禁、提交类问题还要看那一步本身的结果
 */
function rerunUnproven(o: { kind: string }, t: Task): string | null {
  if (t.status !== 'done') return `关联任务重新执行后停在「${t.status}」${t.error ? `：${clipReason(t.error)}` : ''}`;
  if (o.kind === 'feishu_writeback' && t.writeback?.state !== 'done' && t.writeback?.state !== 'skipped') {
    return `任务完成了，但飞书回写仍没成功${t.writeback?.message ? `：${clipReason(t.writeback.message)}` : ''}`;
  }
  if ((o.kind === 'gate_fail' || o.kind === 'gate_unverified') && t.gate && t.gate.verdict !== 'pass') return `任务完成了，但门禁结论仍是「${t.gate.verdict}」`;
  if (o.kind === 'commit_fail' && t.leftover?.length) return `任务完成了，但仍有 ${t.leftover.length} 个改动文件没有提交`;
  return null;
}
