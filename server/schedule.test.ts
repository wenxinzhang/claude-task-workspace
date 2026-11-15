import { describe, expect, it } from 'vitest';
import { clock, dayKey, dueProjects, SCHEDULE_TIME } from './schedule.ts';
import { normalizeProject } from './store.ts';
import { validateProjectPatch } from './validate.ts';
import type { Project } from './types.ts';

const project = (id: string, exec: Partial<Project['exec']>): Project => normalizeProject({ id, name: id, workdir: 'E:\\proj', exec, createdAt: 1 } as unknown as Project);

// 本机时区的 2026-11-12 22:00:30
const at = (h: number, m: number, day = 12) => new Date(2026, 10, day, h, m, 30);

describe('dueProjects', () => {
  const on = project('on', { scheduleEnabled: true, scheduleTime: '22:00' });
  const off = project('off', { scheduleEnabled: false, scheduleTime: '22:00' });
  const other = project('other', { scheduleEnabled: true, scheduleTime: '08:30' });

  it('只返回已开启、且时间正好是这一分钟的项目', () => {
    expect(dueProjects([on, off, other], at(22, 0), new Map()).map((p) => p.id)).toEqual(['on']);
    expect(dueProjects([on, off, other], at(8, 30), new Map()).map((p) => p.id)).toEqual(['other']);
    expect(dueProjects([on, off, other], at(22, 1), new Map())).toEqual([]);
    expect(dueProjects([on, off, other], at(21, 59), new Map())).toEqual([]);
  });

  it('同一天只触发一次，第二天再触发', () => {
    const fired = new Map([['on', dayKey(at(22, 0))]]);
    expect(dueProjects([on], at(22, 0), fired)).toEqual([]);
    expect(dueProjects([on], at(22, 0, 13), fired).map((p) => p.id)).toEqual(['on']);
  });

  it('日期和时间按本机时区补零', () => {
    expect(dayKey(new Date(2026, 0, 5, 9, 7))).toBe('2026-01-05');
    expect(clock(new Date(2026, 0, 5, 9, 7))).toBe('09:07');
  });
});

describe('定时设置', () => {
  it('默认关闭；旧项目数据没有这两项时补默认值', () => {
    expect(project('p', {}).exec).toMatchObject({ scheduleEnabled: false, scheduleTime: '22:00' });
  });

  it('时间只接受 24 小时制 HH:MM', () => {
    expect(validateProjectPatch({ exec: { scheduleEnabled: 1, scheduleTime: '07:05' } }).exec).toEqual({ scheduleEnabled: true, scheduleTime: '07:05' });
    for (const bad of ['24:00', '7:05', '12:60', '晚上十点', '']) {
      expect(SCHEDULE_TIME.test(bad)).toBe(false);
      expect(() => validateProjectPatch({ exec: { scheduleTime: bad } })).toThrow('HH:MM');
    }
  });
});
