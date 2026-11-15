// @cli-output 独立应用进程脚本：终端输出是其唯一结果通道（另写结果文件供服务器消费）
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ApplyResult, Proposal, ProposalEdit } from './observe-types.ts';

/** 提案可改动的文件白名单：仅 server/ 与 client/ 下的 .ts/.tsx/.css；拒绝绝对路径与穿越 */
export function isAllowedFile(file: string): boolean {
  if (!file || file.includes('\\') || path.isAbsolute(file)) return false;
  const norm = path.posix.normalize(file);
  if (norm.startsWith('../') || norm.includes('/../')) return false;
  if (!/^(server|client)\//.test(norm)) return false;
  return /\.(ts|tsx|css)$/.test(norm);
}

/** 全量预校验：白名单、find 非空且唯一、顺序模拟（同文件多条 edit 依次生效）；任一不过整体拒绝 */
export function checkEdits(root: string, edits: ProposalEdit[]): { ok: true } | { ok: false; reason: string } {
  const buffers = new Map<string, string>();
  for (const e of edits) {
    if (!isAllowedFile(e.file)) return { ok: false, reason: `文件不在白名单：${e.file}` };
    if (!e.find) return { ok: false, reason: 'find 为空' };
    if (e.find === e.replace) return { ok: false, reason: 'find 与 replace 相同' };
    let content = buffers.get(e.file);
    if (content === undefined) {
      try {
        content = fs.readFileSync(path.join(root, e.file), 'utf8').replace(/\r\n/g, '\n');
      } catch {
        return { ok: false, reason: `读不到文件：${e.file}` };
      }
      buffers.set(e.file, content);
    }
    const find = e.find.replace(/\r\n/g, '\n');
    const count = content.split(find).length - 1;
    if (count !== 1) {
      return { ok: false, reason: count === 0 ? `find 在 ${e.file} 中不存在（提案已失效）` : `find 在 ${e.file} 中出现 ${count} 次，要求唯一匹配` };
    }
    buffers.set(e.file, content.split(find).join(e.replace.replace(/\r\n/g, '\n')));
  }
  return { ok: true };
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const backupsDir = (root: string) => path.join(root, 'data', 'observer-backups');
const safeId = (id: string) => id.replace(/[^A-Za-z0-9-]/g, '');

/** 备份受影响文件（保留目录结构与原字节），manifest 记 beforeHash；返回备份目录 */
export function backupFiles(root: string, proposalId: string, files: string[]): string {
  const dir = path.join(backupsDir(root), safeId(proposalId));
  fs.mkdirSync(dir, { recursive: true });
  const manifest: { files: { file: string; beforeHash: string; afterHash?: string }[] } = { files: [] };
  for (const file of files) {
    const src = path.join(root, file);
    const dest = path.join(dir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    manifest.files.push({ file, beforeHash: sha256(fs.readFileSync(src)) });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return dir;
}

/** 未完成的旧备份（manifest 没有 afterHash）里，当前内容与备份时不一致的文件；没有旧备份或已完成返回空 */
export function staleBackupDrift(root: string, proposalId: string): string[] {
  let manifest: { restored?: boolean; files: { file: string; beforeHash: string; afterHash?: string }[] };
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(backupsDir(root), safeId(proposalId), 'manifest.json'), 'utf8'));
  } catch {
    return [];
  }
  // 已经还原过的备份不是「唯一的原始副本」：此后文件再变是别的正当改动，不拦
  if (manifest.restored) return [];
  return manifest.files
    .filter((f) => !f.afterHash)
    .filter((f) => {
      try {
        return sha256(fs.readFileSync(path.join(root, f.file))) !== f.beforeHash;
      } catch {
        return true;
      }
    })
    .map((f) => f.file);
}

/** 应用成功后补记 afterHash：手动回滚的漂移判据 */
export function finalizeManifest(root: string, proposalId: string): void {
  const dir = path.join(backupsDir(root), safeId(proposalId));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { files: { file: string; afterHash?: string }[] };
  for (const f of manifest.files) f.afterHash = sha256(fs.readFileSync(path.join(root, f.file)));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

/** 从备份还原；checkDrift=true 时任一文件当前 hash≠afterHash（或缺失）整体拒绝 */
export function restoreBackup(root: string, proposalId: string, opts?: { checkDrift?: boolean }): { ok: boolean; reason?: string } {
  const dir = path.join(backupsDir(root), safeId(proposalId));
  let manifest: { files: { file: string; beforeHash: string; afterHash?: string }[] };
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return { ok: false, reason: '没有可用的备份' };
  }
  if (opts?.checkDrift) {
    const drifted: string[] = [];
    for (const f of manifest.files) {
      if (!f.afterHash) {
        drifted.push(f.file);
        continue;
      }
      try {
        if (sha256(fs.readFileSync(path.join(root, f.file))) !== f.afterHash) drifted.push(f.file);
      } catch {
        drifted.push(f.file);
      }
    }
    if (drifted.length) return { ok: false, reason: `文件已被改动，拒绝回滚：${drifted.join('、')}` };
  }
  try {
    for (const f of manifest.files) {
      const dest = path.join(root, f.file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(dir, f.file), dest);
    }
  } catch (e) {
    return { ok: false, reason: `还原失败：${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    // 记下「已还原」：之后重试应用时，这份备份不再被当成没还原的现场
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, restored: true }, null, 2), 'utf8');
  } catch {
    // 记不上只影响重试时的判断（会偏保守地拒绝），不影响已完成的还原
  }
  return { ok: true };
}

/** 默认检查：typecheck + test，任一非 0 即失败（独立进程里同步跑） */
function defaultRunChecks(root: string): Promise<{ ok: boolean; output: string }> {
  const parts: string[] = [];
  for (const args of [['run', 'typecheck'], ['test']]) {
    const r = spawnSync('npm', args, { cwd: root, shell: true, encoding: 'utf8', timeout: 10 * 60_000 });
    parts.push(`npm ${args.join(' ')} 退出码 ${r.status}`, r.stdout ?? '', r.stderr ?? '');
    if (r.status !== 0) return Promise.resolve({ ok: false, output: parts.join('\n') });
  }
  return Promise.resolve({ ok: true, output: parts.join('\n') });
}

/** 应用提案：预校验→备份→替换（保持原 EOL）→检查→不过回滚；全有或全无 */
export async function applyProposal(opts: { root: string; proposal: Proposal; runChecks?: (root: string) => Promise<{ ok: boolean; output: string }> }): Promise<ApplyResult> {
  const { root, proposal } = opts;
  // 先查旧备份再做预校验：文件没还原时原文片段往往已不在，预校验会抢先报成「提案已失效」
  // 留有未完成的旧备份、且文件与备份时不一致：上次应用改了文件却没还原。此时再备份会覆盖唯一的原始副本，拒绝
  const drifted = staleBackupDrift(root, proposal.id);
  if (drifted.length) {
    return {
      ok: false,
      output: `上次应用留下的改动没有还原，拒绝再次应用以保护原始备份：${drifted.join('、')}。请先从 data/observer-backups/${safeId(proposal.id)} 手工还原这些文件`,
      at: Date.now(),
      mode: 'apply',
      restored: false,
    };
  }
  const check = checkEdits(root, proposal.edits);
  if (!check.ok) return { ok: false, output: check.reason, at: Date.now(), mode: 'apply' };
  const files = [...new Set(proposal.edits.map((e) => e.file))];
  backupFiles(root, proposal.id, files);
  for (const file of files) {
    const orig = fs.readFileSync(path.join(root, file), 'utf8');
    const crlf = orig.includes('\r\n');
    let content = orig.replace(/\r\n/g, '\n');
    for (const e of proposal.edits.filter((x) => x.file === file)) {
      content = content.split(e.find.replace(/\r\n/g, '\n')).join(e.replace.replace(/\r\n/g, '\n'));
    }
    fs.writeFileSync(path.join(root, file), crlf ? content.replace(/\n/g, '\r\n') : content, 'utf8');
  }
  const runChecks = opts.runChecks ?? defaultRunChecks;
  const checks = await runChecks(root);
  if (!checks.ok) {
    const r = restoreBackup(root, proposal.id);
    return { ok: false, output: r.ok ? checks.output : `${checks.output}\n还原失败：${r.reason ?? ''}`, at: Date.now(), mode: 'apply', restored: r.ok };
  }
  finalizeManifest(root, proposal.id);
  return { ok: true, output: checks.output, at: Date.now(), mode: 'apply' };
}

/** 备份 manifest 是否已记录 afterHash（应用成功过）：崩溃兜底据此区分 apply 中断与 rollback 中断 */
export function manifestHasAfterHash(root: string, proposalId: string): boolean {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(backupsDir(root), safeId(proposalId), 'manifest.json'), 'utf8')) as { files: { afterHash?: string }[] };
    return m.files.length > 0 && m.files.every((f) => !!f.afterHash);
  } catch {
    return false;
  }
}

/** 手动回滚：仅当文件自应用后未被改过（afterHash 一致）才还原 */
export async function rollbackProposal(opts: { root: string; proposalId: string }): Promise<ApplyResult> {
  const res = restoreBackup(opts.root, opts.proposalId, { checkDrift: true });
  return { ok: res.ok, output: res.ok ? '已回滚到应用前' : res.reason ?? '', at: Date.now(), mode: 'rollback' };
}

/** 删除某条提案的备份目录（删除提案时一并清理） */
export function removeBackup(root: string, proposalId: string): void {
  const id = safeId(proposalId);
  if (!id) return;
  fs.rmSync(path.join(backupsDir(root), id), { recursive: true, force: true });
}

/** 备份保留最近 keep 份，删最旧 */
export function pruneBackups(root: string, keep = 10): void {
  const dir = backupsDir(root);
  if (!fs.existsSync(dir)) return;
  const entries = fs
    .readdirSync(dir)
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const e of entries.slice(keep)) fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
}

/** 结果文件与运行中标记的路径（服务器轮询消费） */
export const resultPath = (root: string, proposalId: string) => path.join(root, 'data', 'observer-results', `${safeId(proposalId)}.json`);
export const runningPath = (root: string, proposalId: string) => path.join(root, 'data', 'observer-results', `${safeId(proposalId)}.running.json`);

// CLI 入口：仅直接执行本文件时运行（被 import 时不触发）。用法：apply-proposal.ts apply|rollback <proposalId>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, proposalId] = process.argv.slice(2);
  if ((mode === 'apply' || mode === 'rollback') && proposalId) {
    const root = process.cwd();
    fs.mkdirSync(path.dirname(runningPath(root, proposalId)), { recursive: true });
    fs.writeFileSync(runningPath(root, proposalId), JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode }), 'utf8');
    let result: ApplyResult;
    if (mode === 'apply') {
      try {
        const store = JSON.parse(fs.readFileSync(path.join(root, 'data', 'proposals.json'), 'utf8')) as { proposals: Proposal[] };
        const proposal = store.proposals.find((p) => p.id === proposalId);
        result = proposal ? await applyProposal({ root, proposal }) : { ok: false, output: '提案不存在', at: Date.now(), mode: 'apply' };
      } catch (e) {
        result = { ok: false, output: `读取 proposals.json 失败：${e instanceof Error ? e.message : String(e)}`, at: Date.now(), mode: 'apply' };
      }
    } else {
      // rollback 不需要读提案库，直接按备份还原
      result = await rollbackProposal({ root, proposalId });
    }
    fs.writeFileSync(resultPath(root, proposalId), JSON.stringify(result, null, 2), 'utf8');
    fs.rmSync(runningPath(root, proposalId), { force: true });
    pruneBackups(root);
    console.log(JSON.stringify({ ok: result.ok, mode }));
  } else {
    console.log('用法：apply-proposal.ts apply|rollback <proposalId>');
  }
}
