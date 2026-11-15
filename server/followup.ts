import type { LocalAttachment } from './attachments.ts';
import { attachmentSection, testEnvSection } from './prompts.ts';
import type { Task, TestEnv } from './types.ts';

export interface FollowUpContext {
  /** 接续的是上次的会话：代理还记得任务和自己的改动，只需要给指令 */
  resumed: boolean;
  extra: string;
  /** 上一轮的执行总结，新开会话时提供 */
  priorSummary?: string;
  env?: TestEnv;
  files?: LocalAttachment[];
  knowledge?: string;
}

/** 使用者追加过的指令：重新执行和验证时都要带上，与规格冲突时以它为准 */
export function notesSection(notes: string[]): string {
  if (!notes.length) return '';
  return `\n\n## 使用者追加的要求（与规格冲突时以此为准）\n${notes.map((n) => `- ${n}`).join('\n')}`;
}

const rules = (extra: string) => `## 要求
- 在已有改动的基础上继续，不要推翻与追加指令无关的部分
- 仍以已确认的规格为准；追加指令与规格冲突时按追加指令做，并在总结里说明
- 不要提交 git commit，不要推送
- 完成后用几句话总结这次又改了哪些文件、做了什么
${extra ? `- ${extra}` : ''}`;

/** 追加指令的提示词：接续会话时只给指令；新开会话时带上任务、规格和上一轮的总结 */
export function followUpPrompt(task: Task, notes: string[], ctx: FollowUpContext): string {
  const list = notes.map((n) => `- ${n}`).join('\n');
  if (ctx.resumed) {
    return `使用者看了你刚才的工作，追加了下面的指令，请接着继续。

## 追加指令
${list}

${rules(ctx.extra)}`;
  }
  return `当前项目里有一个任务已经实现过一轮，改动在工作区或最近的提交里。使用者追加了指令，请先看清现有改动，再接着继续。

## 任务
${task.title}

## 任务详情
${task.description || '（无）'}

## 已确认的规格
${task.analysis || '（无）'}

## 上一轮的执行总结
${ctx.priorSummary || '（无）'}

## 追加指令
${list}${attachmentSection(ctx.files)}${testEnvSection(ctx.env)}${ctx.knowledge ?? ''}

${rules(ctx.extra)}`;
}
