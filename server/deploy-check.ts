import type { HistoryRecord } from './types.ts';

export interface DeployCheck {
  /** 这个环境上最近一次成功部署的就是当前版本，且没有未提交的改动 */
  upToDate: boolean;
  /** 最近一次成功部署的版本（%h %s）与完成时间；从没成功部署过时没有 */
  commit?: string;
  at?: number;
}

const hash = (commit?: string) => commit?.trim().split(/\s+/)[0] ?? '';

/**
 * 当前代码是不是已经部署在这个环境上了。只看执行记录里这个环境最近一次已经结束的部署：
 * 它成功且版本相同才算最新。最近一次是失败或被中止的，服务器上可能停在半截，不算最新 ——
 * 即使更早有一次成功部署的就是当前版本。还在跑的不算；别的环境部署过也不算。
 * dirtyTracked 是已跟踪文件里没提交的改动数 —— 部署用的是工作区里的代码，有改动就不算同一个版本。
 */
export function lastDeployed(records: HistoryRecord[], envName: string, current: string | undefined, dirtyTracked: number): DeployCheck {
  const last = records
    .filter((r) => r.kind === 'deploy' && r.status !== 'running' && r.envName === envName)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!last || last.status !== 'success') return { upToDate: false };
  const same = !!hash(current) && hash(current) === hash(last.commit);
  return { upToDate: same && dirtyTracked === 0, commit: last.commit, at: last.finishedAt };
}
