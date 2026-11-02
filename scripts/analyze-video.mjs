import {loadEnv, homePath, readConfig} from '../src/config.mjs';
import {Browser} from '../src/browser.mjs';
import {Douyin} from '../src/douyin.mjs';
import {VideoUnderstanding} from '../src/understanding.mjs';
import {VideoAnalysis, codexCommand, publicVideoUrl, runProcess} from '../src/video-analysis.mjs';

loadEnv();
const home = homePath(), cfg = readConfig(home);
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
try {
  if (process.argv.includes('--doctor')) {
    const command = codexCommand(cfg.videoAnalysis);
    const version = await runProcess(command, ['--version'], {timeout: 10000, cleanEnv: true});
    const auth = await runProcess(command, ['login', 'status'], {timeout: 10000, cleanEnv: true});
    const media = await runProcess(cfg.videoAnalysis.python || cfg.video.python,
      ['-c', 'import PIL,imageio_ffmpeg; print("media-ready")'], {timeout: 10000});
    console.log(JSON.stringify({codexAvailable: version.code === 0,
      codexVersion: version.stdout.trim(), authenticated: auth.code === 0,
      mediaReady: media.code === 0, model: cfg.videoAnalysis.model,
      enabled: cfg.videoAnalysis.enabled, headless: cfg.browser.headless, background: cfg.browser.background}, null, 2));
    if (version.code || auth.code || media.code) process.exitCode = 1;
  } else {
    const url = publicVideoUrl(process.argv.find(arg => arg.startsWith('https://')) || '');
    if (!cfg.browser.headless && !cfg.browser.background) throw new Error('请先启用本项目的后台浏览器模式');
    const browser = new Browser(home, cfg.browser);
    try {
      await browser.start();
      const dy = new Douyin(home, browser);
      await dy.checkAccount(cfg.account);
      const video = await dy.detail(url.split('/').at(-1));
      const analyzer = new VideoAnalysis({home, cfg, dy, transcriber: new VideoUnderstanding(home, cfg),
        log: line => console.error(line)});
      const result = await analyzer.analyze({...video, url}, controller.signal, {force: process.argv.includes('--force')});
      console.log(JSON.stringify({videoId: video.id, url, model: result.model,
        summary: result.codex.summary, timeline: result.codex.timeline,
        coverage: result.coverage, limitations: result.codex.limitations}, null, 2));
    } finally {browser.disconnect();}
  }
} catch (error) {
  console.error(error.name === 'AbortError' ? '视频解析已取消' : error.message);
  process.exitCode = 1;
}
