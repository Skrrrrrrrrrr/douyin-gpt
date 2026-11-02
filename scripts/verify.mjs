import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT} from '../src/config.mjs';

// Local gates only: no login, model generation, messaging, commenting, upload or publication.
const tests=readdirSync(join(ROOT,'test')).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>join(ROOT,'test',n));
const python=readdirSync(join(ROOT,'scripts')).filter(n=>n.endsWith('.py')).sort().map(n=>join(ROOT,'scripts',n));
const gates=[
 {name:'源码包文件边界',cmd:process.execPath,args:[join(ROOT,'scripts/package.mjs'),'--check-only']},
 {name:'JavaScript 与配置',cmd:process.execPath,args:[join(ROOT,'scripts/check.mjs')]},
 {name:'自动化回归',cmd:process.execPath,args:['--test',...tests]},
 {name:'控制台 TypeScript',cmd:process.platform==='win32'?'npm.cmd':'npm',args:['run','check'],cwd:join(ROOT,'web/cult')},
 {name:'Python 语法',cmd:process.env.PYTHON||'python3',args:['-c','import ast,pathlib,sys\nfor f in sys.argv[1:]: ast.parse(pathlib.Path(f).read_text(encoding="utf-8"),filename=f)\nprint(f"{len(sys.argv)-1} Python files parsed")',...python]},
];
const results=[];
for(const gate of gates){
 const started=Date.now(),r=spawnSync(gate.cmd,gate.args,{cwd:gate.cwd||ROOT,encoding:'utf8',timeout:180000,maxBuffer:10*1024*1024});
 const ok=!r.error&&r.status===0;results.push({name:gate.name,ok,seconds:Number(((Date.now()-started)/1000).toFixed(2))});
 console.log(`${ok?'PASS':'FAIL'} ${gate.name}`);console.log(String(ok?r.stdout:(r.stderr||r.stdout||r.error?.message||'')).trim().split('\n').slice(-12).join('\n'));
}
const ok=results.every(r=>r.ok);console.log(JSON.stringify({ok,checks:results},null,2));if(!ok)process.exitCode=1;
