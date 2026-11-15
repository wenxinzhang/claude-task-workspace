import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vaultDomains, writeVaultNote } from './vault.ts';

const INDEX = `# 索引

## 30-技术经验

### 前端

- [[已有笔记]] — 钩子

## 40-项目档案

## 90-收件箱
`;

function tempVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  fs.mkdirSync(path.join(dir, '30-技术经验', '前端'), { recursive: true });
  fs.writeFileSync(path.join(dir, '00-索引.md'), INDEX, 'utf8');
  return dir;
}

const ctx = { projectName: '示例项目', source: 'sample-app', taskTitle: '标签间距过大' };

describe('writeVaultNote', () => {
  it('30 经验：按约定写笔记并在索引领域小节加行；同名更新不重复', () => {
    const dir = tempVault();
    try {
      const r1 = writeVaultNote(dir, { title: '树布局避让要把标签拉回树枝', group: '30-技术经验', domain: '前端', fact: '避让算法会把标签推离树枝', why: '只避让不回收', how: '避让后加一步 leader line 回收', related: ['已有笔记'] }, ctx);
      expect(r1.updated).toBe(false);
      const file = path.join(dir, r1.rel);
      const md = fs.readFileSync(file, 'utf8');
      expect(md).toContain('type: lesson');
      expect(md).toContain('tags: [claude/30-技术经验, 前端]');
      expect(md).toContain('source: sample-app');
      expect(md).toContain('**为什么：** 只避让不回收');
      expect(md).toContain('[[已有笔记]]');
      const index1 = fs.readFileSync(path.join(dir, '00-索引.md'), 'utf8');
      expect(index1).toContain('- [[树布局避让要把标签拉回树枝]] — 避让算法会把标签推离树枝');
      // 加在「前端」小节内，而不是别的章节
      expect(index1.indexOf('[[树布局避让要把标签拉回树枝]]')).toBeLessThan(index1.indexOf('## 40-项目档案'));

      const r2 = writeVaultNote(dir, { title: '树布局避让要把标签拉回树枝', group: '30-技术经验', domain: '前端', fact: '更新后的事实', why: 'w', how: 'h' }, ctx);
      expect(r2.updated).toBe(true);
      const index2 = fs.readFileSync(path.join(dir, '00-索引.md'), 'utf8');
      expect(index2.split('[[树布局避让要把标签拉回树枝]]').length).toBe(2); // 只有一行
      expect(fs.readFileSync(file, 'utf8')).toContain('更新后的事实');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('领域不存在：落 90-收件箱，文件名带日期与来源', () => {
    const dir = tempVault();
    try {
      const r = writeVaultNote(dir, { title: '某个坑', group: '30-技术经验', domain: '不存在的领域', why: 'w', how: 'h' }, ctx);
      expect(r.group).toBe('90-收件箱');
      expect(r.rel).toMatch(/^90-收件箱\/\d{4}-\d{2}-\d{2}-sample-app-某个坑\.md$/);
      expect(fs.readFileSync(path.join(dir, '00-索引.md'), 'utf8')).toContain('## 90-收件箱');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('40 项目档案：一个项目一页，第二次追加小节不覆盖', () => {
    const dir = tempVault();
    try {
      const r1 = writeVaultNote(dir, { title: '统计要按树范围过滤', group: '40-项目档案', fact: 'f1', why: 'w', how: 'h' }, ctx);
      expect(r1.rel).toBe('40-项目档案/示例项目.md');
      const r2 = writeVaultNote(dir, { title: '第二条经验', group: '40-项目档案', fact: 'f2', why: 'w', how: 'h' }, ctx);
      expect(r2.updated).toBe(true);
      const md = fs.readFileSync(path.join(dir, r2.rel), 'utf8');
      expect(md).toContain('统计要按树范围过滤');
      expect(md).toContain('第二条经验');
      expect(md).toContain('f1');
      const index = fs.readFileSync(path.join(dir, '00-索引.md'), 'utf8');
      expect(index.split('[[示例项目]]').length).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('目录不对（没有索引）报错', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
    try {
      expect(() => writeVaultNote(dir, { title: 'x', group: '90-收件箱', why: 'w', how: 'h' }, ctx)).toThrow('00-索引.md');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('vaultDomains 列出已有领域', () => {
    const dir = tempVault();
    try {
      expect(vaultDomains(dir)).toEqual(['前端']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
