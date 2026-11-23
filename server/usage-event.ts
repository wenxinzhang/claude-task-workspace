import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const MAX_RECORDS = 500;

/** 使用事件的种类：只收白名单里的，前端上报其他值一律拒收 */
export const USAGE_KINDS = [
  'view', // 页面/视图切换
  'click', // 关键按钮点击
  'open_drawer', // 抽屉/详情打开
  'close_drawer', // 抽屉/详情关闭（配对算停留时长）
  'error', // 前端捕获的操作错误
  'retry', // 同一动作短时间内的重试
] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/**
 * 一条使用事件。只记事件类型、目标标识与计数/时长，不记正文内容——
 * 任务标题、代码、凭据、飞书内容一律不进这个存储。
 * target 是界面上的稳定标识（如 'board'、'btn-start-queue'），不是自由文本。
 */
export interface UsageEvent {
  id: string;
  at: number;
  kind: UsageKind;
  /** 界面位置标识：视图名或控件名（白名单校验后的短标识） */
  target: string;
  /** 关联项目（可空：全局界面的事件没有项目） */
  projectId?: string;
  /** 事件自带的数值：停留毫秒数、连续第几次点击等；没有就不填 */
  metric?: number;
}

/** 事件上报的形状校验：target 只收短标识，超长或含非标识字符的直接拒收 */
export function parseUsageEvent(raw: unknown): UsageEvent | null {
  const r = raw as Partial<UsageEvent> | null;
  if (!r || !USAGE_KINDS.includes(r.kind as UsageKind)) return null;
  if (typeof r.target !== 'string' || !r.target.trim() || r.target.length > 64) return null;
  if (!/^[\w.-]+$/.test(r.target)) return null;
  const out: UsageEvent = { id: randomUUID(), at: Date.now(), kind: r.kind as UsageKind, target: r.target };
  // projectId 与 target 同款形状校验：自由文本（标题片段、报错消息）不许借这个字段落盘
  if (typeof r.projectId === 'string' && r.projectId.length <= 64 && /^[\w.-]+$/.test(r.projectId)) out.projectId = r.projectId;
  if (typeof r.metric === 'number' && Number.isFinite(r.metric) && r.metric >= 0 && r.metric <= 24 * 3_600_000) out.metric = Math.round(r.metric);
  return out;
}

/**
 * 使用事件本地存储：data/usage-events.json，与 ObservationStore 同构（原子写、节流、change 事件、全局上限）。
 * 用途是统计「哪里卡、哪里反复点」，删除任一条不影响功能；提供清空入口。
 */
export class UsageEventStore extends EventEmitter {
  private records: UsageEvent[] = [];
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dir: string) {
    super();
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'usage-events.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.records = Array.isArray(parsed) ? (parsed as UsageEvent[]) : [];
    } catch {
      this.records = [];
    }
  }

  list(since?: number): UsageEvent[] {
    const out = since ? this.records.filter((r) => r.at >= since) : this.records;
    return structuredClone(out);
  }

  add(raw: unknown): UsageEvent | null {
    const ev = parseUsageEvent(raw);
    if (!ev) return null;
    this.records.push(ev);
    while (this.records.length > MAX_RECORDS) this.records.shift();
    this.scheduleSave();
    this.emit('change');
    return ev;
  }

  /** 清空全部事件，返回清了几条（设置里的「停止采集并清空」用） */
  clear(): number {
    const n = this.records.length;
    this.records = [];
    this.scheduleSave();
    this.emit('change');
    return n;
  }

  /** 最近 N 天内的点击聚合计数：按 target 分组，摩擦分析用 */
  clickCounts(sinceMs: number): { target: string; n: number }[] {
    const since = Date.now() - sinceMs;
    const counts = new Map<string, number>();
    for (const r of this.records) {
      if (r.kind !== 'click' || r.at < since) continue;
      counts.set(r.target, (counts.get(r.target) ?? 0) + 1);
    }
    return [...counts.entries()].map(([target, n]) => ({ target, n })).sort((a, b) => b.n - a.n);
  }

  /** 抽屉停留：前端在 close_drawer 的 metric 里带上本次停留毫秒数，这里按控件算中位数 */
  drawerDwellMs(sinceMs: number): { target: string; n: number; medianMs: number | null }[] {
    const since = Date.now() - sinceMs;
    const dwell = new Map<string, number[]>();
    for (const r of this.records) {
      if (r.at < since) continue;
      if (r.kind === 'close_drawer' && typeof r.metric === 'number') {
        const arr = dwell.get(r.target) ?? [];
        arr.push(r.metric);
        dwell.set(r.target, arr);
      }
    }
    return [...dwell.entries()].map(([target, arr]) => {
      const sorted = arr.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return { target, n: sorted.length, medianMs: sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2) };
    });
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 300);
  }

  private save() {
    // 写盘失败不击穿服务：下次变更会再试，tmp+rename 保证不留半截文件
    try {
      this.writeFile();
    } catch {
      // 有意吞掉：使用统计写失败不应杀死正在跑任务的服务
    }
  }

  private writeFile(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}
