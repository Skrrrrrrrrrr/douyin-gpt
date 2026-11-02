import {loadEnv,homePath} from '../src/config.mjs';
import {dashboardOrigin,dashboardOrigins,setDashboardOrigins} from '../src/dashboard-origins.mjs';

loadEnv();const [action,value]=process.argv.slice(2),home=homePath();
if(action==='allow'&&value){const origin=dashboardOrigin(value);setDashboardOrigins(home,[...new Set([...dashboardOrigins(home),origin])]);console.log(`已允许管理页面来源：${origin}`);}
else if(action==='remove'&&value){const origin=dashboardOrigin(value);setDashboardOrigins(home,dashboardOrigins(home).filter(s=>s!==origin));console.log('已移除管理页面来源');}
else if(action==='status')console.log(JSON.stringify({origins:dashboardOrigins(home)},null,2));
else throw new Error('用法：dashboard-pages.mjs allow|remove https://dashboard.example.com，或 status');
