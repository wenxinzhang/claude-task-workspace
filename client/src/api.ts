import { useEffect, useState } from 'react';
import { DEFAULT_ENV, DEFAULT_FEISHU_SOURCE, defaultEnv } from '../../server/types.ts';
import type {
  Criterion,
  DeployEnv,
  DeployStatus,
  DeployStep,
  ExecConfig,
  GateResult,
  GitConfig,
  HistoryRecord,
  Observation,
  ObserverStatus,
  Preflight,
  Project,
  Proposal,
  QueueStatus,
  RunEvidence,
  RunProgress,
  Settings,
  Spec,
  Task,
  TaskStatus,
  TestEnv,
} from '../../server/types.ts';
import type { FlowMetrics } from '../../server/flow-metrics.ts';

export { DEFAULT_ENV, defaultEnv };
export type { FlowMetrics };
export type { Criterion, DeployEnv, DeployStatus, DeployStep, ExecConfig, GateResult, GitConfig, HistoryRecord, Observation, ObserverStatus, Preflight, Project, Proposal, QueueStatus, RunEvidence, RunProgress, Settings, Spec, Task, TaskStatus, TestEnv };
export type TaskBrief = Omit<Task, 'logs'> & { logCount: number };
export const IDLE_QUEUE: QueueStatus = { running: false, currentId: null, todoCount: 0 };

export const PROVIDER_LABEL: Record<ExecConfig['provider'], string> = { claude: 'Claude Code', codex: 'Codex CLI', custom: '本地命令行代理' };

export const COLUMNS: { key: TaskStatus; label: string; hint: string; color: string }[] = [
  { key: 'pending_confirm', label: '待确认', hint: '看规格、回答问题后确认', color: '#9aa39d' },
  { key: 'todo', label: '待修改', hint: '规格已冻结，等待执行', color: '#5b7fd6' },
  { key: 'in_progress', label: '修复中', hint: '代理正在修改代码', color: '#e0973a' },
  { key: 'testing', label: '验证中', hint: '逐项验证验收项', color: '#9a6fd6' },
  { key: 'review', label: '待验证', hint: '等待人工验收', color: '#e06a4a' },
  { key: 'done', label: '已通过', hint: '通过门禁或人工验收', color: '#2f9e6e' },
  { key: 'blocked', label: '异常', hint: '需要处理', color: '#d64545' },
];

/** 状态显示名：项目自定义了飞书回写取值（不等于默认值）就跟随团队叫法，否则用规范名（待修改/待验证/已通过） */
export function statusLabel(project: Project | null | undefined, status: TaskStatus): string {
  const f = project?.feishu;
  const custom = (v: string | undefined, def: string) => {
    const t = v?.trim();
    return t && t !== def ? t : '';
  };
  if (status === 'todo') return custom(f?.writeBackTodoValue, DEFAULT_FEISHU_SOURCE.writeBackTodoValue) || '待修改';
  if (status === 'review') return custom(f?.writeBackReviewValue, DEFAULT_FEISHU_SOURCE.writeBackReviewValue) || '待验证';
  if (status === 'done') return custom(f?.writeBackDoneValue, DEFAULT_FEISHU_SOURCE.writeBackDoneValue) || '已通过';
  return COLUMNS.find((c) => c.key === status)?.label ?? status;
}

export const STAGE_LABEL = { analysis: '理解', implement: '实现', verify: '验证' } as const;

/** Git 仓库概况，与服务端 repoInfo 一致 */
export interface RepoInfo {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: number;
  remote: string | null;
  head: string;
}

/** 执行记录里的耗时：23.2 s */
export function fmtSec(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

/** 2026-11-12 14:05:26 */
export function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 今天 10:24 / 昨天 18:37 / 11-10 09:00 */
export function fmtDayTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (day(d) === day(now)) return `今天 ${hm}`;
  if (day(d) === day(yest)) return `昨天 ${hm}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

/** 用时：不到一分钟显示秒，否则显示「x 分 y 秒」 */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** 每秒更新一次的当前时间：用于显示已用时；不需要时不计时 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** 从任务详情里取某个字段的值，如「类型：bug」 */
export function fieldOf(description: string, name: string): string {
  return new RegExp(`${name}[:：]\\s*(.+)`).exec(description)?.[1].trim() ?? '';
}

export async function api<T = unknown>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 上传一张截图到任务，返回更新后的任务 */
export async function uploadImage(taskId: string, file: File): Promise<TaskBrief> {
  const res = await fetch(`/api/tasks/${taskId}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name || 'image.png') },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as TaskBrief;
}

/** 上传截图给观察者诊断：立即返回，诊断后台跑，结果经 SSE 推送到台账 */
export async function uploadScreenshot(file: File, page: string, note: string): Promise<{ started: boolean; token: string }> {
  const res = await fetch(`/api/observations/screenshot-diagnose?page=${encodeURIComponent(page)}&note=${encodeURIComponent(note)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name || 'image.png') },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as { started: boolean; token: string };
}

/** 前端预检，和服务端限制一致 */
export function checkImage(file: File): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return `「${file.name}」不是支持的图片格式`;
  if (file.size > MAX_IMAGE_BYTES) return `「${file.name}」超过 10 MB`;
  return null;
}

type LogListener = (e: { id: string; line: string }) => void;
const logListeners = new Set<LogListener>();

export function onLog(fn: LogListener) {
  logListeners.add(fn);
  return () => void logListeners.delete(fn);
}

type DeployLogListener = (e: { projectId: string; line: string }) => void;
const deployLogListeners = new Set<DeployLogListener>();

export function onDeployLog(fn: DeployLogListener) {
  deployLogListeners.add(fn);
  return () => void deployLogListeners.delete(fn);
}

/** 订阅服务端 SSE：项目、任务列表、各项目队列状态、日志、执行记录 */
export function useLive() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [tasks, setTasks] = useState<TaskBrief[]>([]);
  const [queues, setQueues] = useState<Record<string, QueueStatus>>({});
  const [deploys, setDeploys] = useState<Record<string, DeployStatus>>({});
  const [history, setHistory] = useState<Record<string, HistoryRecord[]>>({});
  const [observations, setObservations] = useState<Observation[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [observer, setObserver] = useState<ObserverStatus | null>(null);
  const [flow, setFlow] = useState<Record<string, FlowMetrics>>({});
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    api<HistoryRecord[]>('/api/history').then((all) => {
      const by: Record<string, HistoryRecord[]> = {};
      for (const r of all) (by[r.projectId] ??= []).push(r);
      setHistory(by);
    }, () => undefined);
    const es = new EventSource('/api/events');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('projects', (e) => setProjects(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('tasks', (e) => setTasks(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('queue', (e) => setQueues(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('log', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      logListeners.forEach((fn) => fn(data));
    });
    es.addEventListener('deploy', (e) => setDeploys(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('deploy-log', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      deployLogListeners.forEach((fn) => fn(data));
    });
    es.addEventListener('history', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { projectId: string; records: HistoryRecord[] };
      setHistory((h) => ({ ...h, [data.projectId]: data.records }));
    });
    es.addEventListener('observations', (e) => setObservations(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('proposals', (e) => setProposals(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('observer', (e) => setObserver(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('flow', (e) => setFlow(JSON.parse((e as MessageEvent).data)));
    return () => es.close();
  }, []);

  return { projects, tasks, queues, deploys, history, observations, proposals, observer, flow, connected };
}
