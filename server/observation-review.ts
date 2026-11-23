import { effectiveAttribution, OBSERVATION_SECTION_KEYS, OBSERVATION_SECTION_LABEL, type Observation, type ObservationIssueDraft, type ObservationKind, type ObservationReview, type ObservationSections } from './observe-types.ts';

export const OBSERVATION_TEXT_LIMIT = 10_000;
export const ISSUE_BODY_LIMIT = 40_000;
export const ISSUE_TITLE_LIMIT = 256;

const suggestions: Record<ObservationKind, string> = {
  exec_error: '从关联任务的执行记录定位首次报错，修复后重新运行同一任务。',
  gate_fail: '逐项检查未通过的验收项，补齐实现或验证，再复跑门禁。',
  gate_unverified: '为需人工验收的条目补充操作步骤、预期结果及可核对的验证证据。',
  commit_fail: '检查提交失败的原因，处理冲突或提交检查失败，再验证提交结果。',
  analyze_fail: '检查理解阶段的输入及首条报错，修复后用原任务复验。',
  preflight_fail: '定位失败的自检项，补齐依赖或配置后重新运行自检。',
  feishu_import: '检查飞书导入时的错误和相关字段配置，用一条样本记录复验导入。',
  feishu_writeback: '核对飞书回写字段、目标值与写入权限，用一条样本记录复验。',
  deploy_fail: '从部署日志定位第一个失败步骤，修复后复验部署和应用健康状态。',
  git_sync: '检查同步时的分支、远端和冲突信息，处理后复验同步。',
  git_push: '检查远端拒绝推送的原因，修复后验证目标分支已更新。',
  llm_finding: '核对原始观察记录中的证据，定位对应流程，再用相同场景复验。',
  flow_backlog: '检查积压最久的任务，定位并处理所在阶段的阻塞，复验队列能否继续。',
  flow_gate: '抽查门禁放行的记录，核对是否有足够的验收证据，再用同类任务复验。',
  flow_finding: '根据审查记录定位异常环节，修复后用相同场景复验。',
  usage_friction: '核对被反复点击或报错的控件，确认操作是否有可见反馈、是否真正生效，修复后用相同操作复验。',
  screenshot_finding: '对照截图与诊断描述定位界面或流程问题，修复后在相同页面复验。',
  manual: '按问题描述复现，修复后按验收标准复验。',
};

const LEGACY_SUGGESTION = /(?:^|\n)建议[：:]\s*/;

/**
 * 问题详情的五个章节。新记录直接用 sections；旧记录只映射能明确对应的字段：
 * 用户保存的「发现的问题」或模型写的描述 → 问题是什么；用户保存的「修改建议」或采集时带的建议 → 处理方案。
 * 影响范围、要解决什么、验收标准没有来源就留空（页面显示「待补充」），不凭空生成；按类型自动套的通用建议也不算。
 * 原始 detail 由详情页另外完整展示
 */
export function observationSections(o: Observation): ObservationSections {
  if (o.sections) return o.sections;
  const legacy = o.kind === 'llm_finding' ? LEGACY_SUGGESTION.exec(o.detail) : null;
  const detail = (legacy ? o.detail.slice(0, legacy.index) : o.detail).trim();
  const useDetail = o.source === 'llm' || o.kind === 'flow_backlog' || o.kind === 'flow_gate';
  const out: ObservationSections = {};
  const problem = o.review?.finding?.trim() || (useDetail ? detail : '');
  if (problem) out.problem = problem;
  const plan = o.review?.suggestion?.trim() || o.suggestion?.trim() || (legacy ? o.detail.slice(legacy.index + legacy[0].length).trim() : '');
  if (plan) out.plan = plan;
  return out;
}

/** 章节正文校验：只收五个已知键的字符串，逐段截断；problem / goal 由调用方决定是否必填 */
export function cleanSections(raw: unknown): ObservationSections {
  const out: ObservationSections = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of OBSERVATION_SECTION_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v !== 'string') continue;
    const text = v.trim();
    if (text.length > OBSERVATION_TEXT_LIMIT) throw new Error(`「${OBSERVATION_SECTION_LABEL[key]}」最多 ${OBSERVATION_TEXT_LIMIT} 个字符`);
    if (text) out[key] = text;
  }
  return out;
}

export function observationReview(observation: Observation): ObservationReview {
  if (observation.review) return observation.review;
  // 在问题目录里填过章节的（新建的手动问题、编辑过的旧问题）：Issue 草稿用章节内容，和详情页一致
  const s = observation.sections;
  if (s && (s.problem || s.plan)) {
    const finding = [s.problem, s.impact && `影响范围：${s.impact}`, s.goal && `要解决什么：${s.goal}`].filter(Boolean).join('\n\n');
    return {
      finding: (finding || observation.title).slice(0, OBSERVATION_TEXT_LIMIT),
      suggestion: (s.plan || suggestions[observation.kind]).slice(0, OBSERVATION_TEXT_LIMIT),
    };
  }
  const legacy = observation.kind === 'llm_finding' ? /(?:^|\n)建议[：:]\s*/.exec(observation.detail) : null;
  const detail = legacy ? observation.detail.slice(0, legacy.index) : observation.detail;
  const suggestion = legacy ? observation.detail.slice(legacy.index + legacy[0].length).trim() : '';
  const useDetail = observation.source === 'llm' || observation.kind === 'flow_backlog' || observation.kind === 'flow_gate';
  return {
    finding: ((useDetail && detail.trim()) || observation.title).slice(0, OBSERVATION_TEXT_LIMIT),
    suggestion: (observation.suggestion?.trim() || suggestion || suggestions[observation.kind]).slice(0, OBSERVATION_TEXT_LIMIT),
  };
}

const ATTRIBUTION_TEXT = { tool: '工具自身', project: '目标项目', environment: '环境' } as const;

/** 证据摘要：只收结构化事实。原始 detail（可能含代码与客户路径）与远端 URL（可能带凭据）一律不进 Issue */
function evidenceSection(o: Observation): string {
  const c = o.context;
  // 变量字段各截 200：病态配置下截字段而不是吞掉正文尾段；归因只在「影响范围」写一遍
  const clip = (v: string) => v.slice(0, 200);
  const lines = [
    `- 问题类型：${o.kind}`,
    `- 采集方式：${o.source === 'llm' ? 'LLM 审查' : '代码采集'}`,
  ];
  if (c.provider) lines.push(`- 代理：${clip(c.provider)}${c.model ? ` / ${clip(c.model)}` : ''}`);
  if (c.durationMs !== undefined) lines.push(`- 耗时：${Math.round(c.durationMs / 1000)} 秒`);
  if (c.toolCalls != null) lines.push(`- 工具调用：${c.toolCalls} 次`);
  if (c.costUsd !== undefined) lines.push(`- 花费：${c.costUsd} 美元`);
  if (c.gateVerdict) lines.push(`- 门禁结论：${c.gateVerdict}`);
  if (c.branch) lines.push(`- 分支：${clip(c.branch)}`);
  if (c.envName) lines.push(`- 环境：${clip(c.envName)}`);
  if (o.taskId) lines.push(`- 关联任务：${o.taskId.slice(0, 8)}…`);
  if (c.screenshotToken) lines.push('- 截图：保存在本地工作台，不随 Issue 上传');
  return lines.join('\n');
}

function impactSection(o: Observation): string {
  const a = effectiveAttribution(o);
  const parts = [`归属：${a ? ATTRIBUTION_TEXT[a] : '未判定'}`];
  if (o.context.component) parts.push(`涉及组件：${o.context.component}`);
  return `- ${parts.join('；')}`;
}

/** Issue 建议包草稿：问题 + 建议 + 证据摘要 + 影响范围 + 验收标准；不传 observation 时保持原三段结构 */
export function observationIssueDraft(repository: string, title: string, review: ObservationReview, observation?: Observation): ObservationIssueDraft {
  const sections = [
    '## 发现的问题',
    review.finding.trim().slice(0, OBSERVATION_TEXT_LIMIT),
    '## 修改建议',
    review.suggestion.trim().slice(0, OBSERVATION_TEXT_LIMIT),
  ];
  if (observation) sections.push('## 证据摘要', evidenceSection(observation), '## 影响范围', impactSection(observation));
  const verification = observation?.sections?.verification?.trim();
  sections.push('## 验收标准', verification ? verification.slice(0, OBSERVATION_TEXT_LIMIT) : '- 按上述问题场景复验，确认问题消失，并记录验证结果。');
  return {
    repository,
    title: title.replace(/\s+/g, ' ').trim().slice(0, ISSUE_TITLE_LIMIT),
    body: sections.join('\n\n').slice(0, ISSUE_BODY_LIMIT),
  };
}
