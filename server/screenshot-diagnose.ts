import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import { runAgent, type AgentRequest, type AgentResult } from './agent.ts';
import { cacheName, MAX_UPLOAD_BYTES, type AttachmentCache } from './attachments.ts';
import type { ObservationStore } from './observe.ts';
import { DEFAULT_OBSERVER_SETTINGS, type Observation, type ObservationAttribution, type ObserverSettings } from './observe-types.ts';
import type { Observer } from './observer.ts';

/** 截图诊断的输出契约：只产出诊断与建议，不产出代码改动 */
export const SCREENSHOT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '一句话概括看到的界面或流程问题' },
    detail: { type: 'string', description: '问题描述：截图里看到了什么、与用户说明的对应关系、可能的原因' },
    suggestion: { type: 'string', description: '修改建议：改哪个界面或流程、怎么改、改完怎么验证' },
    attribution: { type: 'string', enum: ['tool', 'project', 'environment', 'unknown'], description: '问题归属：工具自身/目标项目/环境/看不出来' },
  },
  required: ['title', 'detail', 'suggestion'],
};

const TITLE_LIMIT = 200;
const TEXT_LIMIT = 10_000;
const ATTRIBUTIONS: ObservationAttribution[] = ['tool', 'project', 'environment'];

export interface ScreenshotFinding {
  title: string;
  detail: string;
  suggestion: string;
  attribution?: ObservationAttribution;
}

/** 诊断输出归一：三个文本字段必填且非空，超长截断；归因只认三个枚举，unknown 置空不下结论 */
export function normalizeScreenshotFinding(raw: unknown): ScreenshotFinding | null {
  const r = raw as { title?: unknown; detail?: unknown; suggestion?: unknown; attribution?: unknown } | null;
  if (!r || typeof r !== 'object') return null;
  const text = (v: unknown, limit: number): string | null => {
    if (typeof v !== 'string' || !v.trim()) return null;
    return v.trim().slice(0, limit);
  };
  const title = text(r.title, TITLE_LIMIT);
  const detail = text(r.detail, TEXT_LIMIT);
  const suggestion = text(r.suggestion, TEXT_LIMIT);
  if (!title || !detail || !suggestion) return null;
  const out: ScreenshotFinding = { title, detail, suggestion };
  if (ATTRIBUTIONS.includes(r.attribution as ObservationAttribution)) out.attribution = r.attribution as ObservationAttribution;
  return out;
}

/** 诊断提示词：图片走 Read 工具读取（Claude）或 images 参数（Codex），只读授权，明示不改代码 */
export function screenshotPrompt(o: { imagePath: string; note: string; page: string; usageSummary: string }): string {
  const lines = [
    '你是这个缺陷修复工具的第三方观察者。用户上传了一张界面截图，请诊断其中反映的界面或流程问题。',
    `先用 Read 工具读取图片：${o.imagePath}`,
  ];
  if (o.page) lines.push(`截图来自页面：${o.page}`);
  if (o.note.trim()) lines.push(`用户说明：${o.note.trim()}`);
  if (o.usageSummary) lines.push(`近期使用概况（本地事件统计，供参考）：${o.usageSummary}`);
  lines.push(
    '你可以只读查阅 server/ 与 client/ 的代码来定位问题，但只诊断、不要修改任何文件，不得修改代码或配置。',
    '看不出来的不要猜：归因填 unknown，描述里写明截图不足以判断的部分。',
    '建议要具体到改哪个界面或流程、怎么改、改完怎么验证；不要建议放宽门禁或测试。',
  );
  return lines.join('\n');
}

export interface ScreenshotDeps {
  observations: ObservationStore;
  getSettings: () => { observer?: ObserverSettings };
  toolRoot: string;
  attachmentDir: string;
  run?: (req: AgentRequest) => Promise<AgentResult>;
}

export interface ScreenshotInput {
  imagePath: string;
  token: string;
  note: string;
  page: string;
  usageSummary: string;
}

/** 截图诊断编排：只读会话、中性 cwd、单飞；成功入 warn 发现，失败如实记 note 原因 */
export class ScreenshotDiagnoser {
  private busy = false;

  constructor(private deps: ScreenshotDeps) {}

  isBusy(): boolean {
    return this.busy;
  }

  private recordFailure(o: ScreenshotInput, reason: string): Observation {
    return this.deps.observations.add({
      projectId: '', kind: 'screenshot_finding', severity: 'note',
      title: '截图诊断失败', detail: reason.slice(0, TEXT_LIMIT),
      context: { screenshotToken: o.token }, source: 'code',
    });
  }

  async diagnose(o: ScreenshotInput): Promise<{ ok: boolean; observation?: Observation; error?: string }> {
    const s = this.deps.getSettings().observer ?? DEFAULT_OBSERVER_SETTINGS;
    if (!s.enabled) return { ok: false, error: '观察者未开启' };
    if (this.busy) return { ok: false, error: '已有截图诊断在进行' };
    this.busy = true;
    let cwd = '';
    try {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-shot-'));
      const run = this.deps.run ?? runAgent;
      const res = await run({
        cwd,
        exec: s.exec,
        stage: 'analysis',
        access: 'read',
        schema: SCREENSHOT_SCHEMA,
        prompt: screenshotPrompt(o),
        images: [o.imagePath],
        addDirs: [this.deps.attachmentDir, path.join(this.deps.toolRoot, 'server'), path.join(this.deps.toolRoot, 'client')],
        timeoutMs: 5 * 60_000,
      });
      const finding = res.ok ? normalizeScreenshotFinding(res.structured) : null;
      if (!finding) {
        const reason = res.ok ? '诊断输出不符合要求的形状' : res.text || '诊断会话失败';
        return { ok: false, error: reason, observation: this.recordFailure(o, reason) };
      }
      const observation = this.deps.observations.add({
        projectId: '', kind: 'screenshot_finding', severity: 'warn',
        title: finding.title,
        // 诊断详情放首位：派生的评审/Issue 草稿按前缀截断时，保住模型的分析而不是元信息
        detail: [finding.detail, '', `页面：${o.page || '未说明'}`, `用户说明：${o.note.trim() || '无'}`].join('\n'),
        suggestion: finding.suggestion,
        attribution: finding.attribution,
        context: { provider: res.evidence.provider, model: res.evidence.model, durationMs: res.evidence.durationMs, costUsd: res.evidence.costUsd, screenshotToken: o.token },
        source: 'llm',
      });
      return { ok: true, observation };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { ok: false, error: reason, observation: this.recordFailure(o, reason) };
    } finally {
      this.busy = false;
      if (cwd) {
        try {
          fs.rmSync(cwd, { recursive: true, force: true });
        } catch {
          // 代理残留文件句柄（Windows EBUSY），忽略
        }
      }
    }
  }
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 截图诊断路由：上传即返回（诊断后台跑，结果经台账 SSE 推送）；截图文件可查看、可删除 */
export function registerScreenshotRoutes(app: Express, observer: Observer, deps: { attachments: AttachmentCache; diagnoser: ScreenshotDiagnoser }): void {
  app.post('/api/observations/screenshot-diagnose', express.raw({ type: 'image/*', limit: MAX_UPLOAD_BYTES }), (req: Request, res: Response) => {
    try {
      if (!observer.status().enabled) throw new Error('观察者未开启');
      if (deps.diagnoser.isBusy()) throw new Error('已有截图诊断在进行，请稍后再试');
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error('请上传图片文件');
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
      let name = 'image';
      try {
        name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'image'));
      } catch {
        // 文件名编码异常时用默认名
      }
      const att = deps.attachments.saveUpload(req.body, name, type);
      const page = String(req.query.page ?? '').slice(0, 64);
      const note = String(req.query.note ?? '').slice(0, 2000);
      const m = observer.usageMetrics(1);
      const usageSummary = m.eventCount
        ? `近 1 天 ${m.eventCount} 条事件；连点 ${m.repeatedClicks.map((r) => `${r.target}×${r.repeats}`).join('、') || '无'}；操作错误 ${m.errorTargets.map((r) => `${r.target}×${r.n}`).join('、') || '无'}`
        : '';
      const imagePath = path.join(deps.attachments.dir, cacheName(att));
      // 发射后不管：诊断最长 5 分钟，不阻塞 HTTP；失败也会如实记进台账
      void deps.diagnoser.diagnose({ imagePath, token: att.token, note, page, usageSummary }).catch(() => {});
      res.json({ started: true, token: att.token });
    } catch (e) {
      res.status(400).json({ error: errorMessage(e) });
    }
  });
  const fileOf = (token: string): string => {
    if (!/^local_[a-f0-9]{32}$/.test(token)) throw new Error('截图标识不合法');
    if (!fs.existsSync(deps.attachments.dir)) throw new Error('截图不存在');
    const hit = fs.readdirSync(deps.attachments.dir).find((f) => f.startsWith(`${token}.`));
    if (!hit) throw new Error('截图不存在');
    return path.join(deps.attachments.dir, hit);
  };
  app.get('/api/observations/screenshot/:token', (req, res) => {
    try {
      res.sendFile(fileOf(req.params.token));
    } catch (e) {
      res.status(400).json({ error: errorMessage(e) });
    }
  });
  app.delete('/api/observations/screenshot/:token', (req, res) => {
    try {
      fs.rmSync(fileOf(req.params.token), { force: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: errorMessage(e) });
    }
  });
}
