import { CODEX_SANDBOXES, DEFAULT_EXEC, PERMISSION_MODES, PROVIDERS, type ExecConfig, type ItemResult } from './types.ts';

/**
 * 观察者领域类型：问题台账、优化提案、观察者设置。
 * 阶段一独立成模块；阶段二由 types.ts 以 type-only 方式接入 Settings 并再导出。
 * 本模块运行时引用 types.ts 的 DEFAULT_EXEC，反向导入必须 type-only（防循环初始化）。
 */

export const OBSERVATION_KINDS = [
  'exec_error',
  'gate_fail',
  'gate_unverified',
  'commit_fail',
  'analyze_fail',
  'preflight_fail',
  'feishu_import',
  'feishu_writeback',
  'deploy_fail',
  'git_sync',
  'git_push',
  'llm_finding',
  'flow_backlog',
  'flow_gate',
  'flow_finding',
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export type ObservationSeverity = 'error' | 'warn' | 'note';
export type ObservationStatus = 'new' | 'resolved' | 'ignored';
export type ObservationSource = 'code' | 'llm';

/** 问题的现场事实：能取到的都取，取不到的不填（不用 0 回填） */
export interface ObservationContext {
  stage?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  toolCalls?: number | null;
  costUsd?: number;
  gateVerdict?: ItemResult;
  component?: ProposalComponent;
  branch?: string;
  upstream?: string | null;
  envName?: string;
}

export interface Observation {
  id: string;
  at: number;
  projectId: string;
  taskId?: string;
  kind: ObservationKind;
  severity: ObservationSeverity;
  title: string;
  detail: string;
  context: ObservationContext;
  source: ObservationSource;
  status: ObservationStatus;
  /** 标为已解决时关联的提案；手动解决不带 */
  proposalId?: string;
  /** 问题出在哪：工具自身、目标项目、环境。不写时由 effectiveAttribution 按事实推断 */
  attribution?: ObservationAttribution;
  /** 稳定去重键：同 key 的问题未处理或已忽略时不重复入库（流程类问题用） */
  key?: string;
  /** 标为已解决的时间：带 key 的问题在此后一段时间内不重新入库 */
  resolvedAt?: number;
}

export type ObservationAttribution = 'tool' | 'project' | 'environment';

/** 环境问题的特征文本：网络连不上、目录不存在。只收有实际样本的写法，不靠猜测扩充 */
const ENVIRONMENT_PATTERNS = [
  /Could not connect to server/i,
  /Failed to connect to/i,
  /Could not resolve host/i,
  /ETIMEDOUT|ECONNREFUSED|ENOTFOUND/,
  /代码目录不存在/,
  // 模型中转网关没有可用通道
  /No available channel/i,
  /API Error: 50[234]/,
];

/** 只对这些代码采集的集成类问题推断环境归因：它们的 detail 是原始报错，不是代理自述或拼接文本 */
const INFERABLE_KINDS: ObservationKind[] = ['analyze_fail', 'preflight_fail', 'git_sync', 'git_push', 'feishu_import', 'feishu_writeback'];

/**
 * 问题归因：显式写了就用写的；否则只对代码采集的集成类问题、且命中环境特征时判为环境，其余不下结论。
 * LLM 的发现、流程类问题、门禁与执行报错不推断——它们提到网络错误时，问题可能恰恰是工具没有处理好。
 */
export function effectiveAttribution(o: Pick<Observation, 'attribution' | 'detail' | 'kind' | 'source'>): ObservationAttribution | undefined {
  if (o.attribution) return o.attribution;
  if (o.source !== 'code' || !INFERABLE_KINDS.includes(o.kind)) return undefined;
  return ENVIRONMENT_PATTERNS.some((re) => re.test(o.detail)) ? 'environment' : undefined;
}

/** 可行动：未处理、不是备注、也不是环境或目标项目的问题。台账默认列表、新问题计数、诊断输入共用这一个判据 */
export function isActionable(o: Pick<Observation, 'status' | 'severity' | 'attribution' | 'detail' | 'kind' | 'source'>): boolean {
  if (o.status !== 'new' || o.severity === 'note') return false;
  const a = effectiveAttribution(o);
  return a !== 'environment' && a !== 'project';
}

export const PROPOSAL_COMPONENTS = ['prompt', 'gate', 'flow', 'integration'] as const;
export type ProposalComponent = (typeof PROPOSAL_COMPONENTS)[number];

export type ProposalStatus = 'pending' | 'applying' | 'applied' | 'rolled_back' | 'stale' | 'rejected';

export interface ProposalEdit {
  file: string;
  find: string;
  replace: string;
}

/** Probe 式复验结论：原任务重跑一轮，前后门禁对比 */
export interface ProbeRecord {
  taskId: string;
  beforeVerdict: ItemResult | null;
  afterVerdict: ItemResult | null;
  result: 'improved' | 'unchanged' | 'regressed';
  at: number;
}

export interface ApplyResult {
  ok: boolean;
  output: string;
  at: number;
  mode: 'apply' | 'rollback';
  /** 应用没成功时文件是否已还原到应用前；false 表示工作区可能留着改了一半的文件（旧记录没有这个字段） */
  restored?: boolean;
}

/** 应用没成功且文件已还原的提案可以重试；手动回滚的、文件没还原的不行。服务端与页面共用这一个判据 */
export function canRetryApply(p: Pick<Proposal, 'status' | 'result'>): boolean {
  return p.status === 'rolled_back' && p.result?.mode === 'apply' && !p.result.ok && p.result.restored !== false;
}

/**
 * 可以从列表里删掉的提案：已经有结局、且不再需要它的备份。
 * 已应用的不删（它是「工具被改过什么」的记录）；应用没成功、文件没还原的要先点「放弃」才能删，删的时候保留备份。
 */
export function canRemoveProposal(p: Pick<Proposal, 'status' | 'result'>): boolean {
  if (p.status === 'rejected' || p.status === 'stale') return true;
  return p.status === 'rolled_back' && p.result?.restored !== false;
}

/** 被删掉的提案留下的简短记录：只给下次审查看「这个改法有过什么结局」，页面不显示，不含改动内容 */
export interface RemovedProposal {
  title: string;
  component: ProposalComponent;
  status: ProposalStatus;
  probe?: ProbeRecord['result'];
  at: number;
}

/** 可以放弃（拒绝）的提案：还没应用的，以及应用没成功的——后者不管能不能重试都要能清掉 */
export function canAbandon(p: Pick<Proposal, 'status' | 'result'>): boolean {
  return p.status === 'pending' || (p.status === 'rolled_back' && p.result?.mode === 'apply' && !p.result.ok);
}

export interface Proposal {
  id: string;
  at: number;
  title: string;
  component: ProposalComponent;
  problemIds: string[];
  rootCause: string;
  edits: ProposalEdit[];
  risk: string;
  verification: string;
  status: ProposalStatus;
  result?: ApplyResult;
  probe?: ProbeRecord;
}

export interface ObserverSettings {
  enabled: boolean;
  autoOptimize: boolean;
  exec: ExecConfig;
  /** 自动诊断阈值：可行动新问题达到该数量才触发（代码默认值，不暴露为界面设置） */
  minNewObservations: number;
  /** 两次自动诊断的最小间隔（小时） */
  cooldownHours: number;
}

/** 阶段一测试注入设置用；阶段二 Settings 满足此形状 */
export interface ObserverSettingsHost {
  observer?: ObserverSettings;
}

/** 设置补丁形状：exec 允许部分字段（更新时深合并） */
export type ObserverSettingsPatch = Partial<Omit<ObserverSettings, 'exec'>> & { exec?: Partial<ExecConfig> };

export interface ObserverStatus {
  enabled: boolean;
  autoOptimize: boolean;
  idle: boolean;
  diagnosing: boolean;
  applying: string | null;
  applyMode: 'apply' | 'rollback' | null;
  probing: string | null;
  /** 可行动的新问题数（error/warn，note 不计）——自动诊断阈值用 */
  newCount: number;
  /** 待确认提案数——侧边栏角标用，必须等于列表长度 */
  pendingProposals: number;
  lastRunAt: number | null;
  /** 最近一次流程审查的结果；没跑过为 null */
  lastRun: OptimizeRun | null;
}

/** 一次流程审查会话的结果：页面据此告诉使用者这次审查出了什么，失败时给原因 */
export interface OptimizeRun {
  at: number;
  ok: boolean;
  /** 本次产出的提案数 */
  proposals: number;
  /** 本次写入台账的流程发现数 */
  findings: number;
  durationMs: number;
  /** 代理不提供花费时不填 */
  costUsd?: number;
  /** 失败原因；成功时不填 */
  error?: string;
}

/** 流程审查的一条发现：第三方视角看出的不合理环节 */
export interface FlowReviewFinding {
  title: string;
  detail: string;
  attribution?: ObservationAttribution;
  component?: ProposalComponent;
}

/** LLM 复盘的一条归因发现 */
export interface ObserveFinding {
  attribution: 'tool' | 'project' | 'environment' | 'unknown';
  component?: ProposalComponent;
  summary: string;
  detail: string;
  suggestion: string;
}

/** 组件风险秩：提示词最低、门禁最高（改坏门禁可能放行坏修复） */
export function componentRiskRank(c: ProposalComponent): number {
  return { prompt: 0, integration: 1, flow: 2, gate: 3 }[c];
}

/** 默认设置：功能默认关（起步收窄），会话预算 2 美元（代理设置里可调） */
export const DEFAULT_OBSERVER_SETTINGS: ObserverSettings = {
  enabled: false,
  autoOptimize: false,
  exec: { ...DEFAULT_EXEC, budgetUsd: 2 },
  minNewObservations: 3,
  cooldownHours: 6,
};

/** 归一保存过的观察者设置：缺省补默认、非法数值夹取、exec 逐字段补全 */
export function normalizeObserver(raw: unknown): ObserverSettings {
  const r = (raw ?? {}) as Partial<ObserverSettings>;
  const pick = <T extends object>(defaults: T, src: any): T => {
    const out = { ...defaults };
    for (const k of Object.keys(defaults) as (keyof T)[]) if (src?.[k] !== undefined) out[k] = src[k];
    return out;
  };
  const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    return Math.min(max, Math.max(min, n));
  };
  const exec = pick(DEFAULT_OBSERVER_SETTINGS.exec, r.exec);
  // exec 非法值净化：预算是成本安全上限，枚举字段非法回退默认
  exec.budgetUsd =
    typeof exec.budgetUsd === 'number' && Number.isFinite(exec.budgetUsd)
      ? Math.max(0, exec.budgetUsd)
      : DEFAULT_OBSERVER_SETTINGS.exec.budgetUsd;
  if (!PROVIDERS.includes(exec.provider)) exec.provider = DEFAULT_EXEC.provider;
  if (!PERMISSION_MODES.includes(exec.permissionMode)) exec.permissionMode = DEFAULT_EXEC.permissionMode;
  if (!CODEX_SANDBOXES.includes(exec.codexSandbox)) exec.codexSandbox = DEFAULT_EXEC.codexSandbox;
  return {
    enabled: Boolean(r.enabled),
    autoOptimize: Boolean(r.autoOptimize),
    exec,
    minNewObservations: Math.round(clamp(r.minNewObservations, 1, 50, DEFAULT_OBSERVER_SETTINGS.minNewObservations)),
    cooldownHours: clamp(r.cooldownHours, 0.5, 168, DEFAULT_OBSERVER_SETTINGS.cooldownHours),
  };
}
