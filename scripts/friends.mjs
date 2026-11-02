import {homePath,readConfig} from '../src/config.mjs';
import {Browser} from '../src/browser.mjs';
import {Douyin} from '../src/douyin.mjs';
import {takeLock} from '../src/store.mjs';
import {Friends} from '../src/friends.mjs';
import {friendSummary} from '../src/reply-audience.mjs';
const home=homePath(),cfg=readConfig(home),release=takeLock(home),browser=new Browser(home,cfg.browser);
try{await browser.start();await new Friends(home,cfg,new Douyin(home,browser)).sync({force:true});console.log(JSON.stringify(friendSummary(home,cfg)));}
finally{browser.disconnect();release();}
