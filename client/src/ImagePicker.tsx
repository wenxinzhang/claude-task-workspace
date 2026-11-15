import { useRef, useState } from 'react';
import { checkImage } from './api.ts';

export interface Thumb {
  key: string;
  src: string;
  name: string;
}

interface Props {
  items: Thumb[];
  onAdd?: (files: File[]) => void;
  onRemove?: (key: string) => void;
  busy?: boolean;
}

/** 从粘贴 / 拖拽事件中取出图片文件；截图粘贴时没有文件名，补一个 */
export function imagesFrom(data: DataTransfer | null): File[] {
  const files = Array.from(data?.files ?? []).filter((f) => f.type.startsWith('image/'));
  return files.map((f, i) =>
    f.name && f.name !== 'image.png' ? f : new File([f], `截图-${stamp()}${i ? `-${i + 1}` : ''}.${f.type.split('/')[1] || 'png'}`, { type: f.type }),
  );
}

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '');

/** 截图列表：缩略图、点击放大；可编辑时支持选择文件、拖入、删除 */
export function ImagePicker({ items, onAdd, onRemove, busy }: Props) {
  const [preview, setPreview] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const add = (files: File[]) => {
    const bad = files.map(checkImage).find(Boolean);
    setErr(bad ?? '');
    const ok = files.filter((f) => !checkImage(f));
    if (ok.length) onAdd?.(ok);
  };

  return (
    <div className="attachments">
      <span className="label">截图</span>
      <div
        className={`attachment-list${onAdd ? ' droppable' : ''}${over ? ' over' : ''}`}
        onDragOver={onAdd ? (e) => (e.preventDefault(), setOver(true)) : undefined}
        onDragLeave={() => setOver(false)}
        onDrop={
          onAdd
            ? (e) => {
                e.preventDefault();
                setOver(false);
                add(imagesFrom(e.dataTransfer));
              }
            : undefined
        }
      >
        {items.map((it) => (
          <div key={it.key} className="thumb-wrap">
            {failed[it.key] ? (
              // 加载失败时打开原链接可以看到服务端返回的原因
              <a className="thumb broken" href={it.src} target="_blank" rel="noreferrer" title="加载失败，点击查看原因">
                ⚠ {it.name}
              </a>
            ) : (
              <button type="button" className="thumb" title={it.name} onClick={() => setPreview(it.src)}>
                <img src={it.src} alt={it.name} loading="lazy" onError={() => setFailed((f) => ({ ...f, [it.key]: true }))} />
              </button>
            )}
            {onRemove && (
              <button type="button" className="thumb-del" aria-label={`删除 ${it.name}`} onClick={() => onRemove(it.key)}>
                ✕
              </button>
            )}
          </div>
        ))}
        {onAdd && (
          <button type="button" className="thumb add" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? '上传中…' : '＋ 添加截图'}
            <small>可粘贴或拖入</small>
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
          multiple
          hidden
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>
      {err && <small className="error-text">{err}</small>}
      {preview && (
        <div className="lightbox" onClick={() => setPreview(null)}>
          <img src={preview} alt="" />
        </div>
      )}
    </div>
  );
}
