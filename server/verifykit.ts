import fs from 'node:fs';
import path from 'node:path';
import { allowedExecutables, commandExecutables, splitTools } from './shared.ts';

/** 按代码目录的内容给出的验证建议：由使用者确认后才写进项目设置 */
export interface VerifyKit {
  /** 识别出的技术栈，如「Python（backend）」 */
  kinds: string[];
  /** 建议的验证命令，在代码目录下执行 */
  commands: string[];
  /** 这些命令需要放行的工具规则 */
  allowedTools: string[];
  /** 其中当前白名单里还没有的 */
  missingTools: string[];
}

const SKIP = new Set(['node_modules', 'dist', 'build', 'venv', 'env', '__pycache__', 'target', 'vendor', 'coverage']);

function entries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readSmall(file: string): string {
  try {
    return fs.statSync(file).size < 512_000 ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

/** 看代码目录和它的一级子目录，识别技术栈并给出验证命令。只读文件名和配置文件，不执行任何命令 */
export function detectVerifyKit(workdir: string, currentAllowedTools = ''): VerifyKit {
  const kinds: string[] = [];
  const commands: string[] = [];
  const root = entries(workdir);
  const dirs = ['', ...root.filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')).map((e) => e.name)];

  let pythonAt: string | null = null;
  let pytest = false;
  for (const rel of dirs) {
    const list = rel ? entries(path.join(workdir, rel)) : root;
    const names = new Set(list.map((e) => e.name));
    const label = rel || '根目录';
    const at = (name: string) => path.join(workdir, rel, name);

    if (names.has('pyproject.toml') || names.has('requirements.txt') || names.has('setup.py') || list.some((e) => e.isFile() && e.name.endsWith('.py'))) {
      pythonAt ??= label;
      if (/\bpytest\b/.test(readSmall(at('requirements.txt')) + readSmall(at('pyproject.toml')))) pytest = true;
    }
    if (names.has('package.json')) {
      kinds.push(`Node（${label}）`);
      let scripts: Record<string, unknown> = {};
      try {
        scripts = JSON.parse(readSmall(at('package.json'))).scripts ?? {};
      } catch {
        // package.json 解析不了就不给脚本建议
      }
      const npm = rel ? `npm --prefix ${rel}` : 'npm';
      for (const s of ['typecheck', 'lint', 'test', 'build']) {
        if (typeof scripts[s] === 'string') commands.push(s === 'test' ? `${npm} test` : `${npm} run ${s}`);
      }
    }
    if (names.has('go.mod')) {
      kinds.push(`Go（${label}）`);
      const go = rel ? `go -C ${rel}` : 'go';
      commands.push(`${go} build ./...`, `${go} test ./...`);
    }
    if (names.has('Cargo.toml')) {
      kinds.push(`Rust（${label}）`);
      const flag = rel ? ` --manifest-path ${rel}/Cargo.toml` : '';
      commands.push(`cargo check${flag}`, `cargo test${flag}`);
    }
    if (names.has('pom.xml')) {
      kinds.push(`Maven（${label}）`);
      commands.push(rel ? `mvn -q -f ${rel}/pom.xml test` : 'mvn -q test');
    }
  }

  if (pythonAt) {
    kinds.unshift(`Python（${pythonAt}）`);
    const py: string[] = ['python -m py_compile <改动的 .py 文件>'];
    const testsDir = ['tests', 'test'].find((d) => root.some((e) => e.isDirectory() && e.name === d));
    if (pytest) py.push('python -m pytest');
    else if (testsDir) py.push(`python -m unittest discover -s ${testsDir}`);
    commands.unshift(...py);
  }

  const allowedTools = commandExecutables(commands.join('\n')).flatMap((exe) => [`Bash(${exe} *)`, `PowerShell(${exe} *)`]);
  const have = allowedExecutables(currentAllowedTools);
  const rules = new Set(splitTools(currentAllowedTools));
  const missingTools = have.has('*') ? [] : allowedTools.filter((r) => !rules.has(r) && !have.has(/\(([^\s*]+)/.exec(r)![1]));
  return { kinds, commands, allowedTools, missingTools };
}
