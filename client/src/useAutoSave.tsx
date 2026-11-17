// 全局设置各分区共用的自动保存：内容改了就存，不需要点「保存」
import { useEffect, useRef, useState } from 'react';

export type SaveState = { status: 'idle' | 'saving' | 'saved' | 'error'; error?: string };

/**
 * 监听 value 变化，停顿 delay 毫秒后调用 save。
 * 第一次拿到的 value 视为服务端原值，不触发保存；保存失败时保留错误，下次修改再试。
 * 组件卸载时还有没存的修改，立即补存一次，避免切走页面丢掉最后几个字。
 */
export function useAutoSave<T>(value: T | null, save: (v: T) => Promise<void>, delay = 600): SaveState {
  const [state, setState] = useState<SaveState>({ status: 'idle' });
  const lastSaved = useRef<string | null>(null);
  const pending = useRef<T | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const seq = useRef(0);
  const mounted = useRef(true);

  const run = async (v: T, key: string) => {
    pending.current = null;
    const n = ++seq.current;
    if (mounted.current) setState({ status: 'saving' });
    try {
      await saveRef.current(v);
      // 晚返回的旧请求不能把「最后一次存成功的值」改回旧值
      if (n !== seq.current) return;
      lastSaved.current = key;
      if (mounted.current) setState({ status: 'saved' });
    } catch (e) {
      if (mounted.current && n === seq.current) setState({ status: 'error', error: (e as Error).message });
    }
  };

  useEffect(() => {
    if (value === null) return;
    const key = JSON.stringify(value);
    if (lastSaved.current === null) {
      lastSaved.current = key;
      return;
    }
    if (key === lastSaved.current) {
      // 改回了已保存的值：之前那次失败的提示不再成立
      pending.current = null;
      setState((s) => (s.status === 'error' ? { status: 'idle' } : s));
      return;
    }
    pending.current = value;
    const t = setTimeout(() => void run(value, key), delay);
    return () => clearTimeout(t);
  }, [value, delay]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const v = pending.current;
      if (v !== null) void run(v, JSON.stringify(v));
    };
  }, []);

  return state;
}

/** 分区底部的保存状态提示 */
export function SaveStatus({ state }: { state: SaveState }) {
  if (state.status === 'saving') return <span className="muted">保存中…</span>;
  if (state.status === 'saved') return <span className="muted">已自动保存</span>;
  if (state.status === 'error') return <span className="error">没有保存：{state.error}</span>;
  return <span className="muted">修改后自动保存</span>;
}
