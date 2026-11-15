import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ApplyResult, OptimizeRun, ProbeRecord, Proposal, ProposalStatus, RemovedProposal } from './observe-types.ts';

const MAX_PROPOSALS = 50;
const MAX_REMOVED = 30;

interface Persisted {
  lastRunAt: number | null;
  lastRun?: OptimizeRun | null;
  proposals: Proposal[];
  /** 被删掉的提案的简短记录，最多 MAX_REMOVED 条 */
  removed?: RemovedProposal[];
}

/** 优化提案持久化：data/proposals.json（{lastRunAt, proposals[]}），与 History 同构 */
export class ProposalStore extends EventEmitter {
  private data: Persisted = { lastRunAt: null, proposals: [] };
  private file: string;

  constructor(private dir: string) {
    super();
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'proposals.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Persisted>;
      this.data = {
        lastRunAt: parsed.lastRunAt ?? null,
        lastRun: parsed.lastRun ?? null,
        proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
        removed: Array.isArray(parsed.removed) ? parsed.removed : [],
      };
    } catch {
      this.data = { lastRunAt: null, proposals: [] };
    }
  }

  list(): Proposal[] {
    return structuredClone(this.data.proposals);
  }

  add(draft: Omit<Proposal, 'id' | 'at' | 'status'>): Proposal {
    const rec: Proposal = { ...draft, id: randomUUID(), at: Date.now(), status: 'pending' };
    this.data.proposals.push(rec);
    if (this.data.proposals.length > MAX_PROPOSALS) this.data.proposals.splice(0, this.data.proposals.length - MAX_PROPOSALS);
    this.scheduleSave();
    this.emit('change');
    return structuredClone(rec);
  }

  get(id: string): Proposal | undefined {
    const p = this.data.proposals.find((x) => x.id === id);
    return p && structuredClone(p);
  }

  setStatus(id: string, status: ProposalStatus, result?: ApplyResult): Proposal | undefined {
    const p = this.data.proposals.find((x) => x.id === id);
    if (!p) return undefined;
    p.status = status;
    if (result !== undefined) p.result = result;
    this.scheduleSave();
    this.emit('change');
    return structuredClone(p);
  }

  /** 从列表里删除；不存在返回 false */
  remove(id: string): boolean {
    const i = this.data.proposals.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const [p] = this.data.proposals.splice(i, 1);
    // 留一条简短记录：下次审查仍知道这个改法被拒绝或回滚过，不会原样再提一遍
    const removed = [...(this.data.removed ?? []), { title: p.title, component: p.component, status: p.status, probe: p.probe?.result, at: p.at }];
    this.data.removed = removed.slice(-MAX_REMOVED);
    this.scheduleSave();
    this.emit('change');
    return true;
  }

  /** 被删掉的提案的简短记录（只给审查用） */
  listRemoved(): RemovedProposal[] {
    return structuredClone(this.data.removed ?? []);
  }

  /** 记录 Probe 式复验结论 */
  setProbe(id: string, probe: ProbeRecord): Proposal | undefined {
    const p = this.data.proposals.find((x) => x.id === id);
    if (!p) return undefined;
    p.probe = probe;
    this.scheduleSave();
    this.emit('change');
    return structuredClone(p);
  }

  getLastRunAt(): number | null {
    return this.data.lastRunAt;
  }

  setLastRunAt(ts: number): void {
    this.data.lastRunAt = ts;
    this.scheduleSave();
  }

  /** 最近一次流程审查的结果；没跑过为 null */
  getLastRun(): OptimizeRun | null {
    return this.data.lastRun ? structuredClone(this.data.lastRun) : null;
  }

  setLastRun(run: OptimizeRun): void {
    this.data.lastRun = run;
    this.data.lastRunAt = run.at;
    this.scheduleSave();
    this.emit('change');
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  private saveTimer: NodeJS.Timeout | null = null;

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 300);
  }

  private save() {
    // 写盘失败（文件占用/磁盘满）不击穿服务：下次变更会再试，tmp+rename 保证不留半截文件
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      // 有意吞掉：提案写失败不应杀死正在跑任务的服务
    }
  }
}
