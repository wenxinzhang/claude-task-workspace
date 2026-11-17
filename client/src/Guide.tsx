import { useEffect, useMemo, useRef, useState } from 'react';
import type { ManageTarget } from './ProjectsPage.tsx';
import type { View } from './Sidebar.tsx';

/** 看过或跳过指引后记在这台浏览器里；再想看点右上角的「操作指引」 */
const SEEN_KEY = 'guideSeen';

export const guideSeen = () => {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    // 存不了的环境（无痕模式等）不自动弹：否则每次打开都会弹一遍
    return true;
  }
};
const markSeen = () => {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // 忽略
  }
};

type Go = (view: View, manage?: ManageTarget) => void;

interface Step {
  title: string;
  text: string;
  /** 这一步要先打开哪个页面 */
  open?: () => void;
  /** 要圈出来的页面元素；没有就只显示说明 */
  find?: () => Element[];
  /** 圈的是一整段设置：把它滚到页面顶部再圈 */
  section?: boolean;
}

const one = (selector: string) => () => [...document.querySelectorAll(selector)].slice(0, 1);
/** 设置页里的一段：从这个小标题到下一个小标题之前 */
const section = (heading: string) => () => {
  const h = [...document.querySelectorAll('h2.bar-title')].find((e) => e.textContent?.trim() === heading && e.getClientRects().length);
  if (!h) return [];
  const out: Element[] = [h];
  for (let n = h.nextElementSibling; n && !n.matches('h2.bar-title'); n = n.nextElementSibling) out.push(n);
  return out;
};
/**
 * 一段设置里的一部分：从文字以 from 开头的那一项起，到文字以 until 中任一个开头的那一项之前（不给 until 就到这段末尾）。
 * 一整段比窗口还高时用它分成几步讲，说明卡片才不会压在要填的内容上
 */
const part = (heading: string, from: string, until?: string[]) => () => {
  const els = section(heading)();
  const starts = (e: Element, t: string) => !!e.textContent?.trim().startsWith(t);
  const i = els.findIndex((e) => starts(e, from));
  if (i < 0) return [];
  const j = until ? els.findIndex((e, k) => k > i && until.some((t) => starts(e, t))) : -1;
  return els.slice(i, j < 0 ? undefined : j);
};

/** 从零配置到跑通一个任务的完整流程，按先后顺序。没有项目时只到「添加项目」，建好后自动接上后面的步骤 */
function buildSteps(projectId: string | null, go: Go): Step[] {
  const global = () => go('projects', { kind: 'global' });
  const steps: Step[] = [
    {
      title: '从配置到跑通一个任务',
      text: '接下来按顺序带你走一遍：\n① 全局设置：可用模型、飞书连接\n② 建项目，配置代码目录、飞书来源、Git、部署环境\n③ 执行设置：用哪个代理和模型、怎么验证、门禁与流转\n④ 同步任务 → 生成规格 → 加入队列 → 启动执行\n⑤ 看结果、推送代码、部署\n指引打开时页面照常可以操作，可以边看边填。',
    },
    { title: '全局设置 · 可用模型', text: '添加你的代理命令（claude / codex）认识的模型名称，添加后自动保存。之后各项目的「模型」下拉框从这里选。\n不添加也能用：那样会使用代理命令自己的默认模型。', open: global, find: section('可用模型'), section: true },
    { title: '全局设置 · 飞书连接', text: '填飞书自建应用的 App ID 和 App Secret，并按下面「权限准备」开通权限、把应用加为表格协作者，填好后自动保存。\n不从飞书导入任务的话，这一步可以不填。', open: global, find: section('全局飞书连接'), section: true },
    { title: '添加项目', text: '点「添加项目」，填项目名称和代码目录（本机上的绝对路径）。一个项目对应一个代码目录和一个任务看板。\n建好之后，指引会接着讲这个项目的配置。', open: () => go('projects', { kind: 'list' }), find: one('.projects-page .page-head .btn-primary') },
  ];
  if (!projectId) return steps;
  const info = () => go('projects', { kind: 'project', id: projectId, tab: 'info' });
  const exec = () => go('projects', { kind: 'project', id: projectId, tab: 'exec' });
  return [
    ...steps,
    { title: '项目信息 · 基本信息', text: '确认项目名称和本地工作目录。代理会在这个目录里读代码、改代码、跑测试。\n目录需要是 git 仓库，系统才能核对每个任务改了哪些文件。', open: info, find: section('基本信息'), section: true },
    { title: '项目信息 · 飞书来源', text: '填多维表格的链接，再点「编辑」设置：按哪个字段、哪些取值过滤要导入的记录，指派给谁的才导入，以及任务换阶段时要不要把状态回写到飞书。', open: info, find: section('飞书来源'), section: true },
    { title: '项目信息 · Git 仓库', text: '点「编辑」填远端仓库地址和账号密码（HTTPS 远端需要），点「检测仓库」确认代码目录是 git 仓库。\n同步远端和推送代码用的就是这里的配置。', open: info, find: section('Git 仓库'), section: true },
    { title: '项目信息 · 部署环境', text: '点环境右边的「编辑」，填部署命令（必填才能部署），构建命令和健康检查地址按需要填。第一项是默认环境。\n在编辑面板里点「保存」就存好了。项目名称、工作目录、飞书链接改完自动保存。', open: info, find: section('部署环境'), section: true },
    { title: '执行设置 · 代理与模型', text: '选用哪个编码代理（Claude Code、Codex 或自定义命令），再设它的权限模式、允许的工具和模型。\n模型下拉里的选项来自全局设置的「可用模型」；验证阶段可以另选一个更快的模型。', open: exec, find: part('代理与权限', '编码代理', ['验证命令']), section: true },
    { title: '执行设置 · 验证与测试', text: '填验证命令（可点「检测建议」按代码目录自动给出）和测试命令，选验证方式；单次会话花费上限填 0 表示不限。\n测试命令填了之后，每个任务改完都会跑一遍，不通过就判未通过。', open: exec, find: part('代理与权限', '验证命令', ['单任务超时']), section: true },
    { title: '执行设置 · 超时与门禁', text: '设单任务和生成规格的超时。\n「门禁通过后」决定任务验证通过后去哪：直接标记为已通过，或先进待验证等你确认。不想让任务停在待验证等人确认，就勾选下面的那一项。', open: exec, find: part('代理与权限', '单任务超时'), section: true },
    { title: '执行设置 · 流转方式', text: '按需要勾选：规格生成后自动确认、待修改里有任务就自动开工、每天定时启动队列、每个任务新建分支、自动提交代码、积累项目知识。\n每一项下面的小字写了它具体怎么生效。', open: exec, find: part('流转方式', '规格生成后自动确认', ['Skill', '通用要求']), section: true },
    { title: '执行设置 · Skill', text: '指定各阶段一定要用或不许用的 skill；不指定时由代理自己判断。\n这一项只在编码代理选 Claude Code 时才有。', open: exec, find: part('流转方式', 'Skill', ['通用要求']), section: true },
    { title: '执行设置 · 通用要求', text: '「通用要求」会附加到每个任务的提示词里，例如要求新代码都补单元测试。\n执行设置这一页改完自动保存，底部会显示保存状态。', open: exec, find: part('流转方式', '通用要求') },
    { title: '把任务拿进来', text: '在任务收件箱点「手动飞书同步」，按刚才配置的过滤条件拉取表格里的记录。\n不用飞书的话，到任务看板的「批量操作 → 新建任务」手动建。', open: () => go('inbox'), find: one('.inbox-list-head') },
    {
      title: '生成规格并加入队列',
      text: '收件箱默认列出未完成的任务，每条下面的标签是它所在的阶段。选中一个「待确认」的任务，右上角会出现「生成规格」和「加入修复队列」。\n「生成规格」让代理写出目标、改动范围和验收项；规格里如果有问题要你回答，在「验收规格」页签里答完，再点「加入修复队列」，任务就进入待修改。',
      open: () => go('inbox'),
      // 这两个按钮只在选中待确认的任务时才有：有就圈按钮，没有就圈页签
      find: () => (document.querySelector('.inbox-detail-head .head-actions .btn-primary') ? one('.inbox-detail-head .head-actions')() : one('.inbox-tabs')()),
    },
    { title: '启动执行队列', text: '到任务看板点「启动队列」。第一次会先自检（让代理读一个文件、跑一条命令），通过后按待修改的先后顺序逐个执行：改代码，然后自动验证。\n自检不过时，这里会写明原因。', open: () => go('board'), find: one('.board-page .rail-card') },
    { title: '看每个任务的结果', text: '每一列是一个阶段，列名下面的小字写了它的含义。任务跑完会落到靠右的某一列：验证通过的进最后的完成列；需要你核对的进「待验证」，点开卡片核对后点「验收通过」或「打回重做」；没跑通的进「异常」（有这类任务时才显示这一列），点开看原因。\n也可以拖动卡片改变阶段。', open: () => go('board'), find: () => [...document.querySelectorAll('.board-page .columns > .column > header, .board-page .columns > .column > .column-hint')] },
    { title: '推送代码与部署', text: '任务通过后改动已提交在本地。点「推送代码」推到远端，点「一键部署」按部署环境里的命令发布到测试环境。', open: () => go('board'), find: one('[data-guide="top-actions"]') },
    { title: '查执行记录', text: '每次 AI 修复、Git 同步、代码推送和部署的结果与耗时都列在下面，用这一排按类型筛选；点其中一行，右边显示它的详情和日志。\n失败了先来这里看原因。', open: () => go('history'), find: one('.records-page .records-toolbar') },
    { title: '随时再看', text: '这份指引只在第一次打开时自动出现。以后想再看，点右上角的「操作指引」。', find: one('[data-guide="guide-button"]') },
  ];
}

interface Box { left: number; top: number; width: number; height: number }
const CARD_W = 360;
const PAD = 6;

/** 一组元素合起来占的范围，裁到窗口之内；都不可见时为 null */
function boxOf(els: Element[]): Box | null {
  const rs = els.map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
  if (!rs.length) return null;
  const left = Math.max(8, Math.min(...rs.map((r) => r.left)) - PAD);
  const top = Math.max(8, Math.min(...rs.map((r) => r.top)) - PAD);
  const right = Math.min(window.innerWidth - 8, Math.max(...rs.map((r) => r.right)) + PAD);
  const bottom = Math.min(window.innerHeight - 8, Math.max(...rs.map((r) => r.bottom)) + PAD);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

/**
 * 说明卡片放哪：依次试被圈范围的右、左、下、上；四边都放不下（圈的是一大段设置）时放在圈内的右下角 ——
 * 那里通常是表单右侧的空白，比盖住左边的标签和输入框好。没有圈任何东西时居中。
 */
function placeCard(box: Box | null, cardH: number, aside: boolean): { left: number; top: number } {
  const W = window.innerWidth;
  const H = window.innerHeight;
  // 页面上开着弹窗或抽屉（多半是指引叫人点开的）：让到左下角，不压在它上面
  if (aside) return { left: 12, top: Math.max(12, H - cardH - 12) };
  if (!box) return { left: (W - CARD_W) / 2, top: Math.max(24, (H - cardH) / 3) };
  const top = Math.min(Math.max(12, box.top), H - cardH - 12);
  const left = Math.min(Math.max(12, box.left), W - CARD_W - 12);
  if (box.left + box.width + 16 + CARD_W <= W) return { left: box.left + box.width + 16, top };
  if (box.left - 16 - CARD_W >= 0) return { left: box.left - 16 - CARD_W, top };
  if (box.top + box.height + 12 + cardH <= H) return { left, top: box.top + box.height + 12 };
  if (box.top - 12 - cardH >= 0) return { left, top: box.top - 12 - cardH };
  return { left: Math.min(box.left + box.width, W) - CARD_W - 16, top: Math.min(box.top + box.height, H) - cardH - 16 };
}

/**
 * 操作指引：从全局设置、建项目、项目配置到同步任务、执行、部署，按先后顺序逐步带到对应页面并圈出要配置的地方。
 * 指引打开时页面照常可以操作（可以边看边填）；任何一步都可以一键跳过。
 */
export function Guide({ projectId, go, onClose }: { projectId: string | null; go: Go; onClose: () => void }) {
  const steps = useMemo(() => buildSteps(projectId, go), [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [aside, setAside] = useState(false);
  const step = steps[Math.min(index, steps.length - 1)];
  // 项目被删光后步骤变少：把位置收回来，否则再建项目时会直接跳到很后面的某一步
  useEffect(() => {
    if (index > steps.length - 1) setIndex(steps.length - 1);
  }, [index, steps.length]);

  const finish = () => {
    markSeen();
    onClose();
  };

  // 换到新的一步：先打开它所在的页面
  useEffect(() => {
    step.open?.();
    // 焦点还在卡片的按钮上（比如连按「上一步」）就不动它，否则再按一次回车会变成往前走
    if (!cardRef.current?.contains(document.activeElement)) nextRef.current?.focus();
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  // 页面切换、设置加载、使用者自己滚动或操作都会让位置变化，所以隔一会儿重新量一次。
  // 换步时先清掉上一步的圈：否则新页面还没渲染出来的那一小会儿，圈会停在上一步的位置上
  useEffect(() => {
    setBox(null);
    let scrolled = false;
    const measure = () => {
      // 开着弹窗或抽屉时不画圈：圈和压暗都在它们上面一层，会把弹窗一起压暗
      const modal = !!document.querySelector('.overlay');
      setAside(modal);
      if (modal) return setBox(null);
      const els = step.find?.() ?? [];
      if (els.length && !scrolled) {
        scrolled = true;
        els[0].scrollIntoView({ block: step.section ? 'start' : 'nearest' });
      }
      const next = boxOf(els);
      setBox((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    const timer = window.setInterval(measure, 250);
    return () => window.clearInterval(timer);
  }, [step]);

  const last = index >= steps.length - 1;
  const cardH = cardRef.current?.offsetHeight ?? 240;
  const raw = placeCard(box, cardH, aside);
  // 窗口比卡片还窄或还矮时也不跑到窗口外面去
  const pos = { left: Math.max(8, Math.min(raw.left, window.innerWidth - CARD_W - 8)), top: Math.max(8, Math.min(raw.top, window.innerHeight - cardH - 8)) };

  return (
    <div className="guide">
      {box && <div className="guide-spot" style={box} />}
      <div className="guide-card" ref={cardRef} role="dialog" aria-labelledby="guide-title" style={{ ...pos, width: CARD_W }}>
        <div className="guide-count">
          {Math.min(index, steps.length - 1) + 1} / {steps.length}
        </div>
        <h2 id="guide-title">{step.title}</h2>
        <p>{step.text}</p>
        <div className="guide-actions">
          <button className="link" onClick={finish}>
            跳过指引
          </button>
          <span className="grow" />
          {index > 0 && (
            <button className="btn btn-outline sm" onClick={() => setIndex(Math.min(index, steps.length - 1) - 1)}>
              上一步
            </button>
          )}
          <button ref={nextRef} className="btn btn-primary sm" onClick={() => (last ? finish() : setIndex(index + 1))}>
            {last ? '知道了' : index === 0 ? '开始' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  );
}
