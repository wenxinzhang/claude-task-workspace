import { useEffect, useState } from 'react';
import { api, type ExecConfig } from './api.ts';

interface SkillInfo {
  name: string;
  description: string;
  scope: 'project' | 'library' | 'user';
}

type SkillField = 'analysisSkills' | 'implementSkills' | 'verifySkills' | 'disabledSkills';

/** 三个阶段各自「一定要用」的 skill，以及「不许用」的 */
const FIELDS: { key: SkillField; label: string; hint: string }[] = [
  { key: 'analysisSkills', label: '生成规格时必用', hint: '这一阶段只读代码，skill 里要执行命令的步骤会被跳过' },
  { key: 'implementSkills', label: '改代码时必用', hint: '例如调试、测试驱动开发类' },
  { key: 'verifySkills', label: '验证时必用', hint: '例如测试、完成前核验类；验证方式选「只运行测试命令」时不起作用' },
  { key: 'disabledSkills', label: '不许用', hint: '会自己提交、推送、合并分支的 skill 放这里：提交由看板统一处理' },
];

/** skill 的三个来源：写清楚各自在哪，下拉里按来源分组 */
const SOURCES: { scope: SkillInfo['scope']; label: string; where: string }[] = [
  { scope: 'project', label: '目标项目', where: '代码目录下的 .claude/skills' },
  { scope: 'library', label: 'Skill 库', where: '项目管理 → 全局设置里指定的目录' },
  { scope: 'user', label: '本机用户', where: '你电脑的 ~/.claude/skills' },
];

const split = (s: string) => s.split(/\s+/).filter(Boolean);

/** 各阶段 skill：先说明代理能用的 skill 从哪来、各有几个，再按阶段指定必用与禁用 */
export function SkillSettings({ projectId, exec, setExec }: { projectId: string; exec: ExecConfig; setExec: (k: SkillField, v: string) => void }) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    // 切换项目时先清空，并丢弃上一个项目晚到的响应
    let alive = true;
    setSkills(null);
    setErr('');
    api<SkillInfo[]>(`/api/projects/${projectId}/skills`).then(
      (list) => alive && setSkills(list),
      (e: Error) => alive && setErr(e.message),
    );
    return () => {
      alive = false;
    };
  }, [projectId]);

  const known = new Set(skills?.map((s) => s.name));
  const count = (scope: SkillInfo['scope']) => (skills ?? []).filter((s) => s.scope === scope).length;

  return (
    <div className="skill-settings">
      <div className="skill-head">
        <strong>Skill</strong>
        <small className="muted">代理修这个项目的任务时能用的 skill。不指定时由代理自己判断用哪个；下面只用来指定「一定要用」和「不许用」的。</small>
      </div>
      {skills ? (
        <ul className="skill-sources">
          {SOURCES.map((s) => (
            <li key={s.scope}>
              <strong>{s.label}</strong>
              <span className={count(s.scope) ? 'tag' : 'tag muted'}>{count(s.scope)} 个</span>
              <small className="muted">{s.where}</small>
            </li>
          ))}
        </ul>
      ) : (
        <small className="muted">{err || '读取中…'}</small>
      )}
      <small className="muted skill-note">同名的只算一次，按 目标项目 → Skill 库 → 本机用户 的顺序取。这个看板工具自己目录下的 .claude 是开发本工具用的，不会自动给代理；要用其中的 skill，把工具目录填成 Skill 库即可。</small>
      {FIELDS.map(({ key, label, hint }) => {
        const selected = split(exec[key]);
        const options = (skills ?? []).filter((s) => !selected.includes(s.name));
        return (
          <div className="skill-row" key={key}>
            <span className="skill-label">{label}</span>
            <div className="skill-chips">
              {selected.map((name) => (
                <span key={name} className={`chip${key === 'disabledSkills' ? ' chip-off' : ''}${skills && !known.has(name) ? ' chip-missing' : ''}`} title={skills && !known.has(name) ? '三个来源里都没有这个 skill' : undefined}>
                  {name}
                  <button type="button" aria-label={`移除 ${name}`} onClick={() => setExec(key, selected.filter((n) => n !== name).join(' '))}>
                    ×
                  </button>
                </span>
              ))}
              {options.length > 0 && (
                <select
                  className="skill-add"
                  value=""
                  aria-label={`为「${label}」添加 skill`}
                  onChange={(ev) => ev.target.value && setExec(key, [...selected, ev.target.value].join(' '))}
                >
                  <option value="">＋ 添加</option>
                  {SOURCES.map((src) => {
                    const group = options.filter((s) => s.scope === src.scope);
                    if (!group.length) return null;
                    return (
                      <optgroup key={src.scope} label={src.label}>
                        {group.map((s) => (
                          <option key={s.name} value={s.name} title={s.description}>
                            {s.name}
                            {s.description ? ` — ${s.description.slice(0, 40)}` : ''}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
              )}
            </div>
            <small className="muted skill-hint">{hint}</small>
          </div>
        );
      })}
    </div>
  );
}
