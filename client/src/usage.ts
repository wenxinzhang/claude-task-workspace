// 使用事件上报：只发事件种类、控件标识与时长，不发任务标题、代码、凭据、飞书内容。
// 服务端有白名单形状校验；设置里关闭采集后前端停发、服务端拒收，双保险。
import { api } from './api.ts';
import type { UsageKind } from '../../server/usage-event.ts';

let enabled = true;

/** 设置页改动开关后同步这里；首次加载时从服务端设置取 */
export function setUsageCollect(on: boolean): void {
  enabled = on;
}

export function initUsageCollect(): void {
  api<{ observer?: { usageCollect?: boolean } }>('/api/settings').then(
    (s) => {
      enabled = s.observer?.usageCollect !== false;
    },
    () => undefined,
  );
}

/** 上报一条事件：失败静默（统计不应影响正事），metric 是停留毫秒数等数值 */
export function track(kind: UsageKind, target: string, metric?: number): void {
  if (!enabled) return;
  void api('/api/usage/events', 'POST', metric === undefined ? { kind, target } : { kind, target, metric }).catch(() => undefined);
}

/** 全局点击委托：只收显式标了 data-usage 的控件，target 取属性值（短标识）。返回卸载函数 */
export function installUsageClicks(): () => void {
  const onClick = (e: MouseEvent) => {
    const el = (e.target as Element | null)?.closest?.('[data-usage]');
    const target = el?.getAttribute('data-usage');
    if (!el || !target) return;
    track((el.getAttribute('data-usage-kind') as UsageKind) || 'click', target);
  };
  document.addEventListener('click', onClick);
  return () => document.removeEventListener('click', onClick);
}
