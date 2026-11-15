import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { credsLabel, normalizeProject, Store } from './store.ts';
import { validateProjectPatch } from './validate.ts';

const cleanups: (() => void)[] = [];
afterEach(async () => {
  // 等 Store 的延迟落盘结束再删目录
  await new Promise((r) => setTimeout(r, 400));
  for (const fn of cleanups.splice(0)) fn();
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-creds-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.updateSettings({ feishu: { appId: 'cli_global', appSecret: 'global-secret' } });
  return { store, dir };
}

describe('每个项目可单独配置飞书应用', () => {
  it('项目没有单独配置时用全局「飞书连接」', () => {
    const { store, dir } = setup();
    const p = store.createProject({ name: 'p', workdir: dir });
    expect(store.feishuCreds(p.id)).toEqual({ appId: 'cli_global', appSecret: 'global-secret', scope: 'global' });
    expect(store.feishuCreds()).toMatchObject({ appId: 'cli_global', scope: 'global' });
    expect(store.feishuCreds('no-such-project')).toMatchObject({ scope: 'global' });
  });

  it('项目单独配置后只影响这个项目', () => {
    const { store, dir } = setup();
    const a = store.createProject({ name: 'a', workdir: dir, feishu: { appId: 'cli_mine', appSecret: 'my-secret' } });
    const b = store.createProject({ name: 'b', workdir: dir });
    expect(store.feishuCreds(a.id)).toEqual({ appId: 'cli_mine', appSecret: 'my-secret', scope: 'project' });
    expect(store.feishuCreds(b.id)).toMatchObject({ appId: 'cli_global', scope: 'global' });
  });

  it('只填了一半时报错，不悄悄退回全局应用', () => {
    const { store, dir } = setup();
    const p = store.createProject({ name: 'p', workdir: dir, feishu: { appId: 'cli_mine' } });
    expect(() => store.feishuCreds(p.id)).toThrow('同时填写 App ID 和 App Secret');
    store.updateProject(p.id, { feishu: { appId: '', appSecret: 'only-secret' } });
    expect(() => store.feishuCreds(p.id)).toThrow('同时填写');
  });

  it('清空两项后回到全局应用；更新其他设置不会丢掉已保存的密钥', () => {
    const { store, dir } = setup();
    const p = store.createProject({ name: 'p', workdir: dir, feishu: { appId: 'cli_mine', appSecret: 'my-secret' } });
    store.updateProject(p.id, { feishu: { filterValues: '待修改' } });
    expect(store.feishuCreds(p.id)).toMatchObject({ appId: 'cli_mine', appSecret: 'my-secret' });
    store.updateProject(p.id, { feishu: { appId: '', appSecret: '' } });
    expect(store.feishuCreds(p.id)).toMatchObject({ appId: 'cli_global', scope: 'global' });
  });

  it('重新加载后配置仍在；旧项目数据没有这两项时默认为空', () => {
    const { store, dir } = setup();
    const p = store.createProject({ name: 'p', workdir: dir, feishu: { appId: 'cli_mine', appSecret: 'my-secret' } });
    expect(new Store(dir).feishuCreds(p.id)).toMatchObject({ appId: 'cli_mine', scope: 'project' });
    const old = normalizeProject({ id: 'x', name: 'n', workdir: dir, feishu: { url: 'u' }, createdAt: 1 } as any);
    expect(old.feishu).toMatchObject({ appId: '', appSecret: '' });
  });

  it('报错里说明用的是哪个应用、来自哪里，不带密钥', () => {
    expect(credsLabel({ appId: 'cli_mine', appSecret: 'my-secret', scope: 'project' })).toBe('当前使用的飞书应用：cli_mine（来自本项目的配置）');
    expect(credsLabel({ appId: '', appSecret: '', scope: 'global' })).toBe('当前使用的飞书应用：未填写（来自全局「飞书连接」）');
  });

  it('项目设置接受并裁剪这两项', () => {
    expect(validateProjectPatch({ feishu: { appId: ' cli_mine ', appSecret: ' s ' } }).feishu).toEqual({ appId: 'cli_mine', appSecret: 's' });
    expect(() => validateProjectPatch({ feishu: { appId: 123 } })).toThrow();
  });
});
