# Study: how big can the map be?

Date: 2026-10-31. Measured at commit `13445a8`.

## Conclusion

There's no fixed limit on map size, but because the game builds the whole map at startup, today's map has already hit the practical limits. It takes 13.9 s to load against the 4 s maximum in the spec, and uses about 1.7 GB of RAM plus 0.8 GB of video memory.

- **Download is not the limit.** All of NYC would be about 20 MB.
- **RAM is the real limit.** Each 1,000 buildings adds about 11 MB, on top of about 1.3 GB that doesn't change with map size.
- **Load time is already over budget, mostly not because of the map.** 8.2 s of the 13.9 s is shader and GPU work that barely changes with map size.
- **Chrome's JS heap is a hard wall** at about 740,000 buildings, so all of NYC (1.08M) can't load the current way however much RAM the machine has.

Recommendation: don't enlarge the map until shader startup is cut and the map loads in tiles around the player. With both done, all of NYC is realistic.

## Limits at a glance

| Limit | Today | Verdict |
|---|---|---|
| Download | 1.9 MB compressed | Not a problem: all of NYC is about 20 MB, or about 1.5 s at global median speeds |
| Load time | 13.9 s; 41 s with the CPU slowed 4x | Over the 4 s maximum on any map size |
| RAM | 1.7 GB + 0.8 GB video memory | The real limit; integrated GPUs and phones draw video memory from the same RAM |
| Chrome JS heap | 0.57 GB of a 4.4 GB limit | Hard wall at about 740,000 buildings |
| Coordinates | Precise to about 8 mm at 65 km | Fine for NYC; jitter becomes a concern past roughly 250 km |
| Hosting | Cloudflare: 25 MiB per file, 20,000 files on the free plan | Fine, unless one file holds everything |

## How it was measured

- **Machine:** Intel i5-11400F, NVIDIA RTX 3060 (12 GB), 30 GB RAM, Linux.
- **Browser:** Chrome 156, visible window, 1600x900, WebGPU on the real NVIDIA adapter. Headless Chrome returned no hardware adapter, so it wasn't used.
- **Serving:** local static server without compression; three.js from jsDelivr as in `index.html`.
- **Each run:** a fresh browser profile. The load time runs from navigation until the loading overlay hides.
- **Phases:** the `[init]` log printed by `js/main.js`.
- **Memory:** PSS per Chrome process, peak RSS from `/proc`, JS heap after a forced garbage collection, and the change in `nvidia-smi` memory use.
- **Scene totals:** a walk of the scene graph plus `renderer.info`.

The test code patched files only as they were served, so nothing in the repo changed. It lived in a temporary folder and isn't kept in the repo.

**Smaller maps:** to separate fixed cost from cost that grows with the map, the server filtered `GEO.blocks`, `GEO.roads`, `GEO.parks`, `GEO.roadGraph.links`, `REAL_BUILDINGS` and `REAL_TREES` to everything south of a line:

- South of 59th St: `z > -1370`
- South of 14th St: `z > 2219`

Streets, avenues, Central Park, the boroughs, landmarks and piers were left in place.

**CPU slowdown:** `Emulation.setCPUThrottlingRate` at 4x, as a rough stand-in for an entry-level phone. It slows only the main-thread CPU work, not the GPU.

## Results

### Three map sizes

| Measure | Full map | South of 59th | South of 14th |
|---|---|---|---|
| Buildings | 37,353 | 20,901 | 11,263 |
| Trees in source data | 70,680 | 33,567 | 18,627 |
| Load time | 13.87 s | 12.25 s | 10.27 s (see note) |
| City build phases | 4.46 s | 3.29 s | 2.59 s |
| Shader and GPU phases | 8.25 s | 7.79 s | 6.55 s (see note) |
| Total process memory | 1,718 MB | 1,561 MB | 1,411 MB |
| JS heap after GC | 567 MB | 485 MB | 424 MB |
| ArrayBuffers | 312 MB | 240 MB | 204 MB |
| Geometry in the scene | 256 MB | 189 MB | 155 MB |
| Triangles in the scene | 7.3M | 5.0M | 3.8M |

City build phases are `cityGrid`, `boroughs`, `landmarks`, `blocks`, `streetDetails`, `traffic`, `roadPaint` and `culling`. Shader and GPU phases are `compile`, `warmup` and `gpu`.

Note: the south-of-14th run logged a WebGPU validation error ("Binding size for [Buffer] is zero"). It didn't appear in the other runs and is most likely an instance buffer emptied by the cut, though the cause wasn't confirmed. That run's GPU phase, load time and draw counts aren't reliable, so they aren't used in the fits for load time. Its CPU phases and memory are used.

### Where load time goes

| Phase | Normal | CPU slowed 4x |
|---|---|---|
| `renderer` | 80 ms | 100 ms |
| `lighting` | 46 ms | 206 ms |
| `cityGrid` | 722 ms | 2,648 ms |
| `boroughs` | 380 ms | 1,121 ms |
| `landmarks` | 52 ms | 155 ms |
| `blocks` | 1,230 ms | 4,907 ms |
| `streetDetails` | 1,154 ms | 4,596 ms |
| `traffic` | 465 ms | 1,698 ms |
| `roadPaint` | 87 ms | 364 ms |
| `controllers` | 16 ms | 181 ms |
| `culling` | 365 ms | 1,484 ms |
| `ui` | 20 ms | 82 ms |
| `postFX` | 34 ms | 181 ms |
| `compile` | 4,264 ms | 11,373 ms |
| `warmup` | 2,309 ms | 9,122 ms |
| `gpu` | 1,675 ms | 1,105 ms |
| **Total load time** | **13.9 s** | **41.0 s** |

Three things stand out:

- The time was repeatable: two cold runs took 13.81 s and 13.87 s.
- A reload in the same browser took 13.89 s, with `compile` still 4.2 s. Returning players get no speedup.
- Removing all shader and GPU time would still leave 5.6 s, so fixing shaders alone doesn't reach the 4 s maximum. The startup city build has to shrink too.

### Memory and scene, full map

| Item | Amount |
|---|---|
| Game tab process | 995 MB settled, 1,488 MB peak |
| GPU process | 538 MB settled, 778 MB peak |
| All Chrome processes | 1,718 MB settled |
| Video memory increase | 786-809 MiB in the normal runs |
| Tracked by three.js on the GPU | 401 MB, of which 259 MB is textures and render targets |
| Scene | 22,495 objects, 20,874 meshes, 378,534 instances |
| Materials and shader programs | 192 materials, 310 programs |

Render targets depend on screen size, not map size. Geometry reaches the GPU only when first drawn, so video memory is likely to grow as the player explores.

### Rendering

| View | FPS | Draw calls | Triangles |
|---|---|---|---|
| Street level | 76 | 1,076 | 4.7M |
| Helicopter at 150 m | 66 | 1,288 | 4.9M |
| Helicopter at 380 m (its ceiling) | 70 | 1,276 | 4.6M |

Culling holds up, so a bigger map costs load time and memory more than frame rate. These numbers are from the RTX 3060 only. The scene graph still holds about 21,000 meshes that three.js walks every frame, and that per-frame work would grow if the whole map stayed in the scene.

### Download

| Item | Size |
|---|---|
| All 68 files, uncompressed | 7.38 MB |
| All 68 files, gzip | 2.26 MB |
| All 68 files, brotli | 1.90 MB |
| Map data within the brotli total | 0.87 MB |
| `building-geodata.bin.gz` | 441 KB, about 11.8 bytes per building |
| `tree-geodata.bin.gz` | 123 KB, about 1.7 bytes per tree |
| `nyc-geodata.js` | 302 KB brotli |

The compressed totals are calculated from the files and assume the host serves brotli. They weren't measured over a real network.

## Scaling model

Fitted across the three map sizes, using buildings as the measure of map size:

| Measure | Fixed | Per 1,000 buildings | Fit |
|---|---|---|---|
| City build time | 1.8 s | 72 ms | The middle run lands within about 12 ms of a line through the other two |
| Total load time | about 11 s | about 70 ms | Fixed part from the full run's phases |
| Total process memory | 1,296 MB | 11.5 MB | R² 0.98 |
| JS heap | 365 MB | 5.5 MB | R² 0.996 |
| Geometry | 110 MB | 3.9 MB | R² 0.999 |

Memory per 1,000 buildings is 9.5 MB using only the two error-free runs, so 9.5-11.5 MB is the honest range.

The fixed part isn't all engine cost, because the cuts left streets, Central Park and the boroughs in place. Some of that 1.3 GB is map content.

## What larger maps would cost if the whole map still loads at startup

The top row is measured. The rest are projections.

| Map | Buildings | Download | Load on this PC | RAM | JS heap |
|---|---|---|---|---|---|
| Today (to 129th St) | 37k | 1.9 MB | 13.9 s | 1.7 GB | 0.57 GB |
| All Manhattan | 45k | ~2 MB | ~14 s | ~1.8 GB | ~0.6 GB |
| Manhattan + Bronx | 149k | ~4 MB | ~22 s | ~3 GB | ~1.2 GB |
| Manhattan + Brooklyn | 375k | ~7 MB | ~38 s | ~5.6 GB | ~2.4 GB |
| All five boroughs | 1.08M | ~20 MB | ~90 s | Won't load | ~6.3 GB, over the 4.4 GB limit |

The all-NYC download is made up of about 12.8 MB for buildings, 1.6 MB for trees, 4.5 MB for roads and blocks, and 1 MB for code. The roads and blocks figure assumes about 15 times Manhattan's data, which is a guess.

Treat these as rough sizes, not forecasts. Outer-borough buildings are smaller and have fewer street props around them, so the model may run high there.

### Citywide data

| Area | Buildings |
|---|---|
| Manhattan | 45,172 |
| Bronx | 104,268 |
| Brooklyn | 330,113 |
| Queens | 460,950 |
| Staten Island | about 142,461 (total minus the others) |
| **All NYC** | **1,082,964** |

NYC also has 897,619 living trees in the forestry data. The detailed map covers about 43 km² of about 780 km² of NYC land.

### What fits in RAM

The budgets are estimates of what a tab can use, not measurements.

| Device | Budget, including video memory | What fits today |
|---|---|---|
| 16 GB PC with integrated GPU | about 4 GB | About 150k buildings, roughly Manhattan + Bronx |
| 8 GB PC with integrated GPU | about 2.5 GB | About today's map |
| Entry-level phone (3-4 GB) | about 1-1.5 GB | Today's map is probably already too big, though its smaller screen saves some video memory |

## Other limits checked

- **Coordinates:** world positions are 32-bit floats at 1 unit = 1 m. Precision is about 8 mm at 65 km, 3 cm at 260 km and 12 cm at 1,000 km. NYC fits comfortably. A much larger world would need a moving origin.
- **File formats and grid keys:** the varint data formats and spatial cell keys have no limit that matters at city scale.
- **GPU buffers:** this adapter allows 4 GB buffers. Others may allow far less, but the map is already split into chunks.
- **Hosting:** 25 MiB per file and 20,000 files on the free plan is plenty for tiles.

## Recommendations

1. **Cut shader startup first.** It's the largest part of load time on any map size. Options to explore are fewer pipeline variants, compiling less before the first frame, and finishing the rest after the game is interactive.
2. **Load the map in tiles around the player.** Load time and memory then depend on what's nearby, not on the size of the map. Build tiles off the main thread where possible, because the startup build alone takes 18 s with the CPU slowed 4x. Fog already hides much of the distant city, so nearby tiles can be detailed and far ones simple.
3. **Then test on real devices.** The spec's phone and integrated GPU targets are still unproven. The code has no graphics quality tiers yet, which the spec requires.

Tiles complicate the single-HTML offline download in `ai/prompt_0.md`. That file would have to include every tile, about 30 MB for all of NYC, which is over Cloudflare's 25 MiB cap. It would need to cover a smaller area or be hosted elsewhere.

## Not tested

- No real phone or integrated GPU. The 4x slowdown affects only the CPU, and it ran with the RTX 3060.
- No real network: downloads came from a local server, except three.js from the CDN.
- The WebGL2 fallback.
- What fills the JS heap. A heap profile would show how much of the 567 MB can be saved.
- Whether geometry can be freed from JS after upload to the GPU. It could save memory, but it's untested and collisions or culling may still need the data.

## Sources

- [Statista: global median speeds](https://statista.com/statistics/896779/average-mobile-fixed-broadband-download-upload-speeds): May 2026, 125.47 Mbps fixed and 113.16 Mbps mobile, as reported in a search result; not checked against Ookla directly.
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [NYC Open Data: building footprints](https://data.cityofnewyork.us/City-Government/BUILDING/5zhs-2jue)
- [NYC Open Data: forestry tree points](https://data.cityofnewyork.us/Environment/Forestry-Tree-Points/hn5i-inap)
