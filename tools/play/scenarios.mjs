// Each scenario plays one stretch of the game. `metric` records feel numbers; `expect` fails the run.
const MPH_60 = 26.82;

async function teleportAndSettle(human, place, mode) {
  if (mode) {
    await human.press({ person: 'Digit1', car: 'Digit2', cyclist: 'Digit3', helicopter: 'Digit4' }[mode]);
    await human.react();
  }
  await human.clickTeleport(place);
  return human.state();
}

// The city builds behind the game; this waits for all of it, which is what the first scripted minute can't show
async function expectCityCompletes(human, page, expect, minutes = 2.5) {
  const done = await human.page.waitForFunction(() => window.__slopDebug.worldCompleteAt() !== null, null, { timeout: minutes * 60000, polling: 500 }).catch(() => null);
  expect(done, `the city was not finished after ${minutes} min`);
  return page.evaluate(() => window.__slopDebug.renderInfo());
}

export const SCENARIOS = {
  'first-minute': {
    async run({ human, page, metric, expect }) {
      await human.wait(1500); // a new player takes in the screen first
      const start = await human.state();
      expect(start.mode === 'car', `first visit should start in the car, got ${start.mode}`);

      // Timed inside the page: a round trip from this script would add its own delay
      await page.evaluate(() => {
        window.__motion = new Promise((done) => {
          addEventListener('keydown', () => {
            const pressed = performance.now();
            const check = () => {
              if (Math.abs(window.__slopDebug.player().speed) > 0.01) done(performance.now() - pressed);
              else requestAnimationFrame(check);
            };
            check();
          }, { once: true });
        });
      });
      await human.down('KeyW');
      metric('inputToMotionMs', Math.round(await page.evaluate(() => window.__motion)));

      // Traffic can end a run, so try again from a standstill rather than report the crash as the car's pace.
      // Times come from the game clock: this is about the car, not the frame rate of this machine.
      let best = null;
      let peak = 0;
      for (let attempt = 0; attempt < 4 && best === null; attempt++) {
        const startClock = await human.clock();
        let previous = 0;
        let crashed = false;
        for (const deadline = Date.now() + 20000; Date.now() < deadline && !crashed;) {
          const speed = Math.abs((await human.state()).speed);
          peak = Math.max(peak, speed);
          if (speed >= MPH_60) {
            best = await human.clock() - startClock;
            break;
          }
          crashed = previous > 5 && speed < previous * 0.8;
          previous = speed;
          await human.wait(50);
        }
        if (best === null) {
          await human.up('KeyW');
          await human.down('KeyS');
          await human.until((s) => Math.abs(s.speed) < 0.5, { timeout: 5000 });
          await human.up('KeyS');
          await human.hold('KeyA', 450);
          await human.down('KeyW');
        }
      }
      metric('zeroToSixtySeconds', best === null ? null : Number(best.toFixed(1)));
      metric('peakSpeedMph', Math.round(peak * 2.237));

      await human.up('KeyW');
      await human.down('KeyS');
      const brakingFrom = await human.state();
      const stopped = await human.until((s) => Math.abs(s.speed) < 0.5, { timeout: 8000, every: 50 });
      await human.up('KeyS');
      if (stopped) {
        metric('brakingFromMph', Math.round(Math.abs(brakingFrom.speed) * 2.237));
        metric('brakingMetres', Number(Math.hypot(stopped.x - brakingFrom.x, stopped.z - brakingFrom.z).toFixed(1)));
      }

      // Turn radius at city speed, on full lock
      await human.down('KeyW');
      await human.until((s) => Math.abs(s.speed) > 9, { timeout: 5000, every: 50 });
      await human.down('KeyD');
      await human.wait(300);
      const a = await human.state();
      await human.wait(1200);
      const b = await human.state();
      await human.releaseAll();
      const turned = Math.abs(Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading)));
      if (turned > 0.1) metric('turnRadiusMetres', Number((Math.hypot(b.x - a.x, b.z - a.z) / turned).toFixed(1)));
      await human.down('KeyS');
      await human.until((s) => Math.abs(s.speed) < 0.5, { timeout: 6000 });
      await human.releaseAll();
    }
  },

  'drive-route': {
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      await teleportAndSettle(human, 'empire');
      const { waypoints } = await page.evaluate(() => {
        const { avenueX, streetZ } = window.__slopDebug;
        return {
          waypoints: [
            { x: avenueX('5') + 3, z: streetZ(42) + 6 },
            { x: avenueX('7') + 3, z: streetZ(42) + 3 },
            { x: avenueX('7') + 3, z: streetZ(46) }
          ]
        };
      });
      const total = { seconds: 0, backups: 0, blockedSeconds: 0 };
      for (const waypoint of waypoints) {
        const leg = await human.driveTo(waypoint, { timeout: 80000 });
        expect(leg.reached, `did not reach waypoint ${Math.round(waypoint.x)}, ${Math.round(waypoint.z)}`);
        total.seconds += leg.seconds;
        total.backups += leg.backups;
        total.blockedSeconds += leg.blockedSeconds;
        if (!leg.reached) break;
      }
      metric('routeSeconds', Number(total.seconds.toFixed(1)));
      metric('routeBackups', total.backups);
      metric('blockedByTrafficShare', Number((total.blockedSeconds / Math.max(1, total.seconds)).toFixed(3)));
    }
  },

  'crash-recovery': {
    async run({ human, page, metric, expect }) {
      await human.wait(1000);
      const from = await teleportAndSettle(human, 'empire');
      // Build up speed down 5th Ave, then swing into the unbroken east wall of the next block.
      await human.down('KeyW');
      await human.until((state) => Math.hypot(state.x - from.x, state.z - from.z) > 110, { timeout: 12000 });
      const wall = await page.evaluate((x) => ({ x: x + 200 }), from.x);
      let hit = null;
      let previous = await human.state();
      const deadline = Date.now() + 12000;
      while (!hit && Date.now() < deadline) {
        const state = await human.state();
        await human.steerTowards(state, { x: wall.x, z: state.z + 120 });
        // Throttle held, so only an impact takes a quarter of the speed away between two looks.
        if (Math.abs(previous.speed) > 6 && Math.abs(state.speed) < Math.abs(previous.speed) * 0.75) hit = { before: previous, after: state };
        previous = state;
        await human.wait(60);
      }
      await human.releaseAll();
      expect(hit, 'never hit the wall');
      if (!hit) return;
      metric('impactMph', Math.round(Math.abs(hit.before.speed) * 2.237));

      const hitAt = Date.now();
      await human.react();
      await human.hold('KeyS', 1300);
      // Back the way it came, which is open by construction: this bot steers in straight lines and can't route around
      // a corner, and the crash can leave it rolling down a cross street
      const road = {
        x: hit.before.x - Math.sin(hit.before.heading) * 45,
        z: hit.before.z - Math.cos(hit.before.heading) * 45
      };
      const recovery = await human.driveTo(road, { timeout: 14000, arrive: 18 });
      expect(recovery.reached, `could not drive away after the crash: ended at speed ${(await human.state()).speed.toFixed(1)}, ${recovery.backups} backups`);
      metric('crashRecoverySeconds', recovery.reached ? Number(((Date.now() - hitAt) / 1000).toFixed(1)) : null);
      metric('crashRecoveryBackups', recovery.backups);
    }
  },

  'walk-cycle': {
    async run({ human, metric, expect }) {
      await human.wait(800);
      await teleportAndSettle(human, 'timessq', 'person');
      await human.down('KeyW');
      await human.wait(2500);
      const walking = await human.state();
      expect(Math.abs(walking.speed) > 3, `walking stayed at ${walking.speed.toFixed(1)} m/s`);
      metric('runSpeedMph', Math.round(Math.abs(walking.speed) * 2.237));

      const ground = walking.y;
      await human.down('Space');
      await human.wait(90);
      await human.up('Space');
      const air = await human.until((s) => s.y > ground + 0.3, { timeout: 1500, every: 30 });
      expect(air, 'jump never left the ground');
      const landed = await human.until((s) => s.y <= ground + 0.05, { timeout: 3000, every: 30 });
      expect(landed, 'never landed after the jump');

      // Over the kerb and back
      await human.hold('KeyA', 700);
      await human.wait(1500);
      await human.hold('KeyD', 900);
      await human.wait(1500);
      await human.releaseAll();

      await human.press('Digit3');
      await human.react();
      await human.down('KeyW');
      await human.wait(3500);
      const cycling = await human.state();
      expect(cycling.mode === 'cyclist', 'did not switch to the bicycle');
      expect(Math.abs(cycling.speed) > 4, `cycling stayed at ${cycling.speed.toFixed(1)} m/s`);
      metric('cycleSpeedMph', Math.round(Math.abs(cycling.speed) * 2.237));
      await human.hold('KeyA', 600);
      await human.wait(1500);
      await human.hold('KeyD', 600);
      await human.wait(1000);
      await human.releaseAll();
    }
  },

  helicopter: {
    async run({ human, metric, expect }) {
      await human.wait(800);
      await teleportAndSettle(human, 'bryant', 'helicopter');
      await human.press('Digit4');
      await human.down('Space');
      await human.wait(2500);
      await human.up('Space');
      const climbed = await human.state();
      expect(climbed.y > 100, `climbed only to ${climbed.y.toFixed(0)} m`);

      await human.down('KeyW');
      await human.wait(4000);
      await human.hold('KeyA', 900);
      await human.wait(1500);
      await human.up('KeyW');
      const cruising = await human.state();
      expect(Math.abs(cruising.speed) > 15, `cruise speed only ${cruising.speed.toFixed(1)} m/s`);
      metric('heliCruiseMph', Math.round(Math.abs(cruising.speed) * 2.237));

      // Land on a street: straight down
      await human.until((s) => Math.abs(s.speed) < 2, { timeout: 8000 });
      await human.down('KeyQ');
      const started = Date.now();
      const down = await human.until((s) => s.y < 1, { timeout: 30000 });
      await human.up('KeyQ');
      metric('heliDescentSeconds', down ? Number(((Date.now() - started) / 1000).toFixed(1)) : null);
      metric('heliSettledAltitude', Number((await human.state()).y.toFixed(1)));

      // Roof landing: climb, fly on until there is a roof underneath, stop, and sink straight down onto it
      await human.down('Space');
      await human.wait(2600);
      await human.up('Space');
      await human.down('KeyW');
      const overRoof = await human.until((s) => s.roof > 12, { timeout: 12000, every: 60 });
      await human.up('KeyW');
      expect(overRoof, 'never flew over a roof');
      if (overRoof) {
        const stopped = await human.until((s) => Math.abs(s.speed) < 1.5, { timeout: 6000 });
        const target = stopped || overRoof;
        await human.down('KeyQ');
        const settled = await human.until((s) => Math.abs(s.y - (s.roof + 0.25)) < 0.2 && s.roof > 5, { timeout: 25000, every: 60 });
        await human.wait(700);
        await human.up('KeyQ');
        const end = await human.state();
        expect(settled, `did not settle on the roof: y ${end.y.toFixed(1)}, roof ${end.roof.toFixed(1)}`);
        const drift = Math.hypot(end.x - target.x, end.z - target.z);
        expect(drift < 8, `landing threw the helicopter ${drift.toFixed(1)} m sideways`);
        metric('heliRoofHeight', Number(end.roof.toFixed(1)));
      }

      await human.press('Digit1');
      await human.react();
      expect((await human.state()).mode === 'person', 'could not leave the helicopter');
      await human.press('Digit4');
      await human.down('KeyE');
      await human.wait(1200);
      await human.releaseAll();
    }
  },

  'mode-map': {
    async run({ human, page, expect }) {
      await human.wait(800);
      await human.down('KeyW');
      await human.wait(1800);
      for (const key of ['Digit1', 'Digit3', 'Digit4', 'Digit2']) {
        await human.press(key);
        await human.wait(human.between(500, 900));
      }
      await human.releaseAll();
      for (let i = 0; i < 12; i++) {
        await human.press('KeyV');
        await human.wait(human.between(250, 500));
      }
      await human.press('Digit5');
      for (const time of ['midday', 'twilight', 'midnight', 'golden']) {
        await page.locator(`[data-time="${time}"]`).click();
        await human.wait(700);
      }

      await human.press('KeyM');
      await human.wait(700);
      const open = () => page.evaluate(() => !document.getElementById('fullmap-modal').classList.contains('hidden'));
      expect(await open(), 'the map did not open');
      await page.locator('#fullmap-search').click();
      await page.keyboard.type('Broadway', { delay: 70 });
      await human.wait(800);
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.press('Escape');
      await human.wait(300);
      if (await open()) await page.keyboard.press('Escape');
      await human.wait(400);
      expect(!(await open()), 'the map did not close');

      await human.press('KeyM');
      await human.wait(600);
      const box = await page.locator('#fullmap-canvas').boundingBox();
      const before = await human.state();
      await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
      await human.wait(900);
      if (await open()) await page.keyboard.press('Escape');
      const after = await human.state();
      expect(Math.hypot(after.x - before.x, after.z - before.z) > 5 || !(await open()), 'the map click did nothing');

      await human.clickTeleport('owtc');
      await human.clickTeleport('centralpark');
    }
  },

  touch: {
    profile: 'phone',
    async run({ human, game, page, metric, expect }) {
      const { cdp } = game;
      const fits = () => page.evaluate(() => {
        const canvas = document.querySelector('#canvas-container canvas');
        const rect = canvas.getBoundingClientRect();
        const { aspect } = window.__slopDebug.camera();
        return { width: innerWidth, height: innerHeight, cssWidth: rect.width, cssHeight: rect.height, aspect, scale: visualViewport.scale };
      });
      const expectFit = (fit, label) => {
        expect(Math.abs(fit.cssWidth - fit.width) < 1 && Math.abs(fit.cssHeight - fit.height) < 1, `${label}: canvas is ${fit.cssWidth}x${fit.cssHeight} in a ${fit.width}x${fit.height} window`);
        expect(Math.abs(fit.aspect - fit.width / fit.height) < 0.01, `${label}: camera aspect ${fit.aspect} for ${fit.width}x${fit.height}`);
        expect(fit.scale === 1, `${label}: page zoomed to ${fit.scale}`);
      };
      await human.wait(1000);
      expectFit(await fits(), 'portrait');

      const stick = await page.locator('#touch-stick').boundingBox();
      const center = { x: stick.x + stick.width / 2, y: stick.y + stick.height / 2 };
      const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
      await touch('touchStart', [{ x: center.x, y: center.y, id: 1 }]);
      await touch('touchMove', [{ x: center.x, y: center.y - 40, id: 1 }]);
      await human.wait(3000);
      const driving = await human.state();
      expect(Math.abs(driving.speed) > 3, `joystick drove at only ${driving.speed.toFixed(1)} m/s`);
      await touch('touchEnd', []);
      await human.wait(300);

      // Rotate mid-drive, with the car still rolling
      const rolling = await human.state();
      await page.setViewportSize({ width: 844, height: 390 });
      await human.wait(1000);
      const landscape = await fits();
      expectFit(landscape, 'landscape');
      const after = await human.state();
      metric('speedAcrossRotation', { before: Number(rolling.speed.toFixed(1)), after: Number(after.speed.toFixed(1)) });
      await human.wait(500);

      const stick2 = await page.locator('#touch-stick').boundingBox();
      const center2 = { x: stick2.x + stick2.width / 2, y: stick2.y + stick2.height / 2 };
      await touch('touchStart', [{ x: center2.x, y: center2.y, id: 2 }]);
      await touch('touchMove', [{ x: center2.x + 30, y: center2.y - 30, id: 2 }]);
      await human.wait(2000);
      await touch('touchEnd', []);

      await page.setViewportSize({ width: 390, height: 844 });
      await human.wait(1000);
      expectFit(await fits(), 'portrait again');
    }
  },

  pause: {
    async run({ human, page, expect }) {
      const snapshot = () => page.evaluate(() => {
        const debug = window.__slopDebug;
        const dialog = document.getElementById('pause-menu');
        return { paused: debug.paused(), open: dialog.open, clock: debug.clock(), audio: debug.audioState(), ...debug.player() };
      });
      await human.wait(800);
      await human.down('KeyW'); // also unlocks audio, which needs a gesture
      await human.wait(2500);
      await human.up('KeyW');

      for (const [label, opener] of [['P', () => human.press('KeyP')], ['Esc', () => human.press('Escape')], ['button', () => page.locator('#btn-pause').click()]]) {
        await opener();
        await human.wait(500);
        const start = await snapshot();
        expect(start.paused && start.open, `${label} did not open the pause screen`);
        expect(start.audio !== 'running', `${label}: audio still ${start.audio} while paused`);
        await page.keyboard.down('KeyW');
        await page.keyboard.press('Digit4');
        await page.keyboard.press('KeyM');
        await human.wait(5000);
        await page.keyboard.up('KeyW');
        const end = await snapshot();
        expect(end.clock === start.clock, `${label}: the game clock ran while paused`);
        expect(end.x === start.x && end.z === start.z, `${label}: the player moved while paused`);
        expect(end.mode === start.mode, `${label}: a shortcut changed the mode while paused`);
        expect(await page.locator('#fullmap-modal.hidden').count() === 1, `${label}: M opened the map while paused`);

        // Rotating while paused has to leave a picture behind the dialog
        await page.setViewportSize({ width: 720, height: 1280 });
        await human.wait(500);
        await page.setViewportSize({ width: 1280, height: 720 });
        await human.wait(500);

        await page.locator('#pause-resume').click();
        await human.wait(800);
        const resumed = await snapshot();
        expect(!resumed.paused && !resumed.open, `${label}: did not resume`);
        expect(resumed.clock > end.clock, `${label}: the clock stayed frozen after resuming`);
        expect(resumed.audio === 'running' || resumed.audio === 'none', `${label}: audio did not resume, ${resumed.audio}`);
      }

      await human.press('KeyM');
      await human.wait(500);
      await human.press('Escape');
      await human.wait(400);
      const afterMap = await snapshot();
      expect(!afterMap.paused, 'Esc on the map also opened the pause screen');
      await page.locator('[popovertarget="teleport-popover"]').first().click();
      await human.wait(300);
      await human.press('Escape');
      await human.wait(400);
      expect(!(await snapshot()).paused, 'Esc on a popover also opened the pause screen');
      await human.press('KeyP');
      await human.wait(300);
      await human.press('Escape');
      await human.wait(400);
      expect(!(await snapshot()).paused, 'Esc did not close the pause screen');
    }
  },

  // Too many pixels for integrated graphics, which is what Auto is there to correct
  'auto-steps-down': {
    profile: 'wide',
    async run({ human, page, metric, expect }) {
      await expectCityCompletes(human, page, expect);
      const before = await page.evaluate(() => window.__slopDebug.quality());
      const lowered = await page.waitForFunction((ratio) => window.__slopDebug.quality().pixelRatio < ratio, before.pixelRatio, { timeout: 40000, polling: 500 }).catch(() => null);
      const after = await page.evaluate(() => window.__slopDebug.quality());
      metric('pixelRatio', { before: before.pixelRatio, after: Number(after.pixelRatio.toFixed(3)) });
      await page.waitForTimeout(1000);
      await page.evaluate(() => window.__slopDebug.frameCost());
      await page.waitForTimeout(3000);
      metric('fpsAfter', (await page.evaluate(() => window.__slopDebug.frameCost())).fps);
      if (!lowered) metric('note', 'this GPU kept up at 1440p, so nothing needed lowering');
    }
  },

  'graphics-menu': {
    async run({ human, page, expect }) {
      await expectCityCompletes(human, page, expect);
      await human.down('KeyW');
      await human.wait(2000);
      await human.releaseAll();
      await human.wait(800);
      const before = await human.state();
      await human.press('KeyP');
      await human.wait(400);
      await Promise.all([page.waitForNavigation({ waitUntil: 'commit' }), page.locator('[data-quality="low"]').click()]);
      await page.waitForFunction(() => document.getElementById('loading-overlay')?.classList.contains('hidden'), null, { timeout: 60000, polling: 200 });
      const quality = await page.evaluate(() => window.__slopDebug.quality());
      expect(quality.choice === 'low' && quality.level === 'low', `the Low choice did not stick: ${JSON.stringify(quality)}`);
      const after = await human.state();
      expect(Math.hypot(after.x - before.x, after.z - before.z) < 12, `the reload lost the player: ${Math.round(Math.hypot(after.x - before.x, after.z - before.z))} m away`);

      await human.press('KeyP');
      await human.wait(400);
      await Promise.all([page.waitForNavigation({ waitUntil: 'commit' }), page.locator('[data-quality="auto"]').click()]);
      await page.waitForFunction(() => document.getElementById('loading-overlay')?.classList.contains('hidden'), null, { timeout: 60000, polling: 200 });
      expect((await page.evaluate(() => window.__slopDebug.quality())).choice === 'auto', 'Auto did not come back');
    }
  },

  'high-graphics': {
    query: 'quality=high',
    async run({ human, page, metric, expect }) {
      const { backend } = await expectCityCompletes(human, page, expect);
      expect(backend === 'webgpu', `expected WebGPU, got ${backend}`);
      await human.down('KeyW');
      await human.wait(2500);
      await human.releaseAll();
      metric('level', await page.evaluate(() => window.__slopDebug.quality().level));
    }
  },

  'low-graphics': {
    query: 'quality=low',
    async run({ human, page, expect }) {
      await expectCityCompletes(human, page, expect);
      await human.down('KeyW');
      await human.wait(2500);
      await human.releaseAll();
    }
  },

  'webgl2-fallback': {
    initScript: () => { delete Navigator.prototype.gpu; },
    async run({ human, page, metric, expect }) {
      const { backend } = await expectCityCompletes(human, page, expect, 3.5);
      expect(backend === 'webgl2', `expected the WebGL2 fallback, got ${backend}`);
      metric('level', await page.evaluate(() => window.__slopDebug.quality().level));
      await human.down('KeyW');
      await human.wait(2500);
      await human.releaseAll();
    }
  },

  // Coming back far from the default start: the starting view has to form around the saved spot, not around Midtown
  'saved-position': {
    storage: JSON.stringify({
      version: 1,
      activeMode: 'car',
      entities: { car: { x: -305.7, y: 0, z: 5210, heading: 0 } }
    }),
    async run({ human, page, expect }) {
      const start = await human.state();
      expect(Math.hypot(start.x + 305.7, start.z - 5210) < 40, `restored at ${start.x.toFixed(0)}, ${start.z.toFixed(0)} instead of One WTC`);
      await human.wait(500);
      await human.down('KeyW');
      await human.wait(2000);
      await human.releaseAll();
      await expectCityCompletes(human, page, expect);
    }
  },

  'offline-file': {
    file: 'slop-newyork.html',
    async run({ human, page, expect }) {
      expect(await page.evaluate(() => location.protocol) === 'file:', 'not running from a file');
      expect(await page.evaluate(() => document.fonts.check('14px Inter')), 'the embedded font did not load');
      expect(await page.locator('#loading-overlay .offline-link').evaluate((link) => getComputedStyle(link).display) === 'none', 'the offline copy still offers itself');
      await expectCityCompletes(human, page, expect);
      await human.down('KeyW');
      await human.wait(2000);
      await human.releaseAll();
    }
  },

  soak: {
    memory: true,
    async run({ human, page, options, metric, expect, watchdog }) {
      const minutes = options.soakMinutes;
      const places = ['empire', 'timessq', 'chrysler', 'bryant', 'flatiron', 'centralpark', 'owtc'];
      const pick = (list) => list[Math.floor(human.random() * list.length)];
      const end = Date.now() + minutes * 60000;
      let actions = 0;
      while (Date.now() < end) {
        const roll = human.random();
        const state = await human.state();
        if (roll < 0.5) {
          const angle = human.random() * Math.PI * 2;
          const reach = human.between(80, 260);
          await human.press('Digit2');
          await human.driveTo({ x: state.x + Math.sin(angle) * reach, z: state.z + Math.cos(angle) * reach }, { timeout: 15000, arrive: 20 });
        } else if (roll < 0.65) {
          await human.press(pick(['Digit1', 'Digit3']));
          await human.down('KeyW');
          // A player who walks into a wall turns away; a real trap still trips the stuck check
          let last = await human.state();
          for (const end = Date.now() + human.between(2000, 5000); Date.now() < end;) {
            await human.wait(800);
            const now = await human.state();
            if (Math.hypot(now.x - last.x, now.z - last.z) < 0.5) await human.hold('KeyA', 500);
            last = now;
          }
          await human.releaseAll();
        } else if (roll < 0.75) {
          await human.press('Digit4');
          await human.down('Space');
          await human.wait(1000);
          await human.up('Space');
          await human.down('KeyW');
          await human.wait(human.between(2000, 4000));
          await human.releaseAll();
        } else if (roll < 0.85) {
          await human.clickTeleport(pick(places));
        } else if (roll < 0.93) {
          await human.press('KeyV');
          await human.wait(1200);
          await human.press('Digit5');
        } else {
          await human.press('KeyM');
          await human.wait(1200);
          await page.keyboard.press('Escape');
        }
        actions++;
        await human.releaseAll();
      }
      metric('soakActions', actions);
      const memory = watchdog.memory;
      metric('heapMegabytes', memory);
      if (memory.length >= 6) {
        const settled = memory[2];
        const final = memory.at(-1);
        expect(final < settled * 1.25, `JS heap grew from ${settled} MB to ${final} MB`);
      }
    }
  }
};
