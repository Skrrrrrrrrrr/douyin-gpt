import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {atomicJson} from '../src/store.mjs';

const home='/data',proof={version:1,at:new Date().toISOString(),checks:{}};
function check(name,run){try{proof.checks[name]={ok:true,...run()};}catch(error){proof.checks[name]={ok:false,error:error.message.slice(0,400)};}}
check('node',()=>({version:process.version,platform:process.platform,architecture:process.arch}));
check('chromium',()=>({version:execFileSync('/usr/bin/chromium',['--version'],{encoding:'utf8'}).trim()}));
check('codex-cli',()=>{const version=execFileSync('codex',['--version'],{encoding:'utf8'}).trim(),r=spawnSync('codex',['--no-daemon','--ask-for-approval','never','exec','--ignore-user-config','--help'],{encoding:'utf8'});if(r.status!==0)throw new Error('Video parser CLI options are unavailable: '+r.stderr.slice(0,300));return {version,videoParserOptions:true};});
check('private-data',()=>{for(const name of ['config.json','state.json','memory.json','usage.json','comments.json'])if(JSON.parse(readFileSync(join(home,name),'utf8')).version!==1&&name!=='config.json')throw new Error('Invalid imported '+name);const d=JSON.parse(readFileSync(join(home,'service-desired.json'),'utf8'));if(d.worker!==false)throw new Error('Worker must remain paused during deployment verification');return {schemas:true,workerPaused:true};});
check('image-boundary',()=>{for(const name of ['openai.json','deepseek.json','config.json','.env','dashboard-auth.json'])if(existsSync(join('/app',name)))throw new Error('Private data unexpectedly included in image: '+name);return {privateRuntimeExcluded:true};});
check('python-video',()=>{
 const code=`import json, subprocess\nfrom pathlib import Path\nfrom PIL import Image, ImageDraw, ImageFont\nimport edge_tts, imageio_ffmpeg\nfrom pypinyin import lazy_pinyin\nout=Path('/data/container-checks');out.mkdir(exist_ok=True)\nfont=ImageFont.truetype('/System/Library/Fonts/STHeiti Light.ttc',28)\nim=Image.new('RGB',(320,240),'white');ImageDraw.Draw(im).text((20,50),'容器离线测试',font=font,fill='black');im.save(out/'chinese.png')\nff=imageio_ffmpeg.get_ffmpeg_exe()\nsubprocess.run([ff,'-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=white:s=320x240:r=10','-f','lavfi','-i','anullsrc=r=24000:cl=mono','-t','0.4','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',str(out/'codec.mp4')],check=True)\nresult=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','stream=codec_name','-of','json',str(out/'codec.mp4')]))\nassert {s['codec_name'] for s in result['streams']}=={'h264','aac'}\nprint(json.dumps({'chineseFont':True,'h264':True,'aac':True,'ttsLibrary':edge_tts.__version__,'pinyin':lazy_pinyin('测试')}))`;
 return JSON.parse(execFileSync('/opt/venv/bin/python',['-c',code],{encoding:'utf8',timeout:30000}));
});
proof.ok=Object.values(proof.checks).every(r=>r.ok);mkdirSync(join(home,'container-checks'),{recursive:true,mode:0o700});atomicJson(join(home,'container-checks','verification.json'),proof);console.log(JSON.stringify(proof));if(!proof.ok)process.exitCode=1;
