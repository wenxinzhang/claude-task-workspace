import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { GitConfig } from './types.ts';

/** 报错里用的子命令名：跳过 `-c <配置>` 这样的成对选项 —— 认证头就是这样带进来的，取错了会把凭据写进报错和执行记录 */
export function gitCommandName(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '-C') i++;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return '';
}

/** 运行 git，返回 stdout；input 经 stdin 传入（用于 --pathspec-from-file=-） */
export function git(args: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, out, stderr) => {
      const cmd = gitCommandName(args);
      if (err) reject(new Error(`git ${cmd} 失败：${(stderr || err.message).trim()}`));
      else resolve(out);
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** 解析 `git status --porcelain=v1 -z`：路径相对仓库根目录；重命名时新旧路径都算 */
export function parseStatusZ(out: string): Map<string, string> {
  const entries = new Map<string, string>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (item.length < 4) continue;
    const code = item.slice(0, 2);
    entries.set(item.slice(3), code);
    // R/C 后面紧跟原路径
    if (code[0] === 'R' || code[0] === 'C') entries.set(parts[++i], code);
  }
  return entries;
}

export interface GitSnapshot {
  root: string;
  /** 执行前已有改动的文件 → 状态码 + 内容哈希，用于识别本任务新增的改动 */
  dirty: Map<string, string>;
}

/** 记录执行前的工作区状态；不是 git 仓库返回 null */
export async function snapshot(workdir: string): Promise<GitSnapshot | null> {
  let root: string;
  try {
    root = (await git(['rev-parse', '--show-toplevel'], workdir)).trim();
  } catch {
    return null;
  }
  return { root, dirty: await dirtyWithHash(root) };
}

async function dirtyWithHash(root: string): Promise<Map<string, string>> {
  const status = parseStatusZ(await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root));
  const files = [...status.keys()];
  // 已删除的文件没有内容，哈希为空
  const hashes = files.length ? await hashFiles(root, files) : [];
  return new Map(files.map((f, i) => [f, `${status.get(f)}:${hashes[i] ?? ''}`]));
}

async function hashFiles(root: string, files: string[]): Promise<string[]> {
  const out = await Promise.all(
    // -w 把内容写进对象库：执行前的快照内容之后还能取出来，用于生成 skipped 文件执行期间的 diff
    files.map((f) => git(['hash-object', '-w', '--no-filters', '--', f], root).then((h) => h.trim(), () => '')),
  );
  return out;
}

export interface TaskChanges {
  /** 执行前干净、执行后有变化的文件：本任务的改动 */
  files: string[];
  /** 其中未被 git 跟踪的新文件 */
  untracked: string[];
  /** 执行前就有改动、又被本任务改动的文件，分不清哪些是本任务改的 */
  skipped: string[];
  /** files 中每个文件当前的状态码与内容哈希，用于判断之后有没有再被改动 */
  states: Map<string, string>;
}

/** 对比执行前快照，找出本任务的改动；执行前有改动、执行后被还原的文件不算 */
export async function taskChanges(snap: GitSnapshot): Promise<TaskChanges> {
  const after = await dirtyWithHash(snap.root);
  const files: string[] = [];
  const untracked: string[] = [];
  const skipped: string[] = [];
  const states = new Map<string, string>();
  for (const [file, state] of after) {
    const before = snap.dirty.get(file);
    if (before === undefined) {
      files.push(file);
      states.set(file, state);
      if (state.startsWith('??')) untracked.push(file);
    } else if (before !== state) skipped.push(file);
  }
  return { files, untracked, skipped, states };
}

const MAX_DIFF_CHARS = 60_000;
const MAX_NEW_FILE_CHARS = 8_000;

/** 本任务改动的 diff 文本，给验证用；过长时截断 */
export async function taskDiff(snap: GitSnapshot, changes: TaskChanges): Promise<string> {
  const tracked = changes.files.filter((f) => !changes.untracked.includes(f));
  const parts: string[] = [];
  // git diff 不支持 --pathspec-from-file，分批传路径以免命令行过长
  for (let i = 0; i < tracked.length; i += 100) {
    const batch = tracked.slice(i, i + 100);
    parts.push(
      await git(['--literal-pathspecs', 'diff', 'HEAD', '--', ...batch], snap.root).catch((e: Error) => `（无法生成 diff：${e.message}）`),
    );
  }
  for (const f of changes.untracked) {
    let body: string;
    try {
      const buf = fs.readFileSync(path.join(snap.root, f));
      body = buf.includes(0) ? '（二进制文件）' : clip(buf.toString('utf8'), MAX_NEW_FILE_CHARS);
    } catch {
      body = '（无法读取）';
    }
    parts.push(`--- 新文件 ${f}\n${body}`);
  }
  return clip(parts.join('\n'), MAX_DIFF_CHARS);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…（已截断，共 ${s.length} 字符）` : s);

/**
 * skipped 文件（执行前已有改动、本任务又改过）在执行期间的变化：执行前内容 → 当前内容。
 * 执行前的内容在快照时已写入对象库。这段 diff 不含执行前就有的改动；这些文件仍不自动提交，门禁判定不变。
 */
export async function skippedDiff(snap: GitSnapshot, skipped: string[]): Promise<string> {
  const parts: string[] = [];
  for (const f of skipped) {
    const before = snap.dirty.get(f) ?? '';
    const pre = before.slice(before.indexOf(':') + 1);
    const head = `--- ${f}（执行前已有未提交改动，以下是本任务执行期间的变化）`;
    if (!pre) {
      parts.push(`${head}\n（执行前的内容无法取得，请直接读取当前文件）`);
      continue;
    }
    try {
      const [post] = await hashFiles(snap.root, [f]);
      if (!post) {
        parts.push(`${head}\n（文件已被删除）`);
        continue;
      }
      if (post === pre) continue;
      const d = await git(['diff', '--no-color', pre, post], snap.root);
      parts.push(`${head}\n${clip(d, MAX_NEW_FILE_CHARS)}`);
    } catch (e) {
      parts.push(`${head}\n（无法生成 diff：${(e as Error).message}）`);
    }
  }
  return clip(parts.join('\n'), MAX_DIFF_CHARS);
}

export interface CommitResult extends TaskChanges {
  committed: boolean;
  hash?: string;
}

/**
 * 只提交本任务产生的改动：执行后有变化、且执行前不脏的文件。
 * 执行前就脏的文件即使被再次修改也不提交，记入 skipped 提示用户。
 * only：只提交这些文件（实现阶段的改动），验证阶段留下的临时文件不带进提交。
 */
export async function commitTaskChanges(snap: GitSnapshot, message: string, only?: string[]): Promise<CommitResult> {
  const all = await taskChanges(snap);
  const keep = only && new Set(only);
  const changes = keep ? { ...all, files: all.files.filter((f) => keep.has(f)), untracked: all.untracked.filter((f) => keep.has(f)) } : all;
  const { files } = changes;
  if (!files.length) return { committed: false, ...changes };

  // 路径按字面匹配（如 Next.js 的 [id].tsx），经 stdin 传入避免命令行过长
  const spec = files.join('\0');
  const fromStdin = ['--pathspec-from-file=-', '--pathspec-file-nul'];
  await git(['--literal-pathspecs', 'add', '-A', ...fromStdin], snap.root, spec);
  // --only：只提交这些路径，不带上用户之前暂存的其他内容
  await git(['--literal-pathspecs', 'commit', '--only', '-m', message, ...fromStdin], snap.root, spec);
  const hash = (await git(['rev-parse', '--short', 'HEAD'], snap.root)).trim();
  return { committed: true, hash, ...changes };
}

/** 提交信息：首行是任务标题，正文是 Claude 的执行总结 */
export function commitMessage(title: string, summary?: string): string {
  const subject = title.replace(/\s+/g, ' ').trim().slice(0, 72) || '完成任务';
  const body = (summary ?? '').trim().slice(0, 4000);
  return body ? `${subject}\n\n${body}` : subject;
}

/** 仓库概况：看板上的 Git 面板用 */
export interface RepoInfo {
  branch: string;
  upstream: string | null;
  /** 本地领先 / 落后上游的提交数；没有上游时为 0 */
  ahead: number;
  behind: number;
  /** 未提交的改动文件数（含未跟踪） */
  dirty: number;
  /** origin 的地址，去掉了其中的账号信息 */
  remote: string | null;
  head: string;
}

export async function repoInfo(workdir: string): Promise<RepoInfo | null> {
  let out: string;
  try {
    out = await git(['status', '--porcelain=v2', '--branch'], workdir);
  } catch {
    return null;
  }
  const info: RepoInfo = { branch: '', upstream: null, ahead: 0, behind: 0, dirty: 0, remote: null, head: '' };
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) info.branch = line.slice(14).trim();
    else if (line.startsWith('# branch.upstream ')) info.upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [info.ahead, info.behind] = [Number(m[1]), Number(m[2])];
    } else if (line.trim() && !line.startsWith('#')) info.dirty++;
  }
  info.remote = await git(['remote', 'get-url', 'origin'], workdir).then(
    (s) => s.trim().replace(/\/\/[^@/]+@/, '//') || null,
    () => null,
  );
  info.head = await git(['log', '-1', '--format=%h %s'], workdir).then(
    (s) => s.trim(),
    () => '',
  );
  return info;
}

/** HTTPS 远端且配置了凭据：以 Basic 认证头随命令携带，不写进 git 配置 */
export function authArgs(cfg: GitConfig | undefined, remote: string | null | undefined): string[] {
  if (cfg?.username && cfg?.password && remote?.startsWith('https://')) {
    const basic = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
    return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
  }
  return [];
}

/** 本地分支列表 */
export async function branches(workdir: string): Promise<string[]> {
  const out = await git(['branch', '--format=%(refname:short)'], workdir);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** 切换分支：只接受本地已存在的分支，避免把用户输入当参数注入 */
export async function checkout(workdir: string, branch: string): Promise<void> {
  if (!BRANCH_RE.test(branch)) throw new Error('分支名不合法');
  const list = await branches(workdir);
  if (!list.includes(branch)) throw new Error(`分支不存在：${branch}`);
  await git(['checkout', branch], workdir);
}

/** 修改 origin 地址；没有 origin 时新建 */
export async function setRemote(workdir: string, url: string): Promise<void> {
  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) throw new Error('远端地址需要以 https://、http://、git@ 或 ssh:// 开头');
  const has = await git(['remote'], workdir).then(
    (o) => o.split('\n').map((s) => s.trim()).includes('origin'),
    () => false,
  );
  await git(has ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url], workdir);
}

/** 一个区间内的提交列表，如 upstream..HEAD */
export async function commitsBetween(workdir: string, range: string, cap = 50): Promise<{ hash: string; subject: string }[]> {
  const out = await git(['log', '--format=%h%x09%s', range], workdir).catch(() => '');
  return out
    .split('\n')
    .filter(Boolean)
    .slice(0, cap)
    .map((l) => {
      const [hash, ...rest] = l.split('\t');
      return { hash, subject: rest.join('\t') };
    });
}

export interface SyncResult {
  repo: RepoInfo;
  status: 'success' | 'uptodate' | 'conflict';
  pulled: number;
  /** 本地与远端分叉、自动合并成功：多了一个合并提交 */
  merged?: boolean;
  error?: string;
}

/** 分叉时把上游合并进来。合不了（两边改了同一处，或会覆盖没提交的改动）就撤销，本地提交与文件都不变 */
async function mergeUpstream(workdir: string, fetched: RepoInfo): Promise<SyncResult> {
  const upstream = fetched.upstream!;
  // 代码目录里已经有一次没做完的合并（多半是使用者正在手动解决冲突）：不碰它。
  // 这时再合并会失败，随后的撤销会把他已经解决好的内容一起抹掉
  const unfinished = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], workdir).then(
    () => true,
    () => false,
  );
  if (unfinished) {
    return { repo: fetched, status: 'conflict', pulled: 0, error: '代码目录里有一次没做完的合并。先在代码目录里把它完成（解决冲突后提交）或放弃（git merge --abort），再同步或推送。' };
  }
  try {
    await git(['merge', '--no-edit', upstream], workdir);
  } catch (e) {
    const files = await git(['diff', '--name-only', '--diff-filter=U'], workdir).then(
      (s) => s.split('\n').filter(Boolean),
      () => [] as string[],
    );
    // 合并没开始（比如会覆盖没提交的改动）时没有可撤销的，忽略
    await git(['merge', '--abort'], workdir).catch(() => undefined);
    const error = files.length
      ? `远端的 ${fetched.behind} 个提交和本地的改动冲突，没有自动合并，本地代码保持不变。冲突的文件：${files.slice(0, 8).join('、')}${files.length > 8 ? ` 等 ${files.length} 个` : ''}。需要在代码目录里手动合并。`
      : `远端的 ${fetched.behind} 个提交没能自动合并，本地代码保持不变：${(e as Error).message}`;
    return { repo: (await repoInfo(workdir)) ?? fetched, status: 'conflict', pulled: 0, error };
  }
  return { repo: (await repoInfo(workdir)) ?? fetched, status: 'success', pulled: fetched.behind, merged: true };
}

/** 同步远端：fetch 后能快进就快进；本地也有新提交（分叉）时自动合并，合不了报冲突且不改动本地代码 */
export async function syncRemote(workdir: string, auth: string[]): Promise<SyncResult> {
  const before = await repoInfo(workdir);
  if (!before) throw new Error('代码目录不是 git 仓库');
  await git([...auth, 'fetch', '--prune'], workdir);
  const fetched = await repoInfo(workdir);
  if (!fetched) throw new Error('代码目录不是 git 仓库');
  if (!fetched.upstream) return { repo: fetched, status: 'uptodate', pulled: 0, error: '没有设置上游分支，仅取回远端引用' };
  if (fetched.behind === 0) return { repo: fetched, status: 'uptodate', pulled: 0 };
  if (fetched.ahead > 0) return mergeUpstream(workdir, fetched);
  try {
    await git(['merge', '--ff-only', fetched.upstream], workdir);
  } catch (e) {
    return { repo: (await repoInfo(workdir)) ?? fetched, status: 'conflict', pulled: 0, error: (e as Error).message };
  }
  return { repo: (await repoInfo(workdir)) ?? fetched, status: 'success', pulled: fetched.behind };
}
