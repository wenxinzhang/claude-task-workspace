import { describe, expect, it } from 'vitest';
import { lineDiff } from './line-diff.ts';

describe('lineDiff', () => {
  it('中间插入一行：前后相同的行标为 same，新增行标为 add', () => {
    expect(lineDiff('a\nc', 'a\nb\nc')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('替换一行：先删后增', () => {
    expect(lineDiff('a\nx\nc', 'a\ny\nc')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'x' },
      { type: 'add', text: 'y' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('完全不同：全部删、全部增', () => {
    expect(lineDiff('a', 'b\nc')).toEqual([
      { type: 'del', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'add', text: 'c' },
    ]);
  });

  it('重复行不会被前后缀同时占用', () => {
    expect(lineDiff('a', 'a\na')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'add', text: 'a' },
    ]);
  });

  it('CRLF 与 LF 视为相同的行', () => {
    expect(lineDiff('a\r\nb', 'a\nb').every((l) => l.type === 'same')).toBe(true);
  });
});
