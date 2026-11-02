#!/usr/bin/env python3
"""Compose registered character expressions, word-aligned visemes and eye blinks."""
import json, math, sys, wave, subprocess, importlib.util, re
from pathlib import Path
from functools import lru_cache
from array import array
from PIL import Image, ImageDraw, ImageFilter
from pypinyin import lazy_pinyin
import production
spec=importlib.util.spec_from_file_location('layout',Path(__file__).with_name('render-video.py'));layout=importlib.util.module_from_spec(spec);spec.loader.exec_module(layout)
W,H,FPS=1080,1920,25
BOXES={'openai':{'mouth':(283,289,349,342),'eyes':(200,208,407,303)},'deepseek':{'mouth':(190,324,256,375),'eyes':(140,236,346,357)}}

def cues(turn):
    out=[]
    for word in turn.get('wordTimings',[]):
        parts=lazy_pinyin(word['text'],errors=lambda s:list(s));parts=[p.lower() for p in parts if re.search('[a-z0-9]',p,re.I)]
        if not parts:continue
        step=max(.02,(word['end']-word['start'])/len(parts))
        for i,p in enumerate(parts):
            start=word['start']+i*step;shape=4 if re.search('[ou]',p) else 3 if re.search('[ie]',p) else 2 if 'a' in p else 1
            if p.startswith(('m','b','p')):out.append((start,start+step*.24,0));start+=step*.24
            out.append((start,word['start']+(i+1)*step,shape))
    return out

def feather_patch(image,box):
    patch=image.crop(box);mask=Image.new('L',patch.size,0);ImageDraw.Draw(mask).rounded_rectangle((2,2,patch.width-3,patch.height-3),radius=6,fill=255);mask=mask.filter(ImageFilter.GaussianBlur(2));patch.putalpha(mask);return patch

def main(path):
    meta=json.loads(Path(path).read_text());work=Path(meta['workDir']);assets=Path(meta['assets']);timeline=[];pcm=[];cursor=0
    for turn in meta['turns']:
        with wave.open(turn['file'],'rb') as wav:
            if (wav.getnchannels(),wav.getsampwidth(),wav.getframerate())!=(1,2,24000):raise ValueError('Animation expects mono PCM16 24kHz')
            raw=wav.readframes(wav.getnframes())
        duration=math.ceil((len(raw)/48000+.28)*FPS)/FPS
        samples=array('h');samples.frombytes(raw)
        entry={**turn,'start':cursor,'end':cursor+duration,'samples':samples,'cues':cues(turn)};timeline.append(entry);cursor+=duration
        pcm.append(raw+b'\0'*max(0,round(duration*24000)*2-len(raw)))
    production_on=meta.get('production',{}).get('enabled',False);score=None;combined=b''.join(pcm)
    if production_on and meta['production'].get('music',True):combined,score=production.mix_score(combined,meta['production'].get('musicVolume',.08))
    audio=work/'combined.wav'
    with wave.open(str(audio),'wb') as wav:wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(24000);wav.writeframes(combined)
    sheets={}
    for provider,name in [('openai','gpt'),('deepseek','deepseek')]:
        sheet=Image.open(assets/(name+'-expressions.png')).convert('RGBA');cw,ch=sheet.width//3,sheet.height//2
        sheets[provider]=[sheet.crop((x*cw,y*ch,(x+1)*cw,(y+1)*ch)) for y in range(2) for x in range(3)]
    @lru_cache(maxsize=96)
    def actor(provider,shape,blink,active,angle,size=600):
        cells=sheets[provider];im=cells[0].copy();boxes=BOXES[provider]
        if blink:im.alpha_composite(feather_patch(cells[5],boxes['eyes']),dest=boxes['eyes'][:2])
        if shape:im.alpha_composite(feather_patch(cells[shape],boxes['mouth']),dest=boxes['mouth'][:2])
        im=im.resize((size,size),Image.Resampling.LANCZOS)
        if angle:im=im.rotate(angle,resample=Image.Resampling.BICUBIC,expand=False)
        if not active:im.putalpha(im.getchannel('A').point(lambda p:round(p*.82)))
        return im
    backgrounds=[];shots=[]
    for i,turn in enumerate(timeline):
        if production_on:bg,mode=production.background(layout,meta,turn,i,len(timeline))
        else:bg,mode=layout.background(meta,turn,i,len(timeline)).convert('RGBA'),'duo'
        backgrounds.append(bg);shots.append(mode)
    cmd=[layout.FF,'-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','pipe:0','-i',str(audio),'-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-af','loudnorm=I=-16:TP=-1.5:LRA=9','-ar','48000','-ac','2','-threads','4','-movflags','+faststart',meta['videoPath']]
    process=subprocess.Popen(cmd,stdin=subprocess.PIPE,stderr=subprocess.PIPE);total=round(cursor*FPS);index=0
    try:
        for n in range(total):
            t=n/FPS
            while index<len(timeline)-1 and t>=timeline[index]['end']-.0001:index+=1
            turn=timeline[index];local=t-turn['start'];sample=int(local*24000);chunk=turn['samples'][sample:sample+960];energy=math.sqrt(sum(v*v for v in chunk)/max(1,len(chunk)))/32768
            shape=0
            if energy>.009:
                matching=next((c[2] for c in turn['cues'] if c[0]<=local<c[1]),None)
                shape=matching if matching is not None else (1 if energy<.1 else 2)
            frame=backgrounds[index].copy()
            places=production.placements(shots[index],turn['speaker'],production_on and meta['production'].get('camera',True))
            for provider,x,y,size in places:
                phase=.2 if provider=='openai' else 1.4
                active=turn['speaker']==provider;animated=meta.get('animation',True);blink=animated and (t+phase)%3.7<.13;angle=round(math.sin(t*2.6+phase)*(1 if active else .3)) if animated else 0;im=actor(provider,shape if active and animated else 0,blink,active,angle,size)
                frame.alpha_composite(im,dest=(x,y+round(math.sin(t*2.5+phase)*(5 if active else 2))))
            d=ImageDraw.Draw(frame);d.rounded_rectangle((40,1056,1040,1191),radius=24,fill=(249,248,255,255),outline=(225,220,241,255),width=2)
            d.text((82,1090),('同一件事，两种反应' if (meta.get('show') or {}).get('narrative') else '同一本日志，两种看法'),font=layout.font(32,True),fill=(80,68,118))
            d.text((694,1096),'GPT × DeepSeek',font=layout.font(26),fill=(88,101,132))
            process.stdin.write(frame.convert('RGB').tobytes())
            if n in (20,round(total*.5),total-15):frame.convert('RGB').save(work/f'animation-proof-{n}.png')
            if n%250==0:print(f'角色动画 {n}/{total} 帧',flush=True)
    finally:process.stdin.close()
    error=process.stderr.read().decode();code=process.wait()
    if code:raise RuntimeError(error[-3000:])
    layout.run(['-ss','0.8','-i',meta['videoPath'],'-frames:v','1',meta['coverPath']])
    result={'width':W,'height':H,'fps':FPS,'duration':round(cursor,3),'codec':'H264','audio':'AAC stereo 48kHz','bytes':Path(meta['videoPath']).stat().st_size,'segments':len(timeline),'animation':True,'wordAlignedSegments':sum(bool(t['cues']) for t in timeline),'mouthMode':'word-timed approximate visemes, energy-gated','blink':bool(meta.get('animation',True)),'nod':bool(meta.get('animation',True)),'production':production_on,'shots':shots,'music':score}
    (work/'render-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False),flush=True)
if __name__=='__main__':main(sys.argv[1])
