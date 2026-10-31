// Plays through the same inputs a person has: keys and touches, reaction delays, uneven hold times.
// window.__slopDebug is only read, to decide what a player watching the screen would do next.

const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Human {
  constructor(game, seed = 1) {
    this.game = game;
    this.page = game.page;
    this.random = seededRandom(seed);
    this.held = new Set();
  }

  between(min, max) {
    return min + (max - min) * this.random();
  }

  wait(ms) {
    return this.page.waitForTimeout(ms);
  }

  react() {
    return this.wait(this.between(140, 280));
  }

  state() {
    return this.page.evaluate(() => window.__slopDebug.player());
  }

  clock() {
    return this.page.evaluate(() => window.__slopDebug.clock());
  }

  async down(key) {
    if (this.held.has(key)) return;
    this.held.add(key);
    await this.page.keyboard.down(key);
  }

  async up(key) {
    if (!this.held.delete(key)) return;
    await this.page.keyboard.up(key);
  }

  async setKey(key, on) {
    await (on ? this.down(key) : this.up(key));
  }

  async releaseAll() {
    for (const key of [...this.held]) await this.up(key);
  }

  async press(key) {
    await this.page.keyboard.down(key);
    await this.wait(this.between(50, 110));
    await this.page.keyboard.up(key);
  }

  async hold(key, ms) {
    await this.down(key);
    await this.wait(ms * this.between(0.9, 1.1));
    await this.up(key);
  }

  async until(check, { timeout = 15000, every = 100 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const state = await this.state();
      if (check(state)) return state;
      await this.wait(every);
    }
    return null;
  }

  async clickTeleport(place) {
    await this.page.locator('#btn-teleport, [popovertarget="teleport-popover"]').first().click();
    await this.react();
    await this.page.locator(`[data-teleport="${place}"]`).click();
    await this.wait(600);
  }

  // Steers by looking at where the target is, the way a player eyes a street corner.
  async steerTowards(state, target, deadZone = 0.09) {
    const error = wrapAngle(Math.atan2(target.x - state.x, target.z - state.z) - state.heading);
    await this.setKey('KeyA', error > deadZone);
    await this.setKey('KeyD', error < -deadZone);
    return error;
  }

  // Backs off whatever stopped the car, the way a player would, instead of pressing into it.
  async backUp(steerKey) {
    await this.releaseAll();
    await this.react();
    await this.down('KeyS');
    await this.down(steerKey);
    await this.wait(this.between(1100, 1600));
    await this.releaseAll();
  }

  async driveTo(target, { arrive = 14, timeout = 90000, limit = 18 } = {}) {
    const started = Date.now();
    const stats = { reached: false, seconds: 0, backups: 0, blockedSeconds: 0 };
    let last = await this.state();
    let lastMoved = Date.now();
    let lastSample = Date.now();
    while (Date.now() - started < timeout) {
      const state = await this.state();
      const distance = Math.hypot(target.x - state.x, target.z - state.z);
      if (distance < arrive) {
        stats.reached = true;
        break;
      }
      const error = await this.steerTowards(state, target);
      const speed = Math.abs(state.speed);
      await this.setKey('KeyW', speed < limit && (Math.abs(error) < 1.1 || speed < 5));
      await this.setKey('KeyS', speed > limit + 4 || (Math.abs(error) > 1.1 && speed > 7));
      const now = Date.now();
      if (speed < 1) stats.blockedSeconds += (now - lastSample) / 1000;
      lastSample = now;
      if (Math.hypot(state.x - last.x, state.z - last.z) > 1.5) {
        last = state;
        lastMoved = now;
      } else if (now - lastMoved > 2500) {
        stats.backups++;
        await this.backUp(error > 0 ? 'KeyD' : 'KeyA');
        last = await this.state();
        lastMoved = Date.now();
      }
      await this.wait(this.between(90, 170));
    }
    await this.releaseAll();
    stats.seconds = (Date.now() - started) / 1000;
    return stats;
  }
}

// Fails the scenario for what no player should ever see, whatever the script was doing at the time.
export class Watchdog {
  constructor(game, { memory = false } = {}) {
    this.game = game;
    this.failures = [];
    this.memory = memory ? [] : null;
    this.stuckSince = null;
    this.stuckAt = null;
    this.running = true;
    this.loop = this.run();
  }

  fail(message) {
    if (!this.failures.includes(message)) this.failures.push(message);
  }

  async run() {
    let lastMemory = 0;
    while (this.running) {
      const sample = await this.game.page.evaluate(() => {
        const debug = window.__slopDebug;
        return { player: debug.player(), input: debug.input(), paused: debug.paused(), heap: performance.memory?.usedJSHeapSize };
      }).catch(() => null);
      if (sample) this.inspect(sample);
      if (sample && this.memory && Date.now() - lastMemory > 30000) {
        lastMemory = Date.now();
        this.memory.push(Math.round(sample.heap / 1048576));
      }
      await new Promise((done) => setTimeout(done, 250));
    }
  }

  inspect({ player, input, paused }) {
    const { x, y, z, heading, speed, mode } = player;
    if (![x, y, z, heading, speed].every(Number.isFinite)) this.fail(`non-finite player state in ${mode}: ${JSON.stringify(player)}`);
    if (y < player.ground - 1.5) this.fail(`fell through the world in ${mode} at ${x.toFixed(0)}, ${z.toFixed(0)}: y ${y.toFixed(2)}`);
    const pushing = !paused && (input.forward || input.backward);
    const moved = this.stuckAt && Math.hypot(x - this.stuckAt.x, z - this.stuckAt.z) > 0.5;
    if (!pushing || moved || !this.stuckAt) {
      this.stuckAt = player;
      this.stuckSince = Date.now();
    } else if (Date.now() - this.stuckSince > 5000) {
      this.fail(`stuck over 5 s with input held in ${mode} at ${x.toFixed(0)}, ${z.toFixed(0)}`);
    }
  }

  async stop() {
    this.running = false;
    await this.loop;
    for (const error of this.game.errors) this.fail(`console: ${error.slice(0, 240)}`);
    return this.failures;
  }
}
