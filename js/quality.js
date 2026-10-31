// Graphics levels. The level is chosen before the world is built, because MSAA, shadows and agent counts can't change
// afterwards. In Auto, real frame times then correct the first guess.

const LEVELS = {
  low: { ssr: false, msaa: false, bloom: false, shadowTile: 0, pedestrians: 120, cars: 60, buses: 4, drawDistance: 0.7 },
  medium: { ssr: false, msaa: false, bloom: true, shadowTile: 1024, pedestrians: 220, cars: 120, buses: 8, drawDistance: 0.85 },
  high: { ssr: true, msaa: true, bloom: true, shadowTile: 3072, pedestrians: 340, cars: 200, buses: 12, drawDistance: 1 }
};
const LEVEL_ORDER = ['low', 'medium', 'high'];
const CHOICES = ['auto', ...LEVEL_ORDER];

const CHOICE_KEY = 'nyc-quality';
const AUTO_KEY = 'nyc-quality-auto';

// Below this the game looks rough; under 20 FPS it also runs in slow motion (the frame step is capped at 0.05 s).
const TARGET_FRAME_SECONDS = 1 / 28;
const WATCH_AFTER_SECONDS = 5;
const WINDOW_SECONDS = 3;
const PIXEL_SCALE_STEP = 0.85;
const MIN_PIXEL_SCALE = 0.6;

function guessLevel({ backend, vendor, isFallback, cores, memory, coarse, saveData, pixels }) {
  if (backend !== 'webgpu' || isFallback || saveData || cores <= 4 || memory <= 3) return 'low';
  if (coarse) return vendor === 'apple' ? 'medium' : 'low';
  if (vendor === 'nvidia' || vendor === 'amd' || vendor === 'apple') return pixels > 6e6 ? 'medium' : 'high';
  return 'medium'; // Intel and anything unnamed: assume integrated graphics
}

function pixelRatioFor(level, { coarse, devicePixelRatio }) {
  if (level === 'low') return coarse ? 1 : 0.75;
  if (level === 'medium') return 1;
  return Math.min(devicePixelRatio, 1.5);
}

function lowerLevel(level) {
  return LEVEL_ORDER[Math.max(0, LEVEL_ORDER.indexOf(level) - 1)];
}

function readStored(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null; // Storage may be disabled
  }
}

function writeStored(storage, key, value) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch { /* Storage may be disabled or full. */ }
}

// A URL choice wins for this load only, which lets scripts compare levels without touching saved settings.
function pickLevel(device, { search = '', storage } = {}) {
  const fromUrl = new URLSearchParams(search).get('quality');
  const stored = readStored(storage, CHOICE_KEY);
  const choice = CHOICES.includes(fromUrl) ? fromUrl : CHOICES.includes(stored) ? stored : 'auto';
  if (choice !== 'auto') return { choice, level: choice, pixelScale: 1 };

  const guess = guessLevel(device);
  let learned = null;
  try {
    learned = JSON.parse(readStored(storage, AUTO_KEY));
  } catch { /* Ignore a damaged value. */ }
  // A new guess means different hardware or a changed browser, so what was learned no longer applies
  if (learned?.guess !== guess || !LEVEL_ORDER.includes(learned.level)) return { choice, level: guess, guess, pixelScale: 1 };
  return { choice, level: learned.level, guess, pixelScale: Number(learned.pixelScale) || 1 };
}

async function readDevice() {
  const device = {
    backend: 'webgl2',
    vendor: '',
    isFallback: false,
    cores: navigator.hardwareConcurrency || 4,
    memory: navigator.deviceMemory || 8,
    coarse: matchMedia('(pointer: coarse)').matches,
    saveData: navigator.connection?.saveData === true,
    devicePixelRatio: window.devicePixelRatio || 1,
    pixels: screen.width * screen.height * Math.min(window.devicePixelRatio || 1, 1.5) ** 2
  };
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter) {
      device.backend = 'webgpu';
      device.vendor = (adapter.info?.vendor || '').toLowerCase();
      device.isFallback = Boolean(adapter.isFallbackAdapter ?? adapter.info?.isFallbackAdapter);
    }
  } catch { /* three.js falls back to WebGL2 the same way. */ }
  return device;
}

async function detectQuality() {
  const device = await readDevice();
  const picked = pickLevel(device, { search: location.search, storage: localStorage });
  return {
    ...LEVELS[picked.level],
    ...picked,
    pixelRatio: pixelRatioFor(picked.level, device) * picked.pixelScale
  };
}

function saveChoice(choice) {
  writeStored(localStorage, CHOICE_KEY, choice);
  writeStored(localStorage, AUTO_KEY, null);
}

// Steps the picture down while Auto is in charge. Lowering the pixel ratio needs no shader recompile, so it applies
// at once; when that runs out, the lower level is remembered for the next load rather than reloading mid-game.
class FrameWatcher {
  constructor(quality, { storage, onPixelScale }) {
    this.quality = quality;
    this.storage = storage;
    this.onPixelScale = onPixelScale;
    this.pixelScale = quality.pixelScale;
    this.level = quality.level;
    this.settled = false;
    this.running = 0;
    this.seconds = 0;
    this.frames = 0;
  }

  // rawDt is wall time, not the capped simulation step
  update(rawDt) {
    if (this.quality.choice !== 'auto') return;
    this.running += rawDt;
    if (this.running < WATCH_AFTER_SECONDS) return;
    this.seconds += rawDt;
    this.frames++;
    if (this.seconds < WINDOW_SECONDS) return;
    const average = this.seconds / this.frames;
    this.seconds = 0;
    this.frames = 0;
    if (average > TARGET_FRAME_SECONDS) this.stepDown();
  }

  stepDown() {
    if (this.settled) return;
    const next = this.pixelScale * PIXEL_SCALE_STEP;
    if (next >= MIN_PIXEL_SCALE) {
      this.pixelScale = next;
      this.onPixelScale(next);
    } else {
      // Nothing left to change without a reload; this session stays as it is
      this.settled = true;
      if (this.level === 'low') return;
      this.level = lowerLevel(this.level);
      this.pixelScale = 1;
    }
    this.running = 0; // the new setting gets its settling time as well
    writeStored(this.storage, AUTO_KEY, JSON.stringify({ guess: this.quality.guess, level: this.level, pixelScale: this.pixelScale }));
  }
}

export { CHOICES, LEVELS, FrameWatcher, detectQuality, guessLevel, pickLevel, pixelRatioFor, saveChoice };
