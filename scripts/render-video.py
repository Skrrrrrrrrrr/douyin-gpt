#!/usr/bin/env python3
"""Render the daily public diary, using generated character assets and real audio."""
import json, math, os, subprocess, sys, wave
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg
W,H,FPS=1080,1920,25
FONT='/System/Library/Fonts/STHeiti Medium.ttc'
REG='/System/Library/Fonts/STHeiti Light.ttc'
FF=imageio_ffmpeg.get_ffmpeg_exe()
def font(n,bold=False):return ImageFont.truetype(FONT if bold else REG,n)
def wrap(text,f,width):
    rows=[];row=''
    for c in text:
        if c=='\n' or f.getlength(row+c)>width:
            if row:rows.append(row)
            row='' if c=='\n' else c
        else:row+=c
    if row:rows.append(row)
    return rows
def run(args):
    p=subprocess.run([FF,'-hide_banner','-loglevel','error','-y',*map(str,args)],capture_output=True,text=True)
    if p.returncode:raise RuntimeError(p.stderr[-3500:])
def background(meta,turn,index,total):
    im=Image.new('RGB',(W,H));px=im.load()
    for y in range(H):
        t=y/(H-1);color=(int(248-18*t),int(246-12*t),int(255-4*t))
        for x in range(W):px[x,y]=color
    d=ImageDraw.Draw(im)
    for x,y,r,col in [(90,480,220,(232,219,255)),(980,700,300,(214,235,255)),(70,1530,180,(234,228,252))]:d.ellipse((x-r,y-r,x+r,y+r),fill=col)
    for x,y in [(70,390),(980,420),(1020,1110),(505,570)]:
        d.line((x-12,y,x+12,y),fill=(255,255,255),width=4);d.line((x,y-12,x,y+12),fill=(255,255,255),width=4)
    d.rounded_rectangle((54,70,1026,133),radius=31,fill=(255,255,255))
    d.text((80,85),'大肥鱼 × AI 搭子',font=font(32,True),fill=(74,61,110))
    d.text((700,88),'AI角色 · 合成配音',font=font(25),fill=(97,83,140))
    d.text((61,177),'今天，我们干了啥？',font=font(76,True),fill=(43,38,78))
    d.text((65,278),meta['day'].replace('-','.')+'  晚间日志',font=font(34),fill=(104,91,144))
    d.rounded_rectangle((60,341,1020,409),radius=22,fill=(255,255,255))
    d.text((84,358),turn['chapter'],font=font(35,True),fill=(78,66,125))
    d.text((896,361),f'{index+1:02d} / {total:02d}',font=font(25),fill=(134,126,164))
    for provider,x,color,name in [('openai',60,(132,99,192),'GPT'),('deepseek',560,(72,130,205),'DeepSeek')]:
        active=turn['speaker']==provider;own=meta['data']['providers'][provider]
        d.rounded_rectangle((x,1212,x+460,1300),radius=28,fill=color if active else (255,255,255))
        fg=(255,255,255) if active else color
        d.text((x+25,1229),name,font=font(32,True),fill=fg)
        count=f"{own['videoCount']}条视频"
        d.text((x+300,1234),count,font=font(26),fill=fg)
    d.rounded_rectangle((56,1350,1024,1736),radius=34,fill=(255,255,255),outline=(224,218,242),width=2)
    color=(125,91,185) if turn['speaker']=='openai' else (58,117,194)
    d.text((89,1380),'GPT 说' if turn['speaker']=='openai' else 'DeepSeek 说',font=font(28,True),fill=color)
    rows=wrap(turn['text'],font(46),890)
    if len(rows)>5:raise ValueError('字幕超过安全区域')
    for i,line in enumerate(rows):d.text((89,1436+i*55),line,font=font(46),fill=(43,42,68))
    d.text((67,1782),f"统计截至 {meta['cutoff']} · 基于视频文案与抽样画面",font=font(28),fill=(106,99,135))
    d.rounded_rectangle((60,1841,1020,1851),radius=5,fill=(217,209,236))
    d.rounded_rectangle((60,1841,60+int(960*(index+1)/total),1851),radius=5,fill=color)
    return im

def main(path):
    meta=json.loads(Path(path).read_text());work=Path(meta['workDir']);assets=Path(meta['assets']);segments=[];duration=0
    for i,turn in enumerate(meta['turns']):
        bg=work/f'frame-{i:02d}.png';background(meta,turn,i,len(meta['turns'])).save(bg)
        target=work/f'segment-{i:02d}.mp4';dur=math.ceil((turn['duration']+.28)*FPS)/FPS;duration+=dur
        ga=1 if turn['speaker']=='openai' else .76;da=1 if turn['speaker']=='deepseek' else .76
        filt=f"[1:v]scale=520:780,format=rgba,colorchannelmixer=aa={ga}[g];[2:v]scale=520:780,format=rgba,colorchannelmixer=aa={da}[d];[0:v][g]overlay=10:y='427+7*sin(2.4*t)':format=auto[x];[x][d]overlay=550:y='427+7*sin(2.4*t+1)':format=auto,format=yuv420p[v]"
        run(['-loop','1','-i',bg,'-loop','1','-i',assets/'gpt.png','-loop','1','-i',assets/'deepseek.png','-i',turn['file'],'-filter_complex',filt,'-map','[v]','-map','3:a','-af','loudnorm=I=-16:TP=-1.5:LRA=9,apad=pad_dur=0.5','-t',dur,'-r',FPS,'-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-ar','48000','-ac','2','-threads','4','-movflags','+faststart',target]);segments.append(target)
        print(f'已渲染片段 {i+1}/{len(meta["turns"])}',flush=True)
    listing=work/'concat.txt';listing.write_text(''.join("file '"+str(p).replace("'","'\\''")+"'\n" for p in segments))
    run(['-f','concat','-safe','0','-i',listing,'-c','copy','-movflags','+faststart',meta['videoPath']])
    run(['-ss','0.8','-i',meta['videoPath'],'-frames:v','1',meta['coverPath']])
    result={'width':W,'height':H,'fps':FPS,'duration':round(duration,3),'audio':'AAC stereo 48kHz','codec':'H264','bytes':Path(meta['videoPath']).stat().st_size,'segments':len(segments)}
    (work/'render-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False),flush=True)
if __name__=='__main__':main(sys.argv[1])
