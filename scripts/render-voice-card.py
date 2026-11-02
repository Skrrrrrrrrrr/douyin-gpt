"""Render a private reply card using the existing registered host and voice."""
import json,sys,math,wave,subprocess,importlib.util
from pathlib import Path
from array import array
from functools import lru_cache
from PIL import Image,ImageDraw
spec=importlib.util.spec_from_file_location('animation',Path(__file__).with_name('render-animated.py'));a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
def main(file):
 m=json.loads(Path(file).read_text());provider=m['provider'];audio=m['audio'];work=Path(m['workDir']);W,H,FPS=720,1280,20
 with wave.open(audio['file'],'rb') as wav:
  assert (wav.getnchannels(),wav.getsampwidth(),wav.getframerate())==(1,2,24000)
  samples=array('h');samples.frombytes(wav.readframes(wav.getnframes()))
 duration=max(5,math.ceil((len(samples)/24000+.3)*FPS)/FPS)
 if duration>m['maxSeconds']+.5:raise ValueError('Voice card too long')
 sheet=Image.open(Path(m['assets'])/('gpt-expressions.png' if provider=='openai' else 'deepseek-expressions.png')).convert('RGBA');cw,ch=sheet.width//3,sheet.height//2
 cells=[sheet.crop((x*cw,y*ch,(x+1)*cw,(y+1)*ch)) for y in range(2) for x in range(3)];cues=a.cues(audio);boxes=a.BOXES[provider]
 @lru_cache(maxsize=24)
 def actor(shape,blink):
  im=cells[0].copy()
  if shape:im.alpha_composite(a.feather_patch(cells[shape],boxes['mouth']),dest=boxes['mouth'][:2])
  if blink:im.alpha_composite(a.feather_patch(cells[5],boxes['eyes']),dest=boxes['eyes'][:2])
  return im.resize((700,700),Image.Resampling.LANCZOS)
 colour=(116,88,171) if provider=='openai' else (48,113,174);rows=a.layout.wrap(m['text'],a.layout.font(36),610)
 if len(rows)>6:raise ValueError('Caption too long')
 bg=Image.new('RGBA',(W,H),(246,248,253,255));d=ImageDraw.Draw(bg);d.text((48,42),'GPT 的语音卡' if provider=='openai' else 'DeepSeek 的语音卡',font=a.layout.font(36,True),fill=colour);d.text((49,98),'AI角色 · 合成配音',font=a.layout.font(23),fill=(104,112,135));d.rounded_rectangle((40,880,680,1210),radius=26,fill=(255,255,255),outline=(215,224,238),width=2)
 for i,line in enumerate(rows):d.text((62,925+i*45),line,font=a.layout.font(36),fill=(43,52,72))
 d.text((49,1232),'本条仅用于当前私信回复',font=a.layout.font(22),fill=(104,112,135))
 cmd=[a.layout.FF,'-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','pipe:0','-i',audio['file'],'-t',str(duration),'-c:v','libx264','-preset','veryfast','-crf','22','-pix_fmt','yuv420p','-af','apad,loudnorm=I=-16:TP=-1.5:LRA=9','-c:a','aac','-ar','48000','-ac','2','-threads','4','-movflags','+faststart',m['output']]
 p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stderr=subprocess.PIPE)
 try:
  for n in range(round(duration*FPS)):
   t=n/FPS;chunk=samples[int(t*24000):int(t*24000)+960];energy=math.sqrt(sum(x*x for x in chunk)/max(1,len(chunk)))/32768;shape=next((c[2] for c in cues if c[0]<=t<c[1]),1) if energy>.009 else 0
   frame=bg.copy();frame.alpha_composite(actor(shape,t%3.7<.12),dest=(10,170+round(math.sin(t*2.5)*4)));p.stdin.write(frame.convert('RGB').tobytes())
 finally:p.stdin.close()
 error=p.stderr.read().decode();code=p.wait()
 if code:raise RuntimeError(error[-2000:])
 a.layout.run(['-ss','0.8','-i',m['output'],'-frames:v','1',work/'cover.png']);(work/'render-result.json').write_text(json.dumps({'duration':duration,'width':W,'height':H,'audio':'AAC','codec':'H264'}));print(json.dumps({'duration':duration,'frames':round(duration*FPS)}))
if __name__=='__main__':main(sys.argv[1])
