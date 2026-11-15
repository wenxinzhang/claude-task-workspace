import { locateRecord, parseSourceKey, setRecordField, type FeishuRecord } from './feishu.ts';
import { credsLabel, type FeishuCreds, type Store } from './store.ts';
import type { FeishuSource, Project, Task, Writeback } from './types.ts';

const split = (s: string) =>
  s
    .split(/[,，]/)
    .map((v) => v.trim())
    .filter(Boolean);

/** 看板各阶段在飞书上对应的取值 */
function stageValues(f: FeishuSource) {
  return { todo: f.writeBackTodoValue.trim(), review: f.writeBackReviewValue.trim(), done: f.writeBackDoneValue.trim() };
}

const statusField = (f: FeishuSource) => (f.writeBackField || f.filterField).trim();

/**
 * 任务处在当前阶段时，飞书上应该是什么值；不需要写时返回 null。
 * - 已完成待测试(review)、测试通过(done)：写对应取值
 * - 待确认 / 待修改：只有之前把飞书改成过别的值（任务被退回重做）才改回去，刚导入的任务不动
 * - 进行中、测试中、异常：飞书上没有对应取值，不写
 */
export function writebackPlan(f: FeishuSource, task: Pick<Task, 'status' | 'writeback'>): { field: string; value: string; expectCurrent: string[] } | null {
  const field = statusField(f);
  if (!f.writeBack || !field) return null;
  const v = stageValues(f);
  let value = '';
  if (task.status === 'review') value = v.review;
  else if (task.status === 'done') value = v.done;
  else if ((task.status === 'todo' || task.status === 'pending_confirm') && task.writeback?.state === 'done' && task.writeback.value !== v.todo) value = v.todo;
  if (!value) return null;
  // 回写的就是导入过滤用的字段时，飞书上应当是导入取值或看板写过的取值；不是的话说明有人改成了别的状态，不覆盖
  const imported = field === f.filterField.trim() ? split(f.filterValues) : [];
  const expectCurrent = imported.length ? [...new Set([...imported, v.todo, v.review, v.done].filter(Boolean))] : [];
  return { field, value, expectCurrent };
}

/** 同一个任务的回写按顺序执行：连续流转时后一次不会被前一次覆盖 */
const chains = new Map<string, Promise<unknown>>();

/**
 * 按任务当前所在的阶段回写飞书，并把结果记在任务上。可重复调用：飞书上已是目标值时不再写。
 * 不需要回写（项目未开启、任务不是飞书来的、当前阶段没有对应取值）时返回 null，不留记录。
 * 失败不改变任务状态，只记为 failed，由界面提示并支持重试。
 */
export function writeBackTask(store: Store, taskId: string): Promise<Writeback | null> {
  const task = store.get(taskId);
  if (!task || task.source !== 'feishu') return Promise.resolve(null);
  const project = store.getProject(task.projectId);
  // 调用的这一刻就定下要写什么：之后任务再流转，由下一次调用负责
  const plan = project && writebackPlan(project.feishu, task);
  if (!project || !plan) return Promise.resolve(null);
  const { sourceKey, sourceId } = task;

  const log = (line: string) => store.appendLog(taskId, line);
  const record = (state: Writeback['state'], message: string, previous?: string): Writeback => {
    const wb: Writeback = { state, at: Date.now(), field: plan.field, value: plan.value, previous, message };
    store.update(taskId, { writeback: wb });
    log(`飞书回写${state === 'failed' ? '失败' : state === 'skipped' ? '已跳过' : '完成'}：${message}`);
    return wb;
  };

  const run = async (): Promise<Writeback> => {
    let creds: FeishuCreds | undefined;
    try {
      creds = store.feishuCreds(project.id);
      const ref = parseSourceKey(sourceKey) ?? (sourceId && project.feishu.url ? await locateRecord({ ...creds, url: project.feishu.url }, sourceId) : null);
      if (!ref) return record('failed', '任务上没有飞书记录的定位信息，请重新从飞书导入一次后重试');
      const res = await setRecordField(creds, ref, plan.field, plan.value, plan.expectCurrent);
      return record(res.state, res.message, res.previous);
    } catch (e) {
      return record('failed', `${e instanceof Error ? e.message : String(e)}${creds ? `。${credsLabel(creds)}` : ''}`);
    }
  };

  const p = (chains.get(taskId) ?? Promise.resolve()).then(run, run);
  chains.set(taskId, p);
  void p.finally(() => {
    if (chains.get(taskId) === p) chains.delete(taskId);
  });
  return p;
}

/**
 * 反方向同步：按飞书上的状态移动看板上已导入的任务，返回移动了几个。正在执行的任务不动。
 * - 飞书是「测试通过」取值：任务移到 测试通过(done)
 * - 看板回写过之后，飞书又被改回「待修改」取值：视为被退回，任务回到待确认，由人确认后再执行
 */
export function pullFeishuStatus(store: Store, project: Project, records: Pick<FeishuRecord, 'recordId' | 'fields'>[]): number {
  const field = statusField(project.feishu);
  if (!field) return 0;
  const v = stageValues(project.feishu);
  const current = new Map(records.map((r) => [r.recordId, (r.fields[field] ?? '').trim()]));
  let moved = 0;
  for (const t of store.list(project.id)) {
    if (t.source !== 'feishu' || !t.sourceId || !current.has(t.sourceId)) continue;
    if (t.status === 'in_progress' || t.status === 'testing') continue;
    const cur = current.get(t.sourceId)!;
    if (v.done && cur === v.done && t.status !== 'done') {
      store.appendLog(t.id, `飞书上的「${field}」已是「${cur}」，任务移到已通过`);
      store.setStatus(t.id, 'done', { error: undefined, manualChecks: undefined, followUp: undefined });
      moved++;
    } else if (v.todo && cur === v.todo && (t.status === 'review' || t.status === 'done') && t.writeback?.state === 'done' && t.writeback.value !== v.todo) {
      store.appendLog(t.id, `飞书上的「${field}」被改回「${cur}」，任务退回待确认`);
      store.setStatus(t.id, 'pending_confirm', { error: undefined, manualChecks: undefined, followUp: undefined, confirmed: undefined, writeback: undefined });
      moved++;
    }
  }
  return moved;
}
