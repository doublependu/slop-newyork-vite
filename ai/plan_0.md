# Plan 0: npm packaging, Cloudflare deploy, mobile play, offline build, play scripts

Answers `ai/prompt_0.md`, and also covers the Spec in `CLAUDE.md`, because the measurements below show that is the largest piece of work.

Nothing is implemented yet. All experiments ran on a throwaway copy, so the repo is unchanged.

## Where things stand

Every item in the prompt looks doable. Packaging, the Cloudflare config, the offline file and scripted play were each prototyped and worked.

The real gap is the Spec. The game misses both targets on the hardware the Spec names, and packaging alone fixes neither:

| Measure | Spec | Today | With Vite alone |
|---|---|---|---|
| Time to interaction, this laptop | 2-3 s, 4 s max | 9.4 s | 8.1 s |
| Time to interaction, phone profile | 2-3 s, 4 s max | not measured | 28.3 s |
| 1080p on Intel UHD | "plays well" | 20 FPS, slowest 5% of frames 117 ms+ | 20 FPS |

Phases 1-6 and 9 deliver the prompt. Phases 7-8 deliver the Spec. Phase 8 (changing how the world gets built) is the biggest and riskiest part of this plan, and hitting 4 s on a phone is not proven.

| Prompt item | Phase |
|---|---|
| Package with npm | 1 |
| Static site, Cloudflare via wrangler, preview URLs off | 2 |
| Version in a corner | 2 |
| Fork me and Maize.Live links on the loading page | 2 |
| Download as a single HTML file | 3 |
| Scripts that play like a human, with recordings | 4 |
| Full screen, responsive, rotation, zoom prevention | 5 |
| Fork me and Maize.Live links on the pause screen (no pause exists yet) | 6 |
| Balanced and fun, fewer bugs | 9 |
| Three.js | Already used |
| Multiplayer (p3p2), physics engine | Not needed: no multiplayer, and `js/vehicle-physics.js` covers physics |

## Measurements

**Setup:** i7-13620H with Intel UHD (the NVIDIA driver is not loaded, so everything ran on the integrated GPU), Chrome 156 headless with real WebGPU over Vulkan, cold profile, local server with brotli to approximate Cloudflare.

**Phone profile:** 390x844 touch, 4x CPU throttle, 50 Mbps. It slows the CPU only, so its FPS figures flatter a real phone.

### Load time, in seconds (Vite prototype)

| Stage | Desktop | Phone profile |
|---|---|---|
| Download and JS start | 0.7 | 1.7 |
| Renderer, sky, UI | 0.3 | 0.6 |
| World build | 3.9 | 14.9 |
| Shader compile (621 batches, 192 materials) | 1.9 | 7.9 |
| First frame warm-up and GPU wait | 1.4 | 3.2 |
| **Total** | **8.1** | **28.3** |

- **The network is not the problem.** The download drops from 2.0 MB in 68 requests to 1.4 MB in 6.
- **Repeat visits are no faster.** Compile stayed at 1.9 s across three visits in one profile. The CPU profile points at TSL-to-WGSL generation in JS, which the browser's pipeline cache cannot help.
- **The world build has no single hot spot.** The largest self-times are 220-380 ms, so tuning alone cannot give the 7x cut a phone needs.
- **Baking the whole city is out.** It holds 202 MB of geometry plus 42 MB of instance data.
- **Partial baking or splitting is possible.** The generators never call `Math.random`.

### Frame cost on Intel UHD

| Settings | Avg FPS | 95th percentile frame |
|---|---|---|
| 1920x1080, today | 20.2 | 117 ms |
| SSR and MSAA off | 26.8 | 100 ms |
| Also 1024 shadow tiles | 29.8 | 83 ms |
| Also 0.75 pixel ratio | 41.4 | 67 ms |
| SSR, MSAA, shadows and bloom off, 0.75 pixel ratio | 47.9 | 50 ms |
| 1366x768, today | 29.5 | 83 ms |
| 1366x768, SSR and MSAA off, 1024 shadow tiles | 44.3 | 50 ms |

- **Scene load:** 1,073 draw calls and 4.7M triangles per frame.
- **Phones are CPU-limited too.** The main thread spends about 4 ms on simulation and 14 ms submitting the frame on this fast CPU. At 4x that is about 70 ms, or 14 FPS whatever the GPU does, so phones need fewer draws and fewer cars and people, not just fewer effects.
- **Unexplained frame spikes.** Most rows have a 16.7 ms median but a much lower average, so a minority of very slow frames is doing the damage. Even the lightest row misses 60 FPS. The cause is unknown and it could be a headless artifact, so check it in a real window first (Phase 7).
- **WebGL2 fallback works.** No errors, but 13.2 s to load (including a 5.5 s blocking warm-up) and about 19 FPS.

### Prototype results

| Item | Result |
|---|---|
| `three@0.187.0` replaces the CDN dev commit | Boots with no errors. Published 2 days after the pinned commit |
| Bare `three` imports inside addons | No alias needed: same bundle size either way, no `WebGLRenderer` in it |
| Vite 8 build | Under 1 s. 2.78 MB JS (906 KB gzip) plus 563 KB geodata |
| Single file | 3.6 MB. Boots from `file://` with the network off, on WebGPU. Only error is the Google Fonts request |
| `preview_urls: false` | Accepted by `wrangler deploy --dry-run` as a static-assets Worker |
| `wrangler dev` | Brotli on JS and HTML, `.gz` not double-encoded, `_headers` applied and not served |
| Scripted play | Real keyboard and touch input drove the car, helicopter and walking in headless Chrome, and opened the map |
| Video | CDP screencast piped to system `ffmpeg` captures the WebGPU canvas |
| Rotation | In Chrome emulation the canvas, buffer and aspect follow in both directions |
| Links | `github.com/doublependu/slop-newyork-vite` and `maize.live` both return 200 |

### Problems found

- **No pause state exists.** The prompt assumes one, so it has to be built.
- **Blurry phones:** `renderer.setPixelRatio(1.0)` is hard-coded, so a 3x phone renders at 1x.
- **Tunnel view in portrait:** the 56° vertical FOV leaves about 28° horizontal in portrait, against about 98° in landscape.
- **Toolbar overflow:** it sits 6 px off-screen at 390 px wide.
- **Likely iOS zoom trap:** `.fullmap-search` is 13.5px, and iOS zooms in on focused inputs under 16px. This is the "can't zoom back out" case from the prompt.
- **No free corner on desktop:** all four corners hold a panel.
- **Slow motion below 20 FPS:** `dt` is clamped to 0.05 s in `main.js`.
- **Test command:** `node --test tests/` fails on Node 24. All 225 tests pass with `node --test "tests/**/*.test.*"`.

### Not verified

- **Real phones and iOS Safari.** None were available. This covers phone GPU speed, WebGPU availability on entry-level devices, rotation timing and zoom prevention.
- **Pinch and double-tap zoom.** Synthetic pinch left the scale at 1 even on an unprotected control page, so headless Chrome cannot test this at all. It needs a real device.
- **Firefox and Safari opening the offline file.** Only Chrome was tested.
- **Production Cloudflare.** Only the local runtime was tested.

## Decisions

Say so if you want any of these changed.

1. **Layout stays put.** `index.html`, `js/`, `css/` and `tools/` do not move, because the 28 test files and the generators read those paths.
2. **`three` is pinned to exactly `0.187.0`.**
3. **Fork link goes to `github.com/doublependu/slop-newyork-vite`.** The existing HUD GitHub link moves there too, so the game shows one repo, and the pause screen credits `mrdoob/slop-newyork`.
4. **Cloudflare Workers static assets, not Pages.** Worker name is `slop-newyork-vite`. The `workers.dev` production URL stays on; only per-version preview URLs are off. You run `npx wrangler login` and `npm run deploy`.
5. **Fonts are self-hosted.** Offline play needs it, and it removes a third-party stylesheet from the head. Inter (73 KB) plus Overpass 600 and 700 (35 KB), Latin only.
6. **Version sits bottom-right on every layout.** That corner is empty on touch. On desktop it sits at about 10px in the 20 px gutter under the speed cluster, which is the only free space in a corner.
7. **The game stays a sandbox.** It has no goals or score, and missions would be a new feature. Ideas go in `ai/next_0.md`.
8. **The play scripts measure feel; you judge fun.** They can show that acceleration, crash recovery and traffic behave. Whether it is fun comes from you watching the recordings.

## Phase 1: Package with npm and Vite

- Write `package.json` by hand, because the README's `npm create vite` is for an empty folder. Commit the lockfile.

  ```json
  "scripts": {
    "dev": "vite",
    "build": "vite build && vite build --mode offline",
    "preview": "vite preview",
    "test": "node --test \"tests/**/*.test.*\"",
    "deploy": "npm run build && wrangler deploy",
    "play": "node tools/play/run.mjs",
    "bench": "node tools/play/bench.mjs"
  }
  ```

- Add `vite.config.js` with `base: './'` and `build.target: 'esnext'` (the geodata modules use top-level await).
- Clean `index.html`: remove the import map, all `modulepreload` and `preload` tags, the jsDelivr and Google Fonts tags, and the `?v=` on the stylesheet.
- Add `css/fonts.css` with Latin-only `@font-face` rules. Avoid Fontsource's CSS entry points, which would inline every language subset into the offline file.
- Wait on `document.fonts.load()` before the city build, because signs are drawn to canvases with Inter during the build and self-hosting changes that timing. `JetBrains Mono` stays as it is (never loaded, falls back to monospace).
- Extend `.gitignore` with `node_modules/`, `dist/`, `.wrangler/` and `recordings/`.
- Rewrite `tests/boot.test.cjs`, which asserts the import map and preloads. It should assert one module entry and no CDN URLs instead.
- Keep build-time values in HTML. `tests/helpers/module.cjs` runs modules in `vm`, where `import.meta.env` is a syntax error.
- Update the README.

**Done when:** `npm run dev` and `npm run build && npm run preview` boot with no console errors, the game makes no third-party requests, and `npm test` passes.

## Phase 2: Cloudflare, version and loader links

- Add `wrangler.jsonc`:

  ```jsonc
  {
    "name": "slop-newyork-vite",
    "compatibility_date": "2026-10-30",
    "preview_urls": false,
    "assets": { "directory": "./dist" }
  }
  ```

- Add `public/_headers` giving `/assets/*` a one-year immutable cache.
- In `vite.config.js`, read `git rev-parse HEAD`, keep the first 4 characters, and expose them as `%VITE_APP_VERSION%` for `index.html`. Do not use `--short=4`, which git lengthens when ambiguous. Fall back to `dev` outside a git checkout.
- Add `#app-version` as `v.ab12`, above the loading overlay, and hide it in clean view. A deploy from an uncommitted tree shows the last commit.
- Add "Fork me on GitHub" and "More games on Maize.Live" to `#loading-overlay` as static HTML, so they appear before any JS runs. They open in a new tab, so loading continues.

**Done when:** `wrangler deploy --dry-run` passes, the site runs under `wrangler dev`, the version matches `HEAD`, and the links show during load at phone and desktop sizes.

## Phase 3: Offline single file

- Add a second build with `--mode offline`, using `vite-plugin-singlefile`, a high `assetsInlineLimit` and `emptyOutDir: false`. Its output becomes `dist/slop-newyork.html`, about 3.7 MB.
- That build sets `data-offline` on `<html>`, which hides the download link inside the offline copy.
- Add `<a href="./slop-newyork.html" download="slop-newyork.html">` to the loader, and to the pause screen in Phase 6.
- Cloudflare's local runtime redirects `.html` to the extensionless path with a 307. That should keep the `download` name because it stays same-origin, but confirm it in a browser.
- Phones are not a target for this file, since opening local HTML there is unreliable.

**Done when:** the downloaded file boots from `file://` with the network off, with no failed requests.

## Phase 4: Play scripts and benchmark

This comes early because it is the safety net for Phases 5-8.

- Build `tools/play/` on `playwright-core` with system Chrome, so no browser download is needed. Launch flags: `--enable-unsafe-webgpu --enable-features=Vulkan,WebGPU --use-angle=vulkan --ignore-gpu-blocklist`.
- Run against the production build.
- Input goes only through real keyboard, pointer and touch events, with reaction delays and varied hold times. No teleporting through hooks.
- Add a read-only `window.__slopDebug` that exists only with `?debug=1`, used for assertions.
- Write `recordings/<date>/<scenario>.mp4` and `report.json`. Recordings are gitignored.

| Scenario | What it does |
|---|---|
| First minute | Fresh profile: start, accelerate, steer, stop |
| Drive route | 5th Ave to Times Square by steering toward waypoints |
| Crash recovery | Hit a wall at speed, then drive away |
| Walk, cycle | Sidewalks, crowds, jumping, kerbs |
| Helicopter | Take off, cruise, land on a street and on a roof, switch modes |
| Mode and map hopping | Switch modes while moving, change cameras, search the map, teleport |
| Touch | Portrait and landscape joystick, rotation mid-drive |
| Soak | 10 minutes of random play |

- **Checks that fail the run:** console errors, non-finite positions, falling through the world, stuck over 5 s with input held, memory growth during the soak.
- **Feel metrics in the report:** 0-60 time, braking distance, turn radius, seconds to recover from a crash, share of time blocked by traffic, input-to-motion delay.
- **`npm run bench`:** runs the desktop and phone profiles, reports per-stage timings, download size, FPS and 95th-percentile frame time, and fails above the budget in Phase 8.

**Done when:** `npm run play` produces videos and a report, and exits non-zero on a failed check.

## Phase 5: Responsive layout and touch

- **One resize path:** a `ResizeObserver` on `#canvas-container` plus `visualViewport` updates camera, renderer, map and HUD together. It replaces the `resize` listener in `main.js`.
- **Viewport units:** `100vh` becomes `100dvh` in `css/style.css`.
- **Portrait view:** keep a minimum horizontal FOV of about 45-50° in `cameras.js`, applied on resize and on preset change (`cameras.js:121`).
- **HUD:** fix the toolbar overflow at 390 px. Add a script that checks bounding boxes for off-screen or overlapping panels at 360x640, 390x844, 412x915, 844x390, 768x1024, 1024x768, 1366x768, 1920x1080 and 2560x1080.
- **Zoom prevention:**
  - Add `maximum-scale=1, user-scalable=no` to the viewport meta. iOS ignores it, but Android honours it.
  - Set `touch-action: none` on `html` and `body`, and `pan-y` on scrolling popovers.
  - Call `preventDefault` on iOS `gesturestart`, `gesturechange` and `dblclick`.
  - Set `.fullmap-search` to at least 16px on touch.
- **Full screen:** add a toggle in the toolbar and pause screen, hidden where the API is missing (iPhone Safari). Add a small `manifest.webmanifest` so a home-screen install runs full screen there.

**Done when:** the viewport script passes and rotating mid-drive keeps speed and framing. On a real phone, you confirm pinch, double-tap, map search focus and rotation.

## Phase 6: Pause screen

- **Opening it:** `Esc` when no map or popover is open, `P`, a toolbar button (44 px on touch), gamepad button 8, and automatically when the tab is hidden. Browsers keep `Esc` for leaving full screen, so `P` and the button are the reliable routes.
- **While paused:**
  - Skip simulation and rendering in the frame loop, still updating `lastTime`.
  - Reuse what the map does: `resetInput()`, `touchControls.setEnabled(false)`, `gamepadControls.setEnabled(false)`.
  - Call `audioSystem.suspend()`.
  - Block the shortcuts in `main.js` and the `M` key in `nyc-map.js`.
  - Render one frame after a resize, because a resize clears the canvas.
- **Contents:** Resume, Graphics (Phase 7), Full screen, Fork me on GitHub, More games on Maize.Live, Download offline, version, credit line.
- **Code:** `js/pause-menu.js`, unit tested with `loadModule` like `tests/touch-controls.test.cjs`.

**Done when:** a play scenario shows position and clock frozen for 5 s, keys ignored, audio suspended, and a clean resume, including a rotation while paused.

## Phase 7: Device detection and graphics levels

`js/quality.js` picks a level before the world is built, then corrects it from real frames.

- **First guess:** backend, `adapter.info` and `isFallbackAdapter`, `hardwareConcurrency`, `deviceMemory`, coarse pointer, screen pixels, `saveData`. WebGL2 starts at Low.
- **Correction:** in Auto, watch frame times after the first 5 s and step down, lowering pixel ratio first because it costs no recompile. Remember the result in `localStorage`. A manual choice turns this off.
- **Choice:** Auto, Low, Medium, High in the pause screen, plus `?quality=low` for scripts.

Starting values, to tune with `npm run bench`:

| Setting | Low | Medium | High |
|---|---|---|---|
| Pixel ratio | 0.75 desktop, 1 phone | 1 | device, capped at 1.5 |
| SSR | off | off | on |
| MSAA | off | off | on |
| Bloom | off | on | on |
| Sun shadows | off | 1024 tiles | 3072 tiles |
| Pedestrians / cars | about 120 / 60 | about 220 / 120 | 340 / 200 |
| Prop draw distance | shorter | shorter | today's |

- **Find the frame spikes first.** Check whether they appear in a real window. They may be worth more than any setting above.
- **SSR-off path:** keep `mrt({ output })`. Removing MRT entirely gave 32 WGSL errors (`structures must have at least one member`). A one-target MRT gave none.
- **Applying changes:** pixel ratio and draw distance apply live. SSR, bloom, MSAA, shadows and agent counts reload the page, which is acceptable because player state is already saved, and the menu says so.
- **Agent counts:** `NUM_PEDS`, `NUM_CARS` and `NUM_BUSES` are module constants and become options.
- **Stay above 20 FPS:** below that the game runs in slow motion.

**Done when:** Auto holds at least 30 FPS at 1080p on this Intel UHD with the 95th-percentile frame at or under 50 ms, and main-thread frame cost stays at or under 33 ms in the phone profile. Real-phone checks still follow, since the profile does not slow the GPU.

## Phase 8: Load time

Budget in seconds. Targets are goals, not forecasts. Desktop looks reachable; the phone target needs a 7x cut and is unproven.

| Stage | Desktop now | Desktop target | Phone now | Phone target |
|---|---|---|---|---|
| Download and JS start | 0.7 | 0.5 | 1.7 | 1.0 |
| Renderer, sky, UI | 0.3 | 0.2 | 0.6 | 0.3 |
| World build | 3.9 | 1.0 | 14.9 | 1.5 |
| Shader compile | 1.9 | 0.5 | 7.9 | 0.8 |
| First frame | 1.4 | 0.3 | 3.2 | 0.4 |
| **Total** | **8.1** | **2.5** | **28.3** | **4.0** |

The overlay may only drop once the player can really move and steer, since the Spec defines load as time to interaction.

**Step 1: cheap wins, no restructuring.**

- Speed up `polygonBoxOverlaps`, `pointInPoly` and `nearbyReserves` (about 580 ms self-time together).
- Compile only what the spawn view needs before the overlay drops, and compile the rest afterwards with `compileAsync`.
- Check that lower levels really compile less.

**Step 2: build the spawn area first.**

- Give `buildCityGrid`, `buildBoroughs`, `buildLandmarks`, `buildCityBlocks`, `buildStreetDetails` and `buildRoadPaint` a region filter, starting around the saved position or 5th Ave and 37th St.
- Drop the overlay after that area's first frame, then build the rest nearest-first in time-sliced jobs of about 6 ms per frame.
- Make the one-time passes in `main.js` run per batch: `setupSceneCulling`, the storage-buffer swap for instances, `scene.updateMatrixWorld(true)` and shader compile. Compile a batch before revealing it.
- Colliders must exist before the player can reach a building. Measure whether island-wide colliders are cheap enough to build first. If not, limit how far the first area's edge can be reached before the rest arrives.
- Traffic and crowds may start just after interaction.

**Step 3: only if Step 2 falls short.** Bake derived data such as the road network using the existing `tools/` plus `.bin.gz` pattern, or move pure-data work to a Worker.

**Checkpoints:** report `npm run bench` numbers after Step 1 and after Step 2. If the phone profile is still over 4 s after Step 2, stop and decide with you whether to do Step 3 or accept a different phone target.

**Risks:** this touches the largest files in the repo and can cause pop-in, stalls when new shaders first appear, and changed building appearance if random sequences depend on build order. The play scripts run after each step to catch these.

**Done when:** `npm run bench` is within budget on desktop, the phone result is known, and the play scenarios pass.

## Phase 9: Balance and bug pass

- Run every scenario on the finished build, watch the recordings, and sort findings into bugs and tuning.
- Fix bugs, adding a regression test where the code is unit-testable.
- Tune from the feel metrics, for example crash recovery, traffic blockage and helicopter landing, then re-record to confirm.
- Write `ai/next_0.md` with what shipped, final numbers, what is still unverified, and follow-ups such as optional taxi fares.

**Done when:** the 10-minute soak and all scenarios pass, and you have recordings to judge.
