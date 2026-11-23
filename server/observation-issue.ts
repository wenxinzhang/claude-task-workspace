import { execFile } from 'node:child_process';
import { git } from './git.ts';
import type { ObservationIssue } from './observe-types.ts';

const githubPath = /^(?:https?:\/\/(?:[^/@\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/)([a-z\d][a-z\d-]*\/([a-z\d_.-]+?))(?:\.git)?\/?$/i;

export async function githubRepository(workdir: string | undefined): Promise<string> {
  if (!workdir) throw new Error('该问题尚未关联目标项目，无法确定提交仓库');
  const remote = await git(['remote', 'get-url', 'origin'], workdir).catch(() => '');
  const match = githubPath.exec(remote.trim());
  if (!match || match[2] === '.' || match[2] === '..') throw new Error('目标仓库没有配置可用的 GitHub origin');
  return match[1];
}

export type PublishObservationIssue = (repository: string, title: string, body: string) => Promise<Omit<ObservationIssue, 'repository'>>;

export const publishObservationIssue: PublishObservationIssue = (repository, title, body) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      ['api', '--hostname', 'github.com', '--method', 'POST', `repos/${repository}/issues`, '--input', '-'],
      {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_DEBUG: '' },
      },
      (err, out, stderr) => {
        if (err) {
          const status = /\bHTTP (\d{3})\b/.exec(stderr)?.[1];
          if (err.code === 'ENOENT') reject(new Error('请先安装 GitHub CLI（gh），然后运行 gh auth login'));
          else if (status === '401' || /gh auth login/i.test(stderr)) reject(new Error('请先运行 gh auth login 登录 GitHub'));
          else if (status && /^[34]/.test(status)) reject(new Error(`GitHub 拒绝创建 Issue（HTTP ${status}），请检查仓库权限或提交内容`));
          else reject(new Error('无法确认 Issue 是否创建成功，请先到目标仓库查看，再决定是否重试'));
          return;
        }
        try {
          const data = JSON.parse(out);
          const expected = `https://github.com/${repository}/issues/${data.number}`;
          if (!Number.isSafeInteger(data.number) || data.number <= 0 || String(data.html_url).toLowerCase() !== expected.toLowerCase()) throw new Error();
          resolve({ number: data.number, url: expected });
        } catch {
          reject(new Error('GitHub 返回的 Issue 回执异常，请先到目标仓库查看'));
        }
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({ title, body }));
  });
