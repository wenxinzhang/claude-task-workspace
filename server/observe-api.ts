import type { Express, Request, Response } from 'express';
import type { Observer } from './observer.ts';
import { canAbandon, type ObservationStatus } from './observe-types.ts';

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

const OBSERVATION_STATUSES: ObservationStatus[] = ['new', 'resolved', 'ignored'];

/** 观察者路由：台账查询/处理、提案查询/拒绝/应用/复验/回滚、手动诊断 */
export function registerObserverRoutes(app: Express, observer: Observer): void {
  app.get('/api/observations', wrap(() => observer.observations.list()));
  app.post('/api/observations/:id/status', wrap((req) => {
    const status = req.body?.status as ObservationStatus;
    if (!OBSERVATION_STATUSES.includes(status)) throw new Error('非法状态');
    const updated = observer.observations.setStatus(req.params.id, status);
    if (!updated) throw new Error('问题不存在');
    return updated;
  }));
  app.post('/api/observations/clear', wrap(() => ({ cleared: observer.clearObservations() })));
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
