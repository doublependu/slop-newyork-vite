// npm run viewports: checks the HUD at each screen size for panels that overflow or overlap. Saves a screenshot of each.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, PROFILES, ROOT, openGame, serveDist } from './lib.mjs';

const SIZES = {
  touch: [[360, 640], [390, 844], [412, 915], [844, 390], [768, 1024], [1024, 768]],
  mouse: [[1024, 768], [1366, 768], [1920, 1080], [2560, 1080]]
};
PROFILES.touchSizes = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, touch: true };
PROFILES.mouseSizes = { viewport: { width: 1366, height: 768 } };

const PANELS = [
  '.repo-link', '#hud-toolbar', '#hud-cluster', '#mode-switch', '#minimap-card', '#hud-location', '#hud-controls-hint',
  '#touch-stick', '.touch-actions', '#app-version'
];

const measure = (selectors) => selectors.flatMap((selector) => [...document.querySelectorAll(selector)].flatMap((element) => {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return [];
  return [{ selector, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }];
}));

const outDir = join(ROOT, 'recordings/viewports');
mkdirSync(outDir, { recursive: true });
const server = await serveDist();
const browser = await launchChrome();
const problems = [];
for (const [input, sizes] of Object.entries(SIZES)) {
  const game = await openGame(browser, server.url, { profile: `${input}Sizes` });
  for (const [width, height] of sizes) {
    await game.page.setViewportSize({ width, height });
    await game.page.waitForTimeout(700);
    const boxes = await game.page.evaluate(measure, PANELS);
    const label = `${input} ${width}x${height}`;
    await game.page.screenshot({ path: join(outDir, `${input}-${width}x${height}.png`) });
    for (const box of boxes) {
      if (box.left < -0.5 || box.top < -0.5 || box.right > width + 0.5 || box.bottom > height + 0.5) {
        problems.push(`${label}: ${box.selector} off-screen (${Math.round(box.left)}, ${Math.round(box.top)} to ${Math.round(box.right)}, ${Math.round(box.bottom)})`);
      }
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
          problems.push(`${label}: ${a.selector} overlaps ${b.selector}`);
        }
      }
    }
  }
  await game.context.close();
}
await browser.close();
await server.close();
for (const problem of problems) console.log(problem);
console.log(problems.length ? `${problems.length} problems` : 'All viewports clean');
process.exit(problems.length ? 1 : 0);
