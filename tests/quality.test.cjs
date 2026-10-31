const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/quality.js'), 'utf8');
const { FrameWatcher, guessLevel, pickLevel, pixelRatioFor } = loadModule(source, { globals: { Math, JSON, Number, URLSearchParams } });

const desktop = { backend: 'webgpu', vendor: 'intel', isFallback: false, cores: 8, memory: 8, coarse: false, saveData: false, pixels: 2073600 };

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key), map };
}

test('the first guess follows the hardware', () => {
  assert.equal(guessLevel(desktop), 'medium');
  assert.equal(guessLevel({ ...desktop, vendor: 'nvidia' }), 'high');
  assert.equal(guessLevel({ ...desktop, vendor: 'nvidia', pixels: 8294400 }), 'medium');
  assert.equal(guessLevel({ ...desktop, backend: 'webgl2' }), 'low');
  assert.equal(guessLevel({ ...desktop, isFallback: true }), 'low');
  assert.equal(guessLevel({ ...desktop, saveData: true }), 'low');
  assert.equal(guessLevel({ ...desktop, cores: 4 }), 'low');
  assert.equal(guessLevel({ ...desktop, coarse: true, vendor: 'arm' }), 'low');
  assert.equal(guessLevel({ ...desktop, coarse: true, vendor: 'apple' }), 'medium');
});

test('pixel ratio stays affordable', () => {
  assert.equal(pixelRatioFor('low', { coarse: false, devicePixelRatio: 2 }), 0.75);
  assert.equal(pixelRatioFor('low', { coarse: true, devicePixelRatio: 3 }), 1);
  assert.equal(pixelRatioFor('high', { coarse: false, devicePixelRatio: 3 }), 1.5);
  assert.equal(pixelRatioFor('high', { coarse: false, devicePixelRatio: 1 }), 1);
});

test('a URL level beats a saved one, and a saved one beats Auto', () => {
  const storage = memoryStorage({ 'nyc-quality': 'high' });
  assert.equal(pickLevel(desktop, { search: '?quality=low', storage }).level, 'low');
  assert.equal(pickLevel(desktop, { search: '', storage }).level, 'high');
  assert.equal(pickLevel(desktop, { search: '?quality=ultra', storage: memoryStorage() }).level, 'medium');
});

test('Auto keeps what it learned until the hardware guess changes', () => {
  const storage = memoryStorage({ 'nyc-quality-auto': JSON.stringify({ guess: 'medium', level: 'low', pixelScale: 0.85 }) });
  const same = pickLevel(desktop, { storage });
  assert.equal(same.level, 'low');
  assert.equal(same.pixelScale, 0.85);
  assert.equal(pickLevel({ ...desktop, vendor: 'nvidia' }, { storage }).level, 'high');
});

test('slow frames lower the pixel ratio first, then remember a lower level', () => {
  const storage = memoryStorage();
  const scales = [];
  const quality = { choice: 'auto', guess: 'medium', level: 'medium', pixelScale: 1 };
  const watcher = new FrameWatcher(quality, { storage, onPixelScale: (scale) => scales.push(scale) });
  const play = (seconds, dt) => { for (let t = 0; t < seconds; t += dt) watcher.update(dt); };

  play(4.9, 0.05);
  assert.equal(scales.length, 0, 'the first seconds are not judged');
  for (let i = 0; i < 12; i++) play(8.5, 0.05);
  assert.deepEqual(scales.map((s) => Number(s.toFixed(3))), [0.85, 0.722, 0.614]);
  const saved = JSON.parse(storage.map.get('nyc-quality-auto'));
  assert.equal(saved.level, 'low');
  assert.equal(saved.pixelScale, 1);
});

test('smooth frames and manual choices change nothing', () => {
  const storage = memoryStorage();
  const scales = [];
  const smooth = new FrameWatcher({ choice: 'auto', guess: 'high', level: 'high', pixelScale: 1 }, { storage, onPixelScale: (s) => scales.push(s) });
  const manual = new FrameWatcher({ choice: 'high', level: 'high', pixelScale: 1 }, { storage, onPixelScale: (s) => scales.push(s) });
  for (let t = 0; t < 30; t += 0.05) manual.update(0.05);
  for (let t = 0; t < 30; t += 0.016) smooth.update(0.016);
  assert.equal(scales.length, 0);
  assert.equal(storage.map.size, 0);
});
