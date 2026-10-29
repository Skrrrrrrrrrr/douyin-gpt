import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(pkg.version)) {
  throw new Error('package.json 需要有效版本号，例如 0.8.0');
}

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const blocked = new Set(['.data', '.git', 'node_modules', '__pycache__', 'browser', 'runtime', 'reports', 'frames', 'openai.json', 'deepseek.json', 'state.json', 'comments.json', 'Cookies', 'Login Data']);
const problems = [];
for (const file of files) {
  const parts = file.split('/');
  const name = parts.at(-1);
  const envFile = name === '.env' || (name.startsWith('.env.') && !name.endsWith('.example') && !name.endsWith('.sample'));
  if (envFile || file === 'config.json' || parts.some(part => blocked.has(part)) || /\.(?:log|zip|tgz|pem|key|p12|pfx)$/.test(name)) {
    problems.push(`${file}: 私有数据或运行产物`);
    continue;
  }
  const data = readFileSync(file).toString('latin1');
  if (/(?:^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{24,}/.test(data)
      || /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/.test(data)
      || /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(data)) {
    problems.push(`${file}: 疑似 API 密钥`);
  }
  if (/\/Users\/[^/\s]+/.test(data)) problems.push(`${file}: 本机用户绝对路径`);
}

const identities = execFileSync('git', ['log', '--all', '--no-use-mailmap', '--format=%H%x00%ae%x00%ce'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
for (const row of identities) {
  const [commit, ...emails] = row.split('\0');
  if (emails.some(email => !email.endsWith('@users.noreply.github.com') && email !== 'noreply@github.com')) {
    problems.push(`${commit.slice(0, 12)}: 提交身份包含个人邮箱，请使用 GitHub noreply 邮箱`);
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`✓ v${pkg.version}，${files.length} 个已跟踪文件及 ${identities.length} 个提交身份通过发布检查`);
}
