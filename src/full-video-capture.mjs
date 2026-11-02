// These functions run only in the project's own video tab.
export function markVideoInPage({id, play = false}) {
  const title = document.title, currentId = location.pathname.match(/^\/video\/(\d{15,25})/)?.[1];
  if (currentId !== id) return {title, error: '当前页面作品与采集链接不一致'};
  let video = document.querySelector('.video_' + id + ' video, [data-e2e-vid="' + id + '"] video');
  if (!video) {
    const candidates = [...document.querySelectorAll('video')].filter(v => {
      const r = v.getBoundingClientRect(), s = getComputedStyle(v);
      return r.width > 40 && r.height > 40 && r.bottom > 0 && r.right > 0
        && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden';
    });
    if (candidates.length === 1) video = candidates[0];
  }
  if (!video) return {title, ready: false};
  video.setAttribute('data-douyin-gpt-video-id', id);
  video.muted = true;
  if (play || !Number.isFinite(video.duration) || video.readyState < 1) video.play().catch(() => {});
  else video.pause();
  return {title, ready: video.readyState >= 2, url: video.currentSrc || video.src || '',
    durationSeconds: Number.isFinite(video.duration) ? video.duration : 0};
}

export async function startFullCapture({id, maxBytes}) {
  if (location.pathname !== '/video/' + id) return {error: '当前作品已变化，停止录制'};
  const video = document.querySelector('[data-douyin-gpt-video-id="' + id + '"], .video_' + id + ' video, [data-e2e-vid="' + id + '"] video');
  if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return {error: '视频尚未准备好'};
  if (window.__douyinFullCapture?.recorder?.state === 'recording') return {error: '已有全片录制正在运行'};
  video.muted = true; video.loop = false; video.playbackRate = 1; video.pause(); video.currentTime = 0;
  if (video.seeking) await new Promise(resolve => {video.addEventListener('seeked', resolve, {once: true});setTimeout(resolve, 5000);});
  await video.play();
  const stream = video.captureStream?.() || video.mozCaptureStream?.();
  if (!stream?.getVideoTracks().length) return {error: '浏览器没有提供可录制的视频轨道'};
  const mime = ['video/webm;codecs=vp8,opus','video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  if (!mime) return {error: '浏览器不支持完整媒体录制'};
  const state = {id, video, duration: video.duration, chunks: [], bytes: 0, lastTime: 0,
    hasAudio: stream.getAudioTracks().length > 0, done: false, error: '', startedAt: Date.now()};
  window.__douyinFullCapture = state;
  const recorder = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 1000000, audioBitsPerSecond: 64000});
  state.recorder = recorder;
  state.finished = new Promise(resolve => {
    recorder.ondataavailable = event => {
      if (!event.data.size) return;
      state.bytes += event.data.size;
      if (state.bytes > maxBytes) {state.error = '单个媒体超过本机录制大小配置';if (recorder.state === 'recording') recorder.stop();}
      else state.chunks.push(event.data);
    };
    recorder.onstop = () => {state.done = true;resolve();};
    recorder.onerror = () => {state.error = '完整媒体录制失败';state.done = true;resolve();};
  });
  state.onEnd = () => {state.ended = true;state.lastTime = state.duration;if (recorder.state === 'recording') recorder.stop();video.pause();};
  video.addEventListener('ended', state.onEnd, {once: true, capture: true});
  recorder.start(1000);
  return {durationSeconds: state.duration, hasAudio: state.hasAudio};
}

export function pollFullCapture({id}) {
  const state = window.__douyinFullCapture;
  if (!state || state.id !== id) return {error: '完整媒体录制状态丢失'};
  if (state.ended) return {done: state.done, ended: true, at: state.duration,
    duration: state.duration, bytes: state.bytes, error: state.error};
  if (location.pathname !== '/video/' + id) return {error: '录制期间作品已变化'};
  const video = document.querySelector('[data-douyin-gpt-video-id="' + id + '"], .video_' + id + ' video, [data-e2e-vid="' + id + '"] video');
  if (!video) return {error: '录制期间视频元素消失'};
  state.lastTime = Math.max(state.lastTime, video.currentTime);
  if (!state.done && video.paused && !video.ended) video.play().catch(() => {});
  return {done: state.done, ended: state.ended === true, at: state.lastTime,
    duration: state.duration, bytes: state.bytes, error: state.error};
}

export async function finishFullCapture({id, cancel = false}) {
  const state = window.__douyinFullCapture;
  if (!state || state.id !== id) return {error: '没有完整媒体录制记录'};
  const video = state.video || document.querySelector('[data-douyin-gpt-video-id="' + id + '"], .video_' + id + ' video, [data-e2e-vid="' + id + '"] video');
  video?.pause();
  for (const next of document.querySelectorAll('video')) {next.muted = true;next.pause();}
  if (state.onEnd) video?.removeEventListener('ended', state.onEnd, {capture: true});
  if (state.recorder?.state === 'recording') state.recorder.stop();
  await Promise.race([state.finished, new Promise(resolve => setTimeout(resolve, 3000))]);
  if (cancel || state.error || !state.ended) {
    delete window.__douyinFullCapture;
    return {error: state.error || '全片录制没有到达视频结尾'};
  }
  state.blob = new Blob(state.chunks, {type: 'video/webm'});
  state.chunks = [];
  return {bytes: state.blob.size, hasAudio: state.hasAudio, durationSeconds: state.duration};
}

export async function readFullCaptureChunk({id, offset = 0, size = 4194304, release = false}) {
  const state = window.__douyinFullCapture;
  if (!state || state.id !== id || !state.blob) return {error: '完整录制数据尚未准备好'};
  if (release) {delete window.__douyinFullCapture;return {released: true};}
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > state.blob.size) return {error: '录制分块位置无效'};
  const end = Math.min(state.blob.size, offset + Math.min(4194304, Math.max(1, size)));
  const chunk = state.blob.slice(offset, end);
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;reader.readAsDataURL(chunk);
  });
  return {base64, bytes: chunk.size, done: end === state.blob.size};
}
