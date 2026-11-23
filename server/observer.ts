import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AgentRequest, AgentResult } from './agent.ts';
import { manifestHasAfterHash, removeBackup, resultPath, restoreBackup, runningPath } from './apply-proposal.ts';
import { classifyRunEnd, isManualStop, wireCollector } from './observe-collect.ts';
import { computeFlowMetrics, flowFindings, flowSection, type FlowMetrics } from './flow-metrics.ts';
import { ObservationStore } from './observe.ts';
import { canRemoveProposal, canRetryApply, DEFAULT_OBSERVER_SETTINGS, type ApplyResult, type ObserverSettings, type ObserverStatus, type ProbeRecord } from './observe-types.ts';
import { Optimizer } from './optimize.ts';
import { ProposalStore } from './proposal-store.ts';
import { UsageEventStore, type UsageEvent } from './usage-event.ts';
import { computeUsageMetrics, usageFindings, type UsageMetrics } from './usage-metrics.ts';
import type { Queue } from './queue.ts';
import { specHash } from './spec.ts';
import type { Store } from './store.ts';
import type { GateResult, Writeback } from './types.ts';

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
    onStateChange: () => emitStatus(),
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
      void optimizer.maybeAuto().catch(() => {});
    }
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
  return {
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
  };
}
