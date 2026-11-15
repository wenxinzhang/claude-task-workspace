import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { branches, checkout, git, gitCommandName, repoInfo, syncRemote } from './git.ts';

describe('gitCommandName：报错里的子命令名', () => {
  it('跳过 -c 带的配置值：认证头不会被当成命令名写进报错', () => {
    expect(gitCommandName(['-c', 'http.extraHeader=Authorization: Basic c2VjcmV0', 'fetch', '--prune'])).toBe('fetch');
    expect(gitCommandName(['merge', '--no-edit', 'origin/main'])).toBe('merge');
    expect(gitCommandName(['-c', 'a=b'])).toBe('');
  });
});

async function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-'));
  await git(['init', '-q'], dir);
  await git(['config', 'user.name', 'test'], dir);
  await git(['config', 'user.email', 'test@example.com'], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  await git(['add', '-A'], dir);
  await git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

const commit = async (dir: string, msg: string) => {
  fs.writeFileSync(path.join(dir, 'a.txt'), `${msg}\n`);
  await git(['add', '-A'], dir);
  await git(['commit', '-q', '-m', msg], dir);
};

/** 克隆出来的仓库没有提交身份：自动合并要生成合并提交，得先配上 */
const identity = async (dir: string) => {
  await git(['config', 'user.name', 'test'], dir);
  await git(['config', 'user.email', 'test@example.com'], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);
};

/** 读文件内容，行尾统一成 \n：Windows 上 git 检出时会把换行转成 \r\n，与合并是否正确无关 */
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');

describe('syncRemote', () => {
  it('落后可快进：合并远端提交；再同步为已最新', async () => {
    const origin = await tempRepo();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-'));
    const clone = path.join(base, 'clone');
    await git(['clone', '-q', origin, clone], base);
    try {
      await commit(origin, 'remote-1');
      const r1 = await syncRemote(clone, []);
      expect(r1.status).toBe('success');
      expect(r1.pulled).toBe(1);
      expect(r1.repo.head).toBe((await repoInfo(origin))!.head);

      const r2 = await syncRemote(clone, []);
      expect(r2.status).toBe('uptodate');
      expect(r2.pulled).toBe(0);
    } finally {
      fs.rmSync(origin, { recursive: true, force: true });
      fs.rmSync(base, { recursive: true, force: true });
    }
    // 十几次 git 子进程：单跑约 3.7 秒，全量并行时会超过默认的 5 秒
  }, 30_000);

  it('分叉且两边改了同一处：报冲突并撤销合并，本地提交与文件都不变', async () => {
    const origin = await tempRepo();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-'));
    const clone = path.join(base, 'clone');
    await git(['clone', '-q', origin, clone], base);
    try {
      await identity(clone);
      await commit(clone, 'local-1');
      await commit(origin, 'remote-1');
      const headBefore = (await repoInfo(clone))!.head;
      const r = await syncRemote(clone, []);
      expect(r.status).toBe('conflict');
      expect(r.error).toContain('冲突');
      expect(r.error).toContain('a.txt');
      expect((await repoInfo(clone))!.head).toBe(headBefore);
      expect(read(clone, 'a.txt')).toBe('local-1\n');
      // 没有留下进行到一半的合并
      expect(fs.existsSync(path.join(clone, '.git', 'MERGE_HEAD'))).toBe(false);
    } finally {
      fs.rmSync(origin, { recursive: true, force: true });
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);

  it('代码目录里已有一次没做完的合并：不合并也不撤销，使用者手动解决好的内容还在', async () => {
    const origin = await tempRepo();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-'));
    const clone = path.join(base, 'clone');
    await git(['clone', '-q', origin, clone], base);
    try {
      await identity(clone);
      await commit(clone, 'local-1');
      await commit(origin, 'remote-1');
      await git(['fetch'], clone);
      // 使用者自己开始合并，冲突后改好并暂存，但还没提交
      await git(['merge', '--no-edit', 'origin/HEAD'], clone).catch(() => undefined);
      expect(fs.existsSync(path.join(clone, '.git', 'MERGE_HEAD'))).toBe(true);
      fs.writeFileSync(path.join(clone, 'a.txt'), 'resolved\n');
      await git(['add', 'a.txt'], clone);
      const r = await syncRemote(clone, []);
      expect(r.status).toBe('conflict');
      expect(r.error).toContain('没做完的合并');
      expect(read(clone, 'a.txt')).toBe('resolved\n');
      expect(fs.existsSync(path.join(clone, '.git', 'MERGE_HEAD'))).toBe(true);
    } finally {
      fs.rmSync(origin, { recursive: true, force: true });
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);

  it('分叉但两边改的不是同一处：自动合并，不再落后，没提交的改动原样保留', async () => {
    const origin = await tempRepo();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-'));
    const clone = path.join(base, 'clone');
    await git(['clone', '-q', origin, clone], base);
    try {
      await identity(clone);
      await commit(clone, 'local-1');
      fs.writeFileSync(path.join(origin, 'b.txt'), 'remote\n');
      await git(['add', '-A'], origin);
      await git(['commit', '-q', '-m', 'remote-b'], origin);
      // 工作区里还有一个没提交的新文件：合并不该动它
      fs.writeFileSync(path.join(clone, 'wip.txt'), 'wip\n');
      const r = await syncRemote(clone, []);
      expect(r.status).toBe('success');
      expect(r.merged).toBe(true);
      expect(r.pulled).toBe(1);
      expect(r.repo.behind).toBe(0);
      expect(r.repo.ahead).toBe(2);
      expect(read(clone, 'b.txt')).toBe('remote\n');
      expect(read(clone, 'a.txt')).toBe('local-1\n');
      expect(read(clone, 'wip.txt')).toBe('wip\n');
    } finally {
      fs.rmSync(origin, { recursive: true, force: true });
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('branches / checkout', () => {
  it('只接受本地已有分支', async () => {
    const dir = await tempRepo();
    try {
      const current = (await repoInfo(dir))!.branch;
      expect(await branches(dir)).toContain(current);
      await expect(checkout(dir, 'no-such-branch')).rejects.toThrow('分支不存在');
      await expect(checkout(dir, 'bad;name')).rejects.toThrow('分支名不合法');
      await git(['branch', 'feature/x'], dir);
      await checkout(dir, 'feature/x');
      expect((await repoInfo(dir))!.branch).toBe('feature/x');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
