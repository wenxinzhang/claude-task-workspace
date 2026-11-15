import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { disabledSkillArgs, listSkills, parseSkillMeta, skillLibraryProblem, splitSkills, stageSkills } from './skills.ts';
import { skillSection } from './prompts.ts';
import { DEFAULT_EXEC } from './types.ts';

describe('parseSkillMeta', () => {
  it('读取 frontmatter 的 name 和 description', () => {
    expect(parseSkillMeta('---\nname: qa-test\ndescription: "端到端验证"\n---\n正文')).toEqual({ name: 'qa-test', description: '端到端验证' });
    expect(parseSkillMeta('没有 frontmatter')).toEqual({});
    expect(parseSkillMeta('---\nname: a\ndescription: >\n  第一行\n  第二行\nallowed-tools: Read\n---')).toEqual({ name: 'a', description: '第一行 第二行' });
  });
});

describe('listSkills', () => {
  it('合并项目和用户 skill，同名项目优先', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    const mk = (dir: string, name: string, desc: string) => {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n`);
    };
    try {
      const work = path.join(root, 'work');
      const home = path.join(root, 'home');
      mk(path.join(work, '.claude', 'skills'), 'qa-test', '项目版');
      mk(path.join(home, '.claude', 'skills'), 'qa-test', '用户版');
      mk(path.join(home, '.claude', 'skills'), 'debug', '调试');
      fs.mkdirSync(path.join(work, '.claude', 'skills', 'no-skill-md'));
      expect(listSkills(work, home)).toEqual([
        { name: 'debug', description: '调试', scope: 'user' },
        { name: 'qa-test', description: '项目版', scope: 'project' },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('阶段 skill', () => {
  const exec = { ...DEFAULT_EXEC, verifySkills: 'qa-test, tool-commit-push', disabledSkills: 'tool-commit-push finishing-branch' };

  it('去掉被禁用的', () => {
    expect(stageSkills(exec, 'verify')).toEqual(['qa-test']);
    expect(stageSkills(exec, 'implement')).toEqual([]);
    expect(splitSkills('a，b、a c')).toEqual(['a', 'b', 'c']);
  });

  it('禁用的 skill 生成权限拦截参数', () => {
    expect(disabledSkillArgs(exec)).toEqual(['--disallowedTools', 'Skill(tool-commit-push)', 'Skill(finishing-branch)']);
    expect(disabledSkillArgs({ ...exec, disabledSkills: '' })).toEqual([]);
  });

  it('提示词段落', () => {
    const s = skillSection(['qa-test'], ['tool-commit-push']);
    expect(s).toContain('`qa-test`');
    expect(s).toContain('不要使用这些 skill：`tool-commit-push`');
    expect(skillSection([], [])).toBe('');
  });
});

describe('listSkills：链接形式安装的 skill', () => {
  it('目录是符号链接或 junction 时也算（skill 常以链接方式装进 ~/.claude/skills）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-link-'));
    try {
      const real = path.join(root, 'store', 'lark-doc');
      fs.mkdirSync(real, { recursive: true });
      fs.writeFileSync(path.join(real, 'SKILL.md'), '---\nname: lark-doc\ndescription: 飞书文档\n---\n');
      const skillsDir = path.join(root, 'home', '.claude', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      // junction 在 Windows 上不需要管理员权限；其他系统上等同目录符号链接
      fs.symlinkSync(real, path.join(skillsDir, 'lark-doc'), 'junction');
      expect(listSkills('', path.join(root, 'home')).map((s) => s.name)).toEqual(['lark-doc']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('skill 库目录', () => {
  const mk = (dir: string, name: string) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  };

  it('库目录里的 skill 也列出来，标明来自库；与项目或用户同名时不重复', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-lib-'));
    try {
      const work = path.join(root, 'work');
      const home = path.join(root, 'home');
      const lib = path.join(root, 'lib');
      mk(path.join(work, '.claude', 'skills'), 'qa-test');
      mk(path.join(home, '.claude', 'skills'), 'debug');
      mk(path.join(lib, '.claude', 'skills'), 'qa-test');
      mk(path.join(lib, '.claude', 'skills'), 'tdd');
      expect(listSkills(work, home, lib).map((s) => [s.name, s.scope])).toEqual([
        ['debug', 'user'],
        ['qa-test', 'project'],
        ['tdd', 'library'],
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('没配库目录时与原来一样', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-lib-'));
    try {
      mk(path.join(root, 'home', '.claude', 'skills'), 'debug');
      expect(listSkills('', path.join(root, 'home'), '').map((s) => s.name)).toEqual(['debug']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skillLibraryProblem：目录不存在、里面没有 .claude/skills 时说明原因；正常返回空', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-lib-'));
    try {
      expect(skillLibraryProblem('')).toBe('');
      expect(skillLibraryProblem(path.join(root, 'nope'))).toContain('不存在');
      expect(skillLibraryProblem(root)).toContain('.claude/skills');
      mk(path.join(root, '.claude', 'skills'), 'a');
      expect(skillLibraryProblem(root)).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
