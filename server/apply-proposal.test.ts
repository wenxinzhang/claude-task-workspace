import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyProposal, backupFiles, checkEdits, finalizeManifest, isAllowedFile, pruneBackups, restoreBackup, rollbackProposal } from './apply-proposal.ts';
import type { Proposal } from './observe-types.ts';

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'prop1',
  at: 1,
  title: '提案',
  component: 'prompt',
  problemIds: ['o1'],
  rootCause: 'rc',
  edits: [{ file: 'server/a.ts', find: 'const a = 1;', replace: 'const a = 2;' }],
  risk: '低',
  verification: 'v',
  status: 'pending',
  ...over,
});

const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s)).digest('hex');

/** 临时工具根：按相对路径写入文件内容 */
function rootWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-apply-'));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), c, 'utf8');
  }
  return root;
}

describe('isAllowedFile', () => {
  it('只放行 server/ 与 client/ 下的 .ts/.tsx/.css；其余一律拒绝', () => {
    expect(isAllowedFile('server/a.ts')).toBe(true);
    expect(isAllowedFile('client/src/b.tsx')).toBe(true);
    expect(isAllowedFile('client/src/c.css')).toBe(true);
    expect(isAllowedFile('server/x.test.ts')).toBe(true);
    expect(isAllowedFile('data/settings.json')).toBe(false);
    expect(isAllowedFile('.claude/x.md')).toBe(false);
    expect(isAllowedFile('package.json')).toBe(false);
    expect(isAllowedFile('node_modules/x.ts')).toBe(false);
    expect(isAllowedFile('server/../data/x.json')).toBe(false);
    expect(isAllowedFile('E:/abs/server/a.ts')).toBe(false);
    expect(isAllowedFile('/abs/server/a.ts')).toBe(false);
    expect(isAllowedFile('server/a.js')).toBe(false);
    expect(isAllowedFile('docx/x.ts')).toBe(false);
  });
});

describe('checkEdits', () => {
  it('find 唯一匹配通过；出现两次、不存在、空 find、find=replace 都拒绝', () => {
    const root = rootWith({ 'server/a.ts': 'const a = 1;\nconst b = 2;\n' });
    try {
      expect(checkEdits(root, [{ file: 'server/a.ts', find: 'const a = 1;', replace: 'const a = 2;' }]).ok).toBe(true);
      expect(checkEdits(root, [{ file: 'server/a.ts', find: 'const', replace: 'x' }]).ok).toBe(false);
      expect(checkEdits(root, [{ file: 'server/a.ts', find: '不存在', replace: 'x' }]).ok).toBe(false);
      expect(checkEdits(root, [{ file: 'server/a.ts', find: '', replace: 'x' }]).ok).toBe(false);
      expect(checkEdits(root, [{ file: 'server/a.ts', find: 'const a = 1;', replace: 'const a = 1;' }]).ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('同文件两条 edit 顺序模拟：依次生效仍唯一则通过，造成重复则拒绝（锚点）', () => {
    const root = rootWith({ 'server/a.ts': 'aaa\nbbb\n' });
    try {
      expect(checkEdits(root, [
        { file: 'server/a.ts', find: 'aaa', replace: 'ccc' },
        { file: 'server/a.ts', find: 'bbb', replace: 'ddd' },
      ]).ok).toBe(true);
      expect(checkEdits(root, [
        { file: 'server/a.ts', find: 'aaa', replace: 'bbb' },
        { file: 'server/a.ts', find: 'bbb', replace: 'x' },
      ]).ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('CRLF 文件：find 用 LF 书写仍匹配（锚点）', () => {
    const root = rootWith({ 'server/a.ts': 'const a = 1;\r\nconst b = 2;\r\n' });
    try {
      expect(checkEdits(root, [{ file: 'server/a.ts', find: 'const a = 1;\nconst b = 2;', replace: 'const a = 3;\nconst b = 4;' }]).ok).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('backupFiles / manifest', () => {
  it('备份保留原字节与目录结构，manifest 记 beforeHash；finalize 后记 afterHash', () => {
    const root = rootWith({ 'server/a.ts': 'original\n' });
    try {
      const dir = backupFiles(root, 'prop1', ['server/a.ts']);
      expect(fs.readFileSync(path.join(dir, 'server', 'a.ts'), 'utf8')).toBe('original\n');
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      expect(manifest.files[0].file).toBe('server/a.ts');
      expect(manifest.files[0].beforeHash).toBe(sha256('original\n'));
      fs.writeFileSync(path.join(root, 'server/a.ts'), 'changed\n', 'utf8');
      finalizeManifest(root, 'prop1');
      const m2 = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      expect(m2.files[0].afterHash).toBe(sha256('changed\n'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('applyProposal', () => {
  it('全过：内容替换、备份含原文、结果 ok、runChecks 收到工具根；CRLF 保持', async () => {
    const root = rootWith({ 'server/a.ts': 'const a = 1;\r\n' });
    try {
      let checksRoot = '';
      const res = await applyProposal({ root, proposal: proposal(), runChecks: async (r) => { checksRoot = r; return { ok: true, output: '通过' }; } });
      expect(res.ok).toBe(true);
      expect(res.mode).toBe('apply');
      expect(checksRoot).toBe(root);
      expect(fs.readFileSync(path.join(root, 'server', 'a.ts'), 'utf8')).toBe('const a = 2;\r\n');
      expect(fs.readFileSync(path.join(root, 'data', 'observer-backups', 'prop1', 'server', 'a.ts'), 'utf8')).toBe('const a = 1;\r\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('检查失败：所有受影响文件还原为原内容，结果 ok=false 含输出（错误路径锚点）', async () => {
    const root = rootWith({ 'server/a.ts': 'const a = 1;\n', 'server/b.ts': 'const b = 1;\n' });
    try {
      const p = proposal({ edits: [
        { file: 'server/a.ts', find: 'const a = 1;', replace: 'const a = 2;' },
        { file: 'server/b.ts', find: 'const b = 1;', replace: 'const b = 2;' },
      ] });
      const res = await applyProposal({ root, proposal: p, runChecks: async () => ({ ok: false, output: 'typecheck 挂了' }) });
      expect(res.ok).toBe(false);
      expect(res.output).toContain('typecheck 挂了');
      expect(fs.readFileSync(path.join(root, 'server', 'a.ts'), 'utf8')).toBe('const a = 1;\n');
      expect(fs.readFileSync(path.join(root, 'server', 'b.ts'), 'utf8')).toBe('const b = 1;\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('提案失效（stale）：不写任何文件、不产生备份（错误路径锚点）', async () => {
    const root = rootWith({ 'server/a.ts': 'const a = 999;\n' });
    try {
      const res = await applyProposal({ root, proposal: proposal(), runChecks: async () => ({ ok: true, output: '' }) });
      expect(res.ok).toBe(false);
      expect(fs.readFileSync(path.join(root, 'server', 'a.ts'), 'utf8')).toBe('const a = 999;\n');
      expect(fs.existsSync(path.join(root, 'data', 'observer-backups', 'prop1'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('中文与正则元字符按字面替换，不发生转义副作用（锚点）', async () => {
    const root = rootWith({ 'server/a.ts': 'const 标题 = "旧值";\n' });
    try {
      const p = proposal({ edits: [{ file: 'server/a.ts', find: 'const 标题 = "旧值";', replace: 'const 标题 = "$&新值";' }] });
      const res = await applyProposal({ root, proposal: p, runChecks: async () => ({ ok: true, output: '' }) });
      expect(res.ok).toBe(true);
      expect(fs.readFileSync(path.join(root, 'server', 'a.ts'), 'utf8')).toBe('const 标题 = "$&新值";\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('rollbackProposal', () => {
  it('无漂移：还原为原字节，结果 ok 且 mode=rollback', async () => {
    const root = rootWith({ 'server/a.ts': 'orig\n' });
    try {
      await applyProposal({ root, proposal: proposal({ edits: [{ file: 'server/a.ts', find: 'orig', replace: 'changed' }] }), runChecks: async () => ({ ok: true, output: '' }) });
      expect(fs.readFileSync(path.join(root, 'server', 'a.ts'), 'utf8')).toBe('changed\n');
      const res = await rollbackProposal({ root, proposalId: 'prop1' });
      expect(res.ok).toBe(true);
      expect(res.mode).toBe('rollback');
      expect(fs.readFileSync(path.join(root, 'server', 'a.ts'), 'utf8')).toBe('orig\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('任一文件漂移：整体拒绝、文件不动、reason 列出漂移文件', async () => {
    const root = rootWith({ 'server/a.ts': 'orig\n' });
    try {
      await applyProposal({ root, proposal: proposal({ edits: [{ file: 'server/a.ts', find: 'orig', replace: 'changed' }] }), runChecks: async () => ({ ok: true, output: '' }) });
      fs.writeFileSync(path.join(root, 'server', 'a.ts'), 'user-edited\n', 'utf8');
      const res = await rollbackProposal({ root, proposalId: 'prop1' });
      expect(res.ok).toBe(false);
      expect(res.output).toContain('server/a.ts');
      expect(fs.readFileSync(path.join(root, 'server', 'a.ts'), 'utf8')).toBe('user-edited\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('afterHash 缺失（中途崩溃）：漂移校验拒绝；无条件还原仍可恢复', async () => {
    const root = rootWith({ 'server/a.ts': 'orig\n' });
    try {
      await applyProposal({ root, proposal: proposal({ edits: [{ file: 'server/a.ts', find: 'orig', replace: 'changed' }] }), runChecks: async () => ({ ok: true, output: '' }) });
      const manifestFile = path.join(root, 'data', 'observer-backups', 'prop1', 'manifest.json');
      const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      delete m.files[0].afterHash;
      fs.writeFileSync(manifestFile, JSON.stringify(m), 'utf8');
      const res = await rollbackProposal({ root, proposalId: 'prop1' });
      expect(res.ok).toBe(false);
      expect(restoreBackup(root, 'prop1').ok).toBe(true);
      expect(fs.readFileSync(path.join(root, 'server', 'a.ts'), 'utf8')).toBe('orig\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('没有备份：ok=false 不抛（错误路径锚点）', async () => {
    const root = rootWith({});
    try {
      const res = await rollbackProposal({ root, proposalId: 'nope' });
      expect(res.ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('pruneBackups', () => {
  it('12 个备份只留最近 10 个', () => {
    const root = rootWith({});
    try {
      for (let i = 0; i < 12; i++) {
        const d = backupFiles(root, `p${i}`, []);
        fs.utimesSync(d, new Date(i * 1000), new Date(i * 1000));
      }
      pruneBackups(root);
      const left = fs.readdirSync(path.join(root, 'data', 'observer-backups'));
      expect(left).toHaveLength(10);
      expect(left).not.toContain('p0');
      expect(left).toContain('p11');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
