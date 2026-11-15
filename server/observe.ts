import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isActionable, type Observation, type ObservationKind, type ObservationStatus } from './observe-types.ts';

const MAX_RECORDS = 500;
/** 带 key 的问题标为已解决后的静默期 */
const RESOLVED_QUIET_MS = 24 * 3_600_000;

/** 观察台账持久化：data/observations.json，与 History 同构（原子写、节流、change 事件、全局上限） */
export class ObservationStore extends EventEmitter {
  private records: Observation[] = [];
  private file: string;

  constructor(private dir: string) {
    super();
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'observations.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // 合法 JSON 但形状不对（如 {}）也回退空列表，与 ProposalStore 对称
      this.records = Array.isArray(parsed) ? (parsed as Observation[]) : [];
    } catch {
      this.records = [];
    }
  }

  list(filter?: { projectId?: string; status?: ObservationStatus; kind?: ObservationKind }): Observation[] {
    let out = this.records;
    if (filter?.projectId) out = out.filter((r) => r.projectId === filter.projectId);
    if (filter?.status) out = out.filter((r) => r.status === filter.status);
    if (filter?.kind) out = out.filter((r) => r.kind === filter.kind);
    return structuredClone(out);
  }

  add(input: Omit<Observation, 'id' | 'at' | 'status'>, now = Date.now()): Observation {
    // 带 key 的问题：未处理或已忽略的同 key 记录还在就不重复入库。
    // 刚解决的也不立刻重新入库：流程类问题按历史累计事实判定，改动生效需要新的任务跑过，静默期后仍成立才算复发
    const dup = input.key
      ? this.records.find((r) => r.key === input.key && (r.status !== 'resolved' || (r.resolvedAt !== undefined && now - r.resolvedAt < RESOLVED_QUIET_MS)))
      : undefined;
    if (dup) return structuredClone(dup);
    const rec: Observation = { ...input, id: randomUUID(), at: now, status: 'new' };
    this.records.push(rec);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    this.scheduleSave();
    this.emit('change');
    return structuredClone(rec);
  }

  setStatus(id: string, status: ObservationStatus, now = Date.now()): Observation | undefined {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return undefined;
    rec.status = status;
    rec.resolvedAt = status === 'resolved' ? now : undefined;
    this.scheduleSave();
    this.emit('change');
    return structuredClone(rec);
  }

  /** 提案应用成功：把它关联的、仍是 new 的问题标为已解决并记录提案；ignored 与手动处理过的不动 */
  markResolvedByProposal(proposalId: string, problemIds: string[]): void {
    const ids = new Set(problemIds);
    let changed = false;
    for (const rec of this.records) {
      if (ids.has(rec.id) && rec.status === 'new') {
        rec.status = 'resolved';
        rec.resolvedAt = Date.now();
        rec.proposalId = proposalId;
        changed = true;
      }
    }
    if (changed) {
      this.scheduleSave();
      this.emit('change');
    }
  }

  /** 提案回滚：把该提案自动标为已解决的问题退回 new；手动解决的（无 proposalId）不受影响 */
  reopenByProposal(proposalId: string): void {
    let changed = false;
    for (const rec of this.records) {
      if (rec.proposalId === proposalId && rec.status === 'resolved') {
        rec.status = 'new';
        rec.proposalId = undefined;
        changed = true;
      }
    }
    if (changed) {
      this.scheduleSave();
      this.emit('change');
    }
  }

  /**
   * 清掉已解决和已忽略的记录，返回清了几条；待处理的不动。保留三类：
   * - 带去重键且被忽略的：删掉它，同一个流程问题会立刻被重新采集进来
   * - 带去重键、刚解决还在静默期内的：同上
   * - keepProposalIds 里的提案关联的：已应用的提案靠它们做复验，复验退化才能回滚
   */
  clearHandled(keepProposalIds: Set<string> = new Set(), now = Date.now()): number {
    const before = this.records.length;
    this.records = this.records.filter(
      (r) =>
        r.status === 'new' ||
        (r.status === 'ignored' && !!r.key) ||
        (r.status === 'resolved' && !!r.key && r.resolvedAt !== undefined && now - r.resolvedAt < RESOLVED_QUIET_MS) ||
        (!!r.proposalId && keepProposalIds.has(r.proposalId)),
    );
    const n = before - this.records.length;
    if (n) {
      this.scheduleSave();
      this.emit('change');
    }
    return n;
  }

  /** 可行动的新问题数：判据见 isActionable（备注级、环境与目标项目的问题不计入自动诊断阈值） */
  countNew(): number {
    return this.records.filter(isActionable).length;
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
      fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      // 有意吞掉：台账写失败不应杀死正在跑任务的服务
    }
  }
}
