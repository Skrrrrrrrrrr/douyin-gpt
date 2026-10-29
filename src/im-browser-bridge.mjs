// NEWJO 私信适配器通过此桥连接本程序已核对 profile 的专用聊天标签。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cdp } from './browser.mjs';
export { sleep } from './browser.mjs';

export async function openPage() {
  const home = process.env.DOUYIN_GPT_HOME;
  if (!home) throw new Error('缺少 DOUYIN_GPT_HOME');
  const runtime = JSON.parse(readFileSync(join(home, 'browser-runtime.json'), 'utf8'));
  const id = runtime.tabs?.chat;
  if (!id) throw new Error('聊天标签尚未初始化');
  const list = await (await fetch(`http://127.0.0.1:${Number(runtime.port)}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
  const target = list.find(t => t.id === id && t.type === 'page');
  if (!target) throw new Error('专用聊天标签已关闭');
  const page = await Cdp.connect(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  return { ev: expression => page.ev(expression), send: (...args) => page.send(...args), close: () => page.close(), status: 'managed-profile' };
}
