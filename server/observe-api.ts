import type { Express, Request, Response } from 'express';
import type { Observer } from './observer.ts';
import { canAbandon, effectiveAttribution, fixRoute, type Observation, type ObservationAttribution, type ObservationStatus } from './observe-types.ts';
import { cleanSections, observationIssueDraft, observationReview, ISSUE_BODY_LIMIT, ISSUE_TITLE_LIMIT, OBSERVATION_TEXT_LIMIT } from './observation-review.ts';
import { publishObservationIssue, type PublishObservationIssue } from './observation-issue.ts';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 与 index.ts 同款的错误包装：业务错误统一 400 + {error} */
function wrap(fn: (req: Request) => unknown | Promise<unknown>) {
  return (req: Request, res: Response) => {
    try {
      const out = fn(req);
      if (out instanceof Promise) {
        out.then((v) => res.json(v ?? {})).catch((e) => res.status(400).json({ error: message(e) }));
      } else {
        res.json(out ?? {});
      }
    } catch (e) {
      res.status(400).json({ error: message(e) });
    }
  };
}

// 待复核只由提案应用设置，不接受手动设：手动设的没有静默期起点，永远走不出来
const OBSERVATION_STATUSES: ObservationStatus[] = ['new', 'resolved', 'ignored'];


interface IssueOptions {
  resolveRepository: (observation: Observation) => Promise<string>;
  createIssue?: PublishObservationIssue;
  /** 新建问题时校验所属项目：存在且未归档。不传则不校验（测试用） */
  projectExists?: (projectId: string) => boolean;
}

function requiredText(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`请填写${label}`);
  const text = value.trim();
  if (text.length > limit) throw new Error(`${label}最多 ${limit} 个字符`);
  return text;
}

function optionalText(value: unknown, label: string, limit: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${label}格式不对`);
  const text = value.trim();
  if (text.length > limit) throw new Error(`${label}最多 ${limit} 个字符`);
  return text;
}

/** 观察者路由：台账查询/处理、提案查询/拒绝/应用/复验/回滚、手动诊断 */
const ATTRIBUTIONS: unknown[] = ['tool', 'project', 'environment'];

export function registerObserverRoutes(app: Express, observer: Observer, issueOptions?: IssueOptions): void {
  const get = (id: string) => {
    const observation = observer.observations.get(id);
    if (!observation) throw new Error('问题不存在');
    return observation;
  };
  const resolveRepository = (observation: Observation) => {
    if (effectiveAttribution(observation) === 'environment') throw new Error('环境问题没有关联的 GitHub 仓库');
    if (!issueOptions) throw new Error('GitHub Issues 未配置');
    return issueOptions.resolveRepository(observation);
  };
  app.get('/api/observations', wrap(() => observer.observations.list()));
  // 问题目录：手动新建问题。必填标题、「问题是什么」「要解决什么」，其余章节和属性可空
  app.post('/api/observations', wrap((req) => {
    const title = requiredText(req.body?.title, '问题标题', ISSUE_TITLE_LIMIT);
    const sections = cleanSections(req.body?.sections);
    if (!sections.problem) throw new Error('请填写「问题是什么」');
    if (!sections.goal) throw new Error('请填写「要解决什么」');
    const projectId = optionalText(req.body?.projectId, '所属项目', 100);
    if (projectId && issueOptions?.projectExists && !issueOptions.projectExists(projectId)) throw new Error('所属项目不存在或已归档');
    const owner = optionalText(req.body?.owner, '负责人', 60);
    const source = optionalText(req.body?.source, '发现来源', 120);
    // 归属显式写上：工具自身的问题会进自动审查（提示词里带章节正文），目标项目和环境的问题只记录不触发审查
    const attribution = ATTRIBUTIONS.includes(req.body?.attribution) ? (req.body.attribution as ObservationAttribution) : projectId ? 'project' : 'tool';
    return observer.observations.add({
      projectId,
      kind: 'manual',
      severity: 'warn',
      title,
      // detail 保存发现来源，在详情页属性栏里显示；手动问题没有采集原文
      detail: source ? `发现来源：${source}` : '',
      context: {},
      source: 'code',
      attribution,
      sections,
      ...(owner ? { owner } : {}),
    });
  }));
  // 问题目录：编辑标题、章节与负责人。章节整体替换；旧记录第一次保存后就有了 sections，原 detail 不动
  app.post('/api/observations/:id/content', wrap((req) => {
    const current = get(req.params.id);
    const patch: { title?: string; sections?: ReturnType<typeof cleanSections>; owner?: string } = {};
    if (req.body?.title !== undefined) patch.title = requiredText(req.body.title, '问题标题', ISSUE_TITLE_LIMIT);
    if (req.body?.sections !== undefined) {
      const raw = req.body.sections;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('问题说明格式不对');
      patch.sections = cleanSections(raw);
      // 编辑不能把正文清空：问题是什么始终必填；手动问题的「要解决什么」也保持必填
      if (!patch.sections.problem) throw new Error('请填写「问题是什么」');
      if (current.kind === 'manual' && !patch.sections.goal) throw new Error('请填写「要解决什么」');
    }
    if (req.body?.owner !== undefined) patch.owner = optionalText(req.body.owner, '负责人', 60);
    return observer.observations.editContent(req.params.id, patch);
  }));
  app.post('/api/observations/:id/review', wrap((req) =>
    observer.observations.saveReview(req.params.id, {
      finding: requiredText(req.body?.finding, '发现的问题', OBSERVATION_TEXT_LIMIT),
      suggestion: requiredText(req.body?.suggestion, '修改建议', OBSERVATION_TEXT_LIMIT),
    }),
  ));
  app.get('/api/observations/:id/issue-draft', wrap(async (req) => {
    const observation = get(req.params.id);
    const repository = observation.issue?.repository ?? await resolveRepository(observation);
    return observationIssueDraft(repository, observation.title, observationReview(observation), observation);
  }));
  app.post('/api/observations/:id/issue', wrap(async (req) => {
    const host = req.get('host')?.toLowerCase();
    const origin = req.get('origin')?.toLowerCase();
    if (!host || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) ||
      (origin && origin !== `http://${host}` && origin !== `https://${host}`)) {
      throw new Error('请在本机工作台提交 Issue');
    }
    if (req.body?.confirmed !== true) throw new Error('请先确认提交 Issue');
    const title = requiredText(req.body.title, 'Issue 标题', ISSUE_TITLE_LIMIT);
    const body = requiredText(req.body.body, 'Issue 正文', ISSUE_BODY_LIMIT);
    const observation = get(req.params.id);
    const repository = observation.issue?.repository ?? await resolveRepository(observation);
    if (req.body.repository !== repository) throw new Error('目标仓库已变化，请重新打开提交确认');
    const publish = issueOptions?.createIssue ?? publishObservationIssue;
    return observer.observations.recordIssue(observation.id, async () => ({
      ...await publish(repository, title, body),
      repository,
    }));
  }));
  app.post('/api/observations/:id/status', wrap((req) => {
    const status = req.body?.status as ObservationStatus;
    if (!OBSERVATION_STATUSES.includes(status)) throw new Error('非法状态');
    const updated = observer.observations.setStatus(req.params.id, status);
    if (!updated) throw new Error('问题不存在');
    return updated;
  }));
  app.post('/api/observations/clear', wrap(() => ({ cleared: observer.clearObservations() })));
  // 使用事件：前端上报（形状非法或采集已关闭即拒），以及摩擦指标查询与手动采集
  app.post('/api/usage/events', wrap((req) => {
    const ev = observer.addUsage(req.body);
    if (!ev) throw new Error('事件未被接受：形状非法或使用采集已关闭');
    return ev;
  }));
  app.get('/api/usage/metrics', wrap((req) => observer.usageMetrics(Math.min(90, Math.max(1, Number(req.query.days) || 7)))));
  app.post('/api/usage/collect', wrap(() => ({ added: observer.collectUsage() })));
  app.post('/api/usage/clear', wrap(() => ({ cleared: observer.usage.clear() })));
  app.get('/api/proposals', wrap(() => observer.proposals.list()));
  app.post('/api/proposals/clear', wrap(() => ({ cleared: observer.clearProposals() })));
  app.delete('/api/proposals/:id', wrap((req) => {
    const r = observer.removeProposal(req.params.id);
    if (!r.ok) throw new Error(r.reason ?? '无法删除');
    return r;
  }));
  app.post('/api/proposals/:id/reject', wrap((req) => {
    const p = observer.proposals.get(req.params.id);
    // 应用没成功的提案也可以放弃，否则它会一直留在「等你处理」里
    if (!p || !canAbandon(p)) throw new Error('只有待确认或应用未成功的提案可以拒绝');
    return observer.proposals.setStatus(req.params.id, 'rejected');
  }));
  app.post('/api/optimize/run', wrap(async () => {
    const r = await observer.optimizer.runManual();
    if (!r.started) throw new Error(r.reason ?? '无法启动诊断');
    return r;
  }));
  // 一键修复：按归属分流。工具问题只诊断这一条并直接应用提案；目标项目问题重新执行关联任务；环境问题改代码修不了
  app.post('/api/observations/:id/fix', wrap((req) => {
    const o = get(req.params.id);
    if (o.status !== 'new') throw new Error('只有未处理的问题可以一键修复');
    const route = fixRoute(o);
    if (!route) throw new Error('备注级记录不进入修复');
    if (route.mode === 'manual') throw new Error(route.reason);
    if (route.mode === 'diagnose') {
      const r = observer.optimizer.runForObservation(o.id);
      if (!r.started) throw new Error(r.reason ?? '无法启动修复');
      return { mode: 'diagnose' };
    }
    const r = observer.fixOne(o.id);
    if (!r.ok) throw new Error(r.reason ?? '无法开始');
    return { mode: route.mode, resolved: !!r.resolved };
  }));
  // 一键修复开始前的确认信息
  app.get('/api/observations-fix-plan', wrap(() => observer.planBatchFix()));
  // 页头一键修复：未处理的可修问题逐条依次修；停止只是不再开始下一条
  app.post('/api/observations/fix-all', wrap(() => {
    const r = observer.startBatchFix();
    if (!r.ok) throw new Error(r.reason ?? '无法开始一键修复');
    return r;
  }));
  app.post('/api/observations/fix-all/stop', wrap(() => {
    const r = observer.stopBatchFix();
    if (!r.ok) throw new Error(r.reason ?? '无法停止');
    return r;
  }));
  app.post('/api/proposals/:id/apply', wrap((req) => {
    const r = observer.startApply(req.params.id);
    if (!r.ok) throw new Error(r.reason ?? '无法应用');
    return r;
  }));
  app.post('/api/proposals/:id/probe', wrap((req) => {
    const observationId = req.body?.observationId;
    if (typeof observationId !== 'string' || !observationId) throw new Error('缺少 observationId');
    const r = observer.startProbe(req.params.id, observationId);
    if (!r.ok) throw new Error(r.reason ?? '无法复验');
    return r;
  }));
  app.post('/api/proposals/:id/rollback', wrap((req) => {
    const r = observer.startRollback(req.params.id);
    if (!r.ok) throw new Error(r.reason ?? '无法回滚');
    return r;
  }));
}
