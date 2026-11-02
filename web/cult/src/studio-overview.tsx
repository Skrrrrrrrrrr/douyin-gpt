import {useEffect,useRef,useState} from 'react';
import {ArrowDownRight,ArrowRight,ArrowUpRight,Check,Clapperboard,Clock3,MessageCircle,Pause,Play,ShieldCheck,Video} from 'lucide-react';
import {gsap} from 'gsap';
import {ScrollTrigger} from 'gsap/ScrollTrigger';
import {useGSAP} from '@gsap/react';
import {Badge,Empty,Progress} from './ui';
import {assetUrl,dateTime,labels,media,providerName,time} from './lib/format';
import type {PageProps,Provider,Row} from './types';

gsap.registerPlugin(useGSAP,ScrollTrigger);
const portrait=(provider:string)=>assetUrl('/host/'+(provider==='deepseek'?'deepseek':'gpt')+'.png');
const episodeStatus=(v:Row|null)=>['rejected','unknown'].includes(v?.review?.status||'')?v?.review?.status:v?.status;

function ChannelMarquee(){
  const [paused,setPaused]=useState(false);
  const channels=['发现有趣','认真回应','各有所爱','一起记录','双人晚报'];
  return <div className={'studio-channel '+(paused?'is-paused':'')}>
    <span className="studio-channel-label">两位室友的日常</span>
    <div className="studio-channel-viewport" aria-hidden="true"><div className="studio-channel-track">{[0,1,2,3].map(copy=><span className="studio-channel-set" key={copy}>{channels.map(label=><span key={label}>{label}<i/></span>)}</span>)}</div></div>
    <button type="button" className="studio-marquee-toggle" aria-label={paused?'继续文字流':'暂停文字流'} aria-pressed={paused} onClick={()=>setPaused(!paused)}>{paused?<Play size={13}/>:<Pause size={13}/>}</button>
  </div>;
}

function InlinePortraits(){return <span className="studio-inline-portraits" aria-hidden="true"><img src={portrait('openai')} alt=""/><img src={portrait('deepseek')} alt=""/></span>;}

function RoleCard({provider:p,active,onSelect,running}:{provider:Provider;active:boolean;onSelect:()=>void;running:boolean}){
  const id='role-detail-'+p.id;
  return <article className={'studio-role '+(p.id==='deepseek'?'role-blue':'role-lilac')+(active?' is-expanded':'')}>
    <button className="studio-role-toggle" onClick={onSelect} aria-expanded={active} aria-controls={id}>
      <div className="studio-role-avatar"><img src={portrait(p.id)} alt={p.id==='openai'?'白发 GPT 龙娘':'蓝发 DeepSeek 大肥鱼'}/></div>
      <div className="studio-role-name"><h3>{p.name}<ArrowUpRight size={16}/></h3><p>{p.id==='openai'?'龙娘':'大肥鱼'}<span className={'studio-presence '+(p.enabled&&running?'is-online':'')}>{!p.enabled?'未启用':running?'工作中':'已暂停'}</span></p></div>
    </button>
    <p className="studio-model" title={p.model}>{p.model||'尚未配置模型'}</p>
    <div className="studio-role-progress"><Progress label="观看视频" value={p.videos} max={p.videoLimit}/><Progress label="主动评论" value={p.comments} max={p.commentLimit}/><Progress label="回复评论" value={p.replies} max={p.replyLimit}/></div>
    <div id={id} className="studio-role-detail" aria-hidden={!active}><p>有自己的兴趣，也有自己的节奏。</p><span>{p.id==='openai'?'白发角色':'蓝发角色'} · 音色 {p.voice||'未设置'}</span></div>
    <a href="#discovery" className="studio-role-link">查看兴趣档案<ArrowRight size={15}/></a>
  </article>;
}

export function StudioOverview({data:d}:PageProps){
  const scope=useRef<HTMLDivElement>(null),[expanded,setExpanded]=useState('openai');
  const limit=d.providers.some(p=>p.videoLimit===null)?null:d.providers.reduce((n,p)=>n+(p.videoLimit||0),0),comments=d.providers.reduce((n,p)=>n+p.comments,0),replies=d.providers.reduce((n,p)=>n+p.replies,0);
  const [year,month,day]=d.day.split('-').map(Number),weekday=new Intl.DateTimeFormat('zh-CN',{weekday:'long',timeZone:'Asia/Shanghai'}).format(new Date(Date.UTC(year,month-1,day,4)));
  const events=[
    ...d.videos.map(v=>({id:'v'+v.provider+v.id,kind:'video',title:v.analysis?.summary||v.desc||'观看记录',detail:providerName(v.provider)+' · 观看与理解',at:v.watchedAt,url:'#video/'+v.id})),
    ...d.comments.map(c=>({id:'c'+c.id,kind:'comment',title:c.text,detail:providerName(c.provider)+' · '+(c.kind==='reply'?'回复评论':'主动评论')+' · '+(labels[c.status]||c.status),at:c.createdAt,url:'#messages'})),
    ...d.replies.map(r=>({id:'r'+r.id,kind:'message',title:r.kind==='sticker'?'发出了一份表情回复':r.kind==='voice_card'?'发出了一条角色语音卡':'处理了一条私信回复',detail:providerName(r.provider)+' · '+(labels[r.status]||r.status),at:r.createdAt,url:'#messages'}))
  ].filter(e=>typeof e.at==='string').sort((a,b)=>b.at.localeCompare(a.at)).slice(0,6);
  const episode=d.video,hour=String(d.settings.video.hour).padStart(2,'0');
  useGSAP(()=>{
    const root=scope.current;if(!root)return;
    const mm=gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)',()=>{
      gsap.from(root.querySelectorAll('.studio-hero-copy > *'),{y:15,opacity:0,stagger:.06,duration:.65,ease:'power2.out',clearProps:'transform,opacity'});
      for(const image of root.querySelectorAll<HTMLElement>('[data-scroll-image]')){
        gsap.fromTo(image,{scale:.8},{scale:1,ease:'none',immediateRender:false,scrollTrigger:{trigger:image,start:'top bottom',end:'top 45%',scrub:.8}});
        gsap.to(image,{opacity:.2,ease:'none',scrollTrigger:{trigger:image,start:'bottom 180px',end:'bottom top',scrub:.7}});
      }
    });
    mm.add('(min-width: 1180px) and (prefers-reduced-motion: no-preference)',()=>{
      const section=root.querySelector<HTMLElement>('.studio-chronicle'),heading=root.querySelector<HTMLElement>('.studio-chronicle-heading');
      if(section&&heading)ScrollTrigger.create({trigger:section,pin:heading,pinSpacing:false,start:'top 115px',end:()=>'+='+Math.max(0,section.offsetHeight-heading.offsetHeight-32),invalidateOnRefresh:true});
    });
    let alive=true;
    document.fonts.ready.then(()=>{if(alive)ScrollTrigger.refresh();});
    for(const image of root.querySelectorAll('img'))if(!image.complete)image.addEventListener('load',()=>{if(alive)ScrollTrigger.refresh();},{once:true});
    return()=>{alive=false;mm.revert();};
  },{scope});
  useEffect(()=>{ScrollTrigger.refresh();},[events.length]);
  return <div className="studio-overview" ref={scope}>
    <section className="studio-hero" aria-labelledby="overview-title">
      <div className="studio-hero-copy"><p className="studio-date"><span/>{month} 月 {day} 日，{weekday}</p><h1 id="overview-title" className="max-w-6xl">给你<InlinePortraits/>留个位置，<br/>一起把日常过好。</h1><p className="studio-hero-description">看看世界，认真回应，<br className="studio-mobile-break"/>忙完了，一起把今天记下来。</p><div className="studio-hero-actions"><a href="#videos" className="studio-button">查看观看记录<ArrowUpRight size={17}/></a><a href="#show" className="studio-button studio-button-light">去看双人晚报<Play size={15}/></a></div></div>
      <div className="studio-scenery station-scenery" aria-hidden="true"><div className="studio-orbit orbit-one"/><img className="station-hero-emblem" src={assetUrl('/brand/liuzuo-illustration.png')} alt="" data-scroll-image/><div className="studio-scenery-caption"><span/>灯亮着，位置也给你留着</div></div>
    </section>
    <ChannelMarquee/>
    <div className="studio-section-title"><div><h2>今日总览</h2><p>每一条进度，都来自实际记录。</p></div><span className={'studio-service-state '+(d.daemon.running?'is-online':'')}><i/>{d.daemon.stopping?'正在停止':d.daemon.running?'后台运行中':'后台已暂停'}</span></div>
    <div className="studio-metrics"><div><span>今日观看</span><strong>{d.totalVideos}<small>/ {limit??'不限'}</small></strong><p>{limit&&d.totalVideos>=limit?'今日观看额度已完成':'条视频，慢慢发现'}</p></div><div><span>公开评论 / 回复</span><strong>{comments}<small>/</small>{replies}</strong><p>次公开互动</p></div><div><span>私信已回读</span><strong>{d.privateReplies}<small>条</small></strong><p>仅限允许的联系人</p></div><div><span>待处理异常</span><strong className={d.alerts.length?'has-alert':''}>{d.alerts.length}<small>项</small></strong><a href="#settings/alerts">{d.alerts.length?'前往查看':'目前一切就绪'}<ArrowUpRight size={13}/></a></div></div>
    <div className="studio-bento grid-flow-dense">
      <section className="studio-duet" aria-labelledby="duet-title"><div className="studio-card-heading"><h2 id="duet-title">两位室友的今日进度</h2><span>各有所爱，各自探索</span></div><div className="studio-roles">{d.providers.map(p=><RoleCard key={p.id} provider={p} active={expanded===p.id} onSelect={()=>setExpanded(p.id)} running={d.daemon.running}/>)}</div></section>
      <section className="studio-episode"><div className="studio-card-heading"><h2>今晚的双人晚报</h2><Clapperboard size={19}/></div><div className="studio-episode-title"><Badge status={episodeStatus(episode)} text={episode?undefined:'待制作'}/><h3>{episode?.title||<>今天的故事，<br/>晚上见。</>}</h3></div><div className="studio-episode-art">{episode?.ready?<img className="studio-episode-cover" src={media('cover',{day:d.day})} alt="今晚晚报封面" data-scroll-image/>:<><img src={portrait('openai')} alt="GPT 晚报角色" data-scroll-image/><img src={portrait('deepseek')} alt="DeepSeek 晚报角色" data-scroll-image/></>}</div><div className="studio-episode-bottom"><div><span>{episode?.review?.publishedAt?'实际发布':episode?.publishAt?'计划发布':'每日发布'}</span><strong>{episode?.review?.publishedAt?time(episode.review.publishedAt):episode?.publishAt?.slice(11)||hour+':00'}</strong></div><a href="#show" aria-label="查看晚报制作与成片"><ArrowUpRight size={24}/></a></div><p className="studio-ai-note">公开观看日志 · AI 角色与合成配音</p></section>
    </div>
    <section className="studio-chronicle"><div className="studio-chronicle-heading"><span className="studio-line-mark"/><h2>最近的日常，<br/>都有迹可循。</h2><p>看过的内容、留下的评论，<br/>都汇在这里。</p><a href="#videos" className="studio-text-link">展开全部记录<ArrowRight size={16}/></a><div className="studio-journal-stamp"><Clock3 size={17}/><span>每天 18:30 整理日志<br/>{hour}:00 见证今天的故事</span></div></div><div className="studio-timeline">{events.length?events.map(event=><a href={event.url} className="studio-event" key={event.id}><div className={'studio-event-icon '+(event.kind==='video'?'event-watch':'event-reply')}>{event.kind==='video'?<Video size={19}/>:<MessageCircle size={19}/>}</div><div><span className="studio-event-detail">{event.detail}</span><h3>{event.title}</h3><time dateTime={event.at}>{dateTime(event.at)}</time></div><ArrowUpRight size={17}/></a>):<div className="studio-empty-journal"><div><Video size={28}/><MessageCircle size={24}/></div><h3>日常，从下一条记录开始。</h3><p>开始浏览和互动后，这里会留下实际进度。</p><a href="#settings" className="studio-text-link">查看运行设置<ArrowRight size={16}/></a></div>}</div></section>
    <section className="studio-attention"><div className="studio-attention-title"><ShieldCheck size={21}/><h2>需要留意的事</h2><span>{d.alerts.length} 项</span></div>{d.alerts.length?<div className="studio-alerts">{d.alerts.slice(0,3).map(a=><a href="#settings/alerts" key={a.id}><div><h3>{a.title}</h3><p>{a.message}</p></div><ArrowUpRight size={16}/></a>)}</div>:<p className="studio-all-clear"><Check size={16}/>当前没有待处理异常，所有异常都会保留在运行记录中。</p>}</section>
    <section className="studio-next"><div><span>接下来的事</span><h2>把节奏，调成你喜欢的样子。</h2></div><div><a href="#reviews" className="studio-button studio-button-light">查看待审箱<ArrowUpRight size={16}/></a><a href="#settings" className="studio-button">调整运行设置<ArrowRight size={16}/></a></div><ArrowDownRight className="studio-next-mark" size={82} strokeWidth={.7} aria-hidden="true"/></section>
  </div>;
}
