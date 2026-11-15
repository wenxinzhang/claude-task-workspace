import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { downloadAttachment } from './feishu.ts';
import type { Attachment, Settings, Task } from './types.ts';

/** 已下载到本地、可交给 Claude 读取的附件 */
export interface LocalAttachment {
  name: string;
  field: string;
  path: string;
  isImage: boolean;
}

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
};

const UPLOAD_TYPES = new Set(Object.keys(MIME_EXT));
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 缓存文件名：file_token + 扩展名。Claude 的 Read 工具按扩展名识别图片 */
export function cacheName(att: Pick<Attachment, 'token' | 'name' | 'type' | 'local'>): string {
  if (!/^[A-Za-z0-9_-]+$/.test(att.token)) throw new Error('附件标识不合法');
  const fromName = path.extname(att.name).toLowerCase();
  // 上传文件以 MIME 类型为准，避免文件名伪造扩展名
  const ext = att.local
    ? (MIME_EXT[att.type] ?? '')
    : /^\.[a-z0-9]{1,8}$/.test(fromName)
      ? fromName
      : (MIME_EXT[att.type] ?? '');
  return att.token + ext;
}

/** 飞书附件本地缓存：data/attachments/<token>.<ext>，首次使用时下载 */
export class AttachmentCache {
  private jobs = new Map<string, Promise<string>>();

  constructor(
    readonly dir: string,
    private creds: (projectId?: string) => Settings['feishu'],
  ) {}

  /** 保存用户上传的图片，返回附件信息 */
  saveUpload(data: Buffer, name: string, type: string): Attachment {
    if (!UPLOAD_TYPES.has(type)) throw new Error('只支持 PNG、JPG、GIF、WebP、BMP 图片');
    if (!data.length) throw new Error('文件为空');
    if (data.length > MAX_UPLOAD_BYTES) throw new Error(`图片不能超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    const att: Attachment = {
      token: `local_${randomUUID().replace(/-/g, '')}`,
      name: path.basename(name).slice(0, 200) || 'image',
      type,
      size: data.length,
      field: '截图',
      local: true,
    };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, cacheName(att)), data);
    return att;
  }

  /** 删除上传的文件；飞书附件的缓存保留 */
  removeUpload(att: Attachment) {
    if (att.local) fs.rmSync(path.join(this.dir, cacheName(att)), { force: true });
  }

  async ensure(att: Attachment, projectId?: string): Promise<string> {
    const file = path.join(this.dir, cacheName(att));
    if (fs.existsSync(file)) return file;
    if (att.local) throw new Error('上传的图片文件已丢失');
    // 旧版本缓存没有扩展名，直接改名沿用
    const legacy = path.join(this.dir, att.token);
    if (legacy !== file && fs.existsSync(legacy)) {
      fs.renameSync(legacy, file);
      return file;
    }
    let job = this.jobs.get(att.token);
    if (!job) {
      job = downloadAttachment(this.creds(projectId), att)
        .then(({ data }) => {
          fs.mkdirSync(this.dir, { recursive: true });
          fs.writeFileSync(file, data);
          return file;
        })
        .finally(() => this.jobs.delete(att.token));
      this.jobs.set(att.token, job);
    }
    return job;
  }

  /** 下载任务的全部附件；失败的记日志后跳过，不影响任务执行 */
  async prepare(task: Task, log: (line: string) => void): Promise<LocalAttachment[]> {
    const out: LocalAttachment[] = [];
    for (const att of task.attachments ?? []) {
      try {
        out.push({
          name: att.name,
          field: att.field,
          path: await this.ensure(att, task.projectId),
          isImage: att.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(att.name),
        });
      } catch (e) {
        log(`附件「${att.name}」下载失败，Claude 将看不到它：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (out.length) log(`已准备 ${out.length} 个附件供 Claude 查看`);
    return out;
  }
}
