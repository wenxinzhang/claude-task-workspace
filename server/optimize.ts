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
  type ProposalEdit,
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

/** 自动应用的文件白名单：只允许改这两个提示词文件。component 标 prompt 但改别的文件也不放行 */
const AUTO_APPLY_FILES = ['server/prompts.ts', 'server/observe-prompts.ts'];

/** 自动应用判定：开关、组件、文件白名单、空闲、单飞，全部满足才允许（仅用于自动诊断产出的提案） */
export function canAutoApplyProposal(
  d: { component: ProposalComponent; edits: ProposalEdit[] },
  s: { enabled: boolean; autoApply: boolean },
  idle: boolean,
  applying: string | null,
): boolean {
  return s.enabled && s.autoApply && d.component === 'prompt' && idle && !applying && d.edits.length > 0 && d.edits.every((e) => AUTO_APPLY_FILES.includes(e.file));
}

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
    const f = item as { title?: unknown; detail?: unknown; suggestion?: unknown; attribution?: unknown; component?: unknown } | null;
    if (!f || typeof f.title !== 'string' || !f.title.trim()) continue;
    const finding: FlowReviewFinding = { title: f.title.trim(), detail: typeof f.detail === 'string' ? f.detail : '' };
    if (typeof f.suggestion === 'string' && f.suggestion.trim()) finding.suggestion = f.suggestion.trim();
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
  /** 发起自动应用（observer.startApply）；返回是否真的发起了。不注入则自动应用不生效 */
  onAutoApply?: (proposalId: string) => boolean;
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
    await this.diagnose(s, true);
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

  /** 一键修复：只诊断这一条问题，产出的提案直接发起应用（使用者已在页面上明确要求，不走自动应用白名单） */
  runForObservation(observationId: string): { started: boolean; reason?: string } {
    const s = this.deps.getSettings().observer ?? DEFAULT_OBSERVER_SETTINGS;
    if (!s.enabled) return { started: false, reason: '观察者未开启' };
    if (this.diagnosing) return { started: false, reason: '正在诊断中' };
    if (this.deps.getApplying?.()) return { started: false, reason: '有提案正在应用' };
    if (!this.deps.isIdle()) return { started: false, reason: '队列不空闲，请稍后再试' };
    const o = this.deps.observations.get(observationId);
    if (!o) return { started: false, reason: '问题不存在' };
    if (!isActionable(o)) return { started: false, reason: '只有未处理的工具问题可以一键修复' };
    void this.diagnose(s, false, o.id).catch(() => {});
    return { started: true };
  }

  /** auto=true 仅限自动诊断路径：产出的低风险提示词提案可自动应用；手动诊断始终等人确认 */
  private async diagnose(s: ObserverSettings, auto = false, focusId?: string): Promise<void> {
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
      // 一键修复只看指定的这一条：前置条件已由 runForObservation 检查
      const unresolved = focusId !== undefined
        ? this.deps.observations.list().filter((o) => o.id === focusId)
        : this.deps.observations.list({ status: 'new' }).filter(isActionable);
      const history = proposalHistorySection(this.deps.proposals.list(), this.deps.observations.list(), 10, this.deps.proposals.listRemoved());
      const res = await run({
        cwd,
        exec: s.exec,
        stage: 'analysis',
        access: 'read',
        schema: PROPOSAL_SCHEMA,
        prompt: optimizePrompt(unresolved, history, { typecheckCmd: 'npm run typecheck', testCmd: 'npm test', flow: focusId !== undefined ? undefined : this.deps.getFlow?.() }),
        timeoutMs: 10 * 60_000,
        addDirs: [path.join(this.deps.toolRoot, 'server'), path.join(this.deps.toolRoot, 'client')],
      });
      outcome.costUsd = res.evidence?.costUsd;
      if (res.ok) {
        // 流程发现先入台账，提案才能引用它们
        // 一键修复不收流程发现：提案只能指向这一条问题
        const findingIds = (focusId !== undefined ? [] : normalizeFindings(res.structured)).map(
          (f) =>
            this.deps.observations.add({
              projectId: '',
              kind: 'flow_finding',
              severity: 'warn',
              title: f.title,
              detail: f.detail,
              suggestion: f.suggestion,
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
        // 自动应用每次审查至多一条（单飞）：发起成功才标 auto，失败的留在待确认等人处理
        let autoApplied = false;
        for (const d of drafts) {
          const rec = this.deps.proposals.add(d);
          // 诊断会话最长 10 分钟：判定重取当前设置，期间关掉开关就不再自动应用
          const current = this.deps.getSettings().observer ?? DEFAULT_OBSERVER_SETTINGS;
          // 一键修复：使用者已明确要求直接应用，不受自动应用白名单限制；空闲与单飞仍由 startApply 把关
          const direct = focusId !== undefined;
          if (!autoApplied && (direct || (auto && canAutoApplyProposal(d, current, this.deps.isIdle(), this.deps.getApplying?.() ?? null)))) {
            if (this.deps.onAutoApply?.(rec.id)) {
              autoApplied = true;
              this.deps.proposals.markAuto(rec.id);
            }
          }
        }
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
