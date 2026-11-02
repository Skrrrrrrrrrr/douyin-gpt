import {readFileSync} from 'node:fs';
try{
 const state=JSON.parse(readFileSync('/data/container-runtime.json','utf8'));
 if(state.state!=='ready'||Date.now()-Date.parse(state.checkedAt)>60000)throw new Error('Container heartbeat stale');
 const response=await fetch('http://127.0.0.1:3147/api/auth/session',{signal:AbortSignal.timeout(2500)});
 if(!response.ok)throw new Error('Dashboard unavailable');
 const desktop=await fetch('http://127.0.0.1:6080/vnc.html',{signal:AbortSignal.timeout(2000)});
 if(!desktop.ok)throw new Error('Browser desktop unavailable');
 console.log('ok');
}catch(error){console.error(error.message);process.exitCode=1;}
