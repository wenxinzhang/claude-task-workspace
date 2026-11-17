import { useEffect, useState } from 'react';
import { api, type Settings } from './api.ts';
import { SaveStatus, useAutoSave } from './useAutoSave.tsx';

type Msg = { text: string; error?: boolean } | null;

/** 与服务端校验一致：字母数字与 . _ - [ ]，不以 - 开头 */
const MODEL_NAME = /^[A-Za-z0-9._[\]][A-Za-z0-9._\-[\]]*$/;

// 可用模型清单全页共用一份：几个下拉框和「可用模型」设置区读的是同一个值，保存后一起更新
let cache: string[] | null = null;
let failed = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
const publish = (models: string[]) => {
  cache = models;
  failed = false;
  notify();
};
/**
 * 取清单。取失败时不把「空清单」当结果记下来：那样整页下拉会只剩「使用默认」，
 * 而且在「可用模型」里一保存，就会用这个假的空清单把服务端真实的清单整组覆盖掉
 */
const load = () => {
  if (loading) return;
  failed = false;
  loading = api<Settings>('/api/settings')
    .then((s) => {
      if (!Array.isArray(s.models)) throw new Error('服务端没有返回模型清单');
      cache = s.models;
    })
    .catch(() => {
      failed = true;
    })
    .finally(() => {
      loading = null;
      notify();
    });
};

/** 可用模型清单：还没取到时 models 是 null；failed 表示取失败了（不是清单为空） */
function useModels(): { models: string[] | null; failed: boolean; retry: () => void } {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    listeners.add(fn);
    if (!cache) load();
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return { models: cache, failed, retry: load };
}

/**
 * 模型下拉框：候选来自「项目管理 → 全局设置 → 可用模型」。
 * 第一项是「不指定」；已经保存过、但不在清单里的名称仍然列出来并标明，不会因为换成下拉而被悄悄清掉。
 */
export function ModelSelect({ value, onChange, emptyLabel, ariaLabel }: { value: string; onChange: (v: string) => void; emptyLabel: string; ariaLabel?: string }) {
  const { models, failed } = useModels();
  // 当前值不在候选里时也要有它自己的一项：否则清单还没取到（或取失败）时，下拉会显示成第一项「使用默认」，与实际保存的值不符
  const extra = !!value && !models?.includes(value);
  return (
    <>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel} disabled={!models}>
        <option value="">{emptyLabel}</option>
        {extra && (
          <option value={value}>
            {value}
            {models ? '（不在可用模型清单里）' : ''}
          </option>
        )}
        {(models ?? []).map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      {failed && <small className="error">可用模型清单没取到，暂时不能改选；当前的值不受影响。刷新页面重试。</small>}
      {models?.length === 0 && <small className="muted">还没有可选的模型。到「项目管理 → 全局设置 → 可用模型」里添加后，这里就能选。</small>}
    </>
  );
}

/** 全局设置里的「可用模型」分区：维护各处模型下拉框的候选清单 */
export function ModelsSettings() {
  const { models: saved, failed, retry } = useModels();
  const [list, setList] = useState<string[] | null>(null);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  // 取到服务端清单后才开始编辑；之后以本地为准，增删后立即自动保存
  useEffect(() => {
    if (saved && list === null) setList(saved);
  }, [saved, list]);
  const state = useAutoSave(
    list,
    async (l) => {
      const s = await api<Settings>('/api/settings', 'PUT', { models: l });
      // 服务端还是不认识模型清单的旧版本时，返回里没有这个字段：不能当成保存成功
      if (!Array.isArray(s.models)) throw new Error('服务端没有保存模型清单，请重启看板服务后再试');
      publish(s.models);
    },
    0,
  );

  const add = () => {
    const v = name.trim();
    if (!v || !list) return;
    if (!MODEL_NAME.test(v)) return setMsg({ text: '模型名称只能包含字母、数字和 . _ - [ ]，且不能以 - 开头', error: true });
    if (list.includes(v)) return setMsg({ text: `清单里已经有 ${v}`, error: true });
    setList([...list, v]);
    setName('');
    setMsg(null);
  };

  return (
    <section className="settings">
      <h2 className="bar-title">可用模型</h2>
      <p className="muted">
        各项目「执行设置」和「观察者」里的模型下拉框从这份清单里选。名称要和你的代理命令（claude / codex）认识的模型名完全一致，会原样作为模型参数传过去；这里不检查名称在你的模型服务上是否存在。
      </p>
      {!list && failed ? (
        // 没取到清单时不让编辑：在一份假的空清单上添加并保存，会把真实的清单覆盖掉
        <p className="error">
          可用模型清单没取到。
          <button type="button" className="link" onClick={retry}>
            重试
          </button>
        </p>
      ) : !list ? (
        <p className="muted">加载中…</p>
      ) : (
        <>
          <div className="skill-chips" aria-label="可用模型清单">
            {list.map((m) => (
              <span key={m} className="chip">
                {m}
                <button type="button" aria-label={`移除 ${m}`} onClick={() => {
                    setList(list.filter((x) => x !== m));
                    setMsg(null);
                  }}>
                  ×
                </button>
              </span>
            ))}
            {list.length === 0 && <small className="muted">清单是空的：各处模型下拉框只有「使用默认」一项。</small>}
          </div>
          <div className="field-row">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              // 回车是「添加」，不是提交整张表单
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                add();
              }}
              placeholder="输入模型名称，例如 sonnet"
              aria-label="要添加的模型名称"
            />
            <button type="button" className="btn btn-outline-primary" onClick={add} disabled={!name.trim()}>
              添加
            </button>
          </div>
          <div className="actions">
            {msg ? <span className="error">{msg.text}</span> : <SaveStatus state={state} />}
          </div>
        </>
      )}
    </section>
  );
}
