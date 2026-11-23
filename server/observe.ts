import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isActionable, type Observation, type ObservationIssue, type ObservationKind, type ObservationReview, type ObservationSections, type ObservationStatus } from './observe-types.ts';

const MAX_RECORDS = 500;
/** 带 key 的问题标为已解决后的静默期 */
const RESOLVED_QUIET_MS = 24 * 3_600_000;

/** 观察台账持久化：data/observations.json，与 History 同构（原子写、节流、change 事件、全局上限） */
export class ObservationStore extends EventEmitter {
  private records: Observation[] = [];
  private file: string;
  private submitting = new Map<string, Promise<Observation>>();

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
    // 编号水位单独落盘、只增不减：最新的记录被清理后，下一条也不会复用它的编号（链接与外部引用的 #N 不会指错）
    this.metaFile = path.join(dir, 'observations-meta.json');
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8')) as { lastNumber?: unknown };
      if (typeof meta.lastNumber === 'number' && Number.isFinite(meta.lastNumber)) this.lastNumber = meta.lastNumber;
    } catch {
      // 没有水位文件（首次启动或旧数据）：从现有记录推出来
    }
    this.lastNumber = Math.max(this.lastNumber, this.records.reduce((m, r) => (typeof r.number === 'number' && r.number > m ? r.number : m), 0));
    // 旧记录没有编号：按入库时间补齐，写回文件后固定不变（兼容迁移，无需手动操作）
    const missing = this.records.filter((r) => typeof r.number !== 'number').sort((a, b) => a.at - b.at);
    if (missing.length) {
      for (const r of missing) r.number = ++this.lastNumber;
      this.scheduleSave();
    }
  }

  private metaFile: string;
  private lastNumber = 0;

  private nextNumber(): number {
    return ++this.lastNumber;
  }

  /** 编辑问题目录里的内容：标题、章节、负责人。只改传了的字段，刷新 updatedAt */
  editContent(id: string, patch: { title?: string; sections?: ObservationSections; owner?: string }, now = Date.now()): Observation {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) throw new Error('问题不存在');
    if (patch.title !== undefined) rec.title = patch.title;
    if (patch.sections !== undefined) rec.sections = patch.sections;
    if (patch.owner !== undefined) rec.owner = patch.owner || undefined;
    rec.updatedAt = now;
    this.scheduleSave();
    this.emit('change');
    return structuredClone(rec);
  }

  list(filter?: { projectId?: string; status?: ObservationStatus; kind?: ObservationKind }): Observation[] {
    let out = this.records;
    if (filter?.projectId) out = out.filter((r) => r.projectId === filter.projectId);
    if (filter?.status) out = out.filter((r) => r.status === filter.status);
    if (filter?.kind) out = out.filter((r) => r.kind === filter.kind);
    return structuredClone(out);
  }

  get(id: string): Observation | undefined {
    return structuredClone(this.records.find((r) => r.id === id));
  }

  saveReview(id: string, review: ObservationReview): Observation {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) throw new Error('问题不存在');
    rec.review = review;
    rec.updatedAt = Date.now();
    this.scheduleSave();
    this.emit('change');
    return structuredClone(rec);
  }

  async recordIssue(id: string, publish: (observation: Observation) => Promise<ObservationIssue>): Promise<Observation> {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) throw new Error('问题不存在');
    const pending = this.submitting.get(id);
    if (pending) return pending;
    if (rec.issue) {
      this.saveIssueReceipt(rec.issue);
      return structuredClone(rec);
    }
    const result = publish(structuredClone(rec)).then((issue) => {
      rec.issue = issue;
      try {
        this.saveIssueReceipt(issue);
      } finally {
        this.emit('change');
      }
      return structuredClone(rec);
    });
    this.submitting.set(id, result);
    try {
      return await result;
    } finally {
      this.submitting.delete(id);
    }
  }

  private saveIssueReceipt(issue: ObservationIssue): void {
    try {
      this.writeFile();
    } catch {
      this.scheduleSave();
      throw new Error(`GitHub Issue #${issue.number} 已创建，台账暂时无法写入本地文件`);
    }
  }

  add(input: Omit<Observation, 'id' | 'at' | 'status'>, now = Date.now()): Observation {
    // 带 key 的问题：未处理或已忽略的同 key 记录还在就不重复入库。
    // 刚解决的也不立刻重新入库：流程类问题按历史累计事实判定，改动生效需要新的任务跑过，静默期后仍成立才算复发
    const dup = input.key
      ? this.records.find((r) => r.key === input.key && (r.status !== 'resolved' || (r.resolvedAt !== undefined && now - r.resolvedAt < RESOLVED_QUIET_MS)))
      : undefined;
    if (dup) return structuredClone(dup);
    const rec: Observation = { ...input, id: randomUUID(), at: now, status: 'new', number: this.nextNumber(), updatedAt: now };
    this.records.push(rec);
    while (this.records.length > MAX_RECORDS) {
      const index = this.records.findIndex((r) => r !== rec && !this.submitting.has(r.id));
      // 全部都在提交 Issue 中（几乎不可能）：宁可暂时超上限，也不能 splice(-1) 删掉刚加的那条
      if (index < 0) break;
      this.records.splice(index, 1);
    }
    this.scheduleSave();
    this.emit('change');
    return structuredClone(rec);
  }

  setStatus(id: string, status: ObservationStatus, now = Date.now()): Observation | undefined {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return undefined;
    rec.status = status;
    rec.resolvedAt = status === 'resolved' ? now : undefined;
    rec.updatedAt = now;
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
        this.submitting.has(r.id) ||
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
      this.writeFile();
    } catch {
      // 有意吞掉：台账写失败不应杀死正在跑任务的服务
    }
  }

  private writeFile(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    // 编号水位随台账一起落盘；它只增不减，先写台账后写水位，中途失败重启时仍能从记录里推回不小于真实值的水位
    // 水位单独兜底：台账已经写成功，水位失败只稍后重试，不让调用方以为台账没写进去
    try {
      const metaTmp = `${this.metaFile}.tmp`;
      fs.writeFileSync(metaTmp, JSON.stringify({ lastNumber: this.lastNumber }), 'utf8');
      fs.renameSync(metaTmp, this.metaFile);
    } catch (e) {
      console.error(`问题编号水位写入失败，稍后重试：${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => this.scheduleSave(), 1000).unref?.();
    }
  }
}
