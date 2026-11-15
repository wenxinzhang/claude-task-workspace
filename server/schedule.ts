import type { Project } from './types.ts';

/** 定时时间的格式：24 小时制 HH:MM */
export const SCHEDULE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** 本机时区的日期，用于记录「今天已经触发过」 */
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 本机时区的 HH:MM */
export const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * 现在到点、且今天还没有触发过的项目。
 * 只在设定的那一分钟内触发：服务当时没有运行就错过，不会在之后补跑。
 */
export function dueProjects(projects: Project[], now: Date, fired: Map<string, string>): Project[] {
  const today = dayKey(now);
  const hhmm = clock(now);
  return projects.filter((p) => p.exec.scheduleEnabled && p.exec.scheduleTime === hhmm && fired.get(p.id) !== today);
}
