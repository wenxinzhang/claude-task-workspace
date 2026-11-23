import type { ObserverSettings } from './observe-types.ts';

// 观察者领域类型经此再导出，客户端沿用单一导入路径；仅 type-only，避免运行时循环（observe-types 运行时引用本文件的 DEFAULT_EXEC）
export type { Observation, Proposal, ProposalComponent, ProbeRecord, ObserverStatus, ObserverSettings } from './observe-types.ts';

export const STATUSES = [
  'pending_confirm', // 待确认
  'todo', // 待修改
  'in_progress', // 修复中
  'testing', // 验证中
  'review', // 待验证
  'done', // 已通过
  'blocked', // 异常 / 阻塞
] as const;

export type TaskStatus = (typeof STATUSES)[number];

export type Stage = 'analysis' | 'implement' | 'verify';

export const PROVIDERS = ['claude', 'codex', 'custom'] as const;
/** 执行任务的编码代理：Claude Code、Codex CLI，或任意本地命令行代理 */
export type Provider = (typeof PROVIDERS)[number];

export const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type CodexSandbox = (typeof CODEX_SANDBOXES)[number];

export interface Attachment {
  /** 飞书 file_token */
  token: string;
  name: string;
  /** MIME 类型，如 image/png */
  type: string;
  size: number;
  /** 来源字段名，如「截图」 */
  field: string;
  /** 下载接口的 extra 参数（高级权限表格需要） */
  extra?: string;
  /** 用户在本地上传，不需要从飞书下载 */
  local?: boolean;
}

/** 验收项：确认后冻结，验证阶段按编号逐项给结果 */
export interface Criterion {
  /** AC1、AC2… 由系统编号 */
  id: string;
  text: string;
  /** auto：本机无头会话里能验证；manual：需要浏览器或部署后才能确认 */
  method: 'auto' | 'manual';
  /** 怎么验：要跑的命令、要看的代码位置，或人工去哪里看、预期是什么 */
  how: string;
}

/** 任务规格：理解阶段产出、人工确认后冻结，实现与验证都以它为准 */
export interface Spec {
  goal: string;
  /** 根因假设（缺陷类任务）；需求类任务写现状 */
  rootCause: string;
  /** 允许改动的范围：相对仓库根目录的文件或目录 */
  scope: string[];
  steps: string[];
  criteria: Criterion[];
  risks: string[];
  /** 需要使用者回答后才能确认规格的问题；旧规格没有 */
  questions?: SpecQuestion[];
}

export interface SpecQuestion {
  text: string;
  /** 使用者的回答；空表示还没有回答 */
  answer: string;
  /** 代理生成规格时给的建议回答，作为回答的初稿；旧规格没有 */
  suggestion?: string;
}

/** 一次代理会话留下的事实，全部来自事件流，不取自代理的自述 */
export interface RunEvidence {
  stage: Stage | 'preflight';
  provider: Provider;
  model?: string;
  /** 代理会话标识：追加指令时用它接续同一个会话 */
  sessionId?: string;
  /** 工具调用次数；代理不提供事件流时为 null（未知，不等于 0） */
  toolCalls: number | null;
  /** 各工具的调用次数 */
  tools: Record<string, number>;
  /** 被权限拒绝的调用 */
  denials: { tool: string; input: string }[];
  turns?: number;
  costUsd?: number;
  durationMs: number;
  at: number;
}

export type ItemResult = 'pass' | 'fail' | 'unverified';

export interface CriterionResult {
  id: string;
  text: string;
  method: 'auto' | 'manual';
  how: string;
  result: ItemResult;
  /** 判定依据：跑了什么命令、看了哪段代码；未验证时写原因 */
  evidence: string;
}

/** 门禁结论：由服务端根据事实计算，不采信代理给出的总结论 */
export interface GateReason {
  /** fail：导致未通过；hold：需要人工验收；note：不影响结论的事实 */
  level: 'fail' | 'hold' | 'note';
  text: string;
}

export interface GateResult {
  verdict: ItemResult;
  /** 判定理由，每条都能对上一项事实 */
  reasons: GateReason[];
  items: CriterionResult[];
  /** 超出确认范围的改动文件 */
  outOfScope: string[];
  /** 本任务改动的文件；null 表示无法核对（代码目录不是 git 仓库） */
  changedFiles: string[] | null;
  testCommand?: { exitCode: number | null };
  at: number;
}

/** 飞书回写记录 */
export interface Writeback {
  /** done：飞书已是目标状态；skipped：有意不写；failed：写失败，可重试 */
  state: 'done' | 'skipped' | 'failed';
  at: number;
  field: string;
  value: string;
  /** 回写前飞书上的值 */
  previous?: string;
  message: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  /** 任务理解的文本形式：有 spec 时由 spec 渲染而来，旧任务或手写时是自由文本 */
  analysis: string;
  analyzing: boolean;
  /** 结构化规格；旧任务没有 */
  spec?: Spec;
  /** 确认记录：specHash 用于核对执行时的规格与确认时一致 */
  confirmed?: { at: number; specHash?: string };
  source: 'feishu' | 'manual';
  /** 飞书 record_id，用于导入去重 */
  sourceId?: string;
  /** 飞书记录定位：<app_token>/<table_id>/<record_id>，回写时使用 */
  sourceKey?: string;
  /** 附件（截图等）：飞书附件按需下载，上传的图片直接保存在本地 */
  attachments?: Attachment[];
  status: TaskStatus;
  /** 待办队列排序，越小越先执行 */
  order: number;
  logs: string[];
  error?: string;
  summary?: string;
  /** 自动提交的结果，供后续任务参考改过哪些文件 */
  commit?: { hash: string; files: string[] };
  /** 由用户点「已人工处理完成」结束，summary 可能不代表最终结果 */
  resolvedManually?: boolean;
  /** 需要人工验收的事项，由门禁结论中未验证的验收项生成 */
  manualChecks?: string;
  /** 各阶段最近一次会话的事实 */
  evidence?: Partial<Record<Stage, RunEvidence>>;
  gate?: GateResult;
  writeback?: Writeback;
  /** 使用者在执行后追加的指令，按时间顺序 */
  notes?: string[];
  /** 下一次执行是「追加指令」的一轮：接着上一轮的会话和改动继续 */
  followUp?: boolean;
  /** 本任务改动了但没有提交的文件（任务异常，或没有开启自动提交）；再次执行时仍算作本任务的改动 */
  leftover?: string[];
  createdAt: number;
  updatedAt: number;
}

export const PERMISSION_MODES = ['acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** 全局设置：飞书应用凭证所有项目共用 */
export interface Settings {
  feishu: {
    appId: string;
    appSecret: string;
  };
  /** 运行时观察者：问题台账 + 提案式自优化 */
  observer: ObserverSettings;
  /** 给代理用的 skill 库：这个目录下 .claude/skills 里的 skill 对所有项目的代理可用 */
  skills: {
    libraryDir: string;
  };
  /** 可用模型清单：各处「模型」下拉框的候选。名称由使用者维护，原样作为代理命令的模型参数 */
  models: string[];
}

export interface FeishuSource {
  url: string;
  /** 来源显示名，如「缺陷清单」；留空时页面显示「飞书表格」 */
  name: string;
  /** 本项目单独使用的飞书应用；两项都填才生效，都留空则用全局「飞书连接」 */
  appId: string;
  appSecret: string;
  /** 导入过滤：只导入该字段取值命中的记录 */
  filterField: string;
  /** 逗号分隔，如 "待修改,重新打开"；留空导入全部 */
  filterValues: string;
  /** 第二个过滤条件（默认「指派给」），与上面的条件同时满足 */
  assigneeField: string;
  /** 逗号分隔的人名，留空不过滤 */
  assigneeValues: string;
  /** 导入后自动生成任务理解 */
  autoAnalyze: boolean;
  /** 任务在看板上流转时，把飞书记录的状态改成对应阶段的取值 */
  writeBack: boolean;
  /** 回写的字段，留空则用过滤字段 */
  writeBackField: string;
  /** 各阶段在飞书上的取值，必须是该字段已有的选项；留空表示该阶段不回写 */
  /** 待确认 / 待修改：任务被退回重做时改回这个值 */
  writeBackTodoValue: string;
  /** 已完成待测试(review) */
  writeBackReviewValue: string;
  /** 测试通过(done) */
  writeBackDoneValue: string;
}

export interface ExecConfig {
  provider: Provider;
  /** 测试命令：配置后每个任务都先跑它，退出码非 0 直接判未通过 */
  testCommand: string;
  /** agent：代理按验收项逐项验证；command：只跑测试命令 */
  verificationMode: 'agent' | 'command';
  /** 测试命令超时（分钟） */
  testTimeoutMinutes: number;
  // ---- Claude Code ----
  permissionMode: PermissionMode;
  /** 额外允许的工具，空格分隔，如 "Bash(npm *) Bash(git *)" */
  allowedTools: string;
  /** 可选模型，如 sonnet / opus，留空用默认 */
  model: string;
  // ---- Codex CLI ----
  codexModel: string;
  /** 实现与验证阶段的沙箱；理解阶段固定 read-only */
  codexSandbox: CodexSandbox;
  // ---- 本地命令行代理 ----
  /** 在代码目录下经系统 shell 执行；提示词从 stdin 传入，stdout 作为结果 */
  customCommand: string;
  /** 附加到每个任务提示词末尾的通用要求 */
  extraPrompt: string;
  /** 每个任务在新 git 分支上执行 */
  useBranch: boolean;
  /** 门禁通过后自动 git commit 本任务改动的文件（不推送） */
  autoCommit: boolean;
  /** 积累项目知识：提示词附上同项目已完成任务，并让 Claude 把经验写入项目记忆 */
  useKnowledge: boolean;
  /** 各阶段指定使用的 skill，空格或逗号分隔 */
  analysisSkills: string;
  implementSkills: string;
  verifySkills: string;
  /** 禁止使用的 skill（如会提交/推送/合并的），通过权限规则拦截 */
  disabledSkills: string;
  /** 门禁通过后进入 待验证(review) 还是 已通过(done) */
  passTarget: 'done' | 'review';
  /** 门禁结论是「待人工确认」时也不进待验证，按 passTarget 流转；门禁判失败的仍进异常。默认关闭 */
  skipReview: boolean;
  /** 单个任务执行超时（分钟） */
  timeoutMinutes: number;
  /** 规格生成后自动确认：没有待回答的问题就直接进入待修改，不用逐个点确认 */
  autoConfirm: boolean;
  /** 自动开工：待修改里有任务就自己开始，逐个执行；手动暂停后不再自动启动，直到再次点启动 */
  autoStart: boolean;
  /** 生成规格（理解阶段）的超时（分钟）：超时整段作废重来，所以单独可调 */
  analyzeTimeoutMinutes: number;
  /** 验证阶段单独使用的模型，留空与实现阶段相同。验证以读代码和跑命令为主，可以配更快的模型 */
  verifyModel: string;
  /** 每天定时启动队列：到点后按待办顺序执行，待办清空后自动暂停 */
  scheduleEnabled: boolean;
  /** 定时启动的时间，本机时区，24 小时制 HH:MM */
  scheduleTime: string;
  /** 已确认可用的验证命令，每行一条，在代码目录下执行：写进提示词，并放行其中用到的程序 */
  verifyCommands: string;
  /** 单次代理会话的花费上限（美元），0 表示不限；仅 Claude Code 支持 */
  budgetUsd: number;
}

/** 部署环境：列表第一项为默认环境。SSH 信息提供给代理做验证，部署命令在本机代码目录执行 */
export interface DeployEnv extends TestEnv {
  id: string;
  name: string;
  /** 测试服务器地址 */
  host: string;
  port: number;
  /** 构建命令，留空跳过构建步骤 */
  buildCommand: string;
  /** 健康检查 URL，留空跳过；部署后 GET 它，2xx 视为通过 */
  healthCheck: string;
}

/** 项目的默认部署环境 */
export const defaultEnv = (p: Project): DeployEnv => p.envs[0] ?? DEFAULT_ENV;

/** Git 凭据：HTTPS 远端同步 / 推送时以 Basic 认证头使用，不写进 git 配置 */
export interface GitConfig {
  username: string;
  password: string;
}

export interface Project {
  id: string;
  name: string;
  /** 代理执行任务的代码目录 */
  workdir: string;
  feishu: FeishuSource;
  exec: ExecConfig;
  envs: DeployEnv[];
  git: GitConfig;
  /** 归档后不在侧边栏与默认列表出现 */
  archived: boolean;
  /** 使用者手动暂停过队列：自动开工不再拉起，直到再次点启动。存在项目上，服务重启后仍然有效 */
  queueHeld?: boolean;
  createdAt: number;
}

/** 测试环境信息，执行与验证任务时提供给代理 */
export interface TestEnv {
  /** 测试环境访问地址 */
  url: string;
  username: string;
  password: string;
  /** 测试服务器：地址、登录方式、部署目录、日志位置等 */
  server: string;
  /** 其他说明，如多个账号、数据准备方式 */
  notes: string;
  /** 是否写入执行/验证提示词 */
  shareWithClaude: boolean;
  /** 部署到测试服务器的命令，在代码目录下经系统 shell 执行，退出码 0 视为成功 */
  deployCommand: string;
}

/** 部署步骤：构建产物 / 发布服务 / 健康检查，配置了才跑，时长按实际计时 */
export interface DeployStep {
  name: string;
  /** pending：已排好还没轮到；skipped：前面失败或手动停止，这步没跑 */
  status: 'pending' | 'running' | 'ok' | 'fail' | 'skipped';
  durationMs?: number;
}

/** 测试服务器部署状态（按项目） */
export interface DeployStatus {
  running: boolean;
  startedAt?: number;
  finishedAt?: number;
  /** 上一次部署是否成功；未部署过为 undefined */
  ok?: boolean;
  /** 部署时的 git 提交，便于确认部署的是哪个版本 */
  commit?: string;
  steps?: DeployStep[];
  envName?: string;
  /** 部署智能体是否改过代码：为 true 时实际发布的是 commit 加上未提交的改动 */
  repaired?: boolean;
  /** 当前这一遍（构建 → 发布 → 健康检查）在 steps 里的起始下标；进度只按这一遍算，修复重试时不会往回跳 */
  passStart?: number;
  /** 这次部署是手动停止的：前端据此显示「已停止」而不是「失败」 */
  aborted?: boolean;
}

/** 执行记录：AI 修复 / Git 同步 / 代码推送 / 部署，持久化在 data/history.json */
export interface HistoryRecord {
  id: string;
  projectId: string;
  kind: 'ai' | 'sync' | 'push' | 'deploy';
  title: string;
  /** queued 仅前端虚拟行（排队中的待办任务）使用，服务端不写 */
  status: 'running' | 'success' | 'failed' | 'conflict' | 'uptodate' | 'review' | 'queued';
  startedAt: number;
  finishedAt?: number;
  /** AI 修复：关联任务，日志与重执行都对着它 */
  taskId?: string;
  branch?: string;
  upstream?: string | null;
  /** 同步 / 推送前后的 HEAD（%h %s） */
  before?: string;
  after?: string;
  /** 同步：拉取的提交数；推送：推出去的提交数 */
  count?: number;
  commits?: { hash: string; subject: string }[];
  envName?: string;
  commit?: string;
  /** 部署：部署智能体改过代码，实际发布的是 commit 加未提交的改动 */
  repaired?: boolean;
  steps?: DeployStep[];
  logs: string[];
  error?: string;
}

/** 开工前自检：用真实配置跑一次「读文件 + 执行命令」 */
export interface Preflight {
  state: 'checking' | 'ok' | 'failed';
  /** 未通过的检查项 */
  problems: string[];
  /** 没有检查的项及原因 */
  notes: string[];
  at: number;
}

export interface QueueStatus {
  running: boolean;
  currentId: string | null;
  todoCount: number;
  preflight?: Preflight;
  /** 正在执行的任务的实时进度 */
  progress?: RunProgress;
}

/** 正在执行的任务的进度：只在内存里，随队列状态推送 */
export interface RunProgress {
  stage: Stage;
  /** 本次执行开始的时间 */
  startedAt: number;
  stageStartedAt: number;
  /** 当前阶段的工具调用次数 */
  toolCalls: number;
  /** 最近一步：工具名和参数摘要 */
  lastStep: string;
  lastAt: number;
  /** 已结束阶段的花费合计（美元）；代理不提供时为 0 */
  costUsd: number;
}

export const DEFAULT_TEST_ENV: TestEnv = {
  url: '',
  username: '',
  password: '',
  server: '',
  notes: '',
  shareWithClaude: true,
  deployCommand: '',
};

export const DEFAULT_ENV: DeployEnv = {
  ...DEFAULT_TEST_ENV,
  id: 'default',
  name: '测试环境',
  host: '',
  port: 22,
  buildCommand: '',
  healthCheck: '',
};

export const DEFAULT_FEISHU_SOURCE: FeishuSource = {
  url: '',
  name: '',
  appId: '',
  appSecret: '',
  filterField: '状态',
  filterValues: '',
  assigneeField: '指派给',
  assigneeValues: '',
  autoAnalyze: true,
  // 回写会改动共用的飞书表格，默认关闭
  writeBack: false,
  writeBackField: '',
  writeBackTodoValue: '待修改',
  writeBackReviewValue: '已完成待测试',
  writeBackDoneValue: '测试通过',
};

export const DEFAULT_EXEC: ExecConfig = {
  provider: 'claude',
  testCommand: '',
  verificationMode: 'agent',
  testTimeoutMinutes: 15,
  permissionMode: 'acceptEdits',
  // Windows 上 Claude Code 用 PowerShell 工具执行命令，两者都放行
  allowedTools: ['npm *', 'npx *', 'node *', 'git status*', 'git diff*']
    .flatMap((c) => [`Bash(${c})`, `PowerShell(${c})`])
    .join(' '),
  model: '',
  codexModel: '',
  codexSandbox: 'workspace-write',
  customCommand: '',
  extraPrompt: '',
  useBranch: false,
  autoCommit: true,
  useKnowledge: true,
  analysisSkills: '',
  implementSkills: '',
  verifySkills: '',
  // 提交、推送、合并由看板控制，这类 skill 会和自动提交冲突
  disabledSkills: 'tool-commit-push finishing-branch',
  passTarget: 'done',
  skipReview: false,
  timeoutMinutes: 30,
  autoConfirm: false,
  autoStart: false,
  analyzeTimeoutMinutes: 15,
  verifyModel: '',
  scheduleEnabled: false,
  scheduleTime: '22:00',
  verifyCommands: '',
  budgetUsd: 0,
};

// 位于 DEFAULT_EXEC 之后：observer 默认值展开 DEFAULT_EXEC，提前会 TDZ。
// 与 observe-types 的 DEFAULT_OBSERVER_SETTINGS 一致性由 observe-settings.test.ts 锚定
export const DEFAULT_SETTINGS: Settings = {
  feishu: { appId: '', appSecret: '' },
  observer: { enabled: false, autoOptimize: false, usageCollect: true, autoApply: false, exec: { ...DEFAULT_EXEC, budgetUsd: 2 }, minNewObservations: 3, cooldownHours: 6 },
  skills: { libraryDir: '' },
  models: [],
};
