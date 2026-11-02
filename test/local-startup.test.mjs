import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {startLocal, startupStoragePlan, backgroundBrowserLaunch} from '../scripts/start-local.mjs';

function fixture() {
  const ops = [], desired = {worker: true, dashboard: true, maintenanceUntil: 0};
  let worker = false, dashboard = false, service = false;
  const deps = {
    desired: () => ({...desired}),
    resume: () => { ops.push('resume'); desired.worker = desired.dashboard = true; desired.maintenanceUntil = 0; },
    plan: () => { ops.push('plan'); return {existing: true}; },
    docker: async () => { ops.push('docker'); },
    database: async plan => { assert.equal(plan.existing, true); ops.push('database'); },
    storage: () => { ops.push('storage'); return {backend: 'postgres', ready: true, records: 27}; },
    dashboardStatus: async () => ({running: dashboard, url: dashboard ? 'http://127.0.0.1:3146' : null}),
    startDashboard: async () => { ops.push('dashboard'); dashboard = true; },
    workerStatus: async () => ({running: worker, pid: worker ? 12345 : null}),
    startWorker: async () => { ops.push('worker'); worker = true; },
    browser: async () => { ops.push('browser'); },
    session: async () => { ops.push('session'); return {ready: true}; },
    clearSessionStop: () => { ops.push('clear-session-stop'); },
    serviceStatus: async () => ({loaded: service}),
    installService: async () => { ops.push('service'); service = true; return {loaded: true}; },
  };
  return {deps, desired, ops, run: options => startLocal({home: '/unused', cfg: {}, log: () => {}, deps, ...options})};
}

test('重启后先验证原数据库和账号，再恢复服务；重复启动复用原执行进程', async () => {
  const h = fixture();
  const first = await h.run();
  assert.equal(first.worker, true);
  assert.equal(first.pid, 12345);
  assert.deepEqual(h.ops, ['plan', 'docker', 'database', 'storage', 'dashboard', 'service', 'browser', 'session', 'clear-session-stop', 'worker', 'storage']);
  const second = await h.run();
  assert.equal(second.reused, true);
  for (const op of ['dashboard', 'service', 'browser', 'session', 'worker']) assert.equal(h.ops.filter(x => x === op).length, 1, op);
});

test('人工暂停及维护期间只恢复基础服务，不打开浏览器或恢复执行', async () => {
  for (const change of [{worker: false}, {maintenanceUntil: Date.now() + 600000}, {worker: false, dashboard: false}]) {
    const h = fixture(); Object.assign(h.desired, change);
    const result = await h.run();
    assert.equal(result.paused, true);
    assert.equal(result.worker, false);
    assert.ok(!h.ops.includes('browser'));
    assert.ok(!h.ops.includes('session'));
    assert.ok(!h.ops.includes('worker'));
    if (change.dashboard === false) assert.ok(!h.ops.includes('dashboard'));
  }
});

test('仅显式 resume 恢复人工暂停；启动期间的新暂停优先', async () => {
  const h = fixture(); h.desired.worker = h.desired.dashboard = false;
  assert.equal((await h.run({resume: true})).worker, true);
  assert.equal(h.ops.filter(x => x === 'resume').length, 1);
  const paused = fixture();
  paused.deps.session = async () => { paused.desired.worker = false; return {ready: true}; };
  assert.equal((await paused.run()).paused, true);
  assert.ok(!paused.ops.includes('worker'));
});

test('数据库不可用、错误数据源或缺失绑定时，不能继续核对和启动执行', async () => {
  for (const storage of [{backend: 'postgres', ready: false}, {backend: 'files', ready: true}]) {
    const h = fixture(); h.deps.storage = () => storage;
    await assert.rejects(h.run(), e => e.code === 'STARTUP_DATABASE');
    assert.ok(!h.ops.includes('dashboard'));
    assert.ok(!h.ops.includes('browser'));
    assert.ok(!h.ops.includes('worker'));
  }
  const h = fixture(); h.deps.plan = () => { throw new Error('binding missing'); };
  await assert.rejects(h.run(), /binding missing/);
  assert.deepEqual(h.ops, []);
});

test('登录失效、账号不符或验证阻塞时保留管理入口，不清除阻塞或启动执行', async () => {
  for (const code of ['AUTH_REQUIRED', 'ACCOUNT_MISMATCH', 'PLATFORM_VERIFICATION', 'REMOTE_READ_EMPTY']) {
    const h = fixture(); h.deps.session = async () => ({ready: false, code, action: '请核对登录', userActionRequired: true});
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.dashboard, true);
    assert.equal(result.supervisor, true);
    assert.ok(!h.ops.includes('clear-session-stop'));
    assert.ok(!h.ops.includes('worker'));
  }
});

test('与守护同时启动时接受已经就绪的唯一执行进程，真实启动失败仍报错', async () => {
  const h = fixture(); let competing = false;
  h.deps.workerStatus = async () => ({running: competing, pid: competing ? 24680 : null});
  h.deps.startWorker = async () => { competing = true; throw new Error('launch raced'); };
  assert.equal((await h.run()).pid, 24680);
  const broken = fixture(); broken.deps.startWorker = async () => { throw new Error('launch failed'); };
  await assert.rejects(broken.run(), /launch failed/);
});

test('损坏运行目标不猜测为启动，不创建任何依赖', async () => {
  const h = fixture(); h.desired.corrupt = true;
  await assert.rejects(h.run(), e => e.code === 'STARTUP_DESIRED_CORRUPT');
  assert.deepEqual(h.ops, []);
});

test('后台浏览器使用原独立 profile、普通窗口和 open -g，参数不经 shell 展开', () => {
  const home = '/private/test space/$(not-a-command)';
  const args = backgroundBrowserLaunch(home, 12345, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.deepEqual(args.slice(0, 5), ['-g', '-n', '-a', '/Applications/Google Chrome.app', '--args']);
  assert.ok(args.includes('--user-data-dir=' + join(home, 'browser')));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(!args.some(x => /headless|activate|bringToFront/i.test(x)));
});

test('启动绑定与当前账号及既有本机凭证一致，不创建新凭证或泄露旧凭证', t => {
  const home = mkdtempSync(join(tmpdir(), 'dy-local-start-'));
  t.after(() => rmSync(home, {recursive: true, force: true}));
  const cfg = {account: {secUid: 'bound-fixture'}};
  const accountHash = createHash('sha256').update(cfg.account.secUid).digest('hex');
  const connectionFile = join(home, 'storage-connection.json'), passwordFile = join(home, 'database-password.txt');
  const binding = {version: 1, backend: 'postgres', namespace: 'assistant_' + accountHash, accountHash, connectionFile};
  const plan = {...binding, passwordFile, port: 15432};
  const write = (name, value) => writeFileSync(join(home, name), JSON.stringify(value), {mode: 0o600});
  const blocked = () => assert.throws(() => startupStoragePlan(home, cfg), e => e.code === 'STARTUP_STORAGE_CONFIG' && !e.message.includes('PRIVATE_FIXTURE'));
  blocked();
  write('storage.json', binding); write('storage-plan.json', plan);
  write('storage-connection.json', {host: '127.0.0.1', port: 15432, password: 'PRIVATE_FIXTURE'});
  writeFileSync(passwordFile, 'PRIVATE_FIXTURE\n', {mode: 0o600});
  const before = readFileSync(connectionFile, 'utf8');
  assert.deepEqual(startupStoragePlan(home, cfg), plan);
  assert.equal(readFileSync(connectionFile, 'utf8'), before);
  write('storage-plan.json', {...plan, accountHash: 'b'.repeat(64)}); blocked();
  write('storage-plan.json', plan); write('storage.json', {...binding, namespace: 'other'}); blocked();
  write('storage.json', binding); writeFileSync(passwordFile, 'WRONG_PRIVATE_FIXTURE'); blocked();
});
