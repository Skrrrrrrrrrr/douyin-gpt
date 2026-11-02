import {loadEnv,homePath,readConfig} from '../src/config.mjs';
import {takeLock} from '../src/store.mjs';
import {Browser} from '../src/browser.mjs';
import {Douyin} from '../src/douyin.mjs';
import {Messenger} from '../src/messenger.mjs';
import {syncNativeStickers} from '../src/native-stickers.mjs';
import {stickerComposerInPage} from '../src/sticker-dom.mjs';
loadEnv();const home=homePath(),cfg=readConfig(home),release=takeLock(home),browser=new Browser(home,cfg.browser);
try{await browser.start();await new Douyin(home,browser).checkAccount(cfg.account);const contacts=cfg.reply.contacts.filter(c=>c.enabled);if(contacts.length!==1)throw new Error('诊断需要唯一允许的联系人');const messenger=new Messenger(home,browser);await messenger.read(contacts[0]);if(process.argv[2]==='sync-native'){console.log(JSON.stringify(await syncNativeStickers({home,cfg,browser,messenger,contact:contacts[0]}),null,2));}else{const page=await browser.page('chat','https://www.douyin.com/chat');if(browser.headless)await page.send('Page.bringToFront');console.log(JSON.stringify(await page.ev(`(${stickerComposerInPage.toString()})()`),null,2));}}finally{browser.disconnect();release();}
