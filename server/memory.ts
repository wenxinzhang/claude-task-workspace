import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './git.ts';

/**
 * Claude Code 的项目记忆目录：~/.claude/projects/<路径中非字母数字替换为 -> /memory
 * 以 git 仓库根目录为准（与交互式会话共用同一份记忆）；不是仓库时用代码目录本身。
 */
export function memoryDirFor(projectRoot: string, home = os.homedir()): string {
  const slug = path.resolve(projectRoot).replace(/[^A-Za-z0-9]/g, '-');
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects', slug, 'memory');
}

/** 找到代码目录对应的记忆目录，不存在则创建 */
export async function ensureMemoryDir(workdir: string): Promise<string> {
  const root = await git(['rev-parse', '--show-toplevel'], workdir).then(
    (s) => path.normalize(s.trim()),
    () => workdir,
  );
  const dir = memoryDirFor(root);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
