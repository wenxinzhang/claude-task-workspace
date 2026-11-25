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
  'usage_friction',
  'screenshot_finding',
  // 使用者在问题目录里手动新建的问题
  'manual',
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export type ObservationSeverity = 'error' | 'warn' | 'note';
/** reviewing：修改已应用，但统计类问题要等新任务跑过才知道有没有用（静默期后仍成立会重新入库） */
export type ObservationStatus = 'new' | 'reviewing' | 'resolved' | 'ignored';
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
  /** 截图诊断的附件标识：详情页据此显示/删除截图 */
  screenshotToken?: string;
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
  /** 用户保存的问题描述和建议，原始观察记录保留在 detail */
  review?: ObservationReview;
  suggestion?: string;
  issue?: ObservationIssue;
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
  /** 问题目录里的编号 #N：入库时递增分配；旧记录在加载时按入库时间补齐，之后不再变 */
  number?: number;
  /** 分章节正文（问题目录详情页）。旧记录没有，显示时由 review / detail 兼容映射 */
  sections?: ObservationSections;
  /** 负责人：没填显示「待分配」 */
  owner?: string;
  /** 最后更新时间：改状态、改正文时刷新；旧记录没有时取 resolvedAt / at */
  updatedAt?: number;
}

/** 问题详情的五个章节，顺序即展示顺序。problem 与 goal 新建时必填，其余可空 */
export const OBSERVATION_SECTION_KEYS = ['problem', 'impact', 'goal', 'plan', 'verification'] as const;
export type ObservationSectionKey = (typeof OBSERVATION_SECTION_KEYS)[number];
export type ObservationSections = Partial<Record<ObservationSectionKey, string>>;
export const OBSERVATION_SECTION_LABEL: Record<ObservationSectionKey, string> = {
  problem: '问题是什么',
  impact: '影响范围',
  goal: '要解决什么',
  plan: '处理方案',
  verification: '验收标准',
};

export interface ObservationReview {
  finding: string;
  suggestion: string;
}

export interface ObservationIssue {
  repository: string;
  number: number;
  url: string;
}

export interface ObservationIssueDraft {
  repository: string;
  title: string;
  body: string;
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

/**
 * 统计类问题：结论来自多个任务的累计数据。改了提示词或流程，当下证明不了有效，要等新任务跑过。
 * 提案应用后这类问题先标「待复核」，不直接算已解决
 */
export const REVIEW_KINDS: ObservationKind[] = ['flow_backlog', 'flow_gate', 'flow_finding', 'usage_friction'];
export const needsReview = (o: Pick<Observation, 'kind'>) => REVIEW_KINDS.includes(o.kind);

/** 一键修复里一条问题怎么处理 */
export type FixRoute =
  /** 工具问题：诊断并自动应用修改 */
  | { mode: 'diagnose' }
  /** 目标项目问题：重新执行关联任务 */
  | { mode: 'rerun' }
  /** 环境问题：实际复查一次（重新生成规格），成功了才算已解决 */
  | { mode: 'recheck' }
  /** 改不了、也查不了：列进「需要人工处理」并写明原因 */
  | { mode: 'manual'; reason: string };

/**
 * 一键修复的分流：页头一键修复与详情页按钮共用。只看未处理、不是备注的问题，其余返回 null（不收）。
 * 记录里没写归属、但关联了任务的问题按目标项目处理：重跑任务就是对它最直接的验证。
 * 这条只用于修复分流，不改 effectiveAttribution——自动诊断的输入范围保持不变
 */
export function fixRoute(o: Pick<Observation, 'status' | 'severity' | 'attribution' | 'detail' | 'kind' | 'source' | 'taskId'>): FixRoute | null {
  if (o.status !== 'new' || o.severity === 'note') return null;
  const a = effectiveAttribution(o);
  if (a === 'environment') {
    // 只有「生成规格失败」能低成本实际复查：重新生成一次规格，只读、不改代码
    if (o.kind === 'analyze_fail' && o.taskId) return { mode: 'recheck' };
    return { mode: 'manual', reason: '环境问题（网络、目录、模型网关）没有自动复查的办法：请在本机排除故障后手动标为已解决' };
  }
  if (a === 'project' || (!a && o.taskId && RERUN_KINDS.includes(o.kind))) {
    if (!o.taskId) return { mode: 'manual', reason: '该问题没有关联任务，无法重新执行' };
    // 重跑任务不会重做推送、同步、部署、导入：跑完也证明不了它好了
    if (NO_RERUN_PROOF.includes(o.kind)) return { mode: 'manual', reason: '重新执行任务不会重做这一步，证明不了它已经好了：请在本机确认后手动标为已解决' };
    return { mode: 'rerun' };
  }
  // 积压是环境故障的后果，不是工具的毛病：先处理对应的生成规格失败，积压会跟着消失
  if (o.kind === 'flow_backlog' && ENVIRONMENT_PATTERNS.some((re) => re.test(o.detail))) {
    return { mode: 'manual', reason: '积压是环境故障（模型网关等）造成的：先处理对应的生成规格失败，任务重新生成规格后再把这条标为已解决' };
  }
  return { mode: 'diagnose' };
}

const NO_RERUN_PROOF: ObservationKind[] = ['git_push', 'git_sync', 'deploy_fail', 'feishu_import'];
/** 没写归属时按目标项目重跑的种类：都是任务执行本身的结果，重跑就是验证。LLM 发现、截图、手动问题仍走诊断 */
const RERUN_KINDS: ObservationKind[] = ['exec_error', 'gate_fail', 'gate_unverified', 'commit_fail', 'feishu_writeback', 'preflight_fail'];

/** 点一键修复之前的确认信息：各种处理方式各多少条，以及最长耗时 */
export interface BatchFixPlan {
  diagnose: number;
  rerun: number;
  recheck: number;
  manual: number;
  /** 最长耗时（分钟）：诊断单条上限 10 分钟、重跑单条最多等 60 分钟、复查单条最多等 20 分钟 */
  maxMinutes: number;
}

/** 一键修复的进度：问题逐条依次修，上一条的诊断、应用或重新执行结束后才开始下一条 */
export interface BatchFixState {
  total: number;
  /** 已有结果的条数（修好、待复核、没修好、没能开始都算；需要人工的不在 total 里） */
  finished: number;
  /** 正在修的问题 id；两条之间、全部结束后为 null */
  current: string | null;
  /** 修完后问题变成已解决的条数 */
  fixed: number;
  /** 修改已应用、但要等新任务跑过才能确认的条数（统计类问题） */
  reviewing?: number;
  /** 没能开始或修完仍未解决的问题与原因 */
  failed: { id: string; reason: string }[];
  /** 改不了、也证明不了的问题与原因：要人来处理 */
  manual?: { id: string; reason: string }[];
  /** 正在等别的任务或诊断结束，才能开始下一条 */
  waiting?: boolean;
  startedAt: number;
  /** 全部跑完或被停止的时间；进行中为 null */
  endedAt: number | null;
  stopped?: boolean;
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
  /** 由自动应用发起（仅限低风险提示词提案）：可一键撤销，不必等复验退化 */
  auto?: boolean;
}

export interface ObserverSettings {
  enabled: boolean;
  autoOptimize: boolean;
  /** 使用事件采集开关：关闭后前端停止上报、服务端拒收新事件；已有数据仍可查询与清空 */
  usageCollect: boolean;
  /** 自动应用：仅自动诊断产出的低风险提示词提案（文件白名单内），默认关；应用仍走备份+验证+失败回滚 */
  autoApply: boolean;
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
  /** 页头「一键修复」的进度；本次启动后没点过为 null */
  batchFix: BatchFixState | null;
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
  suggestion?: string;
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
  usageCollect: true,
  autoApply: false,
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
    // 旧配置没有这个字段时保持采集开启（默认值），显式存过 false 的尊重原值
    usageCollect: r.usageCollect === undefined ? true : Boolean(r.usageCollect),
    autoApply: Boolean(r.autoApply),
    exec,
    minNewObservations: Math.round(clamp(r.minNewObservations, 1, 50, DEFAULT_OBSERVER_SETTINGS.minNewObservations)),
    cooldownHours: clamp(r.cooldownHours, 0.5, 168, DEFAULT_OBSERVER_SETTINGS.cooldownHours),
  };
}
