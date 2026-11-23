import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { AgentRequest, AgentResult } from './agent.ts';
import { AttachmentCache } from './attachments.ts';
import { ObservationStore } from './observe.ts';
import { DEFAULT_OBSERVER_SETTINGS } from './observe-types.ts';
import { createObserver } from './observer.ts';
import { Queue } from './queue.ts';
import { Store } from './store.ts';
import { normalizeScreenshotFinding, registerScreenshotRoutes, screenshotPrompt, ScreenshotDiagnoser } from './screenshot-diagnose.ts';
import type { RunEvidence } from './types.ts';

const cleanups: (() => void)[] = [];
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 400));
  for (const fn of cleanups.splice(0)) fn();
});

describe('normalizeScreenshotFinding 形状校验', () => {
  const raw = { title: '按钮没反应', detail: '点击后无反馈', suggestion: '加加载态', attribution: 'tool' };
  it('合法输出归一；attribution 只认三个枚举，unknown 与非法值置空', () => {
    expect(normalizeScreenshotFinding({ ...raw })).toEqual({ title: '按钮没反应', detail: '点击后无反馈', suggestion: '加加载态', attribution: 'tool' });
    expect(normalizeScreenshotFinding({ ...raw, attribution: 'unknown' })!.attribution).toBeUndefined();
    expect(normalizeScreenshotFinding({ ...raw, attribution: '外星' })!.attribution).toBeUndefined();
    expect(normalizeScreenshotFinding({ ...raw, attribution: undefined })!.attribution).toBeUndefined();
  });
  it('缺标题/详情/建议、空字符串、非对象都拒收', () => {
    expect(normalizeScreenshotFinding(null)).toBeNull();
    expect(normalizeScreenshotFinding({ ...raw, title: '' })).toBeNull();
    expect(normalizeScreenshotFinding({ ...raw, detail: '  ' })).toBeNull();
    expect(normalizeScreenshotFinding({ ...raw, suggestion: undefined })).toBeNull();
    expect(normalizeScreenshotFinding({ title: 'x', detail: 'y' })).toBeNull();
  });
  it('超长文本截断到上限，不整条丢弃', () => {
    const long = 'a'.repeat(20_000);
    const f = normalizeScreenshotFinding({ ...raw, detail: long })!;
    expect(f.detail.length).toBeLessThanOrEqual(10_000);
    expect(f.title.length).toBeLessThanOrEqual(200);
  });
});

describe('screenshotPrompt 诊断提示词', () => {
  it('含图片路径、页面、用户说明与使用概况；明示只诊断不改代码', () => {
    const p = screenshotPrompt({ imagePath: 'C:/data/attachments/local_x.png', note: '点了没反应', page: 'board', usageSummary: '近1天 12 条事件' });
    expect(p).toContain('C:/data/attachments/local_x.png');
    expect(p).toContain('点了没反应');
    expect(p).toContain('board');
    expect(p).toContain('近1天 12 条事件');
    expect(p).toContain('只诊断');
    expect(p).toMatch(/不要修改任何文件|不得修改/);
  });
  it('没有用户说明时不留空占位', () => {
    const p = screenshotPrompt({ imagePath: '/x.png', note: '', page: '', usageSummary: '' });
    expect(p).toContain('/x.png');
    expect(p).not.toContain('用户说明：\n');
  });
});

describe('ScreenshotDiagnoser 编排', () => {
  const ev: RunEvidence = { stage: 'analysis', provider: 'claude', toolCalls: 1, tools: {}, denials: [], durationMs: 10, at: Date.now() };
  function setup(opts: { enabled?: boolean; ok?: boolean; structured?: unknown } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-shot-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const observations = new ObservationStore(path.join(root, 'data'));
    let captured: AgentRequest | undefined;
    const run = async (req: AgentRequest): Promise<AgentResult> => {
      captured = req;
      return { ok: opts.ok !== false, text: opts.ok === false ? '网关 503' : '', structured: opts.structured ?? { title: '按钮没反应', detail: '点击后无反馈', suggestion: '加加载态', attribution: 'tool' }, evidence: ev };
    };
    const diagnoser = new ScreenshotDiagnoser({
      observations,
      getSettings: () => ({ observer: { ...DEFAULT_OBSERVER_SETTINGS, enabled: opts.enabled !== false } }),
      toolRoot: root,
      attachmentDir: path.join(root, 'data', 'attachments'),
      run,
    });
    return { root, observations, diagnoser, get captured() { return captured; } };
  }
  const input = { imagePath: '/x/local_x.png', token: 'local_x', note: '点了没反应', page: 'board', usageSummary: '' };

  it('成功：screenshot_finding 入台账，带建议与归因，只读会话且图片在 images 里', async () => {
    const ctx = setup();
    const r = await ctx.diagnoser.diagnose(input);
    expect(r.ok).toBe(true);
    expect(ctx.captured!.access).toBe('read');
    expect(ctx.captured!.images).toEqual(['/x/local_x.png']);
    expect(ctx.captured!.cwd).not.toBe(ctx.root);
    const list = ctx.observations.list({ kind: 'screenshot_finding' });
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe('llm');
    expect(list[0].suggestion).toBe('加加载态');
    expect(list[0].attribution).toBe('tool');
    expect(list[0].detail).toContain('点了没反应');
    expect(list[0].context.screenshotToken).toBe('local_x');
  });

  it('会话失败：记 note 级失败原因，不产出 warn 发现', async () => {
    const ctx = setup({ ok: false });
    const r = await ctx.diagnoser.diagnose(input);
    expect(r.ok).toBe(false);
    const list = ctx.observations.list({ kind: 'screenshot_finding' });
    expect(list).toHaveLength(1);
    expect(list[0].severity).toBe('note');
    expect(list[0].detail).toContain('网关 503');
  });

  it('输出形状非法：按失败记录，不入 warn 发现', async () => {
    const ctx = setup({ structured: { title: '' } });
    const r = await ctx.diagnoser.diagnose(input);
    expect(r.ok).toBe(false);
    expect(ctx.observations.list({ kind: 'screenshot_finding' })[0].severity).toBe('note');
  });

  it('观察者未开启拒绝；单飞：进行中再来一次被拒', async () => {
    const off = setup({ enabled: false });
    expect((await off.diagnoser.diagnose(input)).ok).toBe(false);
    expect(off.observations.list()).toHaveLength(0);
    const ctx = setup();
    const first = ctx.diagnoser.diagnose(input);
    expect(ctx.diagnoser.isBusy()).toBe(true);
    const second = await ctx.diagnoser.diagnose(input);
    expect(second.ok).toBe(false);
    await first;
    expect(ctx.diagnoser.isBusy()).toBe(false);
  });
});

describe('截图诊断路由', () => {
  const ev: RunEvidence = { stage: 'analysis', provider: 'claude', toolCalls: 1, tools: {}, denials: [], durationMs: 10, at: Date.now() };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  function routeSetup(opts: { enabled?: boolean; delayMs?: number } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-shot-route-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new Store(path.join(root, 'data'));
    const queue = new Queue(store, undefined, async () => {
      throw new Error('本测试不执行任务');
    });
    const settings = () => ({ observer: { ...DEFAULT_OBSERVER_SETTINGS, enabled: opts.enabled !== false } });
    const observer = createObserver({ root, store, queue, deployer: { allStatus: () => ({}) }, getSettings: settings, spawnApply: () => {} });
    const attachments = new AttachmentCache(path.join(root, 'data', 'attachments'), () => ({ appId: '', appSecret: '' }));
    const diagnoser = new ScreenshotDiagnoser({
      observations: observer.observations,
      getSettings: settings,
      toolRoot: root,
      attachmentDir: attachments.dir,
      run: async () => {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        return { ok: true, text: '', structured: { title: '按钮没反应', detail: 'd', suggestion: 's', attribution: 'tool' }, evidence: ev };
      },
    });
    const app = express();
    registerScreenshotRoutes(app, observer, { attachments, diagnoser });
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    cleanups.push(() => {
      server.close();
      observer.dispose();
    });
    return { root, observer, attachments, base: `http://127.0.0.1:${port}` };
  }

  const upload = (base: string, query = '') =>
    fetch(`${base}/api/observations/screenshot-diagnose${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-File-Name': 'shot.png' },
      body: png,
    });

  it('上传即返回 started 与 token；诊断完成后发现入台账；截图可读取可删除', async () => {
    const ctx = routeSetup();
    const r = await upload(ctx.base, '?page=board&note=' + encodeURIComponent('点了没反应'));
    expect(r.status).toBe(200);
    const { started, token } = await r.json();
    expect(started).toBe(true);
    expect(token).toMatch(/^local_[a-f0-9]{32}$/);
    // 诊断是后台跑的：等它完成
    await new Promise((res) => setTimeout(res, 100));
    const list = ctx.observer.observations.list({ kind: 'screenshot_finding' });
    expect(list).toHaveLength(1);
    expect(list[0].severity).toBe('warn');
    expect(list[0].context.screenshotToken).toBe(token);
    const img = await fetch(`${ctx.base}/api/observations/screenshot/${token}`);
    expect(img.status).toBe(200);
    expect(Buffer.from(await img.arrayBuffer())).toEqual(png);
    expect((await fetch(`${ctx.base}/api/observations/screenshot/${token}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${ctx.base}/api/observations/screenshot/${token}`)).status).toBe(400);
  });

  it('非法 token、非图片体、观察者未开启都拒绝', async () => {
    const ctx = routeSetup();
    // 路径穿越被 URL 规范化挡在路由外（404）或形状校验拒绝（400），都不能拿到文件
    expect([400, 404]).toContain((await fetch(`${ctx.base}/api/observations/screenshot/../etc`)).status);
    expect((await fetch(`${ctx.base}/api/observations/screenshot/local_zz`)).status).toBe(400);
    const noImage = await fetch(`${ctx.base}/api/observations/screenshot-diagnose`, { method: 'POST', headers: { 'Content-Type': 'image/png' } });
    expect(noImage.status).toBe(400);
    const off = routeSetup({ enabled: false });
    expect((await upload(off.base)).status).toBe(400);
  });

  it('单飞：诊断进行中再上传被拒', async () => {
    // 窗口留 1 秒：慢机器上 HTTP 往返也不至于越过诊断期造成假失败
    const ctx = routeSetup({ delayMs: 1000 });
    expect((await upload(ctx.base)).status).toBe(200);
    expect((await upload(ctx.base)).status).toBe(400);
    await new Promise((res) => setTimeout(res, 1100));
    expect((await upload(ctx.base)).status).toBe(200);
  });
});
