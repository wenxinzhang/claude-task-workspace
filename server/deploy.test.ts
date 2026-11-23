import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Deployer } from './deploy.ts';

const finished = (d: Deployer, id: string) =>
  new Promise<void>((resolve) => {
    const check = () => {
      if (!d.status(id).running) {
        d.off('status', check);
        resolve();
      }
    };
    d.on('status', check);
  });

describe('Deployer', () => {
  it('退出码 0 为成功，并记录输出', async () => {
    const d = new Deployer();
    const done = finished(d, 'p');
    d.start('p', { command: 'echo deployed-ok', cwd: os.tmpdir(), timeoutMs: 30_000, commit: 'abc123 msg' });
    expect(d.status('p').running).toBe(true);
    expect(() => d.start('p', { command: 'echo x', cwd: os.tmpdir(), timeoutMs: 30_000 })).toThrow('正在部署');
    await done;
    expect(d.status('p')).toMatchObject({ running: false, ok: true, commit: 'abc123 msg' });
    expect(d.logs('p').some((l) => l.includes('deployed-ok'))).toBe(true);
    expect(d.logs('p').at(-1)).toContain('部署成功');
  });

  it('部署环境的信息以环境变量交给部署命令，且不出现在命令那一行日志里', async () => {
    const d = new Deployer();
    const done = finished(d, 'p');
    const cmd = process.platform === 'win32' ? 'echo host=%DEPLOY_HOST%' : 'echo host=$DEPLOY_HOST';
    d.start('p', { command: cmd, cwd: os.tmpdir(), timeoutMs: 30_000, env: { DEPLOY_HOST: '10.1.2.3', DEPLOY_PASSWORD: 'qa-secret-value' } });
    await done;
    expect(d.status('p').ok).toBe(true);
    expect(d.logs('p').some((l) => l.includes('host=10.1.2.3'))).toBe(true);
    expect(d.logs('p').some((l) => l.includes('qa-secret-value'))).toBe(false);
  });

  it('非 0 退出码为失败', async () => {
    const d = new Deployer();
    const done = finished(d, 'p');
    d.start('p', { command: 'exit 3', cwd: os.tmpdir(), timeoutMs: 30_000 });
    await done;
    expect(d.status('p').ok).toBe(false);
    expect(d.logs('p').some((l) => l.includes('退出码 3'))).toBe(true);
  });

  it('构建 / 发布 / 健康检查三步骤，时长按实际计时', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const d = new Deployer();
      const done = finished(d, 'p');
      d.start('p', {
        command: 'echo published',
        buildCommand: 'echo built',
        healthCheck: `http://127.0.0.1:${port}/health`,
        cwd: os.tmpdir(),
        timeoutMs: 30_000,
        envName: '测试环境',
      });
      await done;
      const st = d.status('p');
      expect(st.ok).toBe(true);
      expect(st.envName).toBe('测试环境');
      expect(st.steps?.map((s) => s.name)).toEqual(['构建产物', '发布服务', '健康检查']);
      expect(st.steps?.every((s) => s.status === 'ok' && typeof s.durationMs === 'number')).toBe(true);
    } finally {
      server.close();
    }
  });

  it('构建失败就不发布，整体失败', async () => {
    const d = new Deployer();
    const done = finished(d, 'p');
    d.start('p', { command: 'echo should-not-run', buildCommand: 'exit 1', cwd: os.tmpdir(), timeoutMs: 30_000 });
    await done;
    const st = d.status('p');
    expect(st.ok).toBe(false);
    // 一开始就排好了全部步骤：构建失败后，发布服务标成跳过
    expect(st.steps?.map((s) => s.name)).toEqual(['构建产物', '发布服务']);
    expect(st.steps?.map((s) => s.status)).toEqual(['fail', 'skipped']);
    expect(d.logs('p').some((l) => l.includes('should-not-run'))).toBe(false);
  });

  it('修复后重试：第二遍步骤带后缀，passStart 指向第二遍，上一遍失败与跳过的步骤保留', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-repair-'));
    try {
      const d = new Deployer();
      const done = finished(d, 'p');
      d.start('p', {
        command: 'echo published',
        // 第一遍没有标记文件就失败；修复时写入标记文件，第二遍通过
        buildCommand: `node -e "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)"`,
        cwd: dir,
        timeoutMs: 30_000,
        maxRepairs: 2,
        repair: async () => {
          fs.writeFileSync(path.join(dir, 'fixed.txt'), 'ok');
          return true;
        },
      });
      await done;
      const st = d.status('p');
      expect(st.ok).toBe(true);
      expect(st.repaired).toBe(true);
      expect(st.aborted).toBeUndefined();
      expect(st.steps?.map((s) => s.name)).toEqual(['构建产物', '发布服务', '智能体修复（第 1 轮）', '构建产物（第 2 次）', '发布服务（第 2 次）']);
      expect(st.steps?.map((s) => s.status)).toEqual(['fail', 'skipped', 'ok', 'ok', 'ok']);
      expect(st.passStart).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('手动停止：正在跑的那步记失败，没轮到的标跳过，状态带 aborted', async () => {
    const d = new Deployer();
    const done = finished(d, 'p');
    const publishing = new Promise<void>((resolve) => {
      const check = () => {
        if (d.status('p').steps?.some((s) => s.name === '发布服务' && s.status === 'running')) {
          d.off('status', check);
          resolve();
        }
      };
      d.on('status', check);
    });
    d.start('p', {
      command: `node -e "setTimeout(() => {}, 20000)"`,
      healthCheck: 'http://127.0.0.1:1/health',
      cwd: os.tmpdir(),
      timeoutMs: 30_000,
    });
    await publishing;
    d.stop('p');
    await done;
    const st = d.status('p');
    expect(st.ok).toBe(false);
    expect(st.aborted).toBe(true);
    expect(st.steps?.map((s) => s.status)).toEqual(['fail', 'skipped']);
    expect(st.steps?.some((s) => s.status === 'pending' || s.status === 'running')).toBe(false);
  }, 15_000);
});
