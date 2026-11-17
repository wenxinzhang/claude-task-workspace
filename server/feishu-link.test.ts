import { describe, expect, it } from 'vitest';
import { feishuRecordUrl } from './shared.ts';

const KEY = 'HXd1boEMZa8ptzsBk2TcRpkYnde/tblalv1Yed6iSd0e/reczz28aI44CiF9G';
const WIKI =
  'https://xcnizahaj6l1.feishu.cn/wiki/MyZ8wQq8uilPamkhactcAV5JnYe?sheet=4d4df8&table=tblalv1Yed6iSd0e&view=vewP2B92zv';
const FALLBACK = 'https://feishu.cn/base/HXd1boEMZa8ptzsBk2TcRpkYnde?table=tblalv1Yed6iSd0e&record=reczz28aI44CiF9G';

describe('feishuRecordUrl', () => {
  it('wiki 内嵌多维表格：保留知识库路径与 sheet 页签，追加 record', () => {
    expect(feishuRecordUrl(WIKI, KEY)).toBe(`${WIKI}&record=reczz28aI44CiF9G`);
  });
  it('base 链接：在原链接上追加 record', () => {
    const url = 'https://x.feishu.cn/base/AppTok123?table=tblA&view=vewA';
    expect(feishuRecordUrl(url, 'AppTok123/tblA/rec1')).toBe(`${url}&record=rec1`);
  });
  it('wiki 链接不带 table 参数：保留 sheet 页签并补上 table', () => {
    const url = 'https://x.feishu.cn/wiki/WikiTok?sheet=4d4df8';
    expect(feishuRecordUrl(url, KEY)).toBe(`${url}&table=tblalv1Yed6iSd0e&record=reczz28aI44CiF9G`);
  });
  it('配置链接里的旧 record 被替换为本任务的 record', () => {
    expect(feishuRecordUrl(`${WIKI}&record=recOld`, KEY)).toBe(`${WIKI}&record=reczz28aI44CiF9G`);
  });
  it('配置链接的 table 与任务不一致：退回 /base/ 拼装', () => {
    const url = 'https://x.feishu.cn/wiki/WikiTok?table=tblOther&view=vewOther';
    expect(feishuRecordUrl(url, KEY)).toBe(FALLBACK);
  });
  it('没有配置链接：退回 /base/ 拼装', () => {
    expect(feishuRecordUrl(undefined, KEY)).toBe(FALLBACK);
    expect(feishuRecordUrl('', KEY)).toBe(FALLBACK);
  });
  it('配置链接不是 wiki/base 形式：退回 /base/ 拼装', () => {
    expect(feishuRecordUrl('https://x.feishu.cn/drive/abc', KEY)).toBe(FALLBACK);
    expect(feishuRecordUrl('打不开的链接', KEY)).toBe(FALLBACK);
  });
  it('sourceKey 不带 record：不写 record 参数', () => {
    expect(feishuRecordUrl(WIKI, 'HXd1boEMZa8ptzsBk2TcRpkYnde/tblalv1Yed6iSd0e')).toBe(WIKI);
  });
  it('sheets 直链：与 wiki 入口同文档，保留页签并追加 record', () => {
    const url = 'https://x.feishu.cn/sheets/TDUosDcfah164etSHEtcFH18nhh?sheet=4d4df8&table=tblalv1Yed6iSd0e&view=vewP2B92zv';
    expect(feishuRecordUrl(url, KEY)).toBe(`${url}&record=reczz28aI44CiF9G`);
  });
  it('无 table 但带 sheet/view：原样保留并补 table（导入时靠它们解析数据表）', () => {
    const url = 'https://x.feishu.cn/wiki/WikiTok?sheet=4d4df8&view=vewP2B92zv';
    expect(feishuRecordUrl(url, KEY)).toBe(`${url}&table=tblalv1Yed6iSd0e&record=reczz28aI44CiF9G`);
  });
  it('配置链接带旧 record 而 sourceKey 无 record：删掉旧 record', () => {
    expect(feishuRecordUrl(`${WIKI}&record=recOld`, 'HXd1boEMZa8ptzsBk2TcRpkYnde/tblalv1Yed6iSd0e')).toBe(WIKI);
  });
  it('sourceKey 缺 app 或 table：返回 null 交给调用方兜底', () => {
    expect(feishuRecordUrl(WIKI, 'AppOnly')).toBeNull();
    expect(feishuRecordUrl(WIKI, '')).toBeNull();
  });
});