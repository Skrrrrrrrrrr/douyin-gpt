import { readFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { ROOT, loadEnv, homePath, readConfig, modelConfig, makeDirs } from '../src/config.mjs';
import { atomicJson } from '../src/store.mjs';
import { sleep } from '../src/browser.mjs';

loadEnv();
const home = homePath(), command = process.argv[2] || 'status';
const file = join(home, 'daemon.json'), lockFile = join(home, 'process.lock');
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
function isWorker(meta) {
  if (!meta || !Number.isSafeInteger(meta.pid) || !meta.runtimeId) return false;
  try {
    process.kill(meta.pid, 0);
    const cmd = execFileSync('/bin/ps', ['-p', String(meta.pid), '-o', 'command='], { encoding: 'utf8' });
    return cmd.includes(join(ROOT, 'src/cli.mjs')) && cmd.includes(meta.runtimeId);
  } catch { return false; }
}
async function main() {
  const meta = read(file);
  if (command === 'status') {
    console.log(JSON.stringify({ running: isWorker(meta), stopping: Boolean(meta?.stoppingAt && isWorker(meta)), pid: isWorker(meta) ? meta.pid : null, log: join(home, 'assistant.log') }, null, 2));
    return;
  }
  if (command === 'stop') {
    if (!isWorker(meta)) { console.log('后台助手没有运行'); return; }
    atomicJson(file, { ...meta, stoppingAt: new Date().toISOString() });
    // 确认独有 runtimeId 和命令路径后才发信号，避免 PID 重用时误停其他进程。
    process.kill(meta.pid, 'SIGTERM');
    for (let i = 0; i < 150 && isWorker(meta); i++) await sleep(200);
    console.log(isWorker(meta) ? '已请求停止，正在结束当前操作' : '后台助手已停止');
    return;
  }
  if (command !== 'start') throw new Error('用法：background.mjs start|stop|status');
  if (isWorker(meta) && meta.stoppingAt) {
    for (let i = 0; i < 150 && isWorker(meta); i++) await sleep(200);
    if (isWorker(meta)) throw new Error('助手还在结束当前操作，请稍后再次启动');
  } else if (isWorker(meta)) { console.log(`后台助手已运行（PID ${meta.pid}）`); return; }
  const cfg = readConfig(home);
  if (!modelConfig().apiKey) throw new Error('请先配置 OPENAI_API_KEY');
  if (cfg.deepseek.enabled && !modelConfig('deepseek').apiKey) throw new Error('请先配置 DEEPSEEK_API_KEY');
  if (existsSync(lockFile)) {
    const lock = read(lockFile);
    if (lock?.pid) {
      try { process.kill(lock.pid, 0); throw new Error(`已有前台助手运行（PID ${lock.pid}）`); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  makeDirs(home);
  const runtimeId = randomUUID(), logFile = join(home, 'assistant.log');
  const fd = openSync(logFile, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [join(ROOT, 'src/cli.mjs'), 'start', '--live', '--runtime-id', runtimeId], {
      cwd: ROOT, detached: true, env: { ...process.env, DOUYIN_GPT_HOME: home }, stdio: ['ignore', fd, fd],
    });
  } finally { closeSync(fd); }
  let error;
  child.on('error', e => { error = e; });
  child.unref();
  const next = { pid: child.pid, runtimeId, startedAt: new Date().toISOString() };
  for (let i = 0; i < 50; i++) {
    if (error) throw error;
    const lock = read(lockFile);
    if (lock?.pid === child.pid && lock?.runtimeId === runtimeId && isWorker(next)) {
      atomicJson(file, next);
      console.log(`后台助手已启动（PID ${child.pid}）。日志：${logFile}`);
      return;
    }
    await sleep(100);
  }
  throw new Error('助手未正常启动，请检查本机 assistant.log');
}
main().catch(error => { console.error(`错误：${error.message}`); process.exitCode = 1; });
