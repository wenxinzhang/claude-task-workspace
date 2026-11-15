import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecConfig, Stage } from './types.ts';

export interface SkillInfo {
  name: string;
  description: string;
  /** project：目标项目的 .claude/skills；library：全局设置里的 skill 库；user：本机用户目录 ~/.claude/skills */
  scope: 'project' | 'library' | 'user';
}

/** 读取 SKILL.md frontmatter 中的 name / description */
export function parseSkillMeta(text: string): { name?: string; description?: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!fm) return {};
  const field = (key: string) => {
    const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm);
    if (!m) return undefined;
    const value = m[1].trim();
    // YAML 多行写法（> 或 |）：取后面缩进的行
    if (/^[>|][+-]?$/.test(value)) {
      const rest = fm.slice(m.index + m[0].length).split(/\r?\n/).slice(1);
      const lines: string[] = [];
      for (const l of rest) {
        if (l.trim() && !/^\s/.test(l)) break;
        lines.push(l.trim());
      }
      return lines.join(' ').trim() || undefined;
    }
    return value.replace(/^["']|["']$/g, '') || undefined;
  };
  return { name: field('name'), description: field('description') };
}

function scan(dir: string, scope: SkillInfo['scope']): SkillInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    // skill 常以符号链接或 junction 的方式装进来：链接本身不是目录，要按它指向的目标判断
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .flatMap((e) => {
      try {
        const meta = parseSkillMeta(fs.readFileSync(path.join(dir, e.name, 'SKILL.md'), 'utf8'));
        return [{ name: meta.name || e.name, description: meta.description ?? '', scope }];
      } catch {
        return [];
      }
    });
}

/** 代理能用的 skill：目标项目的、全局 skill 库的、本机用户目录的；同名时按这个顺序取第一个 */
export function listSkills(workdir: string, home = os.homedir(), libraryDir = ''): SkillInfo[] {
  const out: SkillInfo[] = [];
  const add = (list: SkillInfo[]) => {
    for (const s of list) if (!out.some((x) => x.name === s.name)) out.push(s);
  };
  if (workdir) add(scan(path.join(workdir, '.claude', 'skills'), 'project'));
  if (libraryDir) add(scan(path.join(libraryDir, '.claude', 'skills'), 'library'));
  add(scan(path.join(home, '.claude', 'skills'), 'user'));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 只列 skill 库里的 skill（不去重、不看项目和用户目录） */
export function listLibrarySkills(libraryDir: string): SkillInfo[] {
  if (!libraryDir) return [];
  return scan(path.join(libraryDir, '.claude', 'skills'), 'library').sort((a, b) => a.name.localeCompare(b.name));
}

/** skill 库目录填得对不对：没问题返回空串，有问题返回一句原因 */
export function skillLibraryProblem(libraryDir: string): string {
  if (!libraryDir) return '';
  if (!fs.existsSync(libraryDir)) return `skill 库目录不存在：${libraryDir}`;
  if (!listLibrarySkills(libraryDir).length) return `skill 库目录下没有找到 skill：需要是 ${libraryDir} 下的 .claude/skills/<名称>/SKILL.md`;
  return '';
}

export type { Stage };

/** 拆分空格/逗号分隔的 skill 名称 */
export const splitSkills = (s: string) => [...new Set(s.split(/[\s,，、]+/).filter(Boolean))];

/** 该阶段指定的 skill（去掉被禁用的） */
export function stageSkills(exec: ExecConfig, stage: Stage): string[] {
  const disabled = splitSkills(exec.disabledSkills);
  const field = { analysis: exec.analysisSkills, implement: exec.implementSkills, verify: exec.verifySkills }[stage];
  return splitSkills(field).filter((s) => !disabled.includes(s));
}

/** 禁用的 skill 通过权限规则拦截，不只靠提示词 */
export function disabledSkillArgs(exec: ExecConfig): string[] {
  const names = splitSkills(exec.disabledSkills);
  return names.length ? ['--disallowedTools', ...names.map((n) => `Skill(${n})`)] : [];
}
