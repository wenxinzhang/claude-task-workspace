import { useEffect, useState } from 'react';
import { SkillSettings } from './SkillSettings.tsx';
import { ModelSelect } from './ModelSelect.tsx';
import { api, DEFAULT_ENV, type DeployEnv, type ExecConfig, type Project, type RepoInfo, type Settings } from './api.ts';
import { Icon } from './Icon.tsx';

type Msg = { text: string; error?: boolean } | null;

/** 右侧抽屉壳：设置页的飞书 / Git / 部署环境编辑共用 */
function SideDrawer({ title, onClose, children, foot }: { title: string; onClose: () => void; children: React.ReactNode; foot: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <strong id="drawer-title">{title}</strong>
          <span className="grow" />
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        <footer className="drawer-foot">{foot}</footer>
      </aside>
    </div>
  );
}

/** 密码输入：带显示 / 隐藏切换 */
function PwdInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="pwd-wrap">
      <input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="new-password" />
      <button type="button" className="icon-btn pwd-eye" onClick={() => setShow(!show)} aria-label={show ? '隐藏密码' : '显示密码'} aria-pressed={show}>
        <Icon name="eye" />
      </button>
    </span>
  );
}

/** 目录浏览：只列目录，供选择代码目录 */
function DirsDialog({ onPick, onClose }: { onPick: (path: string) => void; onClose: () => void }) {
  const [cur, setCur] = useState<{ path: string; parent: string | null; dirs: string[] } | null>(null);
  const [err, setErr] = useState('');
  const load = (p: string) =>
    api<{ path: string; parent: string | null; dirs: string[] }>(`/api/fs/dirs?path=${encodeURIComponent(p)}`).then(
      (r) => {
        setCur(r);
        setErr('');
      },
      (e: Error) => setErr(e.message),
    );
  useEffect(() => {
    load('');
  }, []);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="选择代码目录" onClick={(e) => e.stopPropagation()}>
        <h2>选择代码目录</h2>
        <div className="row dirs-path">
          <span className="mono ellipsis grow" title={cur?.path}>
            {cur?.path || '此电脑'}
          </span>
          <button type="button" className="btn btn-outline sm" disabled={!cur || cur.parent === null} onClick={() => cur && cur.parent !== null && load(cur.parent)}>
            上级
          </button>
        </div>
        <div className="dirs-list">
          {cur?.dirs.map((d) => (
            <button type="button" key={d} className="picker-option" onClick={() => load(d)}>
              <Icon name="folder" size={14} />
              <span className="grow ellipsis">{d.split(/[\\/]/).filter(Boolean).pop()}</span>
            </button>
          ))}
          {cur && cur.dirs.length === 0 && <div className="empty-cell">没有子目录</div>}
        </div>
        {err && <div className="error">{err}</div>}
        <div className="actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>
            取消
          </button>
          <span className="grow" />
          <button type="button" className="btn btn-primary" disabled={!cur?.path} onClick={() => cur && onPick(cur.path)}>
            选择此目录
          </button>
        </div>
      </div>
    </div>
  );
}

/** 部署环境编辑：SSH 信息 + 构建 / 发布 / 健康检查。点「保存」直接存到服务端，存不上时面板不关、错误显示在面板里 */
function EnvDrawer({ projectId, initial, onSave, onClose }: { projectId: string; initial: DeployEnv; onSave: (e: DeployEnv) => Promise<void>; onClose: () => void }) {
  const [e, setE] = useState<DeployEnv>(initial);
  const [test, setTest] = useState<Msg>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof DeployEnv>(k: K, v: DeployEnv[K]) => setE({ ...e, [k]: v });

  const doSave = async () => {
    setSaving(true);
    setTest(null);
    try {
      await onSave({ ...e, name: e.name.trim() });
    } catch (err) {
      setTest({ text: `没有保存：${(err as Error).message}`, error: true });
      setSaving(false);
    }
  };

  const doTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      await api(`/api/projects/${projectId}/envs/${e.id}/test`, 'POST', { host: e.host, port: e.port });
      setTest({ text: `连接 ${e.host}:${e.port} 成功` });
    } catch (err) {
      setTest({ text: (err as Error).message, error: true });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SideDrawer
      title={initial.name ? `编辑部署环境 · ${initial.name}` : '添加部署环境'}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn btn-outline-primary" onClick={doTest} disabled={testing || !e.host}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          {test && <span className={test.error ? 'error' : 'ok-text'}>{test.text}</span>}
          <span className="grow" />
          <button type="button" className="btn btn-outline" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!e.name.trim() || saving}
            onClick={doSave}
          >
            {saving ? '保存中…' : initial.name ? '保存' : '添加环境'}
          </button>
        </>
      }
    >
      <label>
        环境名称
        <input value={e.name} onChange={(ev) => set('name', ev.target.value)} placeholder="输入环境名称" />
      </label>
      <div className="grid2">
        <label>
          IP 地址
          <input value={e.host} onChange={(ev) => set('host', ev.target.value)} placeholder="请输入 IP 地址" />
        </label>
        <label>
          端口号
          <input type="number" min={1} max={65535} value={e.port} onChange={(ev) => set('port', Number(ev.target.value))} />
        </label>
      </div>
      <div className="grid2">
        <label>
          登录账号
          <input value={e.username} onChange={(ev) => set('username', ev.target.value)} placeholder="请输入登录账号" autoComplete="off" />
        </label>
        <label>
          登录密码
          <PwdInput value={e.password} onChange={(v) => set('password', v)} placeholder="请输入登录密码" />
        </label>
      </div>
      <small className="muted">SSH 信息会提供给代理做验证；「测试连接」检查端口可达。</small>
      <label>
        访问地址
        <input value={e.url} onChange={(ev) => set('url', ev.target.value)} placeholder="例如 https://test.example.com" />
      </label>
      <label>
        测试服务器
        <textarea
          rows={3}
          value={e.server}
          onChange={(ev) => set('server', ev.target.value)}
          placeholder={'例如：\n部署目录 /opt/app，日志 /opt/app/logs'}
        />
      </label>
      <label>
        其他说明
        <textarea rows={2} value={e.notes} onChange={(ev) => set('notes', ev.target.value)} placeholder="例如：管理员账号 admin / xxx；测试数据在「演示租户」下" />
      </label>
      <label>
        构建命令（选填）
        <textarea rows={2} className="mono" value={e.buildCommand} onChange={(ev) => set('buildCommand', ev.target.value)} placeholder="例如 npm run build；留空跳过构建步骤" />
      </label>
      <label>
        部署命令
        <textarea
          rows={2}
          className="mono"
          value={e.deployCommand}
          onChange={(ev) => set('deployCommand', ev.target.value)}
          placeholder={'例如 npm run deploy:test\n或 powershell -File scripts\\deploy-test.ps1'}
        />
        <small className="muted">在代码目录下通过系统 shell 执行，退出码为 0 视为成功。</small>
      </label>
      <label>
        健康检查 URL（选填）
        <input value={e.healthCheck} onChange={(ev) => set('healthCheck', ev.target.value)} placeholder="例如 http://192.168.1.10:8080/；留空跳过" />
        <small className="muted">部署后 GET 该地址，2xx 视为通过。</small>
      </label>
      <label className="check">
        <input type="checkbox" checked={e.shareWithClaude} onChange={(ev) => set('shareWithClaude', ev.target.checked)} />
        执行和验证任务时提供给代理
      </label>
    </SideDrawer>
  );
}

/** Git 配置编辑：远端地址 + 账号密码，测试连接用 ls-remote */
function GitDrawer({ project, repo, onClose, onSaved }: { project: Project; repo: RepoInfo | null | undefined; onClose: () => void; onSaved: (r: RepoInfo | null) => void }) {
  const [url, setUrl] = useState(repo?.remote ?? '');
  const [username, setUsername] = useState(project.git.username);
  const [password, setPassword] = useState(project.git.password);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const persist = async () => {
    if (url.trim() && url.trim() !== repo?.remote) await api(`/api/projects/${project.id}/git/remote`, 'POST', { url: url.trim() });
    await api(`/api/projects/${project.id}`, 'PUT', { git: { username, password } });
  };
  const refresh = async () => {
    const r = await api<{ repo: RepoInfo | null }>(`/api/projects/${project.id}/git`);
    onSaved(r.repo);
  };
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await persist();
      await refresh();
      onClose();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await persist();
      const r = await api<{ refs: number }>(`/api/projects/${project.id}/git/test`, 'POST');
      setMsg({ text: `连接成功，远端 ${r.refs} 个分支` });
      await refresh();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SideDrawer
      title="编辑 Git 配置"
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn btn-outline-primary" onClick={test} disabled={busy}>
            {busy ? '处理中…' : '测试连接'}
          </button>
          <span className="grow" />
          <button type="button" className="btn btn-outline" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
            保存
          </button>
        </>
      }
    >
      <label>
        远程仓库
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://git.example.com/team/repo.git" />
      </label>
      <label>
        Git 账号
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
      </label>
      <label>
        Git 密码
        <PwdInput value={password} onChange={setPassword} />
      </label>
      <small className="muted">HTTPS 远端同步 / 推送时以认证头携带凭据，不写进 git 配置；SSH 远端使用本机密钥。密码留空或保持掩码表示不修改。</small>
      {msg && <div className={msg.error ? 'error' : 'ok-text'}>{msg.text}</div>}
    </SideDrawer>
  );
}

/** 项目信息：基本信息 / 飞书来源 / Git 仓库 / 部署环境。在「项目管理 → 配置」里，与执行设置并列 */
export function ProjectSettings({ project }: { project: Project }) {
  const [form, setForm] = useState<Project>(project);
  const [msg, setMsg] = useState<Msg>(null);
  const [drawer, setDrawer] = useState<'feishu' | 'git' | null>(null);
  const [envDraft, setEnvDraft] = useState<DeployEnv | null>(null);
  const [browse, setBrowse] = useState(false);
  const [repo, setRepo] = useState<RepoInfo | null | undefined>(undefined);
  const [feishuTest, setFeishuTest] = useState<Msg>(null);
  const [testing, setTesting] = useState(false);

  // 切换项目时重置表单
  useEffect(() => {
    setForm(project);
    setMsg(null);
    setFeishuTest(null);
    setRepo(undefined);
    api<{ repo: RepoInfo | null }>(`/api/projects/${project.id}/git`).then(
      (r) => setRepo(r.repo),
      () => setRepo(null),
    );
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const f = form.feishu;
  const setFeishu = <K extends keyof Project['feishu']>(k: K, v: Project['feishu'][K]) => setForm({ ...form, feishu: { ...f, [k]: v } });

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault();
    try {
      const saved = await api<Project>(`/api/projects/${project.id}`, 'PUT', {
        name: form.name,
        workdir: form.workdir,
        feishu: form.feishu,
        envs: form.envs,
      });
      setForm(saved);
      setMsg({ text: '已保存' });
    } catch (err) {
      setMsg({ text: (err as Error).message, error: true });
    }
  };

  const detect = () =>
    api<{ repo: RepoInfo | null }>(`/api/projects/${project.id}/git`).then(
      (r) => {
        setRepo(r.repo);
        setMsg(r.repo ? { text: '仓库检测完成' } : { text: '代码目录不是 git 仓库', error: true });
      },
      (e: Error) => setMsg({ text: e.message, error: true }),
    );

  const testFeishu = async () => {
    setTesting(true);
    setFeishuTest(null);
    try {
      const r = await api<{ count: number }>(`/api/projects/${project.id}/feishu/test`, 'POST', { url: f.url });
      setFeishuTest({ text: `连接成功，表格共 ${r.count} 条记录` });
    } catch (e) {
      setFeishuTest({ text: (e as Error).message, error: true });
    } finally {
      setTesting(false);
    }
  };

  /**
   * 部署环境的增、改、删都直接存到服务端：面板里点了「保存」就是保存了，不用再点页面底部的「保存设置」。
   * 只提交环境这一项，页面上没保存的项目名称、工作目录不会被顺带存进去
   */
  const saveEnvs = async (envs: DeployEnv[], done: string) => {
    const saved = await api<Project>(`/api/projects/${project.id}`, 'PUT', { envs });
    setForm((fm) => ({ ...fm, envs: saved.envs }));
    setMsg({ text: done });
  };
  const commitEnv = async (env: DeployEnv) => {
    const exists = form.envs.some((e) => e.id === env.id);
    await saveEnvs(exists ? form.envs.map((e) => (e.id === env.id ? env : e)) : [...form.envs, env], `部署环境「${env.name}」已保存`);
    setEnvDraft(null);
  };
  const removeEnv = (env: DeployEnv) => {
    if (!confirm(`删除部署环境「${env.name}」？\n\n删除后立即生效，不能恢复。`)) return;
    saveEnvs(
      form.envs.filter((x) => x.id !== env.id),
      `部署环境「${env.name}」已删除`,
    ).catch((e: Error) => setMsg({ text: `没有删除：${e.message}`, error: true }));
  };

  // 飞书配置面板：打开时记下当时的内容，「取消」退回去；「保存」直接存到服务端
  const [feishuBefore, setFeishuBefore] = useState<Project['feishu'] | null>(null);
  const [savingFeishu, setSavingFeishu] = useState(false);
  const openFeishu = () => {
    setFeishuBefore(f);
    setFeishuTest(null);
    setDrawer('feishu');
  };
  const cancelFeishu = () => {
    if (feishuBefore) setForm((fm) => ({ ...fm, feishu: feishuBefore }));
    setDrawer(null);
  };
  const saveFeishu = async () => {
    setSavingFeishu(true);
    try {
      const saved = await api<Project>(`/api/projects/${project.id}`, 'PUT', { feishu: f });
      setForm((fm) => ({ ...fm, feishu: saved.feishu }));
      setMsg({ text: '飞书配置已保存' });
      setDrawer(null);
    } catch (e) {
      setFeishuTest({ text: `没有保存：${(e as Error).message}`, error: true });
    } finally {
      setSavingFeishu(false);
    }
  };

  return (
    <form className="settings" onSubmit={save}>
      <h2 className="bar-title">基本信息</h2>
      <div className="field-row">
        <span className="field-label">项目名称</span>
        <input value={form.name} onChange={(ev) => setForm({ ...form, name: ev.target.value })} required />
      </div>
      <div className="field-row">
        <span className="field-label">本地工作目录</span>
        <input value={form.workdir} onChange={(ev) => setForm({ ...form, workdir: ev.target.value })} placeholder="例如 E:\workspace\my-project" required />
        <button type="button" className="btn btn-outline-primary" onClick={() => setBrowse(true)}>
          浏览
        </button>
      </div>
      <small className="muted field-note">代理会在这个目录中阅读代码、实现任务并运行测试。需要是 git 仓库，系统才能核对每个任务改了哪些文件。</small>

      <h2 className="bar-title">飞书来源</h2>
      <div className="field-row">
        <span className="field-label">飞书文档链接</span>
        <input value={f.url} onChange={(ev) => setFeishu('url', ev.target.value)} placeholder="https://xxx.feishu.cn/wiki/...?table=...&view=..." />
        <button type="button" className="btn btn-outline-primary" onClick={openFeishu}>
          编辑
        </button>
      </div>
      <div className="field-status">
        {f.url ? (
          <span className="ok-text">
            <Icon name="check" /> 已配置{f.name ? ` · ${f.name}` : ''}
          </span>
        ) : (
          <span className="muted">未配置：填写链接并编辑应用凭证后，才能手动飞书同步。</span>
        )}
      </div>

      <h2 className="bar-title">Git 仓库</h2>
      <div className="field-row">
        <span className="field-label">远端仓库</span>
        <input readOnly value={repo?.remote ?? (repo === undefined ? '读取中…' : '')} placeholder="代码目录的 origin 地址" />
        <button type="button" className="btn btn-outline-primary" onClick={() => setDrawer('git')}>
          编辑
        </button>
        <button type="button" className="btn btn-outline-primary" onClick={detect}>
          检测仓库
        </button>
      </div>
      <div className="field-row">
        <span className="field-label">当前分支</span>
        <input readOnly value={repo?.branch ?? ''} placeholder="—" />
      </div>
      <small className="muted field-note">
        {repo ? `${repo.ahead} 个提交待推送，落后远端 ${repo.behind} 个${repo.dirty ? `，${repo.dirty} 个文件未提交` : ''}。` : '代码目录不是 git 仓库时无法核对改动。'}
        分支切换在顶栏分支菜单里。
      </small>

      <h2 className="bar-title">部署环境</h2>
      {form.envs.map((e, i) => (
        <div className="env-row" key={e.id}>
          <strong>{e.name}</strong>
          {i === 0 && <span className="pill soft">默认</span>}
          {/* 填了什么就显示什么：只写「未配置部署命令」时，填过地址和账号的环境看起来像没保存 */}
          {(e.url || e.host) && <span className="muted mono">{e.url || `${e.host}:${e.port}`}</span>}
          {e.deployCommand ? (
            <span className="ok-text">
              <Icon name="check" /> 可以一键部署
            </span>
          ) : (
            <span className="muted">还没填部署命令，不能一键部署</span>
          )}
          <span className="grow" />
          {form.envs.length > 1 && (
            <button type="button" className="link" onClick={() => removeEnv(e)}>
              删除
            </button>
          )}
          <button type="button" className="link" onClick={() => setEnvDraft({ ...e })}>
            编辑
          </button>
        </div>
      ))}
      <div className="field-row">
        <button type="button" className="btn btn-outline-primary" onClick={() => setEnvDraft({ ...DEFAULT_ENV, id: crypto.randomUUID(), name: '' })}>
          <Icon name="plus" /> 添加环境
        </button>
      </div>
      <small className="muted field-note">第一项为默认环境，顶栏不选环境时部署到它。环境在编辑面板里点「保存」后立即生效，不用再点下面的「保存设置」。</small>

      <div className="actions settings-foot">
        {msg && <span className={msg.error ? 'error' : 'ok-text'}>{msg.text}</span>}
        <span className="grow" />
        <button type="button" className="btn btn-outline" onClick={() => setForm(project)} title="放弃对项目名称、工作目录、飞书链接的修改">
          取消
        </button>
        <button className="btn btn-primary" title="保存项目名称、工作目录和飞书链接">
          保存设置
        </button>
      </div>

      {drawer === 'feishu' && (
        <SideDrawer
          title="编辑飞书配置"
          onClose={cancelFeishu}
          foot={
            <>
              <button type="button" className="btn btn-outline-primary" onClick={testFeishu} disabled={testing || !f.url}>
                {testing ? '测试中…' : '测试连接'}
              </button>
              {feishuTest && <span className={feishuTest.error ? 'error' : 'ok-text'}>{feishuTest.text}</span>}
              <span className="grow" />
              <button type="button" className="btn btn-outline" onClick={cancelFeishu}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={saveFeishu} disabled={savingFeishu}>
                {savingFeishu ? '保存中…' : '保存'}
              </button>
            </>
          }
        >
          <label>
            来源名称
            <input value={f.name} onChange={(ev) => setFeishu('name', ev.target.value)} placeholder="例如 缺陷清单" />
          </label>
          <label>
            飞书文档链接
            <input value={f.url} onChange={(ev) => setFeishu('url', ev.target.value)} placeholder="https://xxx.feishu.cn/wiki/...?table=..." />
          </label>
          <label>
            App ID
            <input value={f.appId} onChange={(ev) => setFeishu('appId', ev.target.value)} placeholder="留空使用全局「飞书连接」" autoComplete="off" />
          </label>
          <label>
            App Secret（密钥）
            <PwdInput value={f.appSecret} onChange={(v) => setFeishu('appSecret', v)} placeholder="留空使用全局「飞书连接」" />
          </label>
          <small className="muted">不同项目的表格授权给了不同的飞书应用时在这里填写；两项要同时填写，都留空则用全局应用。表格需要把应用加为协作者。</small>
          <div className="grid2">
            <label>
              过滤字段
              <input value={f.filterField} onChange={(ev) => setFeishu('filterField', ev.target.value)} placeholder="状态" />
            </label>
            <label>
              过滤取值（逗号分隔）
              <input value={f.filterValues} onChange={(ev) => setFeishu('filterValues', ev.target.value)} placeholder="如 待修改,驳回修改；留空导入全部" />
            </label>
          </div>
          <div className="grid2">
            <label>
              指派人字段
              <input value={f.assigneeField} onChange={(ev) => setFeishu('assigneeField', ev.target.value)} placeholder="指派给" />
            </label>
            <label>
              指派给（逗号分隔）
              <input value={f.assigneeValues} onChange={(ev) => setFeishu('assigneeValues', ev.target.value)} placeholder="如 福星,于老师；留空不限" />
            </label>
          </div>
          <small className="muted">两个过滤条件需要同时满足。点「手动飞书同步」时按这里的设置导入。</small>
          <label className="check">
            <input type="checkbox" checked={f.autoAnalyze} onChange={(ev) => setFeishu('autoAnalyze', ev.target.checked)} />
            导入后自动生成规格
          </label>
          <label className="check">
            <input type="checkbox" checked={f.writeBack} onChange={(ev) => setFeishu('writeBack', ev.target.checked)} />
            任务换阶段时回写飞书状态
          </label>
          {f.writeBack && (
            <>
              <div className="grid2">
                <label>
                  回写字段
                  <input value={f.writeBackField} onChange={(ev) => setFeishu('writeBackField', ev.target.value)} placeholder={`留空使用过滤字段「${f.filterField || '状态'}」`} />
                </label>
                <label>
                  「待确认 / 待修改」对应的飞书取值
                  <input value={f.writeBackTodoValue} onChange={(ev) => setFeishu('writeBackTodoValue', ev.target.value)} placeholder="如 待修改" />
                </label>
                <label>
                  「待验证」对应的飞书取值
                  <input value={f.writeBackReviewValue} onChange={(ev) => setFeishu('writeBackReviewValue', ev.target.value)} placeholder="如 已完成待测试" />
                </label>
                <label>
                  「已通过」对应的飞书取值
                  <input value={f.writeBackDoneValue} onChange={(ev) => setFeishu('writeBackDoneValue', ev.target.value)} placeholder="如 测试通过" />
                </label>
              </div>
              <small className="muted">取值必须是该字段已有的选项，留空表示该阶段不回写。回写前会先读取飞书当前值，被人改成别的状态就不覆盖。</small>
            </>
          )}
        </SideDrawer>
      )}

      {drawer === 'git' && (
        <GitDrawer
          project={project}
          repo={repo}
          onClose={() => setDrawer(null)}
          onSaved={(r) => setRepo(r)}
        />
      )}

      {envDraft && <EnvDrawer projectId={project.id} initial={envDraft} onSave={commitEnv} onClose={() => setEnvDraft(null)} />}
      {browse && (
        <DirsDialog
          onPick={(p) => {
            setForm({ ...form, workdir: p });
            setBrowse(false);
          }}
          onClose={() => setBrowse(false)}
        />
      )}
    </form>
  );
}

/** 执行设置：按项目保存，在「项目管理 → 配置」里，与项目信息并列 */
export function ExecSettings({ project }: { project: Project }) {
  const [e, setE] = useState<ExecConfig>(project.exec);
  const [msg, setMsg] = useState<Msg>(null);
  // 只在切换项目时重置；SSE 推送项目变化时不覆盖正在编辑的内容
  useEffect(() => {
    setE(project.exec);
    setMsg(null);
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const setExec = <K extends keyof ExecConfig>(k: K, v: ExecConfig[K]) => setE({ ...e, [k]: v });

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault();
    try {
      await api<Project>(`/api/projects/${project.id}`, 'PUT', { exec: e });
      setMsg({ text: '已保存' });
    } catch (err) {
      setMsg({ text: (err as Error).message, error: true });
    }
  };

  return (
    <form className="settings" onSubmit={save}>
      <h2 className="bar-title">代理与权限</h2>
      <label>
        编码代理
        <select value={e.provider} onChange={(ev) => setExec('provider', ev.target.value as ExecConfig['provider'])}>
          <option value="claude">Claude Code（claude 命令）</option>
          <option value="codex">Codex CLI（codex 命令）</option>
          <option value="custom">本地命令行代理（自定义命令）</option>
        </select>
        <small className="muted">生成规格、实现、验证三个阶段都由它执行。队列执行第一个任务前会先用这里的配置自检一次：让代理读一个文件、执行一条命令，读不到文件就不开始。</small>
      </label>
      {e.provider === 'claude' && (
        <>
          <label>
            权限模式
            <select value={e.permissionMode} onChange={(ev) => setExec('permissionMode', ev.target.value as ExecConfig['permissionMode'])}>
              <option value="acceptEdits">acceptEdits：自动允许改文件，命令仅限下方白名单</option>
              <option value="auto">auto：由 Claude Code 自动判断风险</option>
              <option value="dontAsk">dontAsk：未允许的操作直接拒绝</option>
              <option value="bypassPermissions">bypassPermissions：跳过所有权限检查（仅限沙箱）</option>
            </select>
          </label>
          <label>
            允许的工具
            <input value={e.allowedTools} onChange={(ev) => setExec('allowedTools', ev.target.value)} placeholder="例如 Bash(npm *) Bash(git diff*)" />
            <small className="muted">空格或逗号分隔，对应 claude --allowedTools。不在名单里的命令会被拒绝，被拒绝的调用会记在任务的会话记录里。</small>
          </label>
          <label>
            模型
            <ModelSelect value={e.model} onChange={(v) => setExec('model', v)} emptyLabel="使用默认（不指定）" />
          </label>
        </>
      )}
      {e.provider !== 'custom' && (
        <label>
          验证阶段模型
          <ModelSelect value={e.verifyModel} onChange={(v) => setExec('verifyModel', v)} emptyLabel="与实现阶段相同" />
          <small className="muted">验证以读代码和跑命令为主，可以配一个更快的模型来缩短每个任务的验证时间。</small>
        </label>
      )}
      {e.provider === 'codex' && (
        <div className="grid2">
          <label>
            沙箱
            <select value={e.codexSandbox} onChange={(ev) => setExec('codexSandbox', ev.target.value as ExecConfig['codexSandbox'])}>
              <option value="workspace-write">workspace-write：可改代码目录内的文件</option>
              <option value="danger-full-access">danger-full-access：不设沙箱（仅限隔离环境）</option>
              <option value="read-only">read-only：只读，无法实现任务</option>
            </select>
          </label>
          <label>
            模型
            <ModelSelect value={e.codexModel} onChange={(v) => setExec('codexModel', v)} emptyLabel="使用 Codex 的默认模型" />
          </label>
        </div>
      )}
      {e.provider === 'custom' && (
        <label>
          代理命令
          <textarea rows={2} className="mono" value={e.customCommand} onChange={(ev) => setExec('customCommand', ev.target.value)} placeholder="例如 my-agent --non-interactive" />
          <small className="muted">
            在代码目录下通过系统 shell 执行；提示词从标准输入传入，标准输出作为结果。当前阶段和权限通过环境变量 ABU_STAGE（analysis / implement / verify / preflight）和 ABU_ACCESS（read / write）告知，只读由命令自己保证。这类代理不提供事件流，系统无法核对它实际做了哪些操作，会话记录里会如实标注。
          </small>
        </label>
      )}
      <VerifyCommands projectId={project.id} value={e.verifyCommands} onChange={(v) => setExec('verifyCommands', v)} />
      {e.provider === 'claude' && (
        <label>
          单次会话花费上限（美元）
          <input type="number" min={0} max={1000} step={0.5} value={e.budgetUsd} onChange={(ev) => setExec('budgetUsd', Number(ev.target.value))} />
          <small className="muted">生成规格、实现、验证各算一次会话；超出后该会话停止，任务进入「异常」。0 表示不限。</small>
        </label>
      )}
      <label>
        测试命令
        <input value={e.testCommand} onChange={(ev) => setExec('testCommand', ev.target.value)} placeholder="例如 npm test；可留空" />
        <small className="muted">在代码目录下通过系统 shell 执行。填写后每个任务实现完都会运行，退出码非 0 直接判未通过。</small>
      </label>
      <div className="grid2">
        <label>
          验证方式
          <select value={e.verificationMode} onChange={(ev) => setExec('verificationMode', ev.target.value as ExecConfig['verificationMode'])}>
            <option value="agent">代理按验收项逐项验证</option>
            <option value="command">只运行测试命令</option>
          </select>
        </label>
        <label>
          测试命令超时（分钟）
          <input type="number" min={1} max={240} value={e.testTimeoutMinutes} onChange={(ev) => setExec('testTimeoutMinutes', Number(ev.target.value))} />
        </label>
      </div>
      <small className="muted">「只运行测试命令」不逐项核对：命令通过即视为自动验证的验收项通过。人工验证的项不阻断流转，列为部署后的核对清单。没有填写测试命令时仍由代理验证。</small>
      <div className="grid2">
        <label>
          单任务超时（分钟）
          <input type="number" min={1} max={240} value={e.timeoutMinutes} onChange={(ev) => setExec('timeoutMinutes', Number(ev.target.value))} />
        </label>
        <label>
          生成规格超时（分钟）
          <input type="number" min={1} max={60} value={e.analyzeTimeoutMinutes} onChange={(ev) => setExec('analyzeTimeoutMinutes', Number(ev.target.value))} />
        </label>
        <label>
          门禁通过后
          <select value={e.passTarget} onChange={(ev) => setExec('passTarget', ev.target.value as 'done' | 'review')}>
            <option value="done">直接标记为已通过</option>
            <option value="review">进入待验证，人工确认后标记为已通过</option>
          </select>
        </label>
      </div>
      <small className="muted">
        门禁按事实判定，不看代理的自述：实现阶段没有改动、会话没有调用任何工具、测试命令失败或任一验收项未通过，任务进入「异常」；该自动验证的验收项没验到、改动超出确认的范围、或验收项全部是人工验证，进入「待验证」；人工验证的项不阻断，列为部署后的核对清单。
      </small>
      <label className="check">
        <input type="checkbox" checked={e.skipReview} onChange={(ev) => setExec('skipReview', ev.target.checked)} />
        需要人工确认的情况也直接通过，不进入待验证
      </label>
      <small className="muted">
        勾选后，上面说的会进入「待验证」的几种情况（包括文件执行前就有未提交的改动、分不清是哪个任务改的）都不再拦，按「门禁通过后」的设置流转；要人工确认的事项仍记在任务上。门禁判为未通过的任务照旧进入「异常」。
      </small>
      <h2 className="bar-title">流转方式</h2>
      <label className="check">
        <input type="checkbox" checked={e.autoConfirm} onChange={(ev) => setExec('autoConfirm', ev.target.checked)} />
        规格生成后自动确认，进入待修改
      </label>
      <small className="muted">只对第一次生成的规格、且没有待回答的问题时自动确认；有问题的、被退回后重新生成的，留在待确认等你看。不勾选时由你逐个确认，或在看板上把卡片拖到待修改。</small>
      <label className="check">
        <input type="checkbox" checked={e.autoStart} onChange={(ev) => setExec('autoStart', ev.target.checked)} />
        待修改里有任务就自动开工
      </label>
      <small className="muted">一次只执行一个，前一个结束才取下一个，同一个代码目录不会有两个任务同时改。你点过「暂停队列」后不再自动开工（服务重启后也一样），直到再点「启动队列」。某个任务失败后留在代码目录里的改动不会自动清掉，后面的任务碰到同一文件会转人工。</small>
      <label className="check">
        <input type="checkbox" checked={e.scheduleEnabled} onChange={(ev) => setExec('scheduleEnabled', ev.target.checked)} />
        每天定时启动队列
      </label>
      {e.scheduleEnabled && (
        <label>
          启动时间
          <input type="time" value={e.scheduleTime} onChange={(ev) => setExec('scheduleTime', ev.target.value)} required />
        </label>
      )}
      <small className="muted">
        到点后按待修改的先后顺序（确认的先后）逐个执行，待修改清空后自动暂停。时间按本机时区；到点时看板服务必须正在运行，错过的时间点不会补跑。只想跑某一个任务时，打开该待修改任务点「立即执行这一个」。
      </small>
      <label className="check">
        <input type="checkbox" checked={e.useBranch} onChange={(ev) => setExec('useBranch', ev.target.checked)} />
        每个任务新建 git 分支执行（claude-task/xxxx）
      </label>
      <label className="check">
        <input type="checkbox" checked={e.autoCommit} onChange={(ev) => setExec('autoCommit', ev.target.checked)} />
        门禁未判失败时自动提交代码（git commit，不推送）
      </label>
      <small className="muted">只提交实现阶段改动的文件；执行前已有的未提交改动、验证阶段留下的临时文件都不会混进去。提交信息为任务标题 + 代理的执行总结。</small>
      <label className="check">
        <input type="checkbox" checked={e.useKnowledge} onChange={(ev) => setExec('useKnowledge', ev.target.checked)} />
        积累项目知识
      </label>
      <small className="muted">
        生成规格和执行时附上本项目最近完成的相关任务（同「所属模块」优先，最多 5 个）。使用 Claude Code 时，还会让它在执行和验证结束前把可复用的经验写入项目记忆（~/.claude/projects/…/memory，和你平时在这个项目里用 Claude 的记忆是同一份）。
      </small>
      {e.provider === 'claude' && <SkillSettings projectId={project.id} exec={e} setExec={setExec} />}
      <label>
        通用要求（附加到每个任务提示词）
        <textarea rows={4} value={e.extraPrompt} onChange={(ev) => setExec('extraPrompt', ev.target.value)} placeholder="例如：所有新代码需要补充单元测试" />
      </label>

      <div className="actions">
        {msg && <span className={msg.error ? 'error' : 'muted'}>{msg.text}</span>}
        <span className="grow" />
        <button className="btn btn-primary">保存执行设置</button>
      </div>
    </form>
  );
}

interface VerifyKit {
  kinds: string[];
  commands: string[];
  allowedTools: string[];
  missingTools: string[];
}

/** 验证命令：代理验证时可以直接执行的命令。可按代码目录的内容检测出建议，由使用者确认后采用 */
function VerifyCommands({ projectId, value, onChange }: { projectId: string; value: string; onChange: (v: string) => void }) {
  const [kit, setKit] = useState<VerifyKit | null>(null);
  const [err, setErr] = useState('');
  const detect = () =>
    api<VerifyKit>(`/api/projects/${projectId}/verify-kit`).then(
      (k) => {
        setKit(k);
        setErr('');
      },
      (e: Error) => setErr(e.message),
    );
  const programs = [...new Set(value.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean))];
  return (
    <label>
      <span className="row">
        验证命令（每行一条）
        <span className="grow" />
        <button type="button" className="btn btn-outline sm" onClick={detect}>
          检测建议
        </button>
      </span>
      <textarea rows={3} className="mono" value={value} onChange={(ev) => onChange(ev.target.value)} placeholder={'例如\npython -m py_compile <改动的 .py 文件>\npython -m unittest discover -s tests'} />
      <small className="muted">
        代理验证时可以直接执行的命令，在代码目录下运行；会写进提示词，并自动放行其中用到的程序{programs.length ? `（当前：${programs.join('、')}）` : ''}。没有填写时，代理只能靠读代码验证，需要跑命令的验收项会转为人工确认。保存后，开工前自检会试跑这些程序。
      </small>
      {err && <small className="error">{err}</small>}
      {kit && (
        <span className="kit">
          {kit.commands.length ? (
            <>
              <small>检测到 {kit.kinds.join('、')}，建议的验证命令：</small>
              <code>{kit.commands.join('\n')}</code>
              <span className="row">
                <button type="button" className="btn btn-outline sm" onClick={() => onChange(kit.commands.join('\n'))}>
                  采用这些命令
                </button>
                <small className="muted">采用后仍需点页面底部的「保存执行设置」。尖括号里的内容是说明，代理会换成实际的文件。</small>
              </span>
            </>
          ) : (
            <small className="muted">没有从代码目录里识别出常见的技术栈，请手动填写。</small>
          )}
        </span>
      )}
    </label>
  );
}

/** 新建项目：只需要名称和代码目录，其余用默认值，之后在「项目管理 → 配置」里调整 */
export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void }) {
  const [name, setName] = useState('');
  const [workdir, setWorkdir] = useState('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  const [browse, setBrowse] = useState(false);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    try {
      const p = await api<Project>('/api/projects', 'POST', { name, workdir, feishu: { url } });
      onCreated(p);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // 浏览时只显示目录弹窗，选完或取消后回到本弹窗；已填的内容留在 state 里不丢
  if (browse) {
    return (
      <DirsDialog
        onPick={(p) => {
          setWorkdir(p);
          setErr('');
          setBrowse(false);
        }}
        onClose={() => setBrowse(false)}
      />
    );
  }

  return (
    <div className="overlay" onClick={onClose}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-project-title" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 id="new-project-title">新建项目</h2>
        <label>
          项目名称
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          代码目录
          <span className="row">
            <input className="grow" value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="点「浏览」选择，也可以直接填绝对路径" required />
            <button type="button" className="btn btn-outline-primary" onClick={() => setBrowse(true)}>
              浏览
            </button>
          </span>
        </label>
        <label>
          飞书多维表格链接（选填）
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxx.feishu.cn/wiki/...?table=..." />
        </label>
        {err && <div className="error">{err}</div>}
        <div className="actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary">创建</button>
        </div>
      </form>
    </div>
  );
}

/** 全局 Obsidian 知识库：门禁通过后按库内约定写入修复经验 */
export function VaultSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => {
    api<Settings>('/api/settings').then(setSettings, (e) => setMsg({ text: e.message, error: true }));
  }, []);
  if (!settings) return <p className="muted">加载中…</p>;
  const v = settings.vault;
  const set = (patch: Partial<Settings['vault']>) => setSettings({ ...settings, vault: { ...v, ...patch } });

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault();
    try {
      setSettings(await api<Settings>('/api/settings', 'PUT', { vault: v }));
      setMsg({ text: '已保存' });
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  };

  return (
    <form className="settings" onSubmit={save}>
      <h2 className="bar-title">知识库（Obsidian）</h2>
      <p className="muted">
        门禁通过后提炼一条修复经验，按知识库「00-使用约定」写入：跨项目经验进 30-技术经验、只对本项目成立的进 40-项目档案、拿不准进 90-收件箱；同名条目更新不新建，新条目在 00-索引 加一行。与项目记忆共用各项目的「积累项目知识」开关。
      </p>
      <label className="check">
        <input type="checkbox" checked={v.enabled} onChange={(ev) => set({ enabled: ev.target.checked })} />
        门禁通过后把修复经验写入知识库
      </label>
      <label>
        知识库目录
        <input value={v.path} onChange={(ev) => set({ path: ev.target.value })} placeholder="例如 D:\Notes\Claude" />
        <small className="muted">目录里需要有 00-索引.md。写入失败只记日志，不影响任务结果。</small>
      </label>
      <div className="actions">
        {msg && <span className={msg.error ? 'error' : 'muted'}>{msg.text}</span>}
        <span className="grow" />
        <button className="btn btn-primary">保存</button>
      </div>
    </form>
  );
}

/** 全局 skill 库：这个目录下 .claude/skills 里的 skill，所有项目的代理都能用 */
export function SkillLibrarySettings() {
  const [dir, setDir] = useState<string | null>(null);
  const [info, setInfo] = useState<{ dir: string; problem: string; skills: { name: string; description: string }[] } | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const loadInfo = () => api<{ dir: string; problem: string; skills: { name: string; description: string }[] }>('/api/skills/library').then(setInfo, () => setInfo(null));
  // 输入框改了还没保存时，检查结果对应的是旧目录，不显示
  const saved = !!info && info.dir === (dir ?? '').trim();
  useEffect(() => {
    api<Settings>('/api/settings').then((s) => setDir(s.skills.libraryDir), (e) => setMsg({ text: e.message, error: true }));
    void loadInfo();
  }, []);

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault();
    try {
      const s = await api<Settings>('/api/settings', 'PUT', { skills: { libraryDir: dir ?? '' } });
      setDir(s.skills.libraryDir);
      setMsg({ text: '已保存' });
      void loadInfo();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  };

  return (
    <form className="settings" onSubmit={save}>
      <h2 className="bar-title">Skill 库</h2>
      <p className="muted">
        代理修任务时能用的 skill 来自三处：目标项目代码目录下的 .claude/skills、这里指定的 skill 库、本机用户目录的 ~/.claude/skills。
        想让所有项目的代理都用上同一套 skill，就把它们放进一个目录的 .claude/skills 里，把那个目录填在这里；不用往每个项目里拷。
        每次任务开始时系统只把库里的 skill 复制一份给代理：代理改不到库里的原件，库目录下别的文件（配置、钩子、数据）也不会交给它。
      </p>
      {dir === null ? (
        <p className="muted">加载中…</p>
      ) : (
        <label>
          skill 库目录
          <input value={dir} onChange={(ev) => setDir(ev.target.value)} placeholder="例如 E:\my-skills，留空表示不用" />
          <small className="muted">填目录本身，不是 .claude/skills。每个项目用哪些、禁用哪些，在该项目的「执行设置 → Skill」里选。</small>
        </label>
      )}
      {saved && info?.problem && <div className="notice error">{info.problem}</div>}
      {saved && info && !info.problem && info.skills.length > 0 && (
        <small className="muted">
          库里有 {info.skills.length} 个 skill：{info.skills.map((s) => s.name).join('、')}
        </small>
      )}
      <div className="actions">
        {msg && <span className={msg.error ? 'error' : 'muted'}>{msg.text}</span>}
        <span className="grow" />
        <button className="btn btn-primary">保存</button>
      </div>
    </form>
  );
}

/** 全局飞书应用凭证，所有项目共用 */
export function FeishuSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => {
    api<Settings>('/api/settings').then(setSettings, (e) => setMsg({ text: e.message, error: true }));
  }, []);
  if (!settings) return <p className="muted">加载中…</p>;
  const f = settings.feishu;
  const set = (k: keyof Settings['feishu'], v: string) => setSettings({ ...settings, feishu: { ...f, [k]: v } });

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault();
    try {
      setSettings(await api<Settings>('/api/settings', 'PUT', { feishu: f }));
      setMsg({ text: '已保存' });
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  };

  return (
    <form className="settings" onSubmit={save}>
      <h2 className="bar-title">全局飞书连接</h2>
      <p className="muted">所有项目共用这个飞书自建应用读取多维表格、回写任务状态。凭证仅保存在本机 data/settings.json。各项目的表格链接在「项目管理 → 配置 → 项目信息」中配置。</p>

      <label>
        App ID
        <input value={f.appId} onChange={(ev) => set('appId', ev.target.value)} placeholder="cli_xxxxxxxx" required />
      </label>
      <label>
        App Secret
        <PwdInput value={f.appSecret} onChange={(v) => set('appSecret', v)} placeholder="应用密钥" />
      </label>

      <div className="help">
        <strong>权限准备</strong>
        <ol>
          <li>应用开启「机器人」能力，否则无法被添加为文档协作者。</li>
          <li>开通权限：bitable:app:readonly、wiki:wiki:readonly；电子表格内嵌的多维表格还需要 sheets:spreadsheet:readonly。</li>
          <li>要回写飞书状态：把 bitable:app:readonly 换成 bitable:app（可编辑多维表格）。</li>
          <li>发布应用版本使权限生效。</li>
          <li>由文档管理者在「管理协作者」→「添加协作者」中搜索并添加该应用，只导入授予可阅读，需要回写授予可编辑。</li>
        </ol>
      </div>

      <div className="actions">
        {msg && <span className={msg.error ? 'error' : 'muted'}>{msg.text}</span>}
        <span className="grow" />
        <button className="btn btn-primary">保存</button>
      </div>
    </form>
  );
}
