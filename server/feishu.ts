/**
 * 飞书多维表格读取：
 *   wiki 链接  -> wiki/v2/spaces/get_node 换出 bitable app_token
 *   base 链接  -> 直接使用路径中的 app_token
 * 然后按 table / view 分页拉取记录。
 */

import type { Attachment } from './types.ts';

/** 接口根地址；测试时用 FEISHU_API_BASE 指向本地服务 */
const api = () => process.env.FEISHU_API_BASE ?? 'https://open.feishu.cn/open-apis';

export interface ParsedUrl {
  kind: 'wiki' | 'base';
  token: string;
  tableId: string;
  viewId?: string;
}

export interface FeishuRecord {
  recordId: string;
  title: string;
  description: string;
  fields: Record<string, string>;
  attachments: Attachment[];
  /** 记录定位：<app_token>/<table_id>/<record_id>，回写时使用 */
  sourceKey?: string;
}

export function parseFeishuUrl(raw: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('飞书链接格式不正确');
  }
  const m = url.pathname.match(/\/(wiki|base)\/([A-Za-z0-9]+)/);
  if (!m) throw new Error('仅支持 /wiki/... 或 /base/... 形式的多维表格链接');
  const tableId = url.searchParams.get('table');
  if (!tableId) throw new Error('链接中缺少 table 参数，请在多维表格中打开具体数据表后复制链接');
  return {
    kind: m[1] as 'wiki' | 'base',
    token: m[2],
    tableId,
    viewId: url.searchParams.get('view') ?? undefined,
  };
}

/** 把飞书各种字段类型的值转成可读文本 */
export function flattenField(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(flattenField).filter(Boolean).join(value.every(isTextSegment) ? '' : ', ');
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    // 文本片段 / 链接 / 人员 / 关联记录 等常见结构
    for (const key of ['text', 'name', 'en_name', 'link', 'value']) {
      if (key in v) return flattenField(v[key]);
    }
    if ('text_arr' in v) return flattenField(v.text_arr);
    if ('link_record_ids' in v) return flattenField(v.link_record_ids);
    return JSON.stringify(v);
  }
  return String(value);
}

function isTextSegment(v: unknown) {
  return typeof v === 'object' && v !== null && 'text' in v && 'type' in v;
}

/** 常见错误码的排查提示 */
const ERROR_HINTS: Record<number, string> = {
  131006: '应用没有该知识库节点的阅读权限：在表格右上角「…」→「添加文档应用」中添加本应用，或让知识空间管理员授权',
  1254302: '应用没有该多维表格的访问权限：在表格右上角「…」→「添加文档应用」中添加本应用',
  91403: '应用没有该多维表格的访问权限：在表格右上角「…」→「添加文档应用」中添加本应用',
  99991672:
    '应用未开通所需权限：在开发者后台开通 wiki:wiki:readonly、bitable:app:readonly，电子表格内嵌的多维表格还需要 sheets:spreadsheet:readonly，下载截图需要 drive:drive:readonly，然后发布版本',
  1061004: '应用没有该附件的下载权限：在开发者后台开通 drive:drive:readonly 并发布版本，并确认已把本应用添加为表格的文档应用',
  10014: 'App Secret 不正确',
  10003: 'App ID 或 App Secret 不正确',
};

export function feishuErrorMessage(path: string, code: number | undefined, msg: string): string {
  const hint = code !== undefined ? ERROR_HINTS[code] : undefined;
  const base = `飞书接口错误 ${path.split('?')[0]}: ${code ?? ''} ${msg}`.trim();
  return hint ? `${hint}（${base}）` : base;
}

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(`${api()}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; data?: T } & T;
  if (!res.ok || (body.code !== undefined && body.code !== 0)) {
    throw new Error(feishuErrorMessage(path, body.code ?? res.status, body.msg ?? res.statusText));
  }
  return (body.data ?? body) as T;
}

export async function getTenantToken(appId: string, appSecret: string): Promise<string> {
  if (!appId || !appSecret) throw new Error('请先在「飞书连接」中填写 App ID 与 App Secret');
  const data = await call<{ tenant_access_token: string }>('/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  return data.tenant_access_token;
}

interface SheetMetaV2 {
  sheetId: string;
  title: string;
  blockInfo?: { blockToken?: string; blockType?: string };
}

/** v2 metainfo 的 blockToken 形如 "<app_token>_<table_id>"，取下划线前的部分 */
export function appTokenFromBlockToken(blockToken: string): string {
  return blockToken.split('_')[0];
}

async function resolveAppToken(parsed: ParsedUrl, token: string): Promise<string> {
  if (parsed.kind === 'base') return parsed.token;
  const data = await call<{ node: { obj_type: string; obj_token: string } }>(
    `/wiki/v2/spaces/get_node?token=${encodeURIComponent(parsed.token)}`,
    { token },
  );
  const { obj_type, obj_token } = data.node;
  if (obj_type === 'bitable') return obj_token;
  if (obj_type === 'sheet') return resolveEmbeddedBitable(obj_token, parsed.tableId, token);
  throw new Error(`该知识库节点不是多维表格（类型：${obj_type}）`);
}

/** 电子表格中内嵌的多维表格：v2 metainfo 中 BITABLE_BLOCK 页签的 blockToken 含有 app_token */
async function resolveEmbeddedBitable(sheetToken: string, tableId: string, token: string): Promise<string> {
  const data = await call<{ sheets: SheetMetaV2[] }>(`/sheets/v2/spreadsheets/${sheetToken}/metainfo`, { token });
  const blocks = data.sheets
    .map((s) => s.blockInfo)
    .filter((b): b is { blockToken: string; blockType?: string } => b?.blockType === 'BITABLE_BLOCK' && !!b.blockToken);
  if (!blocks.length) throw new Error('该电子表格中没有内嵌的多维表格');

  // 优先尝试 table_id 与链接一致的页签
  blocks.sort((a, b) => Number(b.blockToken.endsWith(`_${tableId}`)) - Number(a.blockToken.endsWith(`_${tableId}`)));
  const candidates = [...new Set(blocks.map((b) => appTokenFromBlockToken(b.blockToken)))];
  for (const appToken of candidates) {
    try {
      await call(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=1`, { token });
      return appToken;
    } catch {
      // 换下一个候选
    }
  }
  throw new Error(`在电子表格内嵌的多维表格中找不到数据表 ${tableId}，请确认链接中的 table 参数`);
}

interface FieldMeta {
  field_id?: string;
  field_name: string;
  type?: number;
  is_primary?: boolean;
  property?: { options?: { name?: string }[] };
}

/** 附件字段类型 */
const ATTACHMENT_FIELD_TYPE = 17;

/** 从附件字段值中取出文件信息；extra 用于开启了高级权限的多维表格下载 */
export function extractAttachments(
  raw: Record<string, unknown>,
  fields: FieldMeta[],
  ctx: { appToken: string; tableId: string; recordId: string },
): Attachment[] {
  const out: Attachment[] = [];
  for (const f of fields) {
    if (f.type !== ATTACHMENT_FIELD_TYPE || !Array.isArray(raw[f.field_name])) continue;
    for (const item of raw[f.field_name] as Record<string, unknown>[]) {
      const token = typeof item?.file_token === 'string' ? item.file_token : '';
      if (!token) continue;
      const extra = f.field_id
        ? JSON.stringify({
            bitablePerm: {
              tableId: ctx.tableId,
              attachments: { [f.field_id]: { [ctx.recordId]: [token] } },
            },
          })
        : undefined;
      out.push({
        token,
        name: typeof item.name === 'string' ? item.name : token,
        type: typeof item.type === 'string' ? item.type : '',
        size: typeof item.size === 'number' ? item.size : 0,
        field: f.field_name,
        extra,
      });
    }
  }
  return out;
}

/** 下载附件原始内容 */
export async function downloadAttachment(
  opts: { appId: string; appSecret: string },
  att: Pick<Attachment, 'token' | 'extra'>,
): Promise<{ data: Buffer; contentType: string }> {
  const token = await getTenantToken(opts.appId, opts.appSecret);
  const qs = att.extra ? `?extra=${encodeURIComponent(att.extra)}` : '';
  const path = `/drive/v1/medias/${encodeURIComponent(att.token)}/download${qs}`;
  const res = await fetch(`${api()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  // 出错时返回 JSON 错误体
  if (!res.ok || contentType.includes('application/json')) {
    const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
    throw new Error(feishuErrorMessage(path, body.code ?? res.status, body.msg ?? res.statusText));
  }
  return { data: Buffer.from(await res.arrayBuffer()), contentType };
}

/** 日期(5)、创建时间(1001)、修改时间(1002) 字段返回毫秒时间戳 */
const DATE_FIELD_TYPES = new Set([5, 1001, 1002]);

export function formatDateFields(raw: Record<string, unknown>, dateFields: Set<string>): Record<string, unknown> {
  const out = { ...raw };
  for (const name of dateFields) {
    const v = out[name];
    if (typeof v === 'number' && Number.isFinite(v)) {
      // 飞书日期按东八区展示
      out[name] = new Date(v + 8 * 3600_000).toISOString().slice(0, 10);
    }
  }
  return out;
}

export async function fetchRecords(opts: { appId: string; appSecret: string; url: string }): Promise<FeishuRecord[]> {
  const parsed = parseFeishuUrl(opts.url);
  const token = await getTenantToken(opts.appId, opts.appSecret);
  const appToken = await resolveAppToken(parsed, token);
  const base = `/bitable/v1/apps/${appToken}/tables/${parsed.tableId}`;

  // 字段列表：主字段作为任务标题，同时保持字段原有顺序
  const fieldData = await call<{ items: FieldMeta[] }>(`${base}/fields?page_size=100`, { token });
  const fieldNames = fieldData.items.map((f) => f.field_name);
  const primary = fieldData.items.find((f) => f.is_primary)?.field_name ?? fieldNames[0];
  const dateFields = new Set(fieldData.items.filter((f) => DATE_FIELD_TYPES.has(f.type ?? -1)).map((f) => f.field_name));

  const records: FeishuRecord[] = [];
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({ page_size: '500' });
    if (pageToken) qs.set('page_token', pageToken);
    const data = await call<{
      items?: { record_id: string; fields: Record<string, unknown> }[];
      has_more: boolean;
      page_token?: string;
    }>(`${base}/records/search?${qs}`, {
      method: 'POST',
      token,
      body: JSON.stringify(parsed.viewId ? { view_id: parsed.viewId } : {}),
    });
    for (const item of data.items ?? []) {
      const rec = toRecord(item.record_id, formatDateFields(item.fields, dateFields), fieldNames, primary);
      rec.attachments = extractAttachments(item.fields, fieldData.items, {
        appToken,
        tableId: parsed.tableId,
        recordId: item.record_id,
      });
      rec.sourceKey = `${appToken}/${parsed.tableId}/${item.record_id}`;
      records.push(rec);
    }
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);

  return records;
}

export function toRecord(
  recordId: string,
  raw: Record<string, unknown>,
  fieldNames: string[],
  primary: string,
): FeishuRecord {
  const fields: Record<string, string> = {};
  for (const name of fieldNames) {
    const text = flattenField(raw[name]).trim();
    if (text) fields[name] = text;
  }
  const title = fields[primary] || `飞书记录 ${recordId}`;
  const description = Object.entries(fields)
    .filter(([name]) => name !== primary)
    .map(([name, text]) => `${name}：${text}`)
    .join('\n');
  return { recordId, title, description, fields, attachments: [] };
}

/** 按字段值过滤，values 用中英文逗号分隔；字段名或取值为空时不过滤 */
export function filterRecords<T extends Pick<FeishuRecord, 'fields'>>(records: T[], field: string, values: string): T[] {
  const wanted = values
    .split(/[,，]/)
    .map((v) => v.trim())
    .filter(Boolean);
  if (!field.trim() || !wanted.length) return records;
  return records.filter((r) => {
    // 多选字段会被拼成 "a, b"，任一取值命中即可
    const actual = (r.fields[field.trim()] ?? '').split(/,\s*/);
    return actual.some((v) => wanted.includes(v));
  });
}

// ---------- 回写 ----------

export interface RecordRef {
  appToken: string;
  tableId: string;
  recordId: string;
}

export function parseSourceKey(key: string | undefined): RecordRef | null {
  const m = /^([A-Za-z0-9]+)\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)$/.exec(key ?? '');
  return m ? { appToken: m[1], tableId: m[2], recordId: m[3] } : null;
}

/** 旧任务没有保存定位信息时，用项目的表格链接换出 app_token */
export async function locateRecord(opts: { appId: string; appSecret: string; url: string }, recordId: string): Promise<RecordRef> {
  const parsed = parseFeishuUrl(opts.url);
  const token = await getTenantToken(opts.appId, opts.appSecret);
  return { appToken: await resolveAppToken(parsed, token), tableId: parsed.tableId, recordId };
}

/** 文本(1) 和单选(3) 字段可以直接写入字符串 */
const TEXT_FIELD_TYPE = 1;
const SINGLE_SELECT_FIELD_TYPE = 3;

export interface FieldWrite {
  state: 'done' | 'skipped';
  /** 写入前飞书上的值 */
  previous: string;
  message: string;
}

/**
 * 把一条记录的某个字段改为指定取值。先读后写：
 * - 已是目标值：不写，返回 done（可重复调用）
 * - expectCurrent 非空且当前值不在其中：记录已被别人改过，不覆盖，返回 skipped
 */
export async function setRecordField(
  creds: { appId: string; appSecret: string },
  ref: RecordRef,
  field: string,
  value: string,
  expectCurrent: string[] = [],
): Promise<FieldWrite> {
  const token = await getTenantToken(creds.appId, creds.appSecret);
  const base = `/bitable/v1/apps/${ref.appToken}/tables/${ref.tableId}`;
  const fields = await call<{ items: FieldMeta[] }>(`${base}/fields?page_size=100`, { token });
  const meta = fields.items.find((f) => f.field_name === field);
  if (!meta) throw new Error(`表格中没有名为「${field}」的字段`);
  if (meta.type !== TEXT_FIELD_TYPE && meta.type !== SINGLE_SELECT_FIELD_TYPE) throw new Error(`字段「${field}」不是文本或单选字段，不支持回写`);
  if (meta.type === SINGLE_SELECT_FIELD_TYPE) {
    const options = (meta.property?.options ?? []).map((o) => o.name ?? '').filter(Boolean);
    // 写入不存在的选项会在表里新建选项，等于改了大家共用的表结构
    if (!options.includes(value)) throw new Error(`字段「${field}」没有选项「${value}」，现有选项：${options.join('、')}`);
  }

  const rec = await call<{ record: { fields: Record<string, unknown> } }>(`${base}/records/${ref.recordId}`, { token });
  const previous = flattenField(rec.record?.fields?.[field]).trim();
  if (previous === value) return { state: 'done', previous, message: `飞书上已是「${value}」，无需修改` };
  if (expectCurrent.length && !expectCurrent.includes(previous)) {
    return {
      state: 'skipped',
      previous,
      message: `飞书上当前是「${previous || '空'}」，不在导入取值（${expectCurrent.join('、')}）内，可能已被他人处理，未覆盖`,
    };
  }
  await call(`${base}/records/${ref.recordId}`, { method: 'PUT', token, body: JSON.stringify({ fields: { [field]: value } }) });
  return { state: 'done', previous, message: `已把「${field}」从「${previous || '空'}」改为「${value}」` };
}
