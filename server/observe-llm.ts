import path from 'node:path';
import { runAgent, type AgentRequest, type AgentResult } from './agent.ts';
import { isManualStop } from './observe-collect.ts';
import { observePrompt, OBSERVE_SCHEMA } from './observe-prompts.ts';
import type { ObservationDraft } from './observe-collect.ts';
import type { ObservationStore } from './observe.ts';
import { DEFAULT_OBSERVER_SETTINGS, PROPOSAL_COMPONENTS, type ObserverSettings, type ProposalComponent } from './observe-types.ts';
import type { Store } from './store.ts';
import type { Task } from './types.ts';

/** 异常轮次才复盘：blocked/review 或带错误；手动停止是用户动作，不复盘 */
export function shouldReview(t: Task, enabled: boolean): boolean {
  return enabled && (t.status === 'blocked' || t.status === 'review' || !!t.error) && !isManualStop(t.error);
}

/** 复盘发现 → 台账草稿：只保留归因为工具的，其余只记任务日志；形状非法的丢弃不抛 */
export function findingsToObservations(t: Task, structured: unknown): ObservationDraft[] {
  const s = structured as { skip?: boolean; findings?: unknown[] } | null | undefined;
  if (!s || s.skip || !Array.isArray(s.findings)) return [];
  const drafts: ObservationDraft[] = [];
  for (const f of s.findings.slice(0, 20)) {
    const finding = f as { attribution?: string; component?: string; summary?: string; detail?: unknown; suggestion?: unknown };
    if (finding?.attribution !== 'tool' || typeof finding.summary !== 'string' || !finding.summary.trim()) continue;
    const component = PROPOSAL_COMPONENTS.includes(finding.component as ProposalComponent) ? (finding.component as ProposalComponent) : undefined;
    const detail = typeof finding.detail === 'string' ? finding.detail : '';
    const suggestion = typeof finding.suggestion === 'string' ? finding.suggestion : '';
    drafts.push({
      projectId: t.projectId,
      taskId: t.id,
      kind: 'llm_finding',
      severity: 'warn',
      title: finding.summary,
      detail: [detail, suggestion && `建议：${suggestion}`].filter(Boolean).join('\n'),
      context: component ? { component } : {},
      source: 'llm',
    });
  }
  return drafts;
}

/** reviewRun 的依赖：run 可注入便于测试；getSettings 只需提供 observer 设置 */
export interface ReviewDeps {
  store: Store;
  observations: ObservationStore;
  toolRoot: string;
  getSettings: () => { observer?: ObserverSettings };
  run?: (req: AgentRequest) => Promise<AgentResult>;
}

/** 异常轮次的只读复盘会话：失败只记任务日志，绝不影响任务本身 */
export async function reviewRun(deps: ReviewDeps, taskId: string): Promise<void> {
  const { store, observations, toolRoot, getSettings } = deps;
  const run = deps.run ?? runAgent;
  try {
    const settings = getSettings().observer ?? DEFAULT_OBSERVER_SETTINGS;
    const task = store.get(taskId);
    if (!task || !shouldReview(task, settings.enabled)) return;
    const project = store.getProject(task.projectId);
    if (!project?.workdir) return;
    const logTail = task.logs.slice(-80).join('\n');
    const res = await run({
      cwd: project.workdir,
      exec: settings.exec,
      stage: 'analysis',
      access: 'read',
      schema: OBSERVE_SCHEMA,
      prompt: observePrompt(task, logTail),
      timeoutMs: 5 * 60_000,
      // 只授权工具的两个代码子目录，绝不给工具根（data/ 有明文凭证）
      addDirs: [path.join(toolRoot, 'server'), path.join(toolRoot, 'client')],
      onLog: (line) => store.appendLog(taskId, line),
    });
    if (!res.ok) {
      store.appendLog(taskId, `观察复盘失败（不影响任务）：${res.text}`);
      return;
    }
    const findings = (res.structured as { findings?: { attribution?: string; summary?: string }[] } | undefined)?.findings;
    if (Array.isArray(findings)) {
      for (const f of findings) {
        if (f && f.attribution !== 'tool' && typeof f.summary === 'string') {
          store.appendLog(taskId, `观察复盘（${f.attribution}，不入台账）：${f.summary}`);
        }
      }
    }
    for (const d of findingsToObservations(task, res.structured)) observations.add(d);
  } catch (e) {
    store.appendLog(taskId, `观察复盘异常（不影响任务）：${e instanceof Error ? e.message : String(e)}`);
  }
}
