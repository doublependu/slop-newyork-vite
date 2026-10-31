// npm run play [-- --only=first-minute,touch] [--headed] [--no-video] [--soak=10]
// Plays every scenario on the production build, writes recordings/<date>/, and exits non-zero on a failed check.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchChrome, openGame, ROOT, serveDist, startRecording } from './lib.mjs';
import { Human, Watchdog } from './human.mjs';
import { SCENARIOS } from './scenarios.mjs';

const option = (name, fallback) => {
  const arg = process.argv.find((value) => value === `--${name}` || value.startsWith(`--${name}=`));
  return arg ? (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : true) : fallback;
};
const names = option('only') ? option('only').split(',') : Object.keys(SCENARIOS);
const video = !option('no-video', false);
const options = { soakMinutes: Number(option('soak', 10)) };
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const outDir = join(ROOT, 'recordings', stamp);
mkdirSync(outDir, { recursive: true });

const server = await serveDist();
const report = [];
for (const [index, name] of names.entries()) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`Unknown scenario: ${name}`);
  const browser = await launchChrome({ headed: option('headed', false) });
  const url = scenario.file ? pathToFileURL(join(ROOT, 'dist', scenario.file)).href : server.url;
  const game = await openGame(browser, url, {
    profile: scenario.profile || 'laptop',
    query: scenario.query,
    storage: scenario.storage,
    initScript: scenario.initScript,
    offline: Boolean(scenario.file)
  });
  const stopRecording = video ? await startRecording(game, join(outDir, `${name}.mp4`)) : null;
  const human = new Human(game, index + 1);
  const watchdog = new Watchdog(game, { memory: scenario.memory });
  const metrics = {};
  const failures = [];
  const started = Date.now();
  // A script that hangs must fail its scenario, not stall the whole run while the video grows.
  const limitMs = ((name === 'soak' ? options.soakMinutes : 0) + 4) * 60000;
  let timer;
  try {
    await Promise.race([
      scenario.run({
        human,
        game,
        page: game.page,
        options,
        watchdog,
        metric: (key, value) => { metrics[key] = value; },
        expect: (condition, message) => { if (!condition) failures.push(message); }
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${limitMs / 60000} min`)), limitMs); })
    ]);
  } catch (error) {
    failures.push(`script: ${error.message.split('\n')[0]}`);
  }
  clearTimeout(timer);
  await human.releaseAll().catch(() => {});
  failures.push(...await watchdog.stop());
  await game.page.screenshot({ path: join(outDir, `${name}.png`) }).catch(() => {});
  await stopRecording?.();
  await browser.close();
  const entry = { name, pass: failures.length === 0, seconds: Math.round((Date.now() - started) / 1000), failures, metrics };
  report.push(entry);
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${entry.pass ? 'PASS' : 'FAIL'} ${name} (${entry.seconds} s) ${JSON.stringify(metrics)}`);
  for (const failure of failures) console.log(`  - ${failure}`);
}
await server.close();
console.log(`\nRecordings and report: ${outDir}`);
process.exit(report.every((entry) => entry.pass) ? 0 : 1);
