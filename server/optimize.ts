import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent, type AgentRequest, type AgentResult } from './agent.ts';
import { isAllowedFile } from './apply-proposal.ts';
import { optimizePrompt, proposalHistorySection, PROPOSAL_SCHEMA } from './observe-prompts.ts';
import type { ObservationStore } from './observe.ts';
import {
  componentRiskRank,
  DEFAULT_OBSERVER_SETTINGS,
  isActionable,
  PROPOSAL_COMPONENTS,
  type FlowReviewFinding,
  type ObservationAttribution,
  type ObserverSettings,
  type OptimizeRun,
  type Proposal,
  type ProposalComponent,
} from './observe-types.ts';
import type { ProposalStore } from './proposal-store.ts';

/** 自动诊断的触发判定：开关、空闲、阈值、冷却、单飞，全部满足才触发 */
export function canAutoOptimize(
  s: { enabled: boolean; autoOptimize: boolean; idle: boolean; newCount: number; lastRunAt: number | null; diagnosing: boolean; applying: string | null },
  now: number,
  cfg: { minNewObservations: number; cooldownHours: number },
): boolean {
  if (!s.enabled || !s.autoOptimize || !s.idle || s.diagnosing || s.applying) return false;
  if (s.newCount < cfg.minNewObservations) return false;
  if (s.lastRunAt !== null && now - s.lastRunAt < cfg.cooldownHours * 3_600_000) return false;
  return true;
}

/** 一条待入库的提案（id/at/status 由 ProposalStore 补） */
export type ProposalDraft = Omit<Proposal, 'id' | 'at' | 'status'>;

/** 诊断输出归一：形状校验、组件必填、problemIds 过滤、白名单预检、≤3 条、按风险秩稳定排序 */
export function normalizeProposals(raw: unknown, knownProblemIds: Set<string>): ProposalDraft[] {
  const arr = (raw as { proposals?: unknown } | null | undefined)?.proposals;
  if (!Array.isArray(arr)) return [];
  const drafts: ProposalDraft[] = [];
  for (const item of arr) {
    const p = item as Partial<Proposal> | null;
    if (!p || typeof p.title !== 'string' || !p.title.trim()) continue;
    if (!PROPOSAL_COMPONENTS.includes(p.component as ProposalComponent)) continue;
    if (!Array.isArray(p.edits) || !p.edits.length) continue;
    const editsOk = p.edits.every((e) => e && typeof e.file === 'string' && isAllowedFile(e.file) && typeof e.find === 'string' && e.find.length > 0 && typeof e.replace === 'string');
    if (!editsOk) continue;
    const problemIds = (Array.isArray(p.problemIds) ? p.problemIds : []).filter((id) => typeof id === 'string' && knownProblemIds.has(id));
    if (!problemIds.length) continue;
    drafts.push({
      title: p.title,
      component: p.component as ProposalComponent,
      problemIds,
      rootCause: typeof p.rootCause === 'string' ? p.rootCause : '',
      edits: p.edits,
      risk: typeof p.risk === 'string' ? p.risk : '',
      verification: typeof p.verification === 'string' ? p.verification : '',
    });
  }
  return drafts.sort((a, b) => componentRiskRank(a.component) - componentRiskRank(b.component)).slice(0, 3);
}

const ATTRIBUTIONS = ['tool', 'project', 'environment'] as const;
const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 流程审查发现归一：只留有标题的，非法归因与组件置空，最多 5 条 */
export function normalizeFindings(raw: unknown): FlowReviewFinding[] {
  const arr = (raw as { findings?: unknown } | null | undefined)?.findings;
  if (!Array.isArray(arr)) return [];
  const out: FlowReviewFinding[] = [];
  for (const item of arr) {
    const f = item as { title?: unknown; detail?: unknown; attribution?: unknown; component?: unknown } | null;
    if (!f || typeof f.title !== 'string' || !f.title.trim()) continue;
    const finding: FlowReviewFinding = { title: f.title.trim(), detail: typeof f.detail === 'string' ? f.detail : '' };
    if (ATTRIBUTIONS.includes(f.attribution as ObservationAttribution)) finding.attribution = f.attribution as ObservationAttribution;
    if (PROPOSAL_COMPONENTS.includes(f.component as ProposalComponent)) finding.component = f.component as ProposalComponent;
    out.push(finding);
  }
  return out.slice(0, 5);
}

/** 把提案里对本次发现的引用（F1、F2…）换成发现入库后的台账 id；对不上的原样留给后续过滤 */
export function resolveRefs(raw: unknown, findingIds: string[]): unknown {
  const arr = (raw as { proposals?: unknown } | null | undefined)?.proposals;
  if (!Array.isArray(arr)) return raw;
  const proposals = arr.map((p) => {
    const ids = (p as { problemIds?: unknown } | null)?.problemIds;
    if (!Array.isArray(ids)) return p;
    const problemIds = ids.map((id) => {
      const m = typeof id === 'string' ? /^F(\d+)$/i.exec(id.trim()) : null;
      return (m && findingIds[Number(m[1]) - 1]) || id;
    });
    return { ...(p as object), problemIds };
  });
  return { ...(raw as object), proposals };
}

/** Optimizer 的依赖：run/isIdle 可注入；getApplying 提供应用单飞锁状态 */
export interface OptimizerDeps {
  observations: ObservationStore;
  proposals: ProposalStore;
  getSettings: () => { observer?: ObserverSettings };
  isIdle: () => boolean;
  toolRoot: string;
  run?: (req: AgentRequest) => Promise<AgentResult>;
  getApplying?: () => string | null;
  onStateChange?: () => void;
  /** 流程体检段落（由流程指标渲染）；不提供则审查只看台账 */
  getFlow?: () => string;
}

/** 诊断会话：中性 cwd 绕开工具目录的 .claude 门禁，只读授权 server/client */
export class Optimizer {
  private diagnosing = false;

  constructor(private deps: OptimizerDeps) {}

  isDiagnosing(): boolean {
    return this.diagnosing;
  }

  async maybeAuto(): Promise<void> {
    const s = this.deps.getSettings().observer ?? DEFAULT_OBSERVER_SETTINGS;
    const ok = canAutoOptimize(
      {
        enabled: s.enabled,
        autoOptimize: s.autoOptimize,
        idle: this.deps.isIdle(),
        newCount: this.deps.observations.countNew(),
        lastRunAt: this.deps.proposals.getLastRunAt(),
        diagnosing: this.diagnosing,
        applying: this.deps.getApplying?.() ?? null,
      },
      Date.now(),
      s,
    );
    if (!ok) return;
    await this.diagnose(s);
  }

  async runManual(): Promise<{ started: boolean; reason?: string }> {
    const s = this.deps.getSettings().observer ?? DEFAULT_OBSERVER_SETTINGS;
    if (!s.enabled) return { started: false, reason: '观察者未开启' };
    if (this.diagnosing) return { started: false, reason: '正在诊断中' };
    if (this.deps.getApplying?.()) return { started: false, reason: '有提案正在应用' };
    if (!this.deps.isIdle()) return { started: false, reason: '队列不空闲，请稍后再试' };
    // 发射后不管：诊断最长 10 分钟，不能阻塞 HTTP 请求（与 startApply 同模式）
    void this.diagnose(s).catch(() => {});
    return { started: true };
  }

  private async diagnose(s: ObserverSettings): Promise<void> {
    this.diagnosing = true;
    try {
      this.deps.onStateChange?.();
    } catch {
      // 广播失败不影响诊断
    }
    const run = this.deps.run ?? runAgent;
    let cwd = '';
    const startedAt = Date.now();
    const outcome: Pick<OptimizeRun, 'ok' | 'proposals' | 'findings' | 'costUsd' | 'error'> = { ok: false, proposals: 0, findings: 0 };
    try {
      // 中性 cwd：绕开工具目录自带 .claude 的 hooks 与 CLAUDE.md 自动加载
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-optimize-'));
      // 环境与目标项目的问题不交给审查：它们不是改工具代码能解决的
      const unresolved = this.deps.observations.list({ status: 'new' }).filter(isActionable);
      const history = proposalHistorySection(this.deps.proposals.list(), this.deps.observations.list(), 10, this.deps.proposals.listRemoved());
      const res = await run({
        cwd,
        exec: s.exec,
        stage: 'analysis',
        access: 'read',
        schema: PROPOSAL_SCHEMA,
        prompt: optimizePrompt(unresolved, history, { typecheckCmd: 'npm run typecheck', testCmd: 'npm test', flow: this.deps.getFlow?.() }),
        timeoutMs: 10 * 60_000,
        addDirs: [path.join(this.deps.toolRoot, 'server'), path.join(this.deps.toolRoot, 'client')],
      });
      outcome.costUsd = res.evidence?.costUsd;
      if (res.ok) {
        // 流程发现先入台账，提案才能引用它们
        const findingIds = normalizeFindings(res.structured).map(
          (f) =>
            this.deps.observations.add({
              projectId: '',
              kind: 'flow_finding',
              severity: 'warn',
              title: f.title,
              detail: f.detail,
              context: f.component ? { component: f.component } : {},
              source: 'llm',
              attribution: f.attribution,
              // 同一条发现（含已被忽略的）下次审查不重复入库
              key: `flow-finding:${f.title.replace(/\s+/g, '')}`,
            }).id,
        );
        outcome.findings = new Set(findingIds).size;
        const known = new Set([...unresolved.map((o) => o.id), ...findingIds]);
        const drafts = normalizeProposals(resolveRefs(res.structured, findingIds), known);
        for (const d of drafts) this.deps.proposals.add(d);
        outcome.ok = true;
        outcome.proposals = drafts.length;
      } else {
        outcome.error = clipText(res.text || '审查会话失败', 300);
      }
    } catch (e) {
      // 审查失败不产出提案，也不影响任何任务；原因留给页面显示
      outcome.error = clipText(e instanceof Error ? e.message : String(e), 300);
    } finally {
      // 先复位再记结果：记结果会触发广播，监听器出错也不能让「审查中」卡死
      this.diagnosing = false;
      try {
        // 失败也记一次：防止失败风暴反复起会话，同时让页面看得到这次为什么没结果
        this.deps.proposals.setLastRun({ at: Date.now(), durationMs: Date.now() - startedAt, ...outcome });
      } catch {
        // 广播失败不影响诊断
      }
      try {
        if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
      } catch {
        // 代理残留文件句柄（Windows EBUSY），忽略
      }
      try {
        this.deps.onStateChange?.();
      } catch {
        // 广播失败不影响诊断
      }
    }
  }
}
