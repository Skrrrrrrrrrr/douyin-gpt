import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, defaultConfig, validateConfig } from '../src/config.mjs';

function walk(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    if (['.data', 'node_modules', '.git'].includes(entry.name)) return [];
    const file = join(path, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
let count = 0;
for (const file of walk(ROOT).filter(f => f.endsWith('.mjs'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
  count++;
}
validateConfig(defaultConfig());
for (const file of ['README.md', 'NOTICE.md', 'vendor/newjo/LICENSE', '.env.example']) readFileSync(join(ROOT, file));
console.log(`✓ ${count} 个 JavaScript 文件语法通过；默认配置和必要文件齐全`);
