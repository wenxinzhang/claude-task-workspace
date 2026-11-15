import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitMessage, commitTaskChanges, git, parseStatusZ, skippedDiff, snapshot, taskChanges, taskDiff } from './git.ts';

async function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-commit-'));
  await git(['init', '-q'], dir);
  await git(['config', 'user.name', 'test'], dir);
  await git(['config', 'user.email', 'test@example.com'], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, 'user.txt'), 'u\n');
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'g\n');
  await git(['add', '-A'], dir);
  await git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

const committedFiles = async (dir: string) =>
  (await git(['show', '--name-only', '--format=', 'HEAD'], dir)).trim().split('\n').filter(Boolean).sort();

describe('parseStatusZ', () => {
  it('解析普通改动与重命名', () => {
    const m = parseStatusZ(' M a.txt\0R  new.txt\0old.txt\0?? [id].tsx\0');
    expect([...m.keys()]).toEqual(['a.txt', 'new.txt', 'old.txt', '[id].tsx']);
  });
});

describe('commitTaskChanges', () => {
  it('只提交本任务的改动，不带上执行前已有的改动和暂存', async () => {
    const dir = await tempRepo();
    try {
      // 用户执行前的改动：一个已修改、一个已暂存的新文件
      fs.writeFileSync(path.join(dir, 'user.txt'), 'user wip\n');
      fs.writeFileSync(path.join(dir, 'staged.txt'), 's\n');
      await git(['add', 'staged.txt'], dir);

      const snap = (await snapshot(dir))!;
      // 任务的改动：修改、新增（含特殊字符）、删除
      fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
      fs.mkdirSync(path.join(dir, 'pages'));
      fs.writeFileSync(path.join(dir, 'pages', '[id].tsx'), 'x\n');
      fs.rmSync(path.join(dir, 'gone.txt'));

      const res = await commitTaskChanges(snap, commitMessage('修复标题遮挡', '改了 a.txt'));
      expect(res.committed).toBe(true);
      expect(res.skipped).toEqual([]);
      expect(await committedFiles(dir)).toEqual(['a.txt', 'gone.txt', 'pages/[id].tsx']);
      expect((await git(['log', '-1', '--format=%s%n%b'], dir)).trim()).toBe('修复标题遮挡\n改了 a.txt');

      // 用户的改动保持原样：user.txt 仍未提交，staged.txt 仍在暂存区
      const left = parseStatusZ(await git(['status', '--porcelain=v1', '-z'], dir));
      expect(left.get('user.txt')).toBe(' M');
      expect(left.get('staged.txt')).toBe('A ');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('执行前已改动、又被任务修改的文件不提交，记入 skipped', async () => {
    const dir = await tempRepo();
    try {
      fs.writeFileSync(path.join(dir, 'user.txt'), 'user wip\n');
      const snap = (await snapshot(dir))!;
      fs.writeFileSync(path.join(dir, 'user.txt'), 'user wip + claude\n');

      const res = await commitTaskChanges(snap, 'x');
      expect(res).toMatchObject({ committed: false, files: [], skipped: ['user.txt'] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('taskDiff 只包含本任务的改动，新文件附内容', async () => {
    const dir = await tempRepo();
    try {
      fs.writeFileSync(path.join(dir, 'user.txt'), 'user wip\n');
      const snap = (await snapshot(dir))!;
      fs.writeFileSync(path.join(dir, 'a.txt'), 'changed-by-task\n');
      fs.writeFileSync(path.join(dir, 'new.ts'), 'export const x = 1;\n');

      const c = await taskChanges(snap);
      expect(c.files.sort()).toEqual(['a.txt', 'new.ts']);
      expect(c.untracked).toEqual(['new.ts']);
      const diff = await taskDiff(snap, c);
      expect(diff).toContain('+changed-by-task');
      expect(diff).toContain('--- 新文件 new.ts\nexport const x = 1;');
      expect(diff).not.toContain('user wip');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skippedDiff 只含执行期间的变化，不含执行前已有的改动', async () => {
    const dir = await tempRepo();
    try {
      fs.writeFileSync(path.join(dir, 'user.txt'), 'user wip\n');
      const snap = (await snapshot(dir))!;
      fs.writeFileSync(path.join(dir, 'user.txt'), 'user wip + claude\n');
      const c = await taskChanges(snap);
      expect(c.skipped).toEqual(['user.txt']);
      const d = await skippedDiff(snap, c.skipped);
      expect(d).toContain('user.txt');
      expect(d).toContain('-user wip');
      expect(d).toContain('+user wip + claude');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('不是 git 仓库时 snapshot 返回 null', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-'));
    try {
      expect(await snapshot(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('commitMessage', () => {
  it('标题压成一行并截断，正文为总结', () => {
    expect(commitMessage('  a\n b  ')).toBe('a b');
    expect(commitMessage('t', ' s ')).toBe('t\n\ns');
    expect(commitMessage('x'.repeat(100)).length).toBe(72);
  });
});
