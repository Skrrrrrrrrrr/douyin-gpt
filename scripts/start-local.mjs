import {existsSync, readFileSync} from 'node:fs';
import {join, isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT, loadEnv, homePath, readConfig} from '../src/config.mjs';
import {Browser, findBrowser, ownedBrowserProcess, probe, sleep} from '../src/browser.mjs';
import {takeLock} from '../src/store.mjs';
import {storageStatus} from '../src/storage.mjs';
import {serviceDesired, setDesired, serviceStatus, installService} from '../src/service-control.mjs';
import {probeSession, clearSessionStop} from '../src/recovery.mjs';
import {startDatabase} from './storage.mjs';

const exec = promisify(execFile);
const failure = (code, message) => Object.assign(new Error(message), {code});
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

// Startup uses the existing database binding; it never sets up or migrates a store.
export function startupStoragePlan(home, cfg) {
  try {
    const binding = readJson(join(home, 'storage.json'));
    const plan = readJson(join(home, 'storage-plan.json'));
    const accountHash = createHash('sha256').update(cfg.account.secUid).digest('hex');
    if (!cfg.account.secUid || binding.backend !== 'postgres' || plan.backend !== 'postgres'
      || binding.version !== 1 || plan.version !== 1 || binding.accountHash !== accountHash
      || plan.accountHash !== accountHash || plan.namespace !== binding.namespace
      || plan.connectionFile !== binding.connectionFile || !isAbsolute(plan.connectionFile)
      || !isAbsolute(plan.passwordFile) || !existsSync(plan.passwordFile)
      || !Number.isSafeInteger(plan.port) || plan.port < 1024 || plan.port > 65535) throw new Error();
    const connection = readJson(plan.connectionFile);
    if (!['127.0.0.1', 'localhost', '::1'].includes(connection.host) || connection.port !== plan.port
      || !connection.password || readFileSync(plan.passwordFile, 'utf8').trim() !== connection.password) throw new Error();
    return plan;
  } catch {
    throw failure('STARTUP_STORAGE_CONFIG', '原数据库绑定或凭证不完整，请检查本机配置；没有创建新库或回退旧数据。');
  }
}

async function ensureDocker(log) {
  const ready = async () => {
    try { await exec('docker', ['info', '--format', '{{.ServerVersion}}'], {timeout: 5000}); return true; }
    catch (error) { if (error.code === 'ENOENT') throw failure('DOCKER_MISSING', '未找到 Docker 命令，请检查 Docker Desktop 安装。'); return false; }
  };
  if (await ready()) return;
  log('正在后台启动 Docker Desktop，等待数据服务就绪…');
  try { await exec('/usr/bin/open', ['-g', '-a', 'Docker'], {timeout: 10000}); }
  catch { throw failure('DOCKER_START_FAILED', 'Docker Desktop 未能启动，请手动打开后重试。'); }
  const until = Date.now() + 120000;
  while (Date.now() < until) { if (await ready()) return; await sleep(2000); }
  throw failure('DOCKER_TIMEOUT', 'Docker 在两分钟内未就绪，请检查 Docker Desktop 后重试。');
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

export function backgroundBrowserLaunch(home, port, binary) {
  const appEnd = binary.indexOf('.app/');
  if (appEnd < 0) throw failure('BROWSER_APP_REQUIRED', '一键启动需要 macOS 的 Chrome 或 Edge 应用。');
  return ['-g', '-n', '-a', binary.slice(0, appEnd + 4), '--args',
    `--user-data-dir=${join(home, 'browser')}`, `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1', '--enable-automation', '--no-first-run',
    '--no-default-browser-check', '--window-size=1440,1000', '--lang=zh-CN',
    'https://www.douyin.com/user/self'];
}

async function ensureBrowser(home, cfg, log) {
  const profile = join(home, 'browser');
  let owned = ownedBrowserProcess(profile);
  if (!owned && !cfg.browser.headless) {
    const binary = findBrowser();
    if (!binary) throw failure('BROWSER_MISSING', '未找到 Chrome / Edge，请先安装原专用浏览器。');
    const port = await freePort();
    log('正在后台打开原专用浏览器，保留普通窗口与原登录资料…');
    // Explicit one-click launch only. Ordinary recovery still cannot reopen a closed window.
    await exec('/usr/bin/open', backgroundBrowserLaunch(home, port, binary), {timeout: 10000});
    for (let i = 0; i < 60; i++) {
      owned = ownedBrowserProcess(profile);
      if (owned && await probe(owned.port)) break;
      await sleep(500);
    }
    if (!owned || !await probe(owned.port)) throw failure('BROWSER_START_FAILED', '专用浏览器未能连接，请检查窗口或浏览器日志后重试。');
  }
  const browser = new Browser(home, cfg.browser);
  try { await browser.start(); } finally { browser.disconnect(); }
}

function realDependencies(home, cfg, log) {
  const script = async (name, args) => exec(process.execPath, [join(ROOT, 'scripts', name + '.mjs'), ...args], {
    cwd: ROOT, env: {...process.env, DOUYIN_GPT_HOME: home}, timeout: 65000, maxBuffer: 1000000,
  });
  return {
    desired: () => serviceDesired(home),
    resume: () => { setDesired(home, 'dashboard', true); setDesired(home, 'worker', true); },
    plan: () => startupStoragePlan(home, cfg),
    docker: () => ensureDocker(log),
    database: async plan => { try { await startDatabase(plan); } catch { throw failure('DATABASE_START_FAILED', '数据库未能就绪，请检查 Docker 中的 database 服务；已保留原数据卷。'); } },
    storage: () => storageStatus(home),
    dashboardStatus: async () => JSON.parse((await script('dashboard', ['status'])).stdout),
    startDashboard: () => script('dashboard', ['start', '--maintenance']),
    workerStatus: async () => JSON.parse((await script('background', ['status'])).stdout),
    startWorker: () => script('background', ['start', '--maintenance']),
    browser: () => ensureBrowser(home, cfg, log),
    session: () => probeSession(home, cfg),
    clearSessionStop: () => clearSessionStop(home),
    serviceStatus: () => serviceStatus(home),
    installService: () => installService(home),
  };
}

async function ensureComponent(deps, key) {
  const status = () => deps[key + 'Status']();
  let state = await status();
  if (state.running && !state.stopping) return state;
  try { await deps[key === 'worker' ? 'startWorker' : 'startDashboard'](); }
  catch (error) {
    // The LaunchAgent may finish the same start while we are waiting.
    state = await status();
    if (!state.running || state.stopping) throw error;
  }
  state = await status();
  if (!state.running || state.stopping) throw failure('STARTUP_' + key.toUpperCase(), `${key === 'worker' ? '执行进程' : '管理服务'}未启动，请查看对应日志。`);
  return state;
}

export async function startLocal({home, cfg, resume = false, log = console.log, deps = realDependencies(home, cfg, log)}) {
  if (deps.desired().corrupt) throw failure('STARTUP_DESIRED_CORRUPT', '运行目标记录损坏，请先在管理页明确选择启动或暂停。');
  const plan = deps.plan();
  if (resume) deps.resume();
  log('1/5 检查 Docker 与原数据库…');
  await deps.docker();
  await deps.database(plan);
  const storage = deps.storage();
  if (storage.backend !== 'postgres' || !storage.ready) throw failure('STARTUP_DATABASE', '原业务数据库不可用，后台没有启动。');
  log(`数据库已就绪（${storage.records} 份业务记录）。`);
  log('2/5 检查管理服务…');
  const dashboard = deps.desired().dashboard ? await ensureComponent(deps, 'dashboard') : {running: false, paused: true};
  log('3/5 检查登录守护…');
  let service = await deps.serviceStatus();
  if (!service.loaded) service = await deps.installService();
  if (!service.loaded) throw failure('STARTUP_SUPERVISOR', '登录守护未加载，请查看 supervisor.log。');
  const result = {ok: true, storage, dashboard: dashboard.running, url: dashboard.url || null, supervisor: service.loaded, worker: false};
  const desired = deps.desired();
  if (!desired.worker || desired.maintenanceUntil > Date.now()) {
    log('4/5 保留人工暂停或维护状态，未打开专用浏览器。');
    return {...result, paused: true};
  }
  const current = await deps.workerStatus();
  if (current.running && !current.stopping) {
    log('4/5 原执行进程已运行，复用现有进程。');
    return {...result, storage: deps.storage(), worker: true, pid: current.pid, reused: true};
  }
  log('4/5 恢复专用浏览器并核对原抖音账号…');
  await deps.browser();
  const session = await deps.session();
  if (!session.ready) return {...result, ok: false, code: session.code, action: session.action, needsUser: session.userActionRequired};
  deps.clearSessionStop();
  // A manual pause made while Docker/browser was starting wins.
  const latest = deps.desired();
  if (!latest.worker || latest.corrupt || latest.maintenanceUntil > Date.now()) return {...result, paused: true};
  log('5/5 恢复原执行进程…');
  const worker = await ensureComponent(deps, 'worker');
  return {...result, storage: deps.storage(), worker: true, pid: worker.pid};
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  if (args.some(arg => !['--resume', '--status'].includes(arg)) || args.includes('--resume') && args.includes('--status')) throw failure('STARTUP_USAGE', '用法：node scripts/start-local.mjs [--status | --resume]');
  if (process.platform !== 'darwin') throw failure('STARTUP_PLATFORM', '一键启动脚本用于当前 Mac；Docker 中只运行数据库。');
  const home = homePath(), cfg = readConfig(home);
  const deps = realDependencies(home, cfg, console.log);
  if (args.includes('--status')) {
    let storage;
    try { storage = deps.storage(); } catch (error) { storage = {ready: false, code: error.code || 'STORAGE_UNAVAILABLE'}; }
    console.log(JSON.stringify({home, storage, service: await deps.serviceStatus(), dashboard: await deps.dashboardStatus(), worker: await deps.workerStatus(), browser: Boolean(ownedBrowserProcess(join(home, 'browser')))}, null, 2));
    return;
  }
  const release = takeLock(join(home, 'startup'));
  try {
    const result = await startLocal({home, cfg, resume: args.includes('--resume'), deps});
    console.log(result.ok ? (result.paused ? '启动检查完成，任务保持暂停。' : '启动完成，抖音助手已在后台运行。') : `需要处理：${result.action || result.code}`);
    if (result.url) console.log('管理地址：' + result.url);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  } finally { release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  // Never print child-command error objects that may carry private environment/configuration.
  console.error(`启动未完成 [${error.code || 'STARTUP_FAILED'}]：${error.code?.startsWith('STARTUP_') || /^(DOCKER_|DATABASE_|BROWSER_)/.test(error.code || '') ? error.message : '请查看本机 assistant.log、dashboard.log 或 supervisor.log，原数据已保留。'}`);
  process.exitCode = 1;
});
