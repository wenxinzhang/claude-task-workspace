import { describe, expect, it } from 'vitest';
import { lastDeployed } from './deploy-check.ts';
import type { HistoryRecord } from './types.ts';

const rec = (p: Partial<HistoryRecord>): HistoryRecord => ({ id: 'x', projectId: 'p', kind: 'deploy', title: '', status: 'success', startedAt: 1, finishedAt: 2, envName: '测试环境', commit: 'abc1234 改了点东西', logs: [], ...p });

describe('lastDeployed：这个环境上最近一次成功部署的是不是当前版本', () => {
  it('最近一次成功部署的版本和当前一致、没有未提交的改动：是最新', () => {
    expect(lastDeployed([rec({ finishedAt: 99 })], '测试环境', 'abc1234 改了点东西', 0)).toEqual({ upToDate: true, commit: 'abc1234 改了点东西', at: 99 });
  });
  it('当前版本比上次部署的新：不是最新', () => {
    expect(lastDeployed([rec({})], '测试环境', 'def5678 又改了', 0).upToDate).toBe(false);
  });
  it('版本一致但有已跟踪文件没提交：不是最新（部署的是工作区里的代码）', () => {
    expect(lastDeployed([rec({})], '测试环境', 'abc1234 改了点东西', 2).upToDate).toBe(false);
  });
  it('只看这个环境：别的环境部署过不算', () => {
    expect(lastDeployed([rec({ envName: '生产环境' })], '测试环境', 'abc1234 改了点东西', 0).upToDate).toBe(false);
  });
  it('只看最近一次已结束的部署：它失败了就不算最新，哪怕更早成功部署的就是当前版本', () => {
    const ok = rec({ commit: 'abc1234 改了点东西', startedAt: 1 });
    expect(lastDeployed([ok], '测试环境', 'abc1234 改了点东西', 0).upToDate).toBe(true);
    // 之后部署别的版本失败了（服务器可能停在半截）：再想把当前版本部署回去，不能说「不用部署」
    const failed = rec({ commit: 'bbb0000 别的版本', status: 'failed', startedAt: 5 });
    expect(lastDeployed([ok, failed], '测试环境', 'abc1234 改了点东西', 0).upToDate).toBe(false);
    // 还在跑的那条不参与判断
    const running = rec({ commit: 'ccc0000 正在部署', status: 'running', startedAt: 9 });
    expect(lastDeployed([ok, running], '测试环境', 'abc1234 改了点东西', 0).upToDate).toBe(true);
  });
  it('从没部署过、或读不到当前版本：不是最新', () => {
    expect(lastDeployed([], '测试环境', 'abc1234 改了点东西', 0).upToDate).toBe(false);
    expect(lastDeployed([rec({ commit: undefined })], '测试环境', undefined, 0).upToDate).toBe(false);
  });
});
