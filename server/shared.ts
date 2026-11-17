// 前后端共用的纯函数：不依赖 node 模块，页面可以直接引用
import type { Criterion, ExecConfig, Spec } from './types.ts';

/** 把 "Bash(npm *), Edit Read" 拆成独立的工具规则，括号内空格不拆 */
export function splitTools(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of input) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 每行一条，去掉空行 */
export const textLines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** 验收项里常见的命令行工具 */
const KNOWN_TOOLS = new Set([
  'python', 'python3', 'py', 'pytest', 'pip', 'ruff', 'mypy', 'flake8',
  'npm', 'npx', 'pnpm', 'yarn', 'node', 'tsc', 'vitest', 'jest', 'eslint',
  'go', 'cargo', 'mvn', 'gradle', 'gradlew', 'java', 'dotnet', 'make', 'git', 'php', 'composer', 'ruby', 'bundle',
]);

const exeName = (token: string) =>
  token
    .replace(/^\.[\\/]/, '')
    .replace(/\.(exe|cmd|bat)$/i, '')
    .toLowerCase();

/** 白名单放行了哪些程序：取 Bash(npm *)、PowerShell(python *) 这类规则的第一个词；不带括号的 Bash 表示全部放行 */
export function allowedExecutables(allowedTools: string): Set<string> {
  const out = new Set<string>();
  for (const rule of splitTools(allowedTools)) {
    if (rule === 'Bash' || rule === 'PowerShell') out.add('*');
    const m = /^(?:Bash|PowerShell)\(\s*([^\s*:)]+)/.exec(rule);
    if (m) out.add(exeName(m[1]));
  }
  return out;
}

/** 命令文本各行用到的程序（第一个词） */
export function commandExecutables(commands: string): string[] {
  return [...new Set(textLines(commands).map((l) => exeName(l.split(/\s+/)[0])))].filter(Boolean);
}

/** 验证命令需要放行的工具规则：Windows 上 Claude Code 可能用 Bash 也可能用 PowerShell，两者都放行 */
export function verifyTools(commands: string): string[] {
  return commandExecutables(commands).flatMap((exe) => [`Bash(${exe} *)`, `PowerShell(${exe} *)`]);
}

/** 实际生效的工具白名单：项目填写的，加上已确认的验证命令用到的程序 */
export function effectiveAllowedTools(exec: Pick<ExecConfig, 'allowedTools' | 'verifyCommands'>): string {
  return [...new Set([...splitTools(exec.allowedTools), ...verifyTools(exec.verifyCommands)])].join(' ');
}

/** 文本里出现在命令位置上的工具：反引号片段的开头，或「执行 / 运行」之后 */
export function mentionedExecutables(text: string): string[] {
  const found = new Set<string>();
  const add = (token: string | undefined) => {
    const name = token ? exeName(token) : '';
    if (KNOWN_TOOLS.has(name)) found.add(name);
  };
  for (const m of text.matchAll(/`([^`]+)`/g)) add(m[1].trim().split(/\s+/)[0]);
  for (const m of text.matchAll(/(?:执行|运行|跑)\s*`?\s*([A-Za-z][\w.-]*)/g)) add(m[1]);
  return [...found];
}

/**
 * 这条自动验收项要靠代理执行命令来验证，但当前权限下这些程序会被拒绝；返回会被拒绝的程序名。
 * 只是按「怎么验」里的文字做的预判：只有 Claude Code 的白名单模式能事先判断，其余情况返回空。
 */
export function blockedExecutables(c: Pick<Criterion, 'method' | 'how'>, exec: Pick<ExecConfig, 'provider' | 'permissionMode' | 'allowedTools' | 'verifyCommands'>): string[] {
  if (c.method !== 'auto') return [];
  if (exec.provider !== 'claude' || (exec.permissionMode !== 'acceptEdits' && exec.permissionMode !== 'dontAsk')) return [];
  const allowed = allowedExecutables(effectiveAllowedTools(exec));
  if (allowed.has('*')) return [];
  return mentionedExecutables(c.how).filter((x) => !allowed.has(x));
}

/**
 * 飞书记录定位链接：在项目配置的原链接上补 table/record，保留知识库路径与
 * 电子表格页签（sheet）上下文。内嵌多维表格的 app_token 只在 API 层有效，
 * 直接开 /base/<appToken> 会落到另一个独立文档（默认首表），与配置的页签不是同一张表。
 * 链接缺失、不是 wiki/base/sheets 形式、或链接里的 table 与任务不一致时，退回 /base/ 拼装。
 * 已知限制：链接不带 table 时 sheet/view 原样保留（导入时正是靠它们解析出数据表与视图）；
 * 若导入后配置被改到别的页签，客户端无 API 映射可判，可能产出 sheet 与 table 矛盾的链接。
 */
export function feishuRecordUrl(projectUrl: string | undefined, sourceKey: string): string | null {
  const [app, table, record] = sourceKey.split('/');
  if (!app || !table) return null;
  const fallback = `https://feishu.cn/base/${app}?table=${table}${record ? `&record=${record}` : ''}`;
  let url: URL;
  try {
    url = new URL((projectUrl ?? '').trim());
  } catch {
    return fallback;
  }
  if (!/\/(wiki|base|sheets)\/[A-Za-z0-9]+/.test(url.pathname)) return fallback;
  const urlTable = url.searchParams.get('table');
  if (urlTable && urlTable !== table) return fallback;
  url.searchParams.set('table', table);
  if (record) url.searchParams.set('record', record);
  else url.searchParams.delete('record');
  return url.toString();
}

/** 规格里还没有回答的问题：回答完才能确认规格 */
export function openQuestions(spec: Pick<Spec, 'questions'>): string[] {
  return (spec.questions ?? []).filter((q) => !q.answer.trim()).map((q) => q.text);
}
