import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_OBSERVER_SETTINGS } from './observe-types.ts';
import { Store } from './store.ts';
import { DEFAULT_SETTINGS } from './types.ts';
import { validateSettingsPatch } from './validate.ts';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'abu-settings-'));

describe('观察者设置接入', () => {
  it('DEFAULT_SETTINGS.observer 与 DEFAULT_OBSERVER_SETTINGS 深度相等', () => {
    expect(DEFAULT_SETTINGS.observer).toEqual(DEFAULT_OBSERVER_SETTINGS);
  });

  it('旧 settings.json 无 observer：启动归一为默认', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ feishu: { appId: 'a', appSecret: 'b' }, vault: { path: '', enabled: false } }), 'utf8');
      const store = new Store(dir);
      expect(store.getSettings().observer).toEqual(DEFAULT_OBSERVER_SETTINGS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('updateSettings 合并 observer：exec 深合并，feishu 不受影响，落盘往返', () => {
    const dir = tmpDir();
    try {
      const store = new Store(dir);
      store.updateSettings({ feishu: { appId: 'x' } });
      const s = store.updateSettings({ observer: { enabled: true, exec: { model: 'sonnet' } } });
      expect(s.observer.enabled).toBe(true);
      expect(s.observer.exec.model).toBe('sonnet');
      expect(s.observer.exec.provider).toBe(DEFAULT_OBSERVER_SETTINGS.exec.provider);
      expect(s.feishu.appId).toBe('x');
      expect(new Store(dir).getSettings().observer.enabled).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validateSettingsPatch：observer 布尔/阈值/冷却/exec 校验，非法值拒绝', () => {
    const p = validateSettingsPatch({ observer: { enabled: true, autoOptimize: false, minNewObservations: 5, cooldownHours: 12, exec: { provider: 'claude', budgetUsd: 3 } } });
    expect(p.observer?.enabled).toBe(true);
    expect(p.observer?.minNewObservations).toBe(5);
    expect(p.observer?.exec?.budgetUsd).toBe(3);
    expect(() => validateSettingsPatch({ observer: { minNewObservations: 0 } })).toThrow();
    expect(() => validateSettingsPatch({ observer: { minNewObservations: 2.5 } })).toThrow();
    expect(() => validateSettingsPatch({ observer: { cooldownHours: 999 } })).toThrow();
    expect(() => validateSettingsPatch({ observer: { exec: { provider: '外星' } } })).toThrow();
    expect(validateSettingsPatch({ feishu: { appId: 'a' } }).observer).toBeUndefined();
  });
});
