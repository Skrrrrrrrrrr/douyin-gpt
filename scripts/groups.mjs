import {homePath,readConfig} from '../src/config.mjs';
import {Browser} from '../src/browser.mjs';
import {Douyin} from '../src/douyin.mjs';
import {Store,takeLock} from '../src/store.mjs';
import {GroupChats,groupSummary} from '../src/group-chats.mjs';
const home=homePath(),cfg=readConfig(home),release=takeLock(home),browser=new Browser(home,cfg.browser);
try{await browser.start();const store=new Store(home),groups=new GroupChats({home,cfg,store,models:{},dy:new Douyin(home,browser),browser});await groups.sync();console.log(JSON.stringify(groupSummary(home,cfg,store)));}
finally{browser.disconnect();release();}
