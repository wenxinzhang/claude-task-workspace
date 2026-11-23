import type { LocalAttachment } from './attachments.ts';
import { renderCriteria } from './spec.ts';
import { allowedExecutables, effectiveAllowedTools, textLines } from './shared.ts';
import type { Criterion, ExecConfig, Task, TestEnv } from './types.ts';

/** 理解阶段：只读代码，产出结构化规格（结构由 SPEC_SCHEMA 约束） */
export function analysisPrompt(task: Pick<Task, 'title' | 'description'>, files?: LocalAttachment[], knowledge = ''): string {
  return `你是资深工程师，正在为下面这个任务写开发前的规格。只阅读代码，不要修改任何文件。

## 任务标题
${task.title}

## 任务详情
${task.description || '（无）'}${attachmentSection(files)}${knowledge}

## 要求
先读代码再下结论：涉及的文件和根因都要来自你实际读到的代码，不要只凭标题推测。读不到代码时不要编写规格，直接说明原因。
读到足以确定根因和改动范围就输出，不必把相关代码全部读完：这一步有时间上限，超时会整段作废重来。
用简体中文，按给定的结构输出。规格要让人一分钟内看完并确认：只写结论，不写推导过程。各字段含义：
- goal：一句话说明要做成什么
- rootCause：不超过三句。缺陷的根因，指到具体文件和位置；需求类任务写现状。没能确认时写明「未确认」和原因
- scope：允许改动的文件或目录，路径相对当前目录。只列确实需要改的，计划新增的回归测试文件或所在测试目录也要列入；实现时超出这个范围的改动（包括新增的测试文件）会被拦下，交人工确认
- steps：实现步骤，不超过 5 步，每步一句
- criteria：验收项。只列判定这次修改是否成立所必需的项，最多 8 条（超出的会被丢弃），同类结果合并成一条；每条一句，只描述一个可以判定是否成立的结果。method 取值：
  - auto（自动验证）：代码改完后，在本机不借助浏览器就能检查，例如构建、类型检查、单元测试、读代码可确认的逻辑。how 写一条可以直接执行的命令，或要核对的代码位置；命令只用「可用的验证命令」段落里列出的已放行程序，该段落说没有放行程序时不要写命令，写要核对的代码位置
  - manual（人工验证）：需要在浏览器里看效果，或需要测试环境数据、部署后才能确认。how 写去哪里看、怎么操作、预期是什么。同一个页面上的多个现象合并成一条
  说明：执行和验证都在本机无头会话中进行，没有浏览器；测试环境运行的是部署前的旧版本，在代码部署前看不到本次改动的效果
  尽量至少给一条 auto 验收项（例如类型检查、构建或读代码可核对的逻辑）：一条 auto 都没有时，任务即使改完也只能整体转人工验收
  本次改动了哪些文件、是否超出 scope，由系统按 git 记录核对，不要写成验收项（例如「git status 只列出某文件」）：工作区里常有别的任务或使用者留下的未提交改动，这类验收项会被判为未通过
- questions：必须由使用者拍板才能动手的问题，例如需求有两种理解、要不要改接口或数据。你能通过读代码确认的事情不要写成问题；没有就给空数组。每条两个字段：
  - text：一个可以直接回答的问句
  - suggestion：你建议的回答，作为初稿给使用者修改。根据读到的代码和任务描述给出推荐做法，一到两句，写成使用者可以直接采用的口吻（例如「只统计当前树，不计入其他树的项目」）；拿不准时写出倾向和理由，不要留空
- risks：仅供知悉的风险，不超过 3 条，每条一句，没有就给空数组`;
}

/** 临时目录段落：自检脚本写到仓库外，不会被门禁当成范围外的改动，也不会留在项目里 */
export function scratchSection(dir: string): string {
  if (!dir) return '';
  return `\n\n## 临时文件\n自检用的临时脚本、临时页面等写到这个目录：${dir}\n它在代码仓库之外，任务结束后自动清理。不要把临时文件写进项目目录：项目里范围外的新文件会被拦下交人工确认。`;
}

/** 已确认可用的验证命令与实际放行的命令程序：告诉代理哪些命令可以直接执行、自动验收项能用哪些程序 */
export function verifySection(exec: Pick<ExecConfig, 'provider' | 'allowedTools' | 'verifyCommands'>): string {
  const commands = textLines(exec.verifyCommands);
  // Claude Code 按白名单放行程序；把实际生效的白名单告诉代理，避免自动验收项写出会被拒绝的命令
  const allowed = exec.provider === 'claude' ? allowedExecutables(effectiveAllowedTools(exec)) : new Set<string>();
  if (!commands.length && !allowed.size && exec.provider !== 'claude') return '';
  const lines = commands.map((c) => `- ${c}`);
  if (exec.provider === 'claude') {
    lines.push(
      allowed.has('*')
        ? '- 命令程序不限，均可直接执行'
        : allowed.size
          ? `- 已放行的命令程序：${[...allowed].join('、')}。自动验收项里的命令只用这些程序，优先用上面列出的已确认命令（部分程序只放行了特定子命令）；其他程序会被权限拒绝，该项只能转人工`
          : '- 当前没有放行任何命令程序：自动验收项不要写命令，写要核对的代码位置；只能靠命令验证的项标为 manual',
    );
  }
  return `\n\n## 可用的验证命令（已放行，可以直接执行）\n${lines.join('\n')}\n每条命令单独执行，不要用分号、&& 或管道把多条命令拼在一起，拼接的命令会被权限拒绝。其他程序的命令也可能被拒绝。`;
}

/** 附件段落：给出本地绝对路径，让代理查看截图 */
export function attachmentSection(files: LocalAttachment[] | undefined): string {
  if (!files?.length) return '';
  const lines = files.map((f) => `- ${f.field}「${f.name}」：${f.path}`);
  return `\n\n## 附件（已下载到本地）
任务详情中提到的截图/附件就是下面这些文件。请先用 Read 工具逐个打开查看${files.some((f) => f.isImage) ? '（Read 可以直接查看图片）' : ''}，结合图片内容理解问题，不要因为看不到截图而跳过：
${lines.join('\n')}`;
}

/** 测试环境信息段落；未开启或全部为空时返回空串 */
export function testEnvSection(env: TestEnv | undefined): string {
  if (!env?.shareWithClaude) return '';
  const lines = [
    env.url && `- 访问地址：${env.url}`,
    env.username && `- 测试账号：${env.username}`,
    env.password && `- 密码：${env.password}`,
    env.server && `- 测试服务器：\n${indent(env.server)}`,
    env.notes && `- 其他说明：\n${indent(env.notes)}`,
  ].filter(Boolean);
  if (!lines.length) return '';
  return `\n\n## 测试环境\n${lines.join('\n')}\n（以上信息仅用于本任务的开发与验证，不要写入代码、配置文件或提交记录）`;
}

const indent = (s: string) =>
  s
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');

export function implementPrompt(task: Task, extra: string, env?: TestEnv, files?: LocalAttachment[], knowledge = ''): string {
  const scoped = !!task.spec?.scope.length;
  return `请在当前项目中完成下面的任务。

## 任务
${task.title}

## 任务详情
${task.description || '（无）'}

## 已确认的规格（按此执行）
${task.analysis || '（无，按任务详情自行判断）'}${attachmentSection(files)}${testEnvSection(env)}${knowledge}

## 要求
- 直接修改代码完成任务，保持与现有代码风格一致
${scoped ? '- 只改规格「改动范围」内的文件。确实需要改范围外的文件时照改，并在总结里说明原因；范围外的改动会交人工确认\n' : ''}- 不要提交 git commit，不要推送
- 本次改动的文件清单和 diff 由系统统计，不必自己运行 git status、git diff 来核对
- 完成后用几句话总结改了哪些文件、做了什么
${extra ? `- ${extra}` : ''}`;
}

/** skill 段落：指定本阶段要用的 skill，并说明禁用的 skill */
export function skillSection(use: string[], disabled: string[]): string {
  const lines: string[] = [];
  if (use.length) {
    lines.push(`本阶段请先用 Skill 工具调用这些 skill，按其中的流程完成工作：${use.map((s) => `\`${s}\``).join('、')}。如果某个 skill 不存在或不适用于本任务，说明原因后继续。`);
  }
  if (disabled.length) {
    lines.push(`不要使用这些 skill：${disabled.map((s) => `\`${s}\``).join('、')}。git 提交、推送、合并分支由看板统一处理。`);
  }
  return lines.length ? `\n\n## Skill\n${lines.join('\n')}` : '';
}

/** 从任务详情中取「所属模块」，用于挑选相关的历史任务 */
export function moduleOf(description: string): string {
  return description.match(/所属模块[:：]\s*(.+)/)?.[1].trim() ?? '';
}

const HISTORY_LIMIT = 5;

/** 挑选同项目已完成的任务：同模块优先，其次最近完成 */
export function relatedHistory(task: Pick<Task, 'id' | 'projectId' | 'description'>, all: Task[], limit = HISTORY_LIMIT): Task[] {
  const mod = moduleOf(task.description);
  return all
    .filter((t) => t.projectId === task.projectId && t.id !== task.id && t.status === 'done')
    .sort((a, b) => {
      const same = Number(!!mod && moduleOf(b.description) === mod) - Number(!!mod && moduleOf(a.description) === mod);
      return same || b.updatedAt - a.updatedAt;
    })
    .slice(0, limit);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 历史任务段落：标题、提交、改动文件、总结摘要 */
export function historySection(history: Task[]): string {
  if (!history.length) return '';
  const items = history.map((t) => {
    const mod = moduleOf(t.description);
    const files = t.commit?.files ?? [];
    const lines = [
      `### ${t.title}${mod ? `（${mod}）` : ''}`,
      `- 完成于 ${new Date(t.updatedAt).toLocaleDateString('zh-CN')}${t.resolvedManually ? '，由人工处理完成，下面的总结是代理当时的结果，可能不完整' : ''}`,
      t.commit && `- 提交：${t.commit.hash}`,
      files.length && `- 改动文件：${files.slice(0, 8).join('、')}${files.length > 8 ? ` 等 ${files.length} 个` : ''}`,
      t.summary && `- 总结：${clip(t.summary.replace(/\s*\n\s*/g, ' '), 400)}`,
    ];
    return lines.filter(Boolean).join('\n');
  });
  return `\n\n## 本项目之前完成的相关任务（仅供参考）
下面是同一项目里已经做完的任务，可以借鉴其中的做法、避免重复踩坑。如果本任务要改同一批文件，请以当前代码为准，不要把之前的修复改回去。
${items.join('\n\n')}`;
}

/** 记忆段落：让 Claude 在结束前把可复用的经验写入项目记忆 */
export function memorySection(memoryDir: string): string {
  return `\n\n## 积累项目经验
本项目的长期记忆目录：${memoryDir}（索引是其中的 MEMORY.md，和你平时在这个项目里用的记忆是同一份）。
任务结束前，回顾这次工作中有没有**下次做别的任务时还用得上、且从代码里看不出来**的经验，例如：
- 踩过的坑和绕过的办法（工具、命令、环境的怪异行为）
- 某类问题的验证方法（怎么启动、怎么登录、看哪个页面或接口）
- 测试环境、部署、数据方面的事实
有的话写进记忆，规则如下：
- 先看 MEMORY.md 和相关文件，已有就更新那一条，不要重复新建
- 一条经验一个 .md 文件，格式和目录里已有的文件一致（frontmatter 含 name、description、metadata.type），并在 MEMORY.md 加一行索引
- 不要记录本次改了哪些代码、任务进度这类 git 里已有的内容，也不要写入密码、密钥等敏感信息
- 发现已有记忆是错的，就改正或删除它
没有值得记的就不写，不要为了写而写。`;
}

/** 本次改动段落：由服务端计算，验证时不需要再运行 git */
export function changesSection(changes?: { files: string[]; skipped: string[]; diff: string }): string {
  if (!changes) return '';
  if (!changes.files.length && !changes.skipped.length) return '\n\n## 本次改动\n（实现阶段没有产生代码改动）';
  const skipped = changes.skipped.length
    ? `\n\n下面这些文件执行前就有未提交的改动，本任务又修改了它们，上面的 diff 末尾单独列出了它们在本任务执行期间的变化（执行前内容→当前内容），核对相关验收项时以该段为准，需要上下文时再读取当前文件：\n${changes.skipped.map((f) => `- ${f}`).join('\n')}`
    : '';
  return `\n\n## 本次改动（已由系统计算，无需再运行 git）
改动的文件：${changes.files.join('、') || '无'}

\`\`\`diff
${changes.diff}
\`\`\`${skipped}`;
}

/** 验证阶段：按验收项编号逐项给结果和依据（结构由 VERIFY_SCHEMA 约束） */
export function verifyPrompt(
  task: Task,
  criteria: Criterion[],
  env?: TestEnv,
  files?: LocalAttachment[],
  knowledge = '',
  changes?: { files: string[]; skipped: string[]; diff: string },
): string {
  return `刚刚有人在当前项目中实现了下面的任务，请你作为测试人员逐项验证。

## 任务
${task.title}

## 规格
${task.analysis || task.description || '（无）'}

## 验收项
${renderCriteria(criteria)}${attachmentSection(files)}${testEnvSection(env)}${changesSection(changes)}${knowledge}

## 验证方式
- 结合上面的改动阅读相关代码，逐项核对自动验证的验收项。只运行验收项「验证方式」里写的命令；验收项没有写命令时，才运行项目已有的构建、类型检查或测试命令。不要修改业务代码
- 标为人工验证的验收项直接给 unverified，evidence 写「需要人工验证」，不要为它们读代码或运行命令
- 你在本机无头会话中运行，没有浏览器；测试环境运行的是部署前的旧版本，看不到本次改动，不要用它判断结果

## 结论
每个验收项单独给结果，id 用验收项的编号：
- pass：你实际验证过，并且成立。evidence 写你做了什么、看到了什么，例如运行的命令和结果、核对的文件与行号
- fail：发现了缺陷，或实现不符合这一项。evidence 写具体问题
- unverified：你没能验证，例如需要浏览器、需要部署、命令被拒绝。evidence 写原因。没有验证过的项不能写 pass
summary 用简体中文写整体说明。`;
}

// 观察者提示词与 schema：阶段一定义在 observe-prompts.ts，此处再导出保持单一导入路径
export { observePrompt, OBSERVE_SCHEMA, optimizePrompt, PROPOSAL_SCHEMA, proposalHistorySection } from './observe-prompts.ts';
