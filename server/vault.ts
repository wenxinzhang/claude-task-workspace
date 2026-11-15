import fs from 'node:fs';
import path from 'node:path';

/** 代理提炼出的经验条目 */
export interface KnowledgeNote {
  skip?: boolean;
  title: string;
  /** 30-技术经验 / 40-项目档案 / 90-收件箱 */
  group: string;
  /** 30 下的领域子目录，如 前端 / 后端与数据 */
  domain?: string;
  fact?: string;
  why?: string;
  how?: string;
  related?: string[];
}

export interface VaultContext {
  projectName: string;
  /** 来源项目目录名 */
  source: string;
  taskTitle: string;
}

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 文件名安全化：保留中文，去掉文件系统与双链非法字符 */
const safeName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|[\]#^]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

const GROUPS = ['30-技术经验', '40-项目档案', '90-收件箱'] as const;

/**
 * 按知识库「00-使用约定」写入一条经验：
 * - 30：领域子目录必须已存在，否则落 90-收件箱（拿不准先收件箱）
 * - 40：一个项目一页，已有页追加「修复经验」小节，不新建重复页
 * - 同名条目更新不新建；新条目在 00-索引 加一行
 */
export function writeVaultNote(vaultPath: string, note: KnowledgeNote, ctx: VaultContext): { rel: string; group: string; updated: boolean } {
  const indexFile = path.join(vaultPath, '00-索引.md');
  if (!fs.existsSync(indexFile)) throw new Error(`知识库目录不正确（缺少 00-索引.md）：${vaultPath}`);
  const date = today();
  const title = safeName(note.title || '未命名经验');
  if (!title) throw new Error('经验标题为空');

  let group: (typeof GROUPS)[number] = (GROUPS as readonly string[]).includes(note.group) ? (note.group as (typeof GROUPS)[number]) : '90-收件箱';
  let domain = (note.domain ?? '').trim();
  if (group === '30-技术经验') {
    const domainDir = path.join(vaultPath, '30-技术经验', domain);
    if (!domain || !fs.existsSync(domainDir) || !fs.statSync(domainDir).isDirectory()) group = '90-收件箱';
  }

  const pageName = group === '40-项目档案' ? safeName(ctx.projectName) : title;
  const fileName = group === '90-收件箱' ? `${date}-${safeName(ctx.source)}-${title}` : pageName;
  const rel = path.join(group, ...(group === '30-技术经验' ? [domain] : []), `${fileName}.md`);
  const file = path.join(vaultPath, rel);
  const exists = fs.existsSync(file);

  const hook = (note.fact || note.why || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const related = (note.related ?? []).map((r) => safeName(r)).filter(Boolean);
  const body = [
    note.fact?.trim() || note.why?.trim() || '（无正文）',
    '',
    note.why?.trim() ? `**为什么：** ${note.why.trim()}` : '',
    note.how?.trim() ? `**怎么用：** ${note.how.trim()}` : '',
    related.length ? `相关：${related.map((r) => `[[${r}]]`).join('、')}` : '',
    `来源：项目「${ctx.projectName}」任务「${ctx.taskTitle.replace(/\s+/g, ' ').slice(0, 60)}」（${date}，修复工具自动写入）`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  if (group === '40-项目档案' && exists) {
    // 项目页已存在：追加小节，更新 updated，不覆盖原有内容
    const old = fs.readFileSync(file, 'utf8');
    const updated = old.replace(/updated: \d{4}-\d{2}-\d{2}/, `updated: ${date}`);
    const section = `\n## 修复经验 · ${date}\n\n### ${title}\n\n${body}\n`;
    fs.writeFileSync(file, updated.includes('## 修复经验') || updated.endsWith('\n') ? updated + section : updated + '\n' + section, 'utf8');
  } else {
    const type = group === '40-项目档案' ? 'project' : 'lesson';
    const tagDomain = group === '30-技术经验' ? domain : group === '40-项目档案' ? safeName(ctx.source) : '待归类';
    let created = date;
    if (exists) {
      const m = /created: (\d{4}-\d{2}-\d{2})/.exec(fs.readFileSync(file, 'utf8'));
      if (m) created = m[1];
    }
    const head = group === '40-项目档案' ? `# ${pageName}\n\n项目修复经验积累（修复工具自动写入）。\n\n## 修复经验 · ${date}\n\n### ${title}\n\n` : `# ${title}\n\n`;
    const md = `---\ntype: ${type}\ntags: [claude/${group}, ${tagDomain}]\nsource: ${ctx.source}\ncreated: ${created}\nupdated: ${date}\n---\n${head}${body}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, md, 'utf8');
  }

  // 索引：已有同名双链不重复加；30 的领域小节不存在时补建
  let index = fs.readFileSync(indexFile, 'utf8');
  const link = `[[${group === '90-收件箱' ? fileName : pageName}]]`;
  if (!index.includes(link)) {
    const bullet = `- ${link} — ${hook || `来自 ${ctx.source} 的修复经验`}`;
    index = insertIndexLine(index, group, group === '30-技术经验' ? domain : null, bullet);
    fs.writeFileSync(indexFile, index, 'utf8');
  }
  return { rel: rel.replace(/\\/g, '/'), group, updated: exists };
}

/** 在索引对应章节末尾加一行；30 加到领域小节末尾，小节不存在则建 */
function insertIndexLine(index: string, group: string, domain: string | null, bullet: string): string {
  const lines = index.split('\n');
  const secStart = lines.findIndex((l) => l.startsWith(`## ${group}`));
  if (secStart < 0) return index + `\n## ${group}\n\n${bullet}\n`;
  let secEnd = lines.length;
  for (let i = secStart + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      secEnd = i;
      break;
    }
  }
  let insertAt = secEnd;
  if (domain) {
    let subStart = -1;
    for (let i = secStart + 1; i < secEnd; i++) {
      if (lines[i].startsWith(`### ${domain}`)) {
        subStart = i;
        break;
      }
    }
    if (subStart < 0) {
      // 新领域小节：放在章节末尾
      const block = [`### ${domain}`, '', bullet, ''];
      lines.splice(secEnd, 0, ...block);
      return lines.join('\n');
    }
    insertAt = secEnd;
    for (let i = subStart + 1; i < secEnd; i++) {
      if (lines[i].startsWith('### ')) {
        insertAt = i;
        break;
      }
    }
  }
  // 回退到小节/章节最后一个非空行之后
  while (insertAt > secStart + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, bullet);
  return lines.join('\n');
}

/** 30-技术经验 下已有的领域子目录，供提炼阶段选择 */
export function vaultDomains(vaultPath: string): string[] {
  const dir = path.join(vaultPath, '30-技术经验');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
