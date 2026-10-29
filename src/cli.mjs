#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROOT, loadEnv, homePath, initConfig, readConfig, writePrivate, modelConfig, dayKey, PROVIDERS, providerBrowse, providerEngagement, providerLabel } from './config.mjs';
import { Store, atomicJson, takeLock } from './store.mjs';
import { Browser, findBrowser } from './browser.mjs';
import { Douyin } from './douyin.mjs';
import { Messenger } from './messenger.mjs';
import { Gpt } from './openai.mjs';
import { Engine } from './engine.mjs';
import { importChromeLogin } from './import-chrome.mjs';
import { Comments } from './comments.mjs';
import { CommentStore } from './comment-store.mjs';
import { CommentAutomation } from './comment-automation.mjs';
import { DailyJournal, journalDay } from './journal.mjs';

loadEnv();
const home = homePath();
const [command = 'help', ...args] = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const log = message => console.log(`[${new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}] ${message}`);
const help = `douyin-gpt · Mac / GPT 抖音助手

  init                              初始化配置与 .env
  doctor                            检查浏览器、密钥和配置（不联网）
  login [--account 抖音号]           打开独立浏览器，扫码并绑定账号
  import-chrome [--account 抖音号]   仅迁移当前 Mac Chrome 的抖音登录 Cookie
  contacts                          列出最近会话的稳定账号 ID（只读）
  allow --id sec_uid --label 昵称    加入自动回复名单，核对账号后写入
  deny --id sec_uid                 移出名单
  once                              预览回复并浏览一轮，不发消息
  once --live                       正式运行一轮
  start --live                      持续刷视频、回私信，并执行已启用的评论操作
  status                            查看运行记录与今日计数
  journal [--day YYYY-MM-DD] [--refresh]  生成每日总结和完整视频日志，不打开浏览器
  outbox                            查看回复记录
  comments-outbox                   查看公开评论和评论回复记录
  comments-resolve --id ID --as sent|skip  核对评论发送结果后解除暂停
  resolve --id 记录ID --as sent|skip 人工核对结果后解除会话暂停
  browser-close                     关闭本程序的专用浏览器

数据目录：${home}
更改联系人或设置后，重启 start。Ctrl+C 停止运行。
首次启动只记录已有消息，只回复启动后新到的消息。`;

async function main() {
  if (command === 'help' || args.includes('--help')) { console.log(help); return; }
  if (command === 'init') {
    initConfig(home);
    const envFile = join(ROOT, '.env');
    if (!existsSync(envFile)) writePrivate(envFile, readFileSync(join(ROOT, '.env.example'), 'utf8'));
    console.log(`已初始化。\n配置：${join(home, 'config.json')}\n密钥：${envFile}\n接下来填 OPENAI_API_KEY，然后 npm run login`);
    return;
  }
  const cfg = readConfig(home);
  if (command === 'doctor') {
    const checks = [
      ['Node.js ≥22', Number(process.versions.node.split('.')[0]) >= 22],
      ['Chrome / Edge', Boolean(findBrowser())],
      ['OPENAI_API_KEY 已设置', Boolean(modelConfig().apiKey)],
      ...(cfg.deepseek.enabled ? [['DEEPSEEK_API_KEY 已设置', Boolean(modelConfig('deepseek').apiKey)]] : []),
      ['账号已绑定', Boolean(cfg.account.secUid)],
      ['自动回复名单已配置', cfg.reply.contacts.some(c => c.enabled)],
    ];
    for (const [name, ok] of checks) console.log(`${ok ? '✓' : '·'} ${name}`);
    console.log(`模型：${modelConfig().model}；数据目录：${home}`);
    if (cfg.deepseek.enabled) console.log(`DeepSeek 模型：${modelConfig('deepseek').model}`);
    if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
    return;
  }
  if (command === 'status' || command === 'outbox' || command === 'comments-outbox') {
    const store = new Store(home);
    const comments = new CommentStore(home);
    if(command==='comments-outbox'){console.log(JSON.stringify(comments.data.actions.slice(-30),null,2));return;}
    if (command === 'outbox') console.log(JSON.stringify(store.data.outbox.slice(-30), null, 2));
    else console.log(JSON.stringify({
      account: cfg.account.douyinId || (cfg.account.secUid ? '已绑定' : '未绑定'),
      contacts: cfg.reply.contacts.filter(c => c.enabled).map(c => c.label),
      today: dayKey(), videosToday: store.videoCount(),
      privateReplyRouting: cfg.reply.routing.enabled ? { scope: '本轮未处理的新来信', keyword: cfg.reply.routing.deepseekKeyword, match: 'deepseek', otherwise: 'openai' } : { match: 'openai' },
      repliesToday: store.data.outbox.filter(o => o.day === dayKey() && o.status === 'sent').length,
      unresolved: store.data.outbox.filter(o => ['sending', 'uncertain'].includes(o.status)).map(o => ({ id: o.id, label: o.label, status: o.status })),
      lastBrowseAt: store.data.lastBrowseAt ? new Date(store.data.lastBrowseAt).toISOString() : null,
      comments: { enabled: cfg.engagement.enabled, postedToday: comments.count('comment'), repliedToday: comments.count('reply'), halted: comments.data.halted, inboxInitialized: comments.data.initialized },
      providers: Object.fromEntries(PROVIDERS.map(provider => {
        const browse = providerBrowse(cfg, provider), engagement = providerEngagement(cfg, provider);
        return [provider, {
          enabled: provider === 'openai' || cfg.deepseek.enabled,
          model: modelConfig(provider).model,
          videosToday: store.videoCount(dayKey(), provider), videosPerDay: browse.videosPerDay,
          commentsToday: comments.count('comment', dayKey(), provider), commentsPerDay: engagement.commentsPerDay,
          commentRepliesToday: comments.count('reply', dayKey(), provider), commentRepliesPerDay: engagement.repliesPerDay,
        }];
      })),
    }, null, 2));
    return;
  }
  if (!['login', 'import-chrome', 'contacts', 'allow', 'deny', 'once', 'start', 'journal', 'resolve', 'comments-resolve', 'browser-close'].includes(command)) throw new Error(`未知命令 ${command}，运行 node src/cli.mjs help 查看用法`);
  if (command === 'start' && !args.includes('--live')) throw new Error('持续自动回复使用 start --live；先预览可用 once');
  if (['once', 'start'].includes(command) && !modelConfig().apiKey) throw new Error('请先在项目 .env 填 OPENAI_API_KEY；不需要把密钥发到聊天里');
  if (['once', 'start'].includes(command) && cfg.deepseek.enabled && !modelConfig('deepseek').apiKey) throw new Error('请先在本机配置 DEEPSEEK_API_KEY，或关闭 deepseek.enabled');
  const release = takeLock(home, { runtimeId: arg('--runtime-id') || '' });
  let browser;
  let closeBrowser = false;
  try {
    const store = new Store(home);
    if (command === 'journal') {
      const day = journalDay(arg('--day') || dayKey());
      const models = { openai: new Gpt(modelConfig()) };
      if (cfg.deepseek.enabled) models.deepseek = new Gpt(modelConfig('deepseek'));
      const journal = new DailyJournal({home,cfg,store,models,ledger:new CommentStore(home),log});
      const file = await journal.refresh({day,force:args.includes('--refresh')});
      console.log(file ? `每日日志已保存：${file}${cfg.journal.outputDir ? `\n同步目录：${cfg.journal.outputDir}` : ''}` : '每日日志已关闭');
      return;
    }
    if(command==='comments-resolve'){
      const ledger=new CommentStore(home),action=ledger.data.actions.find(a=>a.id===arg('--id')),as=arg('--as');
      if(!action||!['draft','sending','accepted','uncertain','not_sent'].includes(action.status)||!['sent','skip'].includes(as))throw new Error('需要评论记录 ID，以及 --as sent 或 --as skip');
      ledger.transition(action,as==='sent'?'sent':'skipped','使用者核对，本命令不会重发');
      if(!ledger.data.actions.some(a=>['sending','uncertain'].includes(a.status))){ledger.data.halted='';ledger.save();}
      console.log('已记录评论核对结果，本条不会重发');return;
    }
    if (command === 'deny') {
      const id = arg('--id');
      if (!id) throw new Error('需要 --id sec_uid');
      cfg.reply.contacts = cfg.reply.contacts.filter(c => c.secUid !== id);
      atomicJson(join(home, 'config.json'), cfg);
      console.log('已从名单移除');
      return;
    }
    if (command === 'resolve') {
      const item = store.data.outbox.find(o => o.id === arg('--id'));
      const as = arg('--as');
      if (!item || !['sending', 'uncertain', 'draft'].includes(item.status) || !['sent', 'skip'].includes(as)) throw new Error('需要待核对的记录 ID，以及 --as sent 或 --as skip');
      store.transition(item, as === 'sent' ? 'sent' : 'skipped', '使用者人工核对；本命令不会重发');
      console.log('已记录核对结果。下次启动后可继续处理新消息，本条不会重发。');
      return;
    }
    if (command === 'import-chrome') {
      // 先让 Chrome 创建它自己的数据库，关闭后才能写入专用 profile。
      browser = new Browser(home, { headless: true });
      await browser.start({ initialUrl: 'about:blank' });
      await browser.quit();
      browser = null;
      // Browser.close 的回执可能早于 Cookie 数据库关闭，短暂等待进程释放。
      await new Promise(resolve => setTimeout(resolve, 1500));
      const imported = await importChromeLogin(home, arg('--profile'));
      browser = new Browser(home, { headless: true });
      await browser.start({ initialUrl: 'https://www.douyin.com/user/self' });
      const actual = await new Douyin(home, browser).whoami();
      const expectedId = arg('--account') || cfg.account.douyinId;
      if ((expectedId && expectedId !== actual.douyinId) || (cfg.account.secUid && cfg.account.secUid !== actual.secUid)) throw new Error('导入的账号与已绑定账号不一致，未修改账号绑定');
      cfg.account = { douyinId: actual.douyinId, secUid: actual.secUid };
      atomicJson(join(home, 'config.json'), cfg);
      console.log(`已复用 Chrome 的抖音登录态并核对账号：${actual.nickname}（${actual.douyinId}），迁移 ${imported.imported} 项抖音 Cookie。凭证内容未输出。`);
      return;
    }
    browser = new Browser(home, { headless: command === 'login' ? false : cfg.browser.headless });
    await browser.start();
    const dy = new Douyin(home, browser);
    const messenger = new Messenger(home, browser);
    if (command === 'browser-close') { await browser.quit(); browser = null; console.log('专用浏览器已关闭'); return; }
    if (command === 'login') {
      const expectedId = arg('--account') || cfg.account.douyinId;
      const page = await browser.page('account', 'https://www.douyin.com/');
      await browser.navigate(page, 'https://www.douyin.com/');
      await browser.cdp.send('Target.activateTarget', { targetId: browser.runtime.tabs.account });
      if (!stdin.isTTY) throw new Error('login 需要交互式终端，请在终端运行 npm run login');
      const prompt = createInterface({ input: stdin, output: stdout });
      try { await prompt.question(`请在专用浏览器里扫码登录${expectedId ? `抖音号 ${expectedId}` : '你的抖音账号'}，完成后按回车核对：`); }
      finally { prompt.close(); }
      const actual = await dy.whoami();
      if (expectedId && actual.douyinId !== expectedId) throw new Error(`登录账号与 --account 不一致；当前账号昵称为 ${actual.nickname}，未绑定`);
      if (cfg.account.secUid && cfg.account.secUid !== actual.secUid) throw new Error('已绑定另一个账号。更换账号请使用独立 DOUYIN_GPT_HOME 初始化，避免沿用聊天记录');
      cfg.account = { douyinId: actual.douyinId, secUid: actual.secUid };
      atomicJson(join(home, 'config.json'), cfg);
      console.log(`已绑定 ${actual.nickname}（抖音号 ${actual.douyinId}）。接下来 npm run contacts`);
      return;
    }
    await dy.checkAccount(cfg.account);
    if (command === 'contacts' || command === 'allow') {
      const contacts = await messenger.contacts();
      if (command === 'contacts') {
        console.table(contacts.map(c => ({ 昵称: c.nick, secUid: c.sec_uid, 未读: c.unread, 可加入名单: Boolean(c.sec_uid && !c.is_group) })));
        console.log('名单仅支持有稳定账号 ID 的个人会话；如未列全，可在浏览器会话列表滚动到目标后重试。');
      } else {
        const id = arg('--id');
        const hits = contacts.filter(c => c.sec_uid === id && !c.is_group);
        if (hits.length !== 1) throw new Error('当前会话列表无法唯一核对这个 secUid，请先运行 contacts');
        const label = arg('--label') || hits[0].nick;
        cfg.reply.contacts = cfg.reply.contacts.filter(c => c.secUid !== id);
        cfg.reply.contacts.push({ secUid: id, label, enabled: true });
        atomicJson(join(home, 'config.json'), cfg);
        store.contact(id).initialized = false;
        store.save();
        console.log(`已允许自动回复 ${label}；首次 start 会建立基线，之后自动回复新消息。`);
      }
      return;
    }
    // 只清理自己创建的过期截图。
    for (const name of readdirSync(join(home, 'frames'))) {
      if (/^\d{15,25}-\d+-\d+\.png$/.test(name)) {
        const file = join(home, 'frames', name);
        if (Date.now() - statSync(file).mtimeMs > 7 * 86_400_000) unlinkSync(file);
      }
    }
    store.recover();
    const controller = new AbortController();
    const stop = () => { log('正在停止，等待当前操作结束…'); controller.abort(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    messenger.signal = controller.signal;
    const gpt = new Gpt(modelConfig());
    gpt.signal = controller.signal;
    const models = { openai: gpt };
    if (cfg.deepseek.enabled) {
      models.deepseek = new Gpt(modelConfig('deepseek'));
      models.deepseek.signal = controller.signal;
    }
    const engagement = new CommentAutomation({home,cfg,gpt,models,comments:new Comments(home,browser),dy,store,live:args.includes('--live'),log});
    const engine = new Engine({ home, cfg, store, gpt, models, dy, messenger, engagement, live: args.includes('--live'), log });
    log(`${args.includes('--live') ? '正式运行' : '预览模式，不发消息'}；名单 ${cfg.reply.contacts.filter(c => c.enabled).length} 人`);
    log(cfg.reply.routing.enabled ? `私信路由：本轮新来信包含「${cfg.reply.routing.deepseekKeyword}」→ DeepSeek；否则 → GPT` : '私信路由：GPT');
    for (const provider of PROVIDERS.filter(p => models[p])) {
      const browse = providerBrowse(cfg,provider), settings = providerEngagement(cfg,provider);
      log(`[${providerLabel(provider)} / ${models[provider].config.model}] 视频 ${browse.videosPerDay}/天；公开评论：${settings.enabled&&settings.commentOnVideos?'开':'关'}（${settings.commentsPerDay}/天）；评论回复：${settings.enabled&&settings.replyToComments?'开':'关'}（${settings.repliesPerDay}/天）`);
    }
    try {
      if (command === 'start') await engine.run(controller.signal);
      else await engine.once(controller.signal);
      if (command === 'once') closeBrowser = true;
    } finally {
      if (controller.signal.aborted) closeBrowser = true;
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } finally {
    if (closeBrowser) await browser?.quit();
    else browser?.disconnect();
    release();
  }
}
main().catch(error => { console.error(`错误：${error.message}`); process.exitCode = 1; });
