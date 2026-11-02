import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {loadEnv,homePath} from '../src/config.mjs';
import {provisionDashboardAuth} from '../src/dashboard-auth.mjs';

loadEnv();
const home=homePath(),action=process.argv[2]||'status';
if(action==='reset'){
 const {bootstrapFile}=provisionDashboardAuth(home,{reset:true});
 console.log('管理员账号：admin；旧密码和登录会话已失效。');
 console.log('请在本机文件中查看新初始密码：'+bootstrapFile);
}else if(action==='status'){
 const file=join(home,'dashboard-auth.json');
 if(!existsSync(file))console.log('后台首次启动时会生成管理员初始密码。');
 else{const data=JSON.parse(readFileSync(file,'utf8'));console.log(JSON.stringify({configured:true,username:data.username,mustChangePassword:data.mustChangePassword},null,2));}
}else throw new Error('用法：dashboard-auth.mjs status|reset');
