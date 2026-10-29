import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, writePrivate } from './config.mjs';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export class Messenger {
  constructor(home, browser) { this.home = home; this.browser = browser; }
  async call(args) {
    await this.browser.page('chat', 'https://www.douyin.com/chat');
    const raw = await new Promise((resolve, reject) => {
      execFile(process.execPath, [join(ROOT, 'vendor/newjo/im-send.mjs'), ...args], {
        env: { ...process.env, DOUYIN_GPT_HOME: this.home },
        encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
        signal: this.signal,
      }, (error, stdout) => {
        if (stdout) resolve(stdout);
        else reject(new Error(error?.killed ? '私信读取/发送超时' : '私信适配器未返回结果'));
      });
    });
    let result;
    try { result = JSON.parse(raw); } catch { throw new Error('私信适配器返回无效 JSON'); }
    if (!result.ok) throw new Error(result.error || '私信操作失败');
    return result;
  }
  async contacts() { return (await this.call(['--list'])).people || []; }
  async read(contact) {
    const result = await this.call(['--read', '--to-id', contact.secUid, '--to', contact.label]);
    if (result.to_sec_uid !== contact.secUid || !result.verified_open) throw new Error('聊天会话身份无法核对');
    return result.messages || [];
  }
  async send(contact, text, expectedMessages) {
    if (!Array.isArray(expectedMessages) || !expectedMessages.length) throw new Error('发送缺少待回复会话快照');
    // 正文不进进程参数列表；临时文件权限为 0600。
    const file = join(this.home, `outgoing-${randomUUID()}.txt`);
    const expectedFile = file + '.json';
    writePrivate(file, text);
    try {
      writePrivate(expectedFile, JSON.stringify(expectedMessages.map(m => ({ id: m.id || '', from: m.from || 'unknown' }))));
      const result = await this.call(['--to-id', contact.secUid, '--to', contact.label, '--file', file, '--expected-file', expectedFile]);
      if (!result.sent || !result.readback || result.to_sec_uid !== contact.secUid) throw new Error('未确认发出的消息');
      return result;
    } finally { for (const path of [file, expectedFile]) { try { unlinkSync(path); } catch {} } }
  }
}
