const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/pause-menu.js'), 'utf8');

function setup() {
  const listeners = new Map();
  const dialog = {
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
    addEventListener: (type, listener) => listeners.set(`dialog:${type}`, listener)
  };
  const resume = {
    focused: false,
    focus() { this.focused = true; },
    addEventListener: (type, listener) => listeners.set(`resume:${type}`, listener)
  };
  const elements = { 'pause-menu': dialog, 'pause-resume': resume };
  const { PauseMenu } = loadModule(source, { globals: { document: { getElementById: (id) => elements[id] } } });
  const calls = [];
  const menu = new PauseMenu({ onOpen: () => calls.push('open'), onClose: () => calls.push('close') });
  return { menu, dialog, resume, listeners, calls };
}

test('opening shows the dialog once and focuses Resume', () => {
  const { menu, dialog, resume, calls } = setup();
  menu.open();
  menu.open();
  assert.equal(dialog.open, true);
  assert.equal(resume.focused, true);
  assert.deepEqual(calls, ['open']);
});

test('Resume and Esc both resume the game', () => {
  const { menu, dialog, listeners, calls } = setup();
  menu.open();
  listeners.get('resume:click')();
  assert.equal(dialog.open, false);
  menu.open();
  let prevented = false;
  listeners.get('dialog:cancel')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(menu.isOpen, false);
  assert.deepEqual(calls, ['open', 'close', 'open', 'close']);
});

test('toggle flips between the two states', () => {
  const { menu } = setup();
  menu.toggle();
  assert.equal(menu.isOpen, true);
  menu.toggle();
  assert.equal(menu.isOpen, false);
});
