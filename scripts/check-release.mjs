import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(pkg.version)) {
  throw new Error('package.json 需要有效版本号，例如 0.8.0');
}

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const blocked = new Set(['.data', '.git', 'node_modules', '__pycache__', 'browser', 'runtime', 'openai.json', 'deepseek.json', 'state.json', 'comments.json', 'Cookies', 'Login Data']);
const problems = [];
for (const file of files) {
  const parts = file.split('/');
  const name = parts.at(-1);
  const envFile = name === '.env' || (name.startsWith('.env.') && !name.endsWith('.example') && !name.endsWith('.sample'));
  if (envFile || parts.some(part => blocked.has(part)) || /\.(?:log|zip|tgz)$/.test(name)) {
    problems.push(`${file}: 私有数据或运行产物`);
    continue;
  }
  const data = readFileSync(file).toString('latin1');
  if (/(?:^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{24,}/.test(data)
      || /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/.test(data)) {
    problems.push(`${file}: 疑似 API 密钥`);
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`✓ v${pkg.version}，${files.length} 个已跟踪文件通过发布检查`);
}
