const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
const entries = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)];

test('the page has one module entry, which the bundler follows', () => {
  assert.equal(entries.length, 1);
  assert.equal(entries[0][1], './js/main.js');
  assert.equal([...html.matchAll(/<script\b/g)].length, 1, 'no import map or other inline scripts');
  assert.doesNotMatch(html, /rel="modulepreload"/);
});

test('the game makes no third-party requests', () => {
  for (const [, url] of html.matchAll(/<(?:link|script)\b[^>]*(?:href|src)="([^"]+)"/g)) {
    assert.doesNotMatch(url, /^(?:https?:)?\/\//, `${url} is loaded from another origin`);
  }
});

test('three.js comes from an exact npm version', () => {
  assert.match(pkg.dependencies.three, /^\d+\.\d+\.\d+$/);
});
