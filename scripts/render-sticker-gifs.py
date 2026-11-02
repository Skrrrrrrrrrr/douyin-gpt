"""Encode the four imagegen keyframes in each atlas as a looping chat GIF."""
import json,subprocess,tempfile,hashlib
from pathlib import Path
from PIL import Image
import imageio_ffmpeg
root=Path(__file__).resolve().parents[1]/'assets'/'stickers';ff=imageio_ffmpeg.get_ffmpeg_exe();outputs=[]
for role in ['gpt','deepseek']:
 for motion in ['wave','nod','laugh']:
  source=root/'frames'/f'{role}-{motion}.png'
  with Image.open(source) as im:w,h=im.size
  assert w%2==0 and h%2==0
  with tempfile.TemporaryDirectory(prefix='dy-gif-') as temp:
   for i in range(4):
    target=Path(temp)/f'frame-{i:02d}.png'
    crop=f'crop={w//2}:{h//2}:{(i%2)*(w//2)}:{(i//2)*(h//2)},scale=480:480:flags=lanczos'
    subprocess.run([ff,'-hide_banner','-loglevel','error','-y','-i',str(source),'-vf',crop,'-frames:v','1',str(target)],check=True)
   output=root/f'{role}-{motion}.gif'
   subprocess.run([ff,'-hide_banner','-loglevel','error','-y','-framerate','4','-i',str(Path(temp)/'frame-%02d.png'),'-filter_complex','split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=dither=sierra2_4a:alpha_threshold=128','-loop','0','-gifflags','-offsetting',str(output)],check=True)
  with Image.open(output) as im:
   frames=[]
   for i in range(im.n_frames):im.seek(i);frames.append(hashlib.sha256(im.convert('RGBA').tobytes()).hexdigest())
   assert im.n_frames==4 and len(set(frames))>1 and im.info.get('loop')==0
  outputs.append({'id':f'{role}-{motion}','frames':4,'bytes':output.stat().st_size})
catalog=json.loads((root/'catalog.json').read_text());known={i['id'] for i in catalog['items']}
for role in ['gpt','deepseek']:
 for motion,label,emotion in [('wave','挥手','happy'),('nod','点头收到','ack'),('laugh','笑哭','happy')]:
  identity=f'{role}-{motion}'
  if identity not in known:catalog['items'].append({'id':identity,'provider':'openai' if role=='gpt' else 'deepseek','emotion':emotion,'label':label,'file':identity+'.gif','animated':True})
(root/'catalog.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(outputs,ensure_ascii=False))
