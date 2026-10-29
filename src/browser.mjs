import { spawn } from 'node:child_process';
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { atomicJson } from './store.mjs';
import { makeDirs } from './config.mjs';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function findBrowser() {
  const override = process.env.DOUYIN_BROWSER;
  if (override) {
    if (!existsSync(override)) throw new Error('DOUYIN_BROWSER 指向的浏览器不存在');
    return override;
  }
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
    : process.platform === 'win32'
      ? [join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'), join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(path => existsSync(path)) || '';
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
export async function probe(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${Number(port)}/json/version`, { signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
export class Cdp {
  static async connect(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('只允许连接本机浏览器');
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('浏览器 WebSocket 连接超时')); }, 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('浏览器 WebSocket 连接失败')); }, { once: true });
    });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) {
          try { Promise.resolve(listener(message.params || {})).catch(() => {}); } catch {}
        }
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(`CDP ${message.error.message}`)) : pending.resolve(message.result);
    });
    ws.addEventListener('close', () => this.rejectPending('浏览器连接已断开'));
    ws.addEventListener('error', () => this.rejectPending('浏览器连接发生错误'));
  }
  rejectPending(reason) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
    this.pending.clear();
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.listeners.get(method)?.delete(listener);
  }
  send(method, params = {}, timeout = 15_000) {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('浏览器连接不可用'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async ev(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 30_000);
    if (result.exceptionDetails) throw new Error('抖音页面执行失败：' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text || '').slice(0, 240));
    return result.result?.value;
  }
  close() { this.rejectPending('连接已关闭'); this.listeners.clear(); this.ws.close(); }
}
export class Browser {
  constructor(home, { headless = false } = {}) {
    this.home = resolve(home);
    this.headless = headless;
    this.runtimeFile = join(home, 'browser-runtime.json');
    this.pages = new Map();
  }
  async start({ initialUrl = 'https://www.douyin.com/' } = {}) {
    makeDirs(this.home);
    let runtime;
    try { runtime = JSON.parse(readFileSync(this.runtimeFile, 'utf8')); } catch {}
    if (runtime?.profile === join(this.home, 'browser')) {
      const info = await probe(runtime.port);
      if (info?.webSocketDebuggerUrl === runtime.wsUrl) {
        const cdp = await Cdp.connect(info.webSocketDebuggerUrl);
        try {
          const { arguments: args } = await cdp.send('Browser.getBrowserCommandLine');
          if (!args.includes(`--user-data-dir=${runtime.profile}`)) throw new Error('浏览器 profile 不匹配');
          const isHeadless = args.some(arg => arg === '--headless' || arg.startsWith('--headless='));
          if (!this.headless && isHeadless) {
            try { await cdp.send('Browser.close', {}, 3000); } catch {}
            cdp.close();
            for (let i = 0; i < 30 && await probe(runtime.port); i++) await sleep(200);
          } else {
            this.runtime = runtime;
            this.cdp = cdp;
            return;
          }
        } catch (error) { cdp.close(); throw error; }
      }
    }
    const browser = findBrowser();
    if (!browser) throw new Error('未找到 Chrome / Edge，请先安装浏览器或设置 DOUYIN_BROWSER');
    const port = await freePort();
    const profile = join(this.home, 'browser');
    const fd = openSync(join(this.home, 'browser.log'), 'a', 0o600);
    const args = [
      `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1', '--enable-automation',
      '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000',
      '--lang=zh-CN', ...(this.headless ? ['--headless=new'] : []), initialUrl,
    ];
    let child;
    try { child = spawn(browser, args, { detached: true, stdio: ['ignore', fd, fd] }); }
    finally { closeSync(fd); }
    let launchError;
    child.on('error', error => { launchError = error; });
    child.unref();
    let info;
    for (let i = 0; i < 60; i++) {
      if (launchError) throw launchError;
      info = await probe(port);
      if (info) break;
      await sleep(500);
    }
    if (!info) throw new Error('浏览器启动失败，检查 .data/browser.log；可能同一 profile 已在其他进程使用');
    this.cdp = await Cdp.connect(info.webSocketDebuggerUrl);
    this.runtime = { port, profile, wsUrl: info.webSocketDebuggerUrl, tabs: {}, pid: child.pid };
    atomicJson(this.runtimeFile, this.runtime);
  }
  async page(kind, url) {
    if (this.pages.has(kind)) return this.pages.get(kind);
    let id = this.runtime.tabs[kind];
    let targets = await (await fetch(`http://127.0.0.1:${this.runtime.port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
    let target = targets.find(t => t.id === id && t.type === 'page');
    if (!target) {
      const result = await this.cdp.send('Target.createTarget', { url });
      id = result.targetId;
      this.runtime.tabs[kind] = id;
      atomicJson(this.runtimeFile, this.runtime);
      for (let i = 0; i < 20 && !target; i++) {
        await sleep(100);
        targets = await (await fetch(`http://127.0.0.1:${this.runtime.port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
        target = targets.find(t => t.id === id);
      }
    }
    if (!target) throw new Error('浏览器标签创建失败');
    const page = await Cdp.connect(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    this.pages.set(kind, page);
    return page;
  }
  async navigate(page, url) {
    const parsed = new URL(url);
    if (!['https://www.douyin.com','https://creator.douyin.com'].includes(parsed.origin)||parsed.username||parsed.password) throw new Error('浏览器只允许访问抖音及创作者中心页面');
    await page.send('Page.navigate', { url });
    await sleep(1500);
    for (let i = 0; i < 25; i++) {
      try { if (await page.ev('document.readyState !== "loading"')) return; } catch {}
      await sleep(400);
    }
    throw new Error('抖音页面加载超时');
  }
  disconnect() {
    for (const page of this.pages.values()) page.close();
    this.pages.clear();
    this.cdp?.close();
  }
  async quit() {
    try { await this.cdp?.send('Browser.close', {}, 3000); } catch {}
    this.disconnect();
  }
}
