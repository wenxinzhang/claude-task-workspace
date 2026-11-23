// 使用洞察：近 7 天的点击热区、连点摩擦、操作错误与抽屉停留；全部来自本地使用事件，零 token。
import { useEffect, useState } from 'react';
import { api, fmtDuration } from './api.ts';
import type { UsageMetrics } from '../../server/usage-metrics.ts';

type Msg = { text: string; error?: boolean } | null;

export function UsageInsights() {
  const [m, setM] = useState<UsageMetrics | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<UsageMetrics>('/api/usage/metrics?days=7').then(
    (d) => {
      setM(d);
      return true;
    },
    (e) => {
      setMsg({ text: (e as Error).message, error: true });
      return false;
    },
  );
  useEffect(() => {
    void load();
  }, []);
  const collect = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ added: number }>('/api/usage/collect', 'POST');
      // 采集成功与刷新失败都是事实，合并成一条消息，不互相覆盖
      const refreshed = await load();
      const text = r.added > 0 ? `已把 ${r.added} 条摩擦写进问题台账` : '没有达到阈值的摩擦，或已在台账里';
      setMsg(refreshed ? { text } : { text: `${text}（统计刷新失败，下方为旧数据）`, error: true });
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  if (!m) return <p className={msg?.error ? 'error' : 'muted'}>{msg?.text ?? '加载中…'}</p>;
  return (
    <div className="usage-insights">
      <div className="usage-insights-head">
        <p className="muted grow">
          近 {m.windowDays} 天共 {m.eventCount} 条使用事件。反复快速点击通常意味着点了没反应；摩擦达到阈值才会进台账。
        </p>
        <button className="btn btn-outline" data-usage="btn-usage-collect" disabled={busy} onClick={() => void collect()}>
          {busy ? '采集中…' : '立即采集摩擦点'}
        </button>
      </div>
      {msg && <p className={msg.error ? 'error' : 'muted'} role="status">{msg.text}</p>}
      {m.eventCount === 0 ? (
        <p className="muted">还没有使用事件。正常使用界面后这里会出现统计；也可以在设置里关闭采集。</p>
      ) : (
        <>
          {m.repeatedClicks.length > 0 && (
            <section className="usage-block">
              <h3>反复点击（可能点了没反应）</h3>
              <ul>
                {m.repeatedClicks.map((r) => (
                  <li key={r.target}><code>{r.target}</code> 连点 {r.repeats} 组</li>
                ))}
              </ul>
            </section>
          )}
          {m.errorTargets.length > 0 && (
            <section className="usage-block">
              <h3>操作出错</h3>
              <ul>
                {m.errorTargets.map((r) => (
                  <li key={r.target}><code>{r.target}</code> 出错 {r.n} 次</li>
                ))}
              </ul>
            </section>
          )}
          <section className="usage-block">
            <h3>点击最多的控件</h3>
            <table className="table compact">
              <thead><tr><th>控件</th><th>次数</th></tr></thead>
              <tbody>
                {m.topClicks.map((r) => (
                  <tr key={r.target}><td><code>{r.target}</code></td><td>{r.n}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
          {(m.drawerDwell?.length ?? 0) > 0 && (
            <section className="usage-block">
              <h3>抽屉停留（中位数）</h3>
              <table className="table compact">
                <thead><tr><th>抽屉</th><th>次数</th><th>停留</th></tr></thead>
                <tbody>
                  {m.drawerDwell!.map((r) => (
                    <tr key={r.target}><td><code>{r.target}</code></td><td>{r.n}</td><td>{r.medianMs === null ? '—' : fmtDuration(r.medianMs)}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}
