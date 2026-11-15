/** 行级差异的一行：same 两边都有，del 只在旧文本，add 只在新文本 */
export interface DiffLine {
  type: 'same' | 'del' | 'add';
  text: string;
}

/**
 * 提案替换片段的行级差异：去掉相同的前后缀，中间部分先删后增。
 * 提案的 find/replace 通常是「在一段原文里插入或改动几行」，前后缀对齐已足够看清改了什么，不做完整 LCS。
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  // 后缀不得与前缀重叠：重复行只能被占用一次
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const same = (text: string): DiffLine => ({ type: 'same', text });
  return [
    ...a.slice(0, head).map(same),
    ...a.slice(head, a.length - tail).map((text): DiffLine => ({ type: 'del', text })),
    ...b.slice(head, b.length - tail).map((text): DiffLine => ({ type: 'add', text })),
    ...a.slice(a.length - tail).map(same),
  ];
}
