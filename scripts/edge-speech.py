#!/usr/bin/env python3
"""Synthesize the selected Mandarin voice; never silently substitute a voice."""
import asyncio, json, os, subprocess, sys, wave
from pathlib import Path
import edge_tts
import imageio_ffmpeg

async def make(data):
    output=Path(data['file']);output.parent.mkdir(parents=True,exist_ok=True)
    mp3=output.with_suffix('.edge.mp3');words=[]
    communicate=edge_tts.Communicate(data['text'],data['voice'],pitch=data.get('pitch','+0Hz'),rate=data.get('rate','+0%'),boundary='SentenceBoundary')
    with mp3.open('wb') as stream:
        async for chunk in communicate.stream():
            if chunk['type']=='audio':stream.write(chunk['data'])
            elif chunk['type'] in ('SentenceBoundary','WordBoundary'):words.append(chunk['text'])
    if not words or mp3.stat().st_size<100:raise RuntimeError('Speech service returned no complete audio/boundary data')
    result=subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-v','error','-y','-i',str(mp3),'-ar','24000','-ac','1','-c:a','pcm_s16le',str(output)],capture_output=True,text=True)
    if result.returncode:raise RuntimeError('Speech audio decoding failed')
    os.chmod(output,0o600)
    with wave.open(str(output),'rb') as wav:duration=wav.getnframes()/wav.getframerate()
    print(json.dumps({'file':str(output),'engine':'edge','voice':data['voice'],'pitch':data.get('pitch','+0Hz'),'rate':data.get('rate','+0%'),'model':'edge-tts/'+data['voice'],'transcript':' '.join(words),'transcriptSource':'service-sentence-boundaries','duration':duration},ensure_ascii=False))
    mp3.unlink(missing_ok=True)

if __name__=='__main__':
    data=json.loads(Path(sys.argv[1]).read_text())
    asyncio.run(asyncio.wait_for(make(data),timeout=60))
