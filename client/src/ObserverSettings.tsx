import { useEffect, useState } from 'react';
import { api, PROVIDER_LABEL, type Settings } from './api.ts';
import { ModelSelect } from './ModelSelect.tsx';

type Msg = { text: string; error?: boolean } | null;

/** 项目管理 → 全局设置里的「观察者」分区：总开关、自动诊断开关、代理配置；触发条件用内置默认值，不暴露为设置项 */
export function ObserverSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => {
    api<Settings>('/api/settings').then(setSettings, (e) => setMsg({ text: (e as Error).message, error: true }));
  }, []);
  const o = settings?.observer;
  const set = (patch: Partial<Settings['observer']>) => settings && setSettings({ ...settings, observer: { ...settings.observer, ...patch } });
  const setExec = (patch: Partial<Settings['observer']['exec']>) =>
    settings && setSettings({ ...settings, observer: { ...settings.observer, exec: { ...settings.observer.exec, ...patch } } });

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!settings) return;
    try {
      setSettings(await api<Settings>('/api/settings', 'PUT', { observer: settings.observer }));
      setMsg({ text: '已保存' });
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  };

  return (
    <form className="settings" onSubmit={save}>
      <h2 className="bar-title">观察者</h2>
      <p className="muted">
        观察自动运行暴露的工具问题（报错、门禁未过、集成失败等），异常轮次起只读会话复盘归因；问题积累到内置条件且队列空闲时自动诊断生成优化提案。
        提案经你确认后才应用：应用前自动备份，类型检查或测试不过自动回滚。诊断与复盘使用下方代理，独立于各项目的执行设置。
      </p>
      {!o ? (
        <p className="muted">加载中…</p>
      ) : (
        <>
          <label className="check">
            <input type="checkbox" checked={o.enabled} onChange={(ev) => set({ enabled: ev.target.checked })} />
            启用观察者（问题采集与异常轮次复盘）
          </label>
          <label className="check">
            <input type="checkbox" checked={o.autoOptimize} onChange={(ev) => set({ autoOptimize: ev.target.checked })} />
            自动诊断（队列空闲且问题达到内置条件时自动生成提案；应用仍需你确认）
          </label>
          <div className="field-row">
            <span className="field-label">代理</span>
            <select value={o.exec.provider} onChange={(e) => setExec({ provider: e.target.value as Settings['observer']['exec']['provider'] })} aria-label="观察者代理">
              {Object.entries(PROVIDER_LABEL).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>
          <label>
            模型
            <ModelSelect value={o.exec.model} onChange={(v) => setExec({ model: v })} emptyLabel="使用默认（不指定）" />
          </label>
          <label>
            单次会话花费上限（美元，0 表示不限）
            <input type="number" min={0} step={0.5} value={o.exec.budgetUsd} onChange={(e) => setExec({ budgetUsd: Number(e.target.value) })} />
            <small className="muted">复盘与诊断会话独立计费，默认 2 美元。仅 Claude Code 支持预算上限。</small>
          </label>
          {o.exec.provider === 'custom' && (
            <label>
              本地代理命令
              <input value={o.exec.customCommand} onChange={(e) => setExec({ customCommand: e.target.value })} placeholder="在代码目录下执行，提示词从 stdin 传入" />
            </label>
          )}
          <div className="actions">
            {msg && <span className={msg.error ? 'error' : 'muted'}>{msg.text}</span>}
            <span className="grow" />
            <button className="btn btn-primary">保存</button>
          </div>
        </>
      )}
    </form>
  );
}
