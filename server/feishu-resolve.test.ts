import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchRecords } from './feishu.ts';

/**
 * 本地假飞书：一个知识库电子表格（两个内嵌多维表格页签 + 一个普通页签）和一个独立多维表格。
 * 记录的「来自」字段写明它属于哪张数据表，用来判断读的是不是该读的那张。
 */
const SHEETS = [
  { sheetId: 'plain1', title: '说明' },
  { sheetId: 'aaa111', title: '缺陷表', blockInfo: { blockType: 'BITABLE_BLOCK', blockToken: 'appSheet_tblFirst' } },
  { sheetId: '4d4df8', title: '二期缺陷', blockInfo: { blockType: 'BITABLE_BLOCK', blockToken: 'appSheet_tblSecond' } },
];
let server: http.Server;
/** 假飞书收到的「读记录」请求数：用来确认报错时没有去读任何一张表 */
let recordReads = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? '';
    if (url.startsWith('/auth/')) return send({ code: 0, tenant_access_token: 't' });
    if (url.startsWith('/wiki/v2/spaces/get_node')) return send({ code: 0, data: { node: { obj_type: 'sheet', obj_token: 'shtTok' } } });
    if (url.startsWith('/sheets/v2/spreadsheets/shtTok/metainfo')) return send({ code: 0, data: { sheets: SHEETS } });
    // 数据表列表：独立多维表格 appBase 有两张表
    if (/^\/bitable\/v1\/apps\/appBase\/tables(\?|$)/.test(url)) return send({ code: 0, data: { items: [{ table_id: 'tblBaseA' }, { table_id: 'tblBaseB' }] } });
    const m = url.match(/^\/bitable\/v1\/apps\/(\w+)\/tables\/(\w+)\/(fields|records\/search)/);
    if (!m) return send({ code: 404, msg: 'not found' }, 404);
    if (m[3] === 'fields') return send({ code: 0, data: { items: [{ field_id: 'f1', field_name: '标题', type: 1, is_primary: true }, { field_id: 'f2', field_name: '来自', type: 1 }] } });
    recordReads++;
    send({ code: 0, data: { has_more: false, items: [{ record_id: 'rec1', fields: { 标题: 'bug', 来自: `${m[1]}/${m[2]}` } }] } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.FEISHU_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.FEISHU_API_BASE;
  await new Promise((r) => server.close(r));
});

const read = (url: string) => fetchRecords({ appId: 'cli_x', appSecret: 's', url });
const WIKI = 'https://x.feishu.cn/wiki/WikiTok1';

describe('飞书链接不带 table 参数', () => {
  it('FR-01 带 table 的链接照旧读指定的数据表', async () => {
    const rs = await read(`${WIKI}?table=tblSecond&view=vew1`);
    expect(rs[0].fields['来自']).toBe('appSheet/tblSecond');
  });
  it('FR-02 电子表格链接只带 sheet：读该页签对应的多维表格，并存下回写要用的定位', async () => {
    const rs = await read(`${WIKI}?from=from_copylink&sheet=4d4df8`);
    expect(rs[0].fields['来自']).toBe('appSheet/tblSecond');
    expect(rs[0].sourceKey).toBe('appSheet/tblSecond/rec1');
  });
  it('FR-03 电子表格链接 sheet 与 table 都不带：读第一个内嵌多维表格页签', async () => {
    const rs = await read(`${WIKI}?from=from_copylink`);
    expect(rs[0].fields['来自']).toBe('appSheet/tblFirst');
  });
  it('FR-04 独立多维表格链接不带 table：读第一张数据表', async () => {
    const rs = await read('https://x.feishu.cn/base/appBase');
    expect(rs[0].fields['来自']).toBe('appBase/tblBaseA');
  });
  it('FR-05 sheet 指向的页签不是多维表格：报错并指出是哪个页签，不去读别的页签', async () => {
    recordReads = 0;
    // 报错里要带上链接中的页签 id：只断言「抛错」的话，假飞书的 404 也能让它通过
    await expect(read(`${WIKI}?sheet=plain1`)).rejects.toThrow(/plain1/);
    expect(recordReads).toBe(0);
  });
});
