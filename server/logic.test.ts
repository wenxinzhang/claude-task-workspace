import { describe, it, expect } from 'vitest';
import { parseFeishuUrl, flattenField, toRecord, feishuErrorMessage, filterRecords, appTokenFromBlockToken, formatDateFields, extractAttachments } from './feishu.ts';

describe('formatDateFields', () => {
  it('只转换日期字段，按东八区输出 YYYY-MM-DD', () => {
    const out = formatDateFields({ 开始: 1791820800000, 数量: 5 }, new Set(['开始']));
    expect(out).toEqual({ 开始: '2026-10-13', 数量: 5 });
  });
});

describe('appTokenFromBlockToken', () => {
  it('取下划线前的 app_token', () => {
    expect(appTokenFromBlockToken('AppToken0123456789abcdefghi_tblExample0000001')).toBe('AppToken0123456789abcdefghi');
  });
});

describe('filterRecords', () => {
  const rec = (title: string, fields: Record<string, string>) => ({ recordId: title, title, description: '', fields });
  const list = [
    rec('a', { 状态: '待修改', 类型: 'bug' }),
    rec('b', { 状态: '已完成待测试', 类型: '优化' }),
    rec('c', { 状态: '重新打开', 类型: 'bug, 优化' }),
    rec('d', {}),
  ];
  it('取值留空不过滤', () => {
    expect(filterRecords(list, '状态', '')).toHaveLength(4);
    expect(filterRecords(list, '', '待修改')).toHaveLength(4);
  });
  it('支持中英文逗号多个取值', () => {
    expect(filterRecords(list, '状态', '待修改，重新打开').map((r) => r.title)).toEqual(['a', 'c']);
    expect(filterRecords(list, ' 状态 ', ' 待修改 , 重新打开').map((r) => r.title)).toEqual(['a', 'c']);
  });
  it('多选字段任一取值命中', () => {
    expect(filterRecords(list, '类型', '优化').map((r) => r.title)).toEqual(['b', 'c']);
  });
  it('精确匹配，不做子串匹配', () => {
    expect(filterRecords(list, '状态', '待测试')).toHaveLength(0);
    // 状态 + 指派给 叠加过滤
    const people = [
      { recordId: '1', title: 'x', description: '', fields: { 状态: '待修改', 指派给: '福星' } },
      { recordId: '2', title: 'y', description: '', fields: { 状态: '待修改', 指派给: '于老师, 福星' } },
      { recordId: '3', title: 'z', description: '', fields: { 状态: '测试通过', 指派给: '福星' } },
      { recordId: '4', title: 'w', description: '', fields: { 状态: '待修改', 指派给: '龚总' } },
    ];
    expect(filterRecords(filterRecords(people, '状态', '待修改'), '指派给', '福星').map((r) => r.title)).toEqual(['x', 'y']);
  });

  it('extractAttachments 取出附件字段并带上高级权限参数', () => {
    const atts = extractAttachments(
      {
        截图: [{ file_token: 'boxTok1', name: 'a.png', type: 'image/png', size: 12 }],
        标题: 'x',
      },
      [
        { field_id: 'fld1', field_name: '截图', type: 17 },
        { field_id: 'fld2', field_name: '标题', type: 1 },
      ],
      { appToken: 'app', tableId: 'tbl', recordId: 'rec1' },
    );
    expect(atts).toHaveLength(1);
    expect(atts[0]).toMatchObject({ token: 'boxTok1', name: 'a.png', type: 'image/png', field: '截图' });
    expect(JSON.parse(atts[0].extra!)).toEqual({ bitablePerm: { tableId: 'tbl', attachments: { fld1: { rec1: ['boxTok1'] } } } });
  });
});

describe('feishuErrorMessage', () => {
  it('已知错误码附带中文提示，并去掉查询参数', () => {
    const m = feishuErrorMessage('/wiki/v2/spaces/get_node?token=abc', 131006, 'permission denied');
    expect(m).toMatch(/^应用没有该知识库节点的阅读权限/);
    expect(m).toContain('131006 permission denied');
    expect(m).not.toContain('token=abc');
  });
  it('未知错误码保留原文', () => {
    expect(feishuErrorMessage('/x', 1, 'oops')).toBe('飞书接口错误 /x: 1 oops');
  });
});
import { splitTools, implementArgs } from './claude.ts';
import { testEnvSection, attachmentSection, analysisPrompt } from './prompts.ts';
import { normalizeProject } from './store.ts';
import { cacheName } from './attachments.ts';
import { validateProjectPatch, validateSettingsPatch } from './validate.ts';
import { DEFAULT_EXEC } from './types.ts';
import { DEFAULT_OBSERVER_SETTINGS } from './observe-types.ts';
import { Store } from './store.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('parseFeishuUrl', () => {
  it('解析 wiki 多维表格链接', () => {
    const p = parseFeishuUrl(
      'https://example.feishu.cn/wiki/WikiToken0123456789abcdefghi?table=tblExample0000001&view=vewExample1',
    );
    expect(p).toEqual({ kind: 'wiki', token: 'WikiToken0123456789abcdefghi', tableId: 'tblExample0000001', viewId: 'vewExample1' });
  });
  it('解析 base 链接，view 可选', () => {
    const p = parseFeishuUrl('https://x.feishu.cn/base/AbC123?table=tbl1');
    expect(p.kind).toBe('base');
    expect(p.viewId).toBeUndefined();
  });
  it('缺少 table 参数时报错', () => {
    expect(() => parseFeishuUrl('https://x.feishu.cn/wiki/AbC123')).toThrow(/table/);
  });
  it('非法链接报错', () => {
    expect(() => parseFeishuUrl('not a url')).toThrow();
    expect(() => parseFeishuUrl('https://x.feishu.cn/docx/abc?table=t')).toThrow();
  });
});

describe('flattenField', () => {
  it('文本片段拼接', () => {
    expect(flattenField([{ type: 'text', text: '登录' }, { type: 'text', text: '报错' }])).toBe('登录报错');
  });
  it('人员 / 多选 用逗号分隔', () => {
    expect(flattenField([{ name: '张三', id: 'ou_1' }, { name: '李四', id: 'ou_2' }])).toBe('张三, 李四');
    expect(flattenField(['P0', 'Bug'])).toBe('P0, Bug');
  });
  it('数字、布尔、链接', () => {
    expect(flattenField(3)).toBe('3');
    expect(flattenField(true)).toBe('true');
    expect(flattenField({ link: 'https://a.com', text: 'A' })).toBe('A');
    expect(flattenField(null)).toBe('');
  });
});

describe('toRecord', () => {
  it('主字段为标题，其余字段拼为描述，空字段忽略', () => {
    const r = toRecord(
      'rec1',
      { 需求: [{ type: 'text', text: '修复登录' }], 优先级: 'P0', 备注: '' },
      ['需求', '优先级', '备注'],
      '需求',
    );
    expect(r.title).toBe('修复登录');
    expect(r.description).toBe('优先级：P0');
  });
  it('无标题时使用 record id', () => {
    expect(toRecord('rec2', {}, ['需求'], '需求').title).toBe('飞书记录 rec2');
  });
});

describe('splitTools / implementArgs', () => {
  it('括号内空格不拆分', () => {
    expect(splitTools('Bash(npm *) Bash(git diff*), Edit')).toEqual(['Bash(npm *)', 'Bash(git diff*)', 'Edit']);
    expect(splitTools('  ')).toEqual([]);
  });
  it('生成 claude 参数', () => {
    const args = implementArgs({ ...DEFAULT_EXEC, model: 'sonnet', allowedTools: 'Bash(npm *)' });
    expect(args).toEqual([
      '--permission-mode',
      'acceptEdits',
      '--model',
      'sonnet',
      '--allowedTools',
      'Bash(npm *)',
      // 默认禁用会提交/合并的 skill
      '--disallowedTools',
      'Skill(tool-commit-push)',
      'Skill(finishing-branch)',
    ]);
  });
});

describe('validateSettingsPatch', () => {
  it('只接受飞书应用凭证', () => {
    expect(validateSettingsPatch({ feishu: { appId: ' cli_x ', url: 'ignored' } })).toEqual({ feishu: { appId: 'cli_x' } });
  });
  it('可用模型清单：去空白、去空项、去重并保持顺序', () => {
    expect(validateSettingsPatch({ models: [' sonnet ', '', 'opus', 'sonnet', 'qwen-max[1m]'] })).toEqual({ models: ['sonnet', 'opus', 'qwen-max[1m]'] });
    expect(validateSettingsPatch({ models: [] })).toEqual({ models: [] });
  });
  it('可用模型清单：拒绝参数注入、非字符串、非数组与超量', () => {
    expect(() => validateSettingsPatch({ models: ['sonnet --dangerously-skip-permissions'] })).toThrow();
    expect(() => validateSettingsPatch({ models: ['--dangerously-skip-permissions'] })).toThrow();
    expect(() => validateSettingsPatch({ models: ['a b'] })).toThrow();
    expect(() => validateSettingsPatch({ models: [1] })).toThrow();
    expect(() => validateSettingsPatch({ models: 'sonnet' })).toThrow();
    expect(() => validateSettingsPatch({ models: Array.from({ length: 51 }, (_, i) => `m${i}`) })).toThrow();
  });
});

describe('validateProjectPatch', () => {
  it('合法执行设置通过', () => {
    const p = validateProjectPatch({ exec: { permissionMode: 'auto', model: 'claude-sonnet-5-5', timeoutMinutes: '15' } });
    expect(p.exec).toEqual({ permissionMode: 'auto', model: 'claude-sonnet-5-5', timeoutMinutes: 15 });
  });
  it('拒绝非法权限模式、模型名和参数注入', () => {
    expect(() => validateProjectPatch({ exec: { permissionMode: 'yolo' } })).toThrow();
    expect(() => validateProjectPatch({ exec: { model: 'sonnet --dangerously-skip-permissions' } })).toThrow();
    expect(() => validateProjectPatch({ exec: { allowedTools: 'Edit --dangerously-skip-permissions' } })).toThrow();
    expect(() => validateProjectPatch({ exec: { timeoutMinutes: 0 } })).toThrow();
  });
  it('理解超时与验证模型：合法值通过，越界与参数注入拒绝', () => {
    expect(validateProjectPatch({ exec: { analyzeTimeoutMinutes: '20', verifyModel: 'haiku' } }).exec).toEqual({ analyzeTimeoutMinutes: 20, verifyModel: 'haiku' });
    expect(() => validateProjectPatch({ exec: { analyzeTimeoutMinutes: 0 } })).toThrow();
    expect(() => validateProjectPatch({ exec: { analyzeTimeoutMinutes: 61 } })).toThrow();
    expect(() => validateProjectPatch({ exec: { verifyModel: 'haiku --x' } })).toThrow();
  });
  it('名称不能为空，代码目录必须存在且为绝对路径', () => {
    expect(() => validateProjectPatch({ name: '  ' })).toThrow('项目名称');
    expect(() => validateProjectPatch({ workdir: 'relative/dir' })).toThrow('绝对路径');
    expect(() => validateProjectPatch({ workdir: path.join(os.tmpdir(), 'no-such-dir-xyz') })).toThrow('不存在');
    expect(validateProjectPatch({ workdir: os.tmpdir() }).workdir).toBe(path.resolve(os.tmpdir()));
  });
});

describe('normalizeProject', () => {
  const base = { id: 'p', name: 'n', workdir: 'E:\proj', createdAt: 1 };
  it('保留代理、验证方式、回写等设置，不认识的键丢弃', () => {
    const p = normalizeProject({
      ...base,
      feishu: { url: 'u', writeBack: true, writeBackReviewValue: '已修复待测' },
      exec: { provider: 'codex', codexModel: 'm', codexSandbox: 'workspace-write', verificationMode: 'agent', testTimeoutMinutes: 15, bogus: 1 },
    } as any);
    expect(p.exec).toMatchObject({ provider: 'codex', codexModel: 'm', codexSandbox: 'workspace-write', verificationMode: 'agent', testTimeoutMinutes: 15 });
    expect(p.exec).not.toHaveProperty('bogus');
    expect(p.feishu).toMatchObject({ writeBack: true, writeBackField: '', writeBackTodoValue: '待修改', writeBackReviewValue: '已修复待测', writeBackDoneValue: '测试通过' });
  });
  it('旧数据没有验证方式：配过测试命令的沿用「只运行测试命令」，其余由代理验证；回写默认关闭', () => {
    expect(normalizeProject({ ...base, exec: { testCommand: 'npm test' } } as any).exec.verificationMode).toBe('command');
    const p = normalizeProject({ ...base, exec: {} } as any);
    expect(p.exec).toMatchObject({ provider: 'claude', verificationMode: 'agent' });
    expect(p.feishu.writeBack).toBe(false);
  });
});

describe('validateProjectPatch 新增设置', () => {
  it('代理、沙箱、验证方式只接受已知取值', () => {
    const p = validateProjectPatch({ exec: { provider: 'codex', codexSandbox: 'read-only', verificationMode: 'command', codexModel: 'gpt-x', testTimeoutMinutes: '5' }, feishu: { writeBack: 1, writeBackReviewValue: ' 已完成待测试 ' } });
    expect(p.exec).toEqual({ provider: 'codex', codexSandbox: 'read-only', verificationMode: 'command', codexModel: 'gpt-x', testTimeoutMinutes: 5 });
    expect(p.feishu).toEqual({ writeBack: true, writeBackReviewValue: '已完成待测试' });
    expect(() => validateProjectPatch({ exec: { provider: 'gemini' } })).toThrow();
    expect(() => validateProjectPatch({ exec: { codexSandbox: 'none' } })).toThrow();
    expect(() => validateProjectPatch({ exec: { verificationMode: 'skip' } })).toThrow();
    expect(() => validateProjectPatch({ exec: { codexModel: 'm --full-auto' } })).toThrow();
  });
});

describe('Store 旧数据迁移', () => {
  it('旧的单项目设置和任务迁入「默认项目」，凭证保留在全局设置', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({
          feishu: { appId: 'cli_a', appSecret: 's', url: 'https://x.feishu.cn/base/abc?table=tbl1', filterField: '状态', filterValues: '待修改' },
          exec: { workdir: 'E:\\proj', model: 'sonnet' },
        }),
      );
      fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify([{ id: 't1', title: 'a', status: 'todo', logs: [], order: 1 }]));

      const store = new Store(dir);
      const [p] = store.listProjects();
      expect(p).toMatchObject({ name: '默认项目', workdir: 'E:\\proj', feishu: { filterValues: '待修改' }, exec: { model: 'sonnet' } });
      expect(p.exec).not.toHaveProperty('workdir');
      expect(store.get('t1')?.projectId).toBe(p.id);
      expect(store.getSettings()).toEqual({ feishu: { appId: 'cli_a', appSecret: 's' }, vault: { path: '', enabled: false }, observer: DEFAULT_OBSERVER_SETTINGS, skills: { libraryDir: '' }, models: [] });
      expect(store.nextTodo(p.id)?.id).toBe('t1');

      // 再次加载不会重复迁移
      expect(new Store(dir).listProjects()).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('全新安装没有项目', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
    try {
      expect(new Store(dir).listProjects()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('testEnvSection', () => {
  const env = { url: 'https://t.example.com', username: 'tester', password: 'p@ss', server: 'ssh deploy@10.0.0.1\n日志 /opt/logs', notes: '', shareWithClaude: true, deployCommand: '' };
  it('包含填写的字段，多行内容缩进', () => {
    const s = testEnvSection(env);
    expect(s).toContain('## 测试环境');
    expect(s).toContain('- 访问地址：https://t.example.com');
    expect(s).toContain('- 测试账号：tester');
    expect(s).toContain('  ssh deploy@10.0.0.1\n  日志 /opt/logs');
    expect(s).not.toContain('其他说明');
  });
  it('关闭共享或全部为空时不输出', () => {
    expect(testEnvSection({ ...env, shareWithClaude: false })).toBe('');
    expect(testEnvSection({ url: '', username: '', password: '', server: '', notes: '', shareWithClaude: true, deployCommand: '' })).toBe('');
    expect(testEnvSection(undefined)).toBe('');
  });
});
describe('附件交给 Claude', () => {
  it('cacheName 保留扩展名，拒绝非法 token', () => {
    expect(cacheName({ token: 'boxAbc', name: 'image.png', type: 'image/png' })).toBe('boxAbc.png');
    expect(cacheName({ token: 'boxAbc', name: '截图', type: 'image/jpeg' })).toBe('boxAbc.jpg');
    expect(cacheName({ token: 'boxAbc', name: 'a', type: '' })).toBe('boxAbc');
    expect(() => cacheName({ token: '../x', name: 'a.png', type: '' })).toThrow();
  });
  it('提示词列出附件绝对路径，并要求用 Read 查看', () => {
    const files = [{ name: 'image.png', field: '截图', path: 'E:\\data\\attachments\\boxAbc.png', isImage: true }];
    const s = attachmentSection(files);
    expect(s).toContain('E:\\data\\attachments\\boxAbc.png');
    expect(s).toContain('Read');
    expect(attachmentSection([])).toBe('');
    expect(analysisPrompt({ title: 't', description: '截图：image.png' }, files)).toContain('## 附件');
  });
});