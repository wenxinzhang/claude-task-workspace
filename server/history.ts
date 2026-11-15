import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { HistoryRecord, Task } from './types.ts';

const MAX_PER_PROJECT = 200;
const MAX_LOG_LINES = 200;

/** 执行记录持久化：data/history.json。AI 修复 / Git 同步 / 代码推送 / 部署 */
export class History extends EventEmitter {
  private records: HistoryRecord[] = [];
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dir: string) {
    super();
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'history.json');
    try {
      this.records = JSON.parse(fs.readFileSync(this.file, 'utf8')) as HistoryRecord[];
    } catch {
      this.records = [];
    }
  }

  list(projectId?: string): HistoryRecord[] {
    const list = projectId ? this.records.filter((r) => r.projectId === projectId) : this.records;
    return structuredClone(list);
  }

  add(rec: HistoryRecord): HistoryRecord {
    this.records.push(rec);
    this.cap(rec.projectId);
    this.save();
    this.emit('change', rec.projectId);
    return rec;
  }

  update(id: string, patch: Partial<HistoryRecord>) {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return;
    Object.assign(rec, patch);
    this.save();
    this.emit('change', rec.projectId);
  }

  /** 日志追加不逐条推送（部署日志走 deploy-log 通道），落盘节流 */
  appendLog(id: string, line: string) {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return;
    rec.logs.push(line);
    if (rec.logs.length > MAX_LOG_LINES) rec.logs.splice(0, rec.logs.length - MAX_LOG_LINES);
    this.scheduleSave();
  }

  /** 升级前执行过的任务没有记录：按 evidence 补一条，只补最近一次 */
  backfillAI(tasks: Task[]) {
    for (const t of tasks) {
      if (!t.evidence?.implement) continue;
      if (this.records.some((r) => r.kind === 'ai' && r.taskId === t.id)) continue;
      this.records.push(aiRecordFromTask(t));
      this.cap(t.projectId);
    }
    this.save();
  }

  private cap(projectId: string) {
    const of = this.records.filter((r) => r.projectId === projectId);
    if (of.length <= MAX_PER_PROJECT) return;
    const drop = new Set(of.slice(0, of.length - MAX_PER_PROJECT).map((r) => r.id));
    this.records = this.records.filter((r) => !drop.has(r.id));
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 300);
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

/** 从任务事实派生 AI 修复记录：步骤时长按事件流，结论按门禁 */
export function aiRecordFromTask(t: Task): HistoryRecord {
  const ev = t.evidence ?? {};
  const stages = [
    ['analysis', '读取修复规格'],
    ['implement', '修改代码'],
    ['verify', '运行测试'],
  ] as const;
  const steps = stages
    .filter(([s]) => ev[s])
    .map(([s, name]) => ({
      name,
      status: (s === 'verify' && t.gate?.verdict === 'fail' ? 'fail' : 'ok') as 'ok' | 'fail',
      durationMs: ev[s]!.durationMs,
    }));
  const first = ev.analysis ?? ev.implement!;
  const last = ev.verify ?? ev.implement!;
  const status: HistoryRecord['status'] =
    t.gate?.verdict === 'pass'
      ? 'success'
      : t.gate?.verdict === 'fail'
        ? 'failed'
        : t.gate?.verdict === 'unverified'
          ? 'review'
          : t.error
            ? 'failed'
            : 'success';
  return {
    id: randomUUID(),
    projectId: t.projectId,
    kind: 'ai',
    title: t.title,
    status,
    startedAt: first.at - first.durationMs,
    finishedAt: last.at,
    taskId: t.id,
    steps,
    logs: [],
    commit: t.commit?.hash,
    error: t.error,
  };
}
