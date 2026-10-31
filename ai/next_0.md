# Next 0: what shipped from plan 0, and what to do next

Answers `ai/plan_0.md`. All nine phases are implemented. Nothing is committed or deployed.

## Results

Measured on the same machine as the plan: i7-13620H with Intel UHD, Chrome 156, cold profile, local server with brotli. Phone profile is 390x844 touch, 4x CPU slowdown, 50 Mbps. It slows the CPU only.

| Measure | Spec | Before | Now |
|---|---|---|---|
| Time to interaction, desktop | 2-3 s, 4 s max | 8.1 s | **1.61 s** |
| Time to interaction, phone profile | 2-3 s, 4 s max | 28.3 s | **3.55 s** |
| 1080p on Intel UHD, default level | "plays well" | 20 FPS, 95th percentile 117 ms | 30.6 FPS, 95th percentile 46.6 ms |
| Main-thread frame, phone profile | under 33 ms | about 70 ms | about 21 ms |

The rest of the city arrives behind the game: 14.5 s after that on desktop, 37.5 s on the phone profile, at about 30 FPS. The "before" phone frame figure is an estimate from the desktop cost at 4x.

These are from `npm run bench`, which fails above 2.5 s on desktop or 4 s on the phone profile. All 16 play scenarios pass, including a 10-minute soak with memory steady at about 820 MB, and all 9 viewports are clean.

## What shipped

| Phase | Result |
|---|---|
| 1 npm and Vite | `three@0.187.0`, Vite 8, self-hosted fonts, no third-party requests |
| 2 Cloudflare | `wrangler.jsonc` with `preview_urls: false`, immutable asset cache, `v.ab12` version tag, loader links |
| 3 Offline | `dist/slop-newyork.html`, 3.7 MB. Runs from `file://` with the network off |
| 4 Play scripts | `npm run play`, `npm run bench`, `npm run viewports` in `tools/play/` |
| 5 Responsive | One resize path, 48° minimum horizontal FOV, zoom prevention, full screen toggle, home-screen manifest, two-row phone toolbar |
| 6 Pause | `js/pause-menu.js`. Esc, P, toolbar button, gamepad button 8, auto when the tab is hidden |
| 7 Graphics levels | `js/quality.js`. Auto, Low, Medium, High. `?quality=low` for scripts |
| 8 Load time | Starting view first, the rest behind the game. See below |
| 9 Balance and bugs | See below |

## How the load time came down

Plan step 2 is what mattered, with these changes from the plan:

- **Builders are generators, not region filters.** They run to a `Ready` marker for the starting view, then resume in slices (`js/world-jobs.js`). Buildings sort into within 450 m of the player and the rest.
- **Shaders are mostly a side effect of what's in the scene.** "Compile only what's in view" saved 0.3 s, because one street view touches 287 of 627 jobs. Leaving landmarks, roof details, water and the seawall out of the first frame is what cut compile.
- **Each stage joins the scene with its shaders ready**, so it appears at once rather than stalling.
- **Code the first view doesn't need is split out**: boroughs, street details, traffic and road paint load on demand. That also moves about 150 ms of land-use painting out of startup.

Step 3 (baking data, moving work to a Worker) was not needed.

## Worth knowing when working in this code

- **Light identity is in every material's cache key.** Adding a light later recompiles every shader, so pooled lights exist from the first frame (`js/light-pools.js`).
- **`compileAsync()` works across tasks and reads the render target at each step.** The compile target stays set between frames, and `renderFrame()` swaps it out. Clearing it early builds the wrong shader variants silently.
- **Instanced meshes must get storage attributes at creation.** The city draws while culling runs, and a chunk that shares a pipeline has to bind its matrices the same way.
- **The map's footprint cache is keyed on list length.** Handing it a growing list rebuilds it every frame, which cost 3.9 s until it got a snapshot.
- **Frames in flight are capped at 2.** This took the 95th-percentile frame from 83 ms to 46 ms at the same FPS. Capping at 1 halves FPS, because the completion signal arrives late.

## Bugs fixed in the balance pass

- **Helicopter could not land on roofs.** Sinking onto a building read as hitting its side and threw it off the edge. Now it settles on the roof (`roofHeightAt`).
- **`audioSystem.suspend()` woke itself back up**, so pausing needed a real paused state.
- **Auto would have misread the busy build period as slow hardware.** It now waits for the city to finish.

The numbers gave no reason to change any tuning: 0-60 mph in 8.7 s, 60-0 mph in 33-37 m, a 17 m turn radius at city speed, input reaching the car within a frame, and recovery from a 60 mph crash in about 7 s, including driving 45 m back.

## Not verified

- **Real phones and iOS Safari.** None were available. This covers phone GPU speed, WebGPU availability, rotation timing, and pinch, double-tap and map-search zoom. Headless Chrome can't test zoom at all.
- **Whether it's fun.** The scripts measure feel. Whether it's fun comes from watching `recordings/` and playing it.
- **Firefox and Safari opening the offline file.** Only Chrome was tested.
- **Production Cloudflare.** Only `wrangler dev` and `--dry-run` were tested.
- **The RTX 3060 PC from `ai/study_map_size.md`.** Shaders took far longer there than here, so re-run `npm run bench` on it.

## Known limits

- **Memory is unchanged.** The whole city still ends up in memory, about 1.7 GB in the map study. Entry-level phones may not hold it.
- **Stalls remain while the city builds.** The worst is 299 ms on desktop, with 7 over 100 ms, and 1.2 s on the phone profile, with 26 over 100 ms. They stop once it's complete.
- **For the first seconds** there are no lane markings, traffic or street furniture, and buildings beyond 450 m are missing.
- **Teleporting before the city is complete** can land in an unbuilt area.

## What to work on next

1. **Test on a real phone.** This is the biggest unknown, and it decides whether the rest of this list matters.
2. **Load the map in tiles and unload them**, as the map study recommends. It's the only thing that lowers memory, and it's what enlarging the map needs.
3. **Shorten the first seconds:** build lane markings earlier, since their absence is the most visible gap.
4. **Add goals.** The game is still a sandbox with no score. Taxi fares would fit, since you start in a taxi.
