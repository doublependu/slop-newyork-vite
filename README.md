# Slop New York

vite package of slop new york

## Setup and run

```bash
npm install
npm run dev
```

## Initial setup

```bash
npm create vite@latest . -- --template vanilla
claude --dangerously-skip-permissions
```

## Build and preview

```bash
npm run build
npm run preview
```

`npm run build` makes the site in `dist/`, plus `dist/slop-newyork.html`: the whole game as one file to play offline.

## Test

```bash
npm test            # unit tests
npm run bench       # load time and frame rate on desktop and phone profiles, fails over budget
npm run viewports   # checks the HUD for overflow and overlap at phone, tablet and desktop sizes
npm run play        # plays the game like a person and records it in recordings/ (not committed)
```

`npm run bench`, `npm run viewports` and `npm run play` use the build in `dist/` and your installed Chrome.

Play options: `npm run play -- --only=first-minute,touch --no-video --soak=3 --headed`.
Bench options: `npm run bench -- --profile=desktop --runs=3 --query=quality=low --headed`.

## Deploy

```bash
npx wrangler login
npm run deploy
```

Cloudflare Workers serves `dist/` as a static site. Per-version preview URLs are off in `wrangler.jsonc`.

## How it loads

The game must be playable within 4 seconds, so only the starting view is built before the loading screen drops: the road deck, the sidewalks and the buildings around the player. The rest of the city builds a few milliseconds per frame while you play (`buildRestOfWorld` in `js/main.js`, `js/world-jobs.js`), and each part joins the scene once its shaders are compiled.

Graphics levels live in `js/quality.js`. Auto picks one from the device and steps down if frames run slow. Add `?quality=low`, `medium` or `high` to the URL to force one, or choose in the pause menu.

## License and data

The project code is available under the [MIT License](LICENSE).

Geographic data: NYC Open Data (including [building footprints and heights](https://data.cityofnewyork.us/City-Government/BUILDING/5zhs-2jue) and [tree locations](https://data.cityofnewyork.us/Environment/Forestry-Tree-Points/hn5i-inap)), [MTA subway entrances](https://data.ny.gov/Transportation/MTA-Subway-Entrances-and-Exits-2024/i9wp-a4ja), and © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Third-party data and dependencies retain their respective licenses.

A New York City simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. Explore Manhattan on foot, by car, by bicycle, or by helicopter.
[Try it live](https://mrdoob.github.io/slop-newyork/)
Explore other cities and community remixes in [Slop Cities](https://github.com/zz85/slop-cities)

