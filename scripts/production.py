"""Deterministic shot layouts and an original locally composed, ducked music bed."""
import math
from array import array
from PIL import ImageDraw

def shot(index,total,enabled=True):
    if not enabled:return 'duo'
    if index in (1,total-2):return 'data'
    if index==2:return 'gpt-close'
    if index in (3,5):return 'deepseek-close'
    if index==4:return 'topic-card'
    return 'duo'

def background(layout,meta,turn,index,total):
    im=layout.background(meta,turn,index,total).convert('RGBA');d=ImageDraw.Draw(im)
    if (meta.get('show') or {}).get('narrative'):
        return story_background(layout,meta,turn,index,total,im)
    mode=shot(index,total,meta.get('production',{}).get('camera',True))
    if mode in ('data','topic-card') and not meta['production'].get('cards',True):mode='duo'
    d.rounded_rectangle((48,430,1032,1190),radius=30,fill=(245,246,253,255))
    if mode=='data' and meta['production'].get('cards',True):
        providers=meta['data']['providers'];is_watch=index==1
        title=('这周实际记录了多少？' if meta['data'].get('weekly') else '今天实际记录了多少？') if is_watch else '公开互动账本'
        d.text((90,466),title,font=layout.font(39,True),fill=(46,54,79))
        values=[providers[p]['videoCount'] if is_watch else providers[p]['comments']+providers[p]['replies'] for p in ['openai','deepseek']];maximum=max(1,*values)
        for i,(label,value,col) in enumerate(zip(['GPT','DeepSeek'],values,[(131,105,183),(69,128,190)])):
            y=546+i*106;d.text((92,y),label,font=layout.font(30,True),fill=col);d.text((870,y),str(value),font=layout.font(37,True),fill=col)
            d.rounded_rectangle((92,y+49,976,y+66),radius=8,fill=(223,228,239));width=round(884*value/maximum)
            if width:d.rounded_rectangle((92,y+49,92+width,y+66),radius=8,fill=col)
        note='观看记录，非完整观看证明' if is_watch else '只计已回读成功的公开评论与回复'
        d.text((92,510),note,font=layout.font(24),fill=(105,111,132))
    elif mode=='topic-card' and meta['production'].get('cards',True):
        title=(meta.get('show') or {}).get('audienceTopic',{});title=(title or {}).get('text') or (meta.get('show') or {}).get('topicSummary','今日话题')
        d.rounded_rectangle((84,460,996,646),radius=23,fill=(255,255,255),outline=(211,218,234),width=2)
        d.text((110,482),('这周聊这个' if meta['data'].get('weekly') else '今天聊这个'),font=layout.font(28,True),fill=(81,102,145))
        for i,line in enumerate(layout.wrap(title[:55],layout.font(32),850)[:2]):d.text((110,532+i*43),line,font=layout.font(32),fill=(46,54,79))
    else:
        accent=(226,220,241) if turn['speaker']=='openai' else (213,231,247)
        d.ellipse((142,476,936,1190),fill=accent)
    return im,mode

def story_background(layout,meta,turn,index,total,im):
    """One shared event; public facts and results stay visible, counters stay quiet."""
    d=ImageDraw.Draw(im);n=meta['show']['narrative'];stage=turn.get('stage','reaction');column=n['column']
    palettes={'diary':((111,87,151),(241,237,249),'一件小事'),
              'qa':((137,98,47),(251,244,228),'你们问，我俩答'),
              'weekly':((45,106,144),(230,242,249),'一周回访')}
    ink,pale,label=palettes[column]
    # Column identity is one strip, not a replacement for either host's identity.
    d.rounded_rectangle((54,70,1026,133),radius=31,fill=pale)
    d.text((80,85),label,font=layout.font(32,True),fill=ink)
    d.text((700,88),'AI角色 · 合成配音',font=layout.font(25),fill=(97,83,140))
    d.rounded_rectangle((48,430,1032,1190),radius=30,fill=(246,247,252,255))
    mode='gpt-close' if turn['speaker']=='openai' else 'deepseek-close'
    if stage in ('event','result','followup','closing'):
        mode='story-card'
        title={'event':'这一件事','result':'处理到了哪一步','followup':'上期回访','closing':'下一期留意什么'}[stage]
        state={'confirmed':'已有公开回读','limited':'保留未知','code_verified':'仅代码检查验证'}.get(n['mainline']['status'],'依据公开记录')
        if stage=='event':content=n['mainline']['happened']
        elif stage=='result':content=n['mainline']['handled']+' '+n['mainline']['result']
        elif stage=='followup':
            f=n.get('followup');title='上期回访' if f else '本期先确认这些';state=('已有新证据' if f['state']=='evidence_ready' else '仍待新证据') if f else '本期结论'
            content=(f['title']+'\n'+f['summary']) if f else '这期先把确认的事实与推测分开。没有新增记录，就不编造后续。'
        else:content=(n.get('proposal') or {}).get('title','有新的公开记录，再继续聊。');state='回访点 · 尚未完成'
        d.rounded_rectangle((80,454,1000,718),radius=22,fill=(255,255,255),outline=(216,222,233),width=2)
        d.text((106,472),title,font=layout.font(28,True),fill=ink)
        width=layout.font(22).getlength(state);d.text((972-width,479),state,font=layout.font(22),fill=(95,105,123))
        rows=layout.wrap(content,layout.font(30),860)
        for i,line in enumerate(rows[:4]):d.text((108,524+i*39),line,font=layout.font(30),fill=(46,54,79))
        source='项目代码检查记录' if n['mainline']['kind']=='growth' else '公开提问与片段记录' if n['mainline']['kind']=='qa' else '公开视频片段记录'
        d.text((110,689),source,font=layout.font(20),fill=(105,111,132))
    if stage=='closing':
        p=meta['data']['providers'];text=f"记录 {p['openai']['videoCount']} + {p['deepseek']['videoCount']} 条视频 · 公开评论 {p['openai']['comments']+p['deepseek']['comments']} · 回复 {p['openai']['replies']+p['deepseek']['replies']}"
        d.text((86,1170),text,font=layout.font(21),fill=(95,105,123))
    return im,mode

def placements(mode,speaker,camera=True):
    if not camera:return [('openai',-20,475,600),('deepseek',500,475,600)]
    if mode=='data':return [('openai',80,740,390),('deepseek',610,740,390)]
    if mode=='gpt-close':return [('deepseek',704,700,380),('openai',-15,450,760)]
    if mode=='deepseek-close':return [('openai',-4,700,380),('deepseek',343,450,760)]
    if mode=='topic-card':return [('openai',-20,640,570),('deepseek',520,640,570)]
    if mode=='story-card':return [('openai',75,738,410),('deepseek',600,738,410)]
    return [('openai',-20,475,600),('deepseek',500,475,600)]

def mix_score(raw,volume=.08,rate=24000):
    voice=array('h');voice.frombytes(raw);out=array('h');block=480;gains=[];duck=1.0;active_music=[];quiet_music=[]
    # A minor, F major, C major, G major. Original sustained/plucked synthesis;
    # no external recordings, samples, recognisable melodies or provider calls.
    chords=[(220,261.626,329.628),(174.614,220,261.626),(130.813,164.814,195.998),(195.998,246.942,293.665)]
    duration=len(voice)/rate
    for start in range(0,len(voice),block):
        values=voice[start:start+block];energy=math.sqrt(sum(v*v for v in values)/max(1,len(values)));speaking=energy>280;target=.18 if speaking else 1
        duck+=(target-duck)*(.65 if speaking else .13);gains.append(duck)
        for j,value in enumerate(values):
            t=(start+j)/rate;notes=chords[int(t/3.2)%len(chords)];beat=t%(.7142857);env=.36+.64*math.exp(-beat*3.5)
            tone=sum(math.sin(2*math.pi*f*t)+.12*math.sin(4*math.pi*f*t) for f in notes)/3
            music=round(12000*tone*env*volume*duck*min(1,t/1.5,max(0,(duration-t)/1.5)))
            (active_music if speaking else quiet_music).append(music*music)
            out.append(max(-32768,min(32767,value+music)))
    rms=lambda xs:round(math.sqrt(sum(xs)/max(1,len(xs))),2)
    return out.tobytes(),{'source':'original-local-synthesis','bpm':84,'volume':volume,'ducking':True,'voiceMusicRMS':rms(active_music),'pauseMusicRMS':rms(quiet_music),'minimumDuckGain':round(min(gains,default=1),3)}
