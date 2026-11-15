import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { parseSourceKey } from './feishu.ts';
import { Store } from './store.ts';
import { pullFeishuStatus, writeBackTask, writebackPlan } from './writeback.ts';
import { DEFAULT_FEISHU_SOURCE, type TaskStatus } from './types.ts';

/** 本地假飞书：只实现回写用到的四个接口，记录收到的写请求 */
const feishu = {
  status: '待修改',
  options: ['待修改', '已完成待测试', '测试通过', '已关闭'],
  puts: [] as { url: string; body: any }[],
  failPut: false,
};
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (body: unknown, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? '';
      if (url.startsWith('/auth/v3/tenant_access_token/internal')) return send({ code: 0, tenant_access_token: 't' });
      if (url.includes('/fields')) {
        return send({
          code: 0,
          data: {
            items: [
              { field_id: 'f1', field_name: '状态', type: 3, property: { options: feishu.options.map((name) => ({ name })) } },
              { field_id: 'f2', field_name: '备注', type: 1 },
              { field_id: 'f3', field_name: '截图', type: 17 },
            ],
          },
        });
      }
      if (url.includes('/records/rec1') && req.method === 'GET') return send({ code: 0, data: { record: { record_id: 'rec1', fields: { 状态: feishu.status } } } });
      if (url.includes('/records/rec1') && req.method === 'PUT') {
        if (feishu.failPut) return send({ code: 1254302, msg: 'no permission' }, 403);
        const body = JSON.parse(raw);
        feishu.puts.push({ url, body });
        feishu.status = body.fields['状态'] ?? feishu.status;
        return send({ code: 0, data: {} });
      }
      send({ code: 404, msg: 'not found' }, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.FEISHU_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.FEISHU_API_BASE;
  await new Promise((r) => server.close(r));
});

const cleanups: (() => void)[] = [];
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 400));
  for (const fn of cleanups.splice(0)) fn();
});

function setup(over: { feishu?: object; status?: TaskStatus; source?: 'feishu' | 'manual' } = {}) {
  Object.assign(feishu, { status: '待修改', puts: [], failPut: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-wb-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.updateSettings({ feishu: { appId: 'cli_x', appSecret: 's' } });
  const project = store.createProject({
    name: 'p',
    workdir: dir,
    // 三个阶段的取值用默认值：待修改 / 已完成待测试 / 测试通过
    feishu: { url: 'https://x.feishu.cn/base/app1?table=tbl1', filterField: '状态', filterValues: '待修改,驳回修改', writeBack: true, ...over.feishu },
  });
  const task = store.create({ projectId: project.id, title: 't', description: '', source: over.source ?? 'feishu', sourceId: 'rec1', sourceKey: 'app1/tbl1/rec1' });
  store.setStatus(task.id, over.status ?? 'review');
  return { store, id: task.id, projectId: project.id };
}

describe('writebackPlan', () => {
  const f = { ...DEFAULT_FEISHU_SOURCE, filterValues: '待修改，驳回修改', writeBack: true };
  const expectCurrent = ['待修改', '驳回修改', '已完成待测试', '测试通过'];
  it('已完成待测试、测试通过各写各的取值；回写字段留空时用过滤字段，并要求飞书上是导入取值或看板写过的取值', () => {
    expect(writebackPlan(f, { status: 'review' })).toEqual({ field: '状态', value: '已完成待测试', expectCurrent });
    expect(writebackPlan(f, { status: 'done' })).toEqual({ field: '状态', value: '测试通过', expectCurrent });
  });
  it('进行中、测试中、异常不回写；刚导入的待确认、待修改任务不回写', () => {
    for (const status of ['in_progress', 'testing', 'blocked', 'pending_confirm', 'todo'] as const) {
      expect(writebackPlan(f, { status })).toBeNull();
    }
  });
  it('回写过的任务退回待修改或待确认：改回待修改取值；上一次写的就是待修改时不再写', () => {
    const wrote = (value: string) => ({ state: 'done' as const, at: 1, field: '状态', value, message: '' });
    expect(writebackPlan(f, { status: 'todo', writeback: wrote('已完成待测试') })).toEqual({ field: '状态', value: '待修改', expectCurrent });
    expect(writebackPlan(f, { status: 'pending_confirm', writeback: wrote('测试通过') })?.value).toBe('待修改');
    expect(writebackPlan(f, { status: 'todo', writeback: wrote('待修改') })).toBeNull();
    expect(writebackPlan(f, { status: 'todo', writeback: { ...wrote('已完成待测试'), state: 'failed' } })).toBeNull();
  });
  it('回写到别的字段时不检查当前值；未开启或该阶段没填取值时不回写', () => {
    expect(writebackPlan({ ...f, writeBackField: '备注' }, { status: 'review' })).toEqual({ field: '备注', value: '已完成待测试', expectCurrent: [] });
    expect(writebackPlan({ ...f, writeBack: false }, { status: 'review' })).toBeNull();
    expect(writebackPlan({ ...f, writeBackReviewValue: ' ' }, { status: 'review' })).toBeNull();
    expect(writebackPlan({ ...f, writeBackReviewValue: ' ' }, { status: 'done' })?.value).toBe('测试通过');
  });
});

describe('parseSourceKey', () => {
  it('解析 app/table/record，格式不对返回 null', () => {
    expect(parseSourceKey('app1/tbl1/rec1')).toEqual({ appToken: 'app1', tableId: 'tbl1', recordId: 'rec1' });
    expect(parseSourceKey('app1/tbl1')).toBeNull();
    expect(parseSourceKey('../x/y')).toBeNull();
    expect(parseSourceKey(undefined)).toBeNull();
  });
});

describe('writeBackTask', () => {
  it('进入已完成待测试：把状态改为对应取值，只写这一个字段，并记下写之前的值', async () => {
    const { store, id } = setup();
    const wb = await writeBackTask(store, id);
    expect(wb).toMatchObject({ state: 'done', field: '状态', value: '已完成待测试', previous: '待修改' });
    expect(feishu.puts).toHaveLength(1);
    expect(feishu.puts[0].url).toBe('/bitable/v1/apps/app1/tables/tbl1/records/rec1');
    expect(feishu.puts[0].body).toEqual({ fields: { 状态: '已完成待测试' } });
    expect(store.get(id)!.writeback?.state).toBe('done');
    expect(store.get(id)!.logs.at(-1)).toContain('飞书回写完成');
  });

  it('逐阶段跟随：已完成待测试 → 测试通过 → 重新放回待修改，飞书依次改成对应取值', async () => {
    const { store, id } = setup();
    await writeBackTask(store, id);
    store.setStatus(id, 'done');
    expect(await writeBackTask(store, id)).toMatchObject({ state: 'done', value: '测试通过', previous: '已完成待测试' });
    store.setStatus(id, 'todo');
    expect(await writeBackTask(store, id)).toMatchObject({ state: 'done', value: '待修改', previous: '测试通过' });
    expect(feishu.puts.map((p) => p.body.fields['状态'])).toEqual(['已完成待测试', '测试通过', '待修改']);
    // 再次执行（进行中）不写；飞书保持待修改
    store.setStatus(id, 'in_progress');
    expect(await writeBackTask(store, id)).toBeNull();
    expect(feishu.status).toBe('待修改');
  });

  it('状态变化由 store 的 status 事件带出：连续流转时按顺序写，最后停在最新阶段的取值', async () => {
    const { store, id } = setup({ status: 'todo' });
    const pending: Promise<unknown>[] = [];
    store.on('status', (taskId: string) => pending.push(writeBackTask(store, taskId)));
    store.setStatus(id, 'in_progress');
    store.setStatus(id, 'review');
    store.setStatus(id, 'done');
    store.setStatus(id, 'done'); // 状态没变，不再触发
    expect(pending).toHaveLength(3);
    await Promise.all(pending);
    expect(feishu.puts.map((p) => p.body.fields['状态'])).toEqual(['已完成待测试', '测试通过']);
    expect(store.get(id)!.writeback).toMatchObject({ state: 'done', value: '测试通过' });
  });

  it('重复执行不会再写一次', async () => {
    const { store, id } = setup();
    await writeBackTask(store, id);
    const again = await writeBackTask(store, id);
    expect(again).toMatchObject({ state: 'done', previous: '已完成待测试' });
    expect(feishu.puts).toHaveLength(1);
  });

  it('飞书上已被别人改成看板不认识的状态：不覆盖', async () => {
    const { store, id } = setup();
    feishu.status = '已关闭';
    const wb = await writeBackTask(store, id);
    expect(wb).toMatchObject({ state: 'skipped', previous: '已关闭' });
    expect(wb!.message).toContain('未覆盖');
    expect(feishu.puts).toHaveLength(0);
  });

  it('目标取值不是该字段已有的选项：报失败，不写入（不在表里新建选项）', async () => {
    const { store, id } = setup({ feishu: { writeBackReviewValue: '已修复' } });
    const wb = await writeBackTask(store, id);
    expect(wb!.state).toBe('failed');
    expect(wb!.message).toContain('没有选项「已修复」');
    expect(feishu.puts).toHaveLength(0);
  });

  it('不支持的字段类型、不存在的字段：报失败', async () => {
    const a = setup({ feishu: { writeBackField: '截图' } });
    expect((await writeBackTask(a.store, a.id))!.message).toContain('不是文本或单选字段');
    const b = setup({ feishu: { writeBackField: '进度' } });
    expect((await writeBackTask(b.store, b.id))!.message).toContain('没有名为「进度」的字段');
  });

  it('接口报错：记为失败并保留原因，任务状态不变，之后可以重试成功', async () => {
    const { store, id } = setup();
    feishu.failPut = true;
    const wb = await writeBackTask(store, id);
    expect(wb!.state).toBe('failed');
    expect(wb!.message).toContain('1254302');
    expect(store.get(id)!.status).toBe('review');

    feishu.failPut = false;
    expect((await writeBackTask(store, id))!.state).toBe('done');
    expect(feishu.status).toBe('已完成待测试');
  });

  it('不该回写的情况：未开启、手动任务、没有对应取值的阶段，都返回 null，不留记录', async () => {
    const off = setup({ feishu: { writeBack: false } });
    expect(await writeBackTask(off.store, off.id)).toBeNull();
    const manual = setup({ source: 'manual' });
    expect(await writeBackTask(manual.store, manual.id)).toBeNull();
    const blocked = setup({ status: 'blocked' });
    expect(await writeBackTask(blocked.store, blocked.id)).toBeNull();
    expect(blocked.store.get(blocked.id)!.writeback).toBeUndefined();
    expect(feishu.puts).toHaveLength(0);
  });
});

describe('pullFeishuStatus', () => {
  const rec = (status: string) => [{ recordId: 'rec1', fields: { 状态: status } }];

  it('飞书上已是测试通过：任务移到测试通过', () => {
    const { store, id, projectId } = setup({ status: 'review' });
    expect(pullFeishuStatus(store, store.getProject(projectId)!, rec('测试通过'))).toBe(1);
    expect(store.get(id)!.status).toBe('done');
    // 再同步一次不重复移动
    expect(pullFeishuStatus(store, store.getProject(projectId)!, rec('测试通过'))).toBe(0);
  });

  it('看板回写过之后飞书被改回待修改：任务退回待确认，清掉确认与回写记录', async () => {
    const { store, id, projectId } = setup({ status: 'review' });
    await writeBackTask(store, id);
    expect(pullFeishuStatus(store, store.getProject(projectId)!, rec('待修改'))).toBe(1);
    const t = store.get(id)!;
    expect(t.status).toBe('pending_confirm');
    expect(t.writeback).toBeUndefined();
    expect(t.confirmed).toBeUndefined();
  });

  it('不动的情况：没回写过的任务飞书仍是待修改、正在执行的任务、飞书是别的状态、表里已没有这条记录', () => {
    const fresh = setup({ status: 'review' });
    expect(pullFeishuStatus(fresh.store, fresh.store.getProject(fresh.projectId)!, rec('待修改'))).toBe(0);
    expect(fresh.store.get(fresh.id)!.status).toBe('review');

    const running = setup({ status: 'in_progress' });
    expect(pullFeishuStatus(running.store, running.store.getProject(running.projectId)!, rec('测试通过'))).toBe(0);
    expect(running.store.get(running.id)!.status).toBe('in_progress');

    const other = setup({ status: 'review' });
    expect(pullFeishuStatus(other.store, other.store.getProject(other.projectId)!, rec('已关闭'))).toBe(0);
    expect(pullFeishuStatus(other.store, other.store.getProject(other.projectId)!, [])).toBe(0);
    expect(other.store.get(other.id)!.status).toBe('review');
  });
});
