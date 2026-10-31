// Shared by the play scenarios and the benchmark: serve the production build, drive system Chrome, record video.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, brotliCompressSync } from 'node:zlib';
import { chromium } from 'playwright-core';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const PROFILES = {
  desktop: { viewport: { width: 1920, height: 1080 } },
  laptop: { viewport: { width: 1280, height: 720 } },
  wide: { viewport: { width: 2560, height: 1440 } },
  // Slows the CPU only, so its FPS flatters a real phone.
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, touch: true, cpuThrottle: 4, mbps: 50 }
};

const CONTENT_TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.gz': 'application/gzip', '.woff2': 'font/woff2'
};

// Stands in for Cloudflare: brotli on text, already-compressed files as they are.
export function serveDist(port = 0) {
  const root = join(ROOT, 'dist');
  if (!existsSync(join(root, 'index.html'))) throw new Error('No build found: run "npm run build" first.');
  const compressed = new Map();
  const server = http.createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = join(root, path);
    if (!file.startsWith(root + sep) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    const ext = extname(file);
    const headers = { 'content-type': CONTENT_TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-store' };
    let body = readFileSync(file);
    if (['.html', '.js', '.css'].includes(ext) && /\bbr\b/.test(req.headers['accept-encoding'] || '')) {
      if (!compressed.has(file)) {
        compressed.set(file, brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }));
      }
      body = compressed.get(file);
      headers['content-encoding'] = 'br';
    }
    res.writeHead(200, headers).end(body);
  });
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done({
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((closed) => { server.close(closed); server.closeAllConnections(); })
  })));
}

export function launchChrome({ headed = false } = {}) {
  return chromium.launch({
    channel: 'chrome',
    headless: !headed,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-precise-memory-info']
  });
}

// Fresh profile each time, so nothing is cached and no saved player position carries over.
export async function openGame(browser, url, { profile = 'laptop', query = '', storage = null, initScript = null, offline = false, timeout = 120000, stayThrottled = false } = {}) {
  const { viewport, deviceScaleFactor = 1, touch = false, cpuThrottle, mbps } = PROFILES[profile];
  const context = await browser.newContext({ viewport, deviceScaleFactor, hasTouch: touch, isMobile: touch });
  const page = await context.newPage();
  const errors = [];
  const warnings = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
    else if (message.type() === 'warning') warnings.push(message.text());
  });
  if (storage) await page.addInitScript((saved) => localStorage.setItem('nyc-player-state', saved), storage);
  if (initScript) await page.addInitScript(initScript);
  if (offline) await context.setOffline(true);
  const cdp = await context.newCDPSession(page);
  if (cpuThrottle) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
  if (mbps) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 40, downloadThroughput: mbps * 125000, uploadThroughput: mbps * 40000
    });
  }
  await page.goto(`${url}?debug=1${query ? `&${query}` : ''}`, { waitUntil: offline ? 'domcontentloaded' : 'commit' });
  await page.waitForFunction(() => document.getElementById('loading-overlay')?.classList.contains('hidden'), null, { timeout, polling: 100 });
  if (cpuThrottle && !stayThrottled) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  return { context, page, cdp, errors, warnings };
}

// Page screencast into ffmpeg, stamped by arrival time because frames come unevenly under load.
export async function startRecording(game, file) {
  mkdirSync(dirname(file), { recursive: true });
  const ffmpeg = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-use_wallclock_as_timestamps', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', '-',
    '-fps_mode', 'vfr', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file
  ], { stdio: ['pipe', 'ignore', 'inherit'] });
  ffmpeg.stdin.on('error', () => {});
  const onFrame = async (frame) => {
    ffmpeg.stdin.write(Buffer.from(frame.data, 'base64'));
    await game.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  };
  game.cdp.on('Page.screencastFrame', onFrame);
  await game.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 2 });
  return async () => {
    await game.cdp.send('Page.stopScreencast').catch(() => {});
    game.cdp.off('Page.screencastFrame', onFrame);
    ffmpeg.stdin.end();
    await new Promise((done) => ffmpeg.on('close', done));
  };
}
