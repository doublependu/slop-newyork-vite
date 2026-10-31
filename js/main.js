import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, vec3, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { createPostProcessing } from './post-processing.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { avenueX, getLocationLabel, isTypingInField, streetZ, ROADS, NYC_LANDMARKS, TELEPORT_LOCATIONS } from './city-config.js';
import { buildCityGrid } from './city-grid.js';
import { buildLandmarks } from './landmarks.js';
import { buildCityBlocks } from './buildings.js';
import { ThirdPersonControllerManager } from './controllers.js';
import { TouchControls } from './touch-controls.js';
import { GamepadControls } from './gamepad-controls.js';
import { CameraSystem, CAMERA_PRESETS } from './cameras.js';
import { LightingSystem } from './lighting.js';
import { NYCMapSystem } from './nyc-map.js';
import { setDrawDistance, setupSceneCullingSteps, updateSceneCulling } from './scene-culling.js';
import { CityAudioSystem } from './audio-system.js';
import { PauseMenu } from './pause-menu.js';
import { CHOICES, FrameWatcher, detectQuality, saveChoice } from './quality.js';
import { createLightPools } from './light-pools.js';
import { WorldBuilder, runUntilReady } from './world-jobs.js';
import { fullscreenElement, fullscreenSupported, onFullscreenChange, toggleFullscreen } from './fullscreen.js';

// Application setup, background city build and frame loop.

async function initApp() {
  const container = document.getElementById('canvas-container');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingStatus = document.getElementById('loading-status');
  const loadingTrack = loadingOverlay ? loadingOverlay.querySelector('.loader-track') : null;
  const loadingFill = document.getElementById('loading-progress');
  // Only shader compilation has measurable progress; other stages use the sweeping bar.
  const setLoadingProgress = (p) => {
    if (!loadingFill) return;
    if (loadingTrack) loadingTrack.classList.remove('is-indeterminate');
    loadingFill.style.transform = `scaleX(${Math.min(1, Math.max(0, p))})`;
  };

  async function showLoadingStage(message) {
    if (loadingStatus) loadingStatus.textContent = message;
    if (loadingTrack) loadingTrack.classList.add('is-indeterminate');
    if (document.hidden) return;
    // Let the label paint before synchronous work. The timeout also lets hidden tabs keep loading.
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 100);
      requestAnimationFrame(() => {
        clearTimeout(timeout);
        setTimeout(resolve, 0);
      });
    });
  }

  // Signs are drawn to canvases with Inter during the city build. A slow font must not hold the game back, though.
  const fontsReady = Promise.race([
    document.fonts?.load('800 16px Inter').catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1000))
  ]);

  // iOS ignores user-scalable=no in the viewport meta; these are the events it lets a page cancel instead.
  for (const type of ['gesturestart', 'gesturechange', 'dblclick']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }

  await showLoadingStage('Initializing graphics...');

  // 1. Pick the graphics level, then initialize Three.js WebGPURenderer with 32-bit float reversedDepthBuffer
  const quality = await detectQuality();
  const renderer = new THREE.WebGPURenderer({
    antialias: quality.msaa,
    powerPreference: 'high-performance',
    reversedDepthBuffer: true
  });
  renderer.setPixelRatio(quality.pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = quality.shadowTile > 0;
  renderer.lighting = new ClusteredLighting(256, 32, 28, 48);
  container.appendChild(renderer.domElement);

  let interactive = false; // set once the loading screen drops
  let worldBuilder = null;
  let worldCompleteAt = null;
  let interactiveAt = null;

  // Start-up phase timings (logged once as "[init] ...") to keep load-time regressions traceable
  const initTimings = [];
  let initMark = performance.now();
  const markInit = (label) => {
    const now = performance.now();
    initTimings.push([label, Math.round(now - initMark)]);
    initMark = now;
  };

  await renderer.init();
  markInit('renderer');

  // 2. Scene, atmosphere and lighting
  await showLoadingStage('Creating sky and environment lighting...');
  const scene = new THREE.Scene();
  const lightingSystem = new LightingSystem(scene, renderer, { shadowTile: quality.shadowTile || 1024 });
  markInit('lighting');

  // 3. The starting view: water, roads, sidewalks, landmarks and the buildings around the player. Everything else
  //    continues behind the game (buildRestOfWorld below) so the player can move as soon as possible.
  await showLoadingStage('Building streets and sidewalks...');
  await fontsReady;
  const lightPools = createLightPools(scene);
  const gridStage = new THREE.Group();
  const cityGridJob = buildCityGrid(scene, gridStage);
  runUntilReady(cityGridJob);
  markInit('cityGrid');
  const landmarkStage = new THREE.Group();
  const { colliders: landmarkColliders } = buildLandmarks(landmarkStage);
  markInit('landmarks');

  // 4. Initialize Third-Person Controllers (Person, Car, Cyclist, Helicopter) & Multi-Camera System
  await showLoadingStage('Preparing player, vehicles and controls...');
  const controllerManager = new ThirdPersonControllerManager(scene, []);
  controllerManager.addColliders(landmarkColliders);
  // Reuse teleport placement so saved players return at rest, close to their last positions.
  try {
    const saved = JSON.parse(localStorage.getItem('nyc-player-state'));
    if (saved?.version === 1) {
      for (const mode of Object.keys(controllerManager.entities)) {
        const p = saved.entities?.[mode];
        if (!p || ![p.x, p.y, p.z, p.heading].every(Number.isFinite)) continue;
        controllerManager.setMode(mode);
        controllerManager.teleportActiveTo(p.x, p.z, p.heading, p.y);
      }
      controllerManager.setMode(Object.hasOwn(controllerManager.entities, saved.activeMode) ? saved.activeMode : 'car');
    }
  } catch { /* Missing or unavailable storage does not prevent playing. */ }
  markInit('controllers');

  await showLoadingStage('Raising the nearest buildings...');
  const blocksStage = new THREE.Group();
  const cityBlocksJob = buildCityBlocks(scene, blocksStage, landmarkColliders, controllerManager.getActiveEntity().position);
  const cityBlocks = runUntilReady(cityBlocksJob);
  let collidersAdded = cityBlocks.colliders.length;
  controllerManager.addColliders(cityBlocks.colliders);
  markInit('blocks');

  // These arrive with the rest of the city, see buildRestOfWorld()
  let boroughs = null;
  let streetDetails = null;
  let trafficSystem = null;
  let highwayTraffic = null;

  function savePlayerState() {
    try {
      const entities = Object.fromEntries(Object.entries(controllerManager.entities).map(([mode, entity]) => [mode, {
        x: entity.position.x, y: entity.position.y, z: entity.position.z, heading: entity.heading
      }]));
      localStorage.setItem('nyc-player-state', JSON.stringify({ version: 1, activeMode: controllerManager.activeMode, entities }));
    } catch { /* Storage may be disabled or full. */ }
  }

  const cameraSystem = new CameraSystem(renderer.domElement, controllerManager);
  const touchControls = new TouchControls(controllerManager);
  const soundButton = document.getElementById('btn-sound');
  const audioSystem = new CityAudioSystem({ controllerManager }, { onStateChange: updateSoundButton });
  function updateSoundButton() {
    if (!soundButton) return;
    soundButton.disabled = !audioSystem.supported;
    soundButton.setAttribute('aria-pressed', String(audioSystem.enabled));
    soundButton.setAttribute('aria-label', audioSystem.enabled ? 'Mute sound' : 'Enable sound');
    soundButton.title = audioSystem.supported ? `${audioSystem.enabled ? 'Mute' : 'Enable'} sound [N]` : 'Web Audio is unavailable';
    soundButton.querySelector('use').setAttribute('href', audioSystem.enabled ? '#i-sound' : '#i-sound-off');
  }
  soundButton?.addEventListener('click', () => audioSystem.setEnabled(!audioSystem.enabled));
  updateSoundButton();
  // pagehide also covers navigation away on mobile; preserve the context across back-forward cache restores.
  window.addEventListener('pagehide', (event) => {
    savePlayerState();
    if (!event.persisted) audioSystem.dispose();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePlayerState(); });

  // Everything that moves or animates: only these get new world matrices per frame.
  // Crowd, tree and building-detail animation changes instance/pose buffers, not Object3D transforms.
  const dynamicRoots = [
    lightPools.traffic,
    scene.getObjectByName('StoreClusteredLights'),
    lightPools.street,
    ...Object.values(controllerManager.entities).map((entity) => entity.mesh),
    controllerManager.entities.cyclist.helmet
  ];
  scene.updateMatrixWorld(true);
  scene.matrixWorldAutoUpdate = false;

  // On WebGPU, small InstancedMeshes (<= 1000 instances) keep their matrices in uniform buffers that three.js
  // re-uploads on every draw of every pass (~2.5 MB/frame with the shadow cascades, stalling the GPU queue).
  // Storage attributes only upload when needed; WebGL2 needs ordinary instanced attributes for correct transforms.
  function useStorageInstancing(root) {
    if (!renderer.backend.isWebGPUBackend) return;
    root.traverse((object) => {
      if (object.isInstancedMesh && !object.instanceMatrix.isStorageInstancedBufferAttribute) {
        object.instanceMatrix = new THREE.StorageInstancedBufferAttribute(object.instanceMatrix.array, 16);
      }
    });
  }
  useStorageInstancing(scene);

  // 5. TSL RenderPipeline with Half-Res Screen Space Reflections (SSRNode), Bloom & Filmic Toning
  //    Fade out distant and matte surfaces so SSR spends its rays on visible glossy reflections.
  await showLoadingStage('Setting up visual effects, map and interface...');
  const scenePass = pass(scene, cameraSystem.camera);
  // The multisampled colour attachments (output, normal, metalRough) only need resolving, never storing: discarding
  // them spares the GPU writing 3 x 4 samples per pixel to memory every frame (transient, memoryless attachments where
  // the browser supports them). The multisampled depth stays stored: SSR reads it.
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  let sceneMRT;
  let reflections;
  if (quality.ssr) {
    const ssrFade = smoothstep(360.0, 180.0, positionView.z.negate());
    const maxSSRRoughness = 0.75;
    sceneMRT = mrt({
      output: output,
      normal: normalView,
      metalRough: vec2(roughness.lessThan(maxSSRRoughness).select(metalness.mul(ssrFade), 0), roughness)
    });
    sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
    sceneMRT.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
    scenePass.setMRT(sceneMRT);

    const scenePassColor = scenePass.getTextureNode('output');
    const scenePassDepth = scenePass.getTextureNode('depth');
    const scenePassNormal = scenePass.getTextureNode('normal');
    const scenePassMetalRough = scenePass.getTextureNode('metalRough');

    const ssrPass = ssr(scenePassColor, scenePassDepth, scenePassNormal, {
      metalnessNode: scenePassMetalRough.r,
      roughnessNode: scenePassMetalRough.g,
      camera: cameraSystem.camera
    });
    ssrPass.resolutionScale = 0.5;
    ssrPass.blurQuality = 1;
    ssrPass.maxDistance.value = 42;
    ssrPass.thickness.value = 0.85;
    // Fewer coarse steps, then refine detected hits to keep reflection edges precise.
    ssrPass.quality.value = 0.25;
    ssrPass.binaryRefine = true;
    ssrPass.intensity.value = 0.50;
    ssrPass.screenEdgeFadeBlack = true;

    // Roughness mip blur must not spread reflections back onto matte or nonreflective surfaces.
    const reflectionMask = scenePassMetalRough.r.greaterThan(0).select(smoothstep(maxSSRRoughness, 0.55, scenePassMetalRough.g), 0);
    reflections = ssrPass.mul(reflectionMask);
  } else {
    // Stays an MRT with one target: without any, the scene's WGSL gets empty output structures and fails to compile.
    sceneMRT = mrt({ output: output });
    scenePass.setMRT(sceneMRT);
    reflections = vec3(0);
  }
  const colorGrade = createPostProcessing(renderer, scenePass.getTextureNode('output'), reflections, quality);
  const renderPipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);

  // 6. Wire UI Controls (Strictly using safe DOM APIs: textContent, classList, addEventListener)
  const modeButtons = document.querySelectorAll('[data-mode]');
  const cameraButtons = document.querySelectorAll('[data-camera]');
  const timeButtons = document.querySelectorAll('[data-time]');
  const teleportButtons = document.querySelectorAll('[data-teleport]');
  const hudToggleBtn = document.getElementById('btn-toggle-hud');
  const modeSwitch = document.getElementById('mode-switch');
  touchControls.onAvailabilityChange = placeModeIndicator;

  const elFps = document.getElementById('hud-fps');
  const elMode = document.getElementById('hud-active-mode');
  const elCamera = document.getElementById('hud-active-camera');
  const elSpeed = document.getElementById('hud-speed');
  const elSpeedMeter = document.getElementById('hud-speed-meter');
  const elAltitude = document.getElementById('hud-altitude');
  const elLocation = document.getElementById('hud-location');
  const elControlsHint = document.getElementById('hud-controls-hint');
  const gamepadControls = new GamepadControls(controllerManager, cameraSystem, {
    onCycleMode: (step) => {
      const modes = ['person', 'car', 'cyclist', 'helicopter'];
      selectMode(modes[(modes.indexOf(controllerManager.activeMode) + step + modes.length) % modes.length]);
    },
    onCycleCamera: cycleCamera,
    onToggleMap: () => {
      if (!pauseMenu.isOpen) mapSystem.toggleFullMap(!mapSystem.isFullMapOpen);
    },
    onCloseMap: () => mapSystem.toggleFullMap(false),
    onTogglePause: () => pauseMenu.toggle()
  });

  const pauseMenu = new PauseMenu({
    onOpen() {
      closePopovers();
      controllerManager.resetInput();
      touchControls.setEnabled(false);
      gamepadControls.setEnabled(false);
      audioSystem.setPaused(true);
    },
    onClose() {
      touchControls.setEnabled(!mapSystem.isFullMapOpen);
      gamepadControls.setEnabled(!mapSystem.isFullMapOpen);
      audioSystem.setPaused(false);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && interactive) pauseMenu.open();
  });
  document.getElementById('btn-pause')?.addEventListener('click', () => pauseMenu.open());

  // Graphics levels decide what gets built and compiled, so a change reloads. Player state saves on the way out.
  for (const button of document.querySelectorAll('[data-quality]')) {
    const choice = button.getAttribute('data-quality');
    button.setAttribute('aria-pressed', String(choice === quality.choice));
    if (choice === 'auto') button.textContent = `Auto (${quality.level})`;
    button.addEventListener('click', () => {
      if (choice === quality.choice) return;
      saveChoice(CHOICES.includes(choice) ? choice : 'auto');
      location.reload();
    });
  }

  if (fullscreenSupported) {
    const buttons = [document.getElementById('btn-fullscreen'), document.getElementById('pause-fullscreen')].filter(Boolean);
    for (const button of buttons) {
      button.hidden = false;
      button.addEventListener('click', () => toggleFullscreen()?.catch(() => {}));
    }
    onFullscreenChange(() => {
      const active = Boolean(fullscreenElement());
      for (const button of buttons) {
        button.setAttribute('aria-pressed', String(active));
        if (button.id === 'pause-fullscreen') button.textContent = active ? 'Exit full screen' : 'Full screen';
        else button.setAttribute('aria-label', active ? 'Exit full screen' : 'Enter full screen');
      }
    });
  }

  // Keyboard guide for each mode: [keys, action]
  const controlHints = {
    person: [[['W', 'S'], 'Walk / Run'], [['A', 'D'], 'Turn'], [['Space'], 'Jump'], [['Drag'], 'Orbit']],
    car: [[['W', 'S'], 'Drive / Reverse'], [['A', 'D'], 'Steer'], [['B'], 'Horn'], [['Drag'], 'Orbit']],
    cyclist: [[['W', 'S'], 'Pedal / Brake'], [['A', 'D'], 'Lean & Turn'], [['Drag'], 'Orbit']],
    helicopter: [[['W', 'S'], 'Pitch'], [['A', 'D'], 'Yaw'], [['Space', 'E'], 'Ascend'], [['Q', 'C'], 'Descend']]
  };
  // Top speeds in mph (controllers.js caps them at 8.2, 36, 19 & 52 m/s): full scale of the speed meter
  const topSpeedMph = { person: 18, car: 81, cyclist: 43, helicopter: 116 };

  function renderControlHints(mode) {
    if (!elControlsHint) return;
    const items = (controlHints[mode] || []).map(([keys, action]) => {
      const item = document.createElement('span');
      item.className = 'hint';
      for (const key of keys) {
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        item.appendChild(kbd);
      }
      const label = document.createElement('span');
      label.className = 'hint-label';
      label.textContent = action;
      item.appendChild(label);
      return item;
    });
    elControlsHint.replaceChildren(...items);
  }

  // The taxi-yellow pill under the selected mode glides from button to button
  function placeModeIndicator() {
    const active = modeSwitch ? modeSwitch.querySelector('.mode-btn.active') : null;
    if (!active) return;
    modeSwitch.style.setProperty('--ind-x', `${active.offsetLeft}px`);
    modeSwitch.style.setProperty('--ind-w', `${active.offsetWidth}px`);
  }

  function selectMode(mode) {
    controllerManager.setMode(mode);
    touchControls.setMode(controllerManager.activeMode);
    gamepadControls.reset();
    modeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });
    document.body.dataset.mode = mode;
    placeModeIndicator();
    const ent = controllerManager.getActiveEntity();
    if (elMode) elMode.textContent = ent.label;
    renderControlHints(mode);

    // If currently on a static scenic camera, switch to 3rd-Person Chase so user sees their selected character/vehicle
    const currentCam = cameraSystem.getActivePreset();
    if (currentCam.category !== 'follow') {
      selectCamera('chase', false);
    }
  }

  function selectCamera(camId, snap = false) {
    cameraSystem.setCameraPreset(camId, snap);
    cameraButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-camera') === camId);
    });
    const preset = cameraSystem.getActivePreset();
    if (elCamera) elCamera.textContent = preset.name;
  }

  // Steps through CAMERA_PRESETS (V / Shift+V, and the arrows either side of the camera name)
  function cycleCamera(step) {
    const n = CAMERA_PRESETS.length;
    const idx = CAMERA_PRESETS.findIndex((p) => p.id === cameraSystem.activePresetId);
    selectCamera(CAMERA_PRESETS[(idx + step + n) % n].id, true);
  }

  function selectTime(timeId) {
    lightingSystem.applyPreset(timeId);
    colorGrade.applyPreset(lightingSystem.activePresetId);
    timeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-time') === timeId);
    });
  }

  // Popovers (native [popover]: light dismiss & Esc for free) open against the control that toggles them: data-anchor
  // names the element they sit above / below, data-align the one whose right edge they line up with
  const popovers = document.querySelectorAll('.popover[popover]');
  const supportsPopover = typeof HTMLElement.prototype.togglePopover === 'function';
  function closePopovers() {
    if (!supportsPopover) return;
    popovers.forEach((pop) => {
      if (pop.matches(':popover-open')) pop.hidePopover();
    });
  }
  popovers.forEach((pop) => {
    const invoker = document.querySelector(`[popovertarget="${pop.id}"]`);
    pop.addEventListener('beforetoggle', (e) => {
      const open = e.newState === 'open';
      if (invoker) invoker.classList.toggle('is-open', open);
      if (!open) return;
      const anchor = document.getElementById(pop.dataset.anchor) || invoker;
      const align = document.getElementById(pop.dataset.align) || invoker;
      if (!anchor || !align) return;
      const r = anchor.getBoundingClientRect();
      const spaceAbove = Math.max(0, r.top - 20);
      const spaceBelow = Math.max(0, window.innerHeight - r.bottom - 20);
      let above = pop.dataset.side === 'above';
      // The camera control moves to the top on touch screens; open toward the available space.
      if ((above ? spaceAbove : spaceBelow) < 160) above = spaceAbove > spaceBelow;
      pop.style.right = `${Math.max(8, window.innerWidth - align.getBoundingClientRect().right)}px`;
      if (above) {
        pop.style.top = 'auto';
        pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
        pop.style.maxHeight = `${spaceAbove}px`;
      } else {
        pop.style.bottom = 'auto';
        pop.style.top = `${r.bottom + 8}px`;
        pop.style.maxHeight = `${spaceBelow}px`;
      }
    });
  });

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectMode(btn.getAttribute('data-mode'));
    });
  });

  cameraButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectCamera(btn.getAttribute('data-camera'), true);
      closePopovers();
    });
  });

  const camPrevBtn = document.getElementById('cam-prev');
  const camNextBtn = document.getElementById('cam-next');
  if (camPrevBtn) camPrevBtn.addEventListener('click', () => cycleCamera(-1));
  if (camNextBtn) camNextBtn.addEventListener('click', () => cycleCamera(1));

  timeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectTime(btn.getAttribute('data-time'));
    });
  });

  // A mouse click mustn't leave the focus on a HUD button, or Space (jump / ascend) and Enter would press it again
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (btn && e.detail > 0) btn.blur();
  });

  // Where you are: the place's name over its street corner, drawn as a pair of NYC street-name signs
  const roadNames = new Set(ROADS.map((r) => r.name));
  const placeNames = new Set(NYC_LANDMARKS.map((l) => l.name));
  let locationText = '';
  function renderLocation(label) {
    if (!elLocation || label === locationText) return;
    locationText = label;
    let place = '';
    let streets = label;
    const split = label.indexOf(' · ');
    if (split >= 0) {
      place = label.slice(0, split);
      streets = label.slice(split + 3);
    } else if (placeNames.has(label) || (!label.includes(' & ') && !roadNames.has(label))) {
      place = label;
      streets = '';
    }
    const nodes = [];
    if (place) {
      const el = document.createElement('div');
      el.className = 'location-place';
      el.textContent = place;
      nodes.push(el);
    }
    if (streets) {
      const row = document.createElement('div');
      row.className = 'location-signs';
      if (streets.startsWith('near ')) {
        streets = streets.slice(5);
        const near = document.createElement('span');
        near.className = 'location-near';
        near.textContent = 'near';
        row.appendChild(near);
      }
      for (const name of streets.split(' & ')) {
        const sign = document.createElement('span');
        sign.className = 'street-sign';
        sign.textContent = name;
        row.appendChild(sign);
      }
      nodes.push(row);
    }
    elLocation.replaceChildren(...nodes);
  }

  // Registered before the map's own key handler, so the Esc that closes the map doesn't also pause the game.
  // A native popover closes on Esc by itself; the pause dialog does too, through its cancel event.
  window.addEventListener('keydown', (e) => {
    if (!interactive || e.repeat || isTypingInField(e)) return;
    if (e.code === 'KeyP') {
      pauseMenu.toggle();
    } else if (e.code === 'Escape' && !pauseMenu.isOpen && !mapSystem.isFullMapOpen) {
      if (supportsPopover && document.querySelector('.popover:popover-open')) return;
      e.preventDefault(); // the dialog opens during this very key press, which must not count as closing it too
      pauseMenu.open();
    }
  });

  function teleportTo(x, z, heading = Math.PI) {
    const destination = controllerManager.teleportActiveTo(x, z, heading);
    touchControls.reset();
    gamepadControls.reset();
    cameraSystem.resetForTeleport();
    selectCamera('chase', true);
    mapSystem.waypoint = {
      x: destination.x,
      z: destination.z,
      name: getLocationLabel(destination.x, destination.z)
    };
    return destination;
  }

  const mapSystem = new NYCMapSystem({
    controllerManager,
    cameraSystem,
    // A copy, because the map redraws its footprint layers whenever this list grows. It gets the full city in one go.
    allBlocks: cityBlocks.allBlocks.slice(),
    onToggle: (open) => {
      controllerManager.resetInput();
      touchControls.setEnabled(!open);
      gamepadControls.setEnabled(!open);
      const mapHint = document.getElementById('fullmap-hover-info');
      if (open && touchControls.available && mapHint) {
        mapHint.textContent = 'Tap to teleport · Drag to pan · Use + / − to zoom';
      }
    },
    onTeleport: teleportTo,
    isPaused: () => pauseMenu.isOpen
  });

  teleportButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-teleport');
      const loc = TELEPORT_LOCATIONS[key];
      if (loc) {
        teleportTo(loc.x, loc.z, loc.heading);
      }
      closePopovers();
    });
  });

  const openMapBtn = document.getElementById('btn-open-map');
  if (openMapBtn) openMapBtn.addEventListener('click', () => mapSystem.toggleFullMap(true));

  if (hudToggleBtn) {
    hudToggleBtn.addEventListener('click', () => {
      document.body.classList.toggle('hud-minimized');
      const isMin = document.body.classList.contains('hud-minimized');
      hudToggleBtn.setAttribute('aria-pressed', String(isMin));
      hudToggleBtn.setAttribute('aria-label', isMin ? 'Show HUD' : 'Hide HUD');
      hudToggleBtn.title = isMin ? 'Show the HUD [H]' : 'Clean view: hide the HUD [H]';
      if (isMin) closePopovers();
    });
  }

  // Global keyboard shortcuts for modes (1-4), cameras (V / 5-0), and HUD (H)
  window.addEventListener('keydown', (e) => {
    if (isTypingInField(e) || pauseMenu.isOpen) return;
    switch (e.code) {
      case 'Digit1':
        selectMode('person');
        break;
      case 'Digit2':
        selectMode('car');
        break;
      case 'Digit3':
        selectMode('cyclist');
        break;
      case 'Digit4':
        selectMode('helicopter');
        break;
      case 'Digit5':
        selectCamera('chase', true);
        break;
      case 'Digit6':
        selectCamera('action', true);
        break;
      case 'Digit7':
        selectCamera('pov', true);
        break;
      case 'Digit8':
        selectCamera('fifthAve', true);
        break;
      case 'Digit9':
        selectCamera('timesSquare', true);
        break;
      case 'Digit0':
        selectCamera('chryslerGCT', true);
        break;
      case 'KeyV':
        cycleCamera(e.shiftKey ? -1 : 1);
        break;
      case 'KeyH':
        if (hudToggleBtn) hudToggleBtn.click();
        break;
      case 'KeyN':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) audioSystem.setEnabled(!audioSystem.enabled);
        break;
      case 'KeyB':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !mapSystem.isFullMapOpen) audioSystem.honk(controllerManager.getActiveEntity());
        break;
    }
  });

  // Window resizes, rotation and mobile browser bars all land here. The new size is applied at the start of the next
  // frame, so the canvas never gets cleared without a fresh image to replace it.
  const viewport = { width: container.clientWidth, height: container.clientHeight };
  let resizePending = false;
  const onViewportChange = () => {
    resizePending = container.clientWidth !== viewport.width || container.clientHeight !== viewport.height;
  };
  new ResizeObserver(onViewportChange).observe(container);
  window.visualViewport?.addEventListener('resize', onViewportChange);

  function applyViewportSize() {
    resizePending = false;
    viewport.width = container.clientWidth;
    viewport.height = container.clientHeight;
    cameraSystem.onResize(viewport.width, viewport.height);
    renderer.setSize(viewport.width, viewport.height);
    placeModeIndicator();
    if (mapSystem.isFullMapOpen) {
      mapSystem.resizeFullCanvas();
      mapSystem.renderFullMap();
    }
  }

  // Initialize the UI and chase camera around the restored player, or the default taxi on a first visit.
  selectMode(controllerManager.activeMode);
  selectCamera('chase', true);
  selectTime('golden');
  // the web fonts change the buttons' widths once they arrive
  if (document.fonts) document.fonts.ready.then(placeModeIndicator);
  markInit('ui');

  // Compile what the starting view shows behind the loading screen, then the rest a job at a time once the player can
  // move. Overlapping compileAsync() jobs keep compilation moving while individual jobs yield to the browser.
  const COMPILE_POOL = 16;
  const nextTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));
  let laterCompileJobs = [];

  // Plain meshes that share a material share its shader, so one job compiles them in turn (the first build serves the
  // rest); every instanced mesh gets a build of its own unless its chunks share a pipeline
  function collectCompileJobs(root) {
    const camera = cameraSystem.camera;
    camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    );
    // A stage that isn't in the scene yet compiles whole, without working out each object's bounds
    const allInView = root !== scene;
    const pipelines = new Map();
    root.traverseVisible((o) => {
      if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return;
      // Shadow stand-ins only draw in the shadow maps, which compile with the frame that needs them
      if (o.userData.shadowProxy) return;
      const key = o.userData.sharesPipelineWith || o;
      let entry = pipelines.get(key);
      if (!entry) pipelines.set(key, (entry = { object: o, inView: false }));
      if (!entry.inView && (allInView || !o.frustumCulled || frustum.intersectsObject(o))) entry.inView = true;
    });
    const groups = { now: { jobs: [], byMaterial: new Map() }, later: { jobs: [], byMaterial: new Map() } };
    for (const { object, inView } of pipelines.values()) {
      const { jobs, byMaterial } = inView ? groups.now : groups.later;
      if (object.isInstancedMesh || Array.isArray(object.material)) {
        jobs.push([object]);
        continue;
      }
      let job = byMaterial.get(object.material);
      if (!job) {
        job = [];
        byMaterial.set(object.material, job);
        jobs.push(job);
      }
      job.push(object);
    }
    return { now: groups.now.jobs, later: groups.later.jobs };
  }

  // compileAsync() works across many tasks and reads the render target at each step, so its target stays set between
  // frames. Those pipelines must be the very ones the scene pass asks for. renderFrame() steps aside for the frame.
  let compileTargetInUse = false;
  function setCompileTarget(inUse) {
    compileTargetInUse = inUse;
    renderer.setRenderTarget(inUse ? scenePass.renderTarget : null);
    renderer.setMRT(inUse ? sceneMRT : null);
  }

  function renderFrame() {
    if (compileTargetInUse) {
      renderer.setRenderTarget(null);
      renderer.setMRT(null);
    }
    renderPipeline.render();
    if (compileTargetInUse) setCompileTarget(true);
  }

  // compileAsync() culls during its synchronous start, and most of these objects are out of view by design
  function compileObject(object) {
    const { frustumCulled, visible } = object;
    object.frustumCulled = false;
    object.visible = true;
    const compiled = renderer.compileAsync(object, cameraSystem.camera, scene);
    object.frustumCulled = frustumCulled;
    object.visible = visible;
    return compiled.catch((e) => console.warn('[compile]', e)); // the frame that needs it compiles it instead
  }

  async function precompileShaders() {
    await showLoadingStage('Preparing the view...');
    // An empty frame first: it sets up the post-processing chain, which configures the scene pass's render target
    // (MSAA samples, depth format), so the pipelines compiled below are the very ones the scene pass asks for
    scene.visible = false;
    renderPipeline.render();
    scene.visible = true;
    markInit('postFX');

    cameraSystem.update(0, 0);
    const { now, later } = collectCompileJobs(scene);
    laterCompileJobs = later;

    await showLoadingStage(`Compiling scene shaders... 0 / ${now.length} batches`);
    setLoadingProgress(0);
    setCompileTarget(true);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < now.length) {
        const job = now[next++];
        // Each compile starts in a task of its own: compileAsync() keeps one precompilation state on the renderer,
        // which must not be mid-step for two of them in the same microtask checkpoint
        for (const object of job) {
          await nextTask();
          await compileObject(object);
        }
        done++;
        if (loadingStatus) {
          loadingStatus.textContent = `Compiling scene shaders... ${done} / ${now.length} batches (${Math.round((done / now.length) * 100)}%)`;
        }
        setLoadingProgress(done / now.length);
      }
    };
    await Promise.all(Array.from({ length: COMPILE_POOL }, worker));
    setCompileTarget(false);
  }

  await precompileShaders();
  markInit('compile');
  await showLoadingStage('Preparing shadows and the first frame...');

  // Runs between frames once the game is interactive, a few objects per frame, so that a shader nobody has reached yet
  // doesn't stall the moment the player turns towards it.
  async function compileJobs(jobs) {
    setCompileTarget(true);
    let sliceStart = performance.now();
    for (const job of jobs) {
      for (const object of job) {
        await compileObject(object);
        if (performance.now() - sliceStart > 3) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          sliceStart = performance.now();
        }
      }
    }
    setCompileTarget(false);
  }

  // A stage of the city is built off to the side and joins the scene with its shaders ready, so it appears at once
  async function revealStage(stage) {
    stage.updateMatrixWorld(true);
    useStorageInstancing(stage);
    const { now, later } = collectCompileJobs(stage);
    await compileJobs([...now, ...later]);
    scene.add(stage);
  }

  function* buildRestOfWorld() {
    yield compileJobs(laterCompileJobs);
    laterCompileJobs = [];
    yield revealStage(cityBlocks.group);
    yield revealStage(landmarkStage);

    // Code the first view doesn't need stays out of the first download
    let city;
    yield Promise.all([import('./boroughs.js'), import('./street-details.js'), import('./traffic.js'), import('./road-paint.js')])
      .then((modules) => { city = Object.assign({}, ...modules); });
    const { buildBoroughs, buildStreetDetails, createTrafficSystem, createHighwayTraffic, buildRoadPaint } = city;

    const cityGrid = yield* cityGridJob;
    yield revealStage(gridStage);
    controllerManager.addColliders(cityGrid.colliders || []);

    yield* cityBlocksJob;
    controllerManager.addColliders(cityBlocks.colliders.slice(collidersAdded));
    collidersAdded = cityBlocks.colliders.length;
    yield revealStage(blocksStage);
    cityBlocks.update(cameraSystem.currentPos.x, cameraSystem.currentPos.z, true);
    yield* mapSystem.prepareBlocks(cityBlocks.allBlocks);

    const boroughStage = new THREE.Group();
    boroughs = yield* buildBoroughs(boroughStage, { sidewalks: cityGrid.sidewalks });
    controllerManager.addColliders(boroughs.colliders);
    yield revealStage(boroughStage);

    const detailStage = new THREE.Group();
    const allColliders = controllerManager.colliders;
    const details = yield* buildStreetDetails(detailStage, allColliders, lightPools);
    yield revealStage(detailStage);
    streetDetails = details;

    // Buildings turned along non-grid streets have oriented colliders whose world bounds reach past their lots: they
    // stay inside the property line anyway, so the road network (lanes & sidewalks) doesn't need them.
    // Elevated building sections that clear even a bus don't obstruct ground traffic.
    const trafficStage = new THREE.Group();
    const traffic = yield* createTrafficSystem(trafficStage, cityGrid.sidewalks, [
      ...cityGrid.footprints,
      ...streetDetails.footprints,
      ...allColliders.filter((c) => !c.obb && (c.minY ?? 0) < 3.5)
    ], streetDetails.signalIntersections, { numCars: quality.cars, numBuses: quality.buses, numPeds: quality.pedestrians, lightPools });
    yield;
    const highway = createHighwayTraffic(trafficStage, cityGrid.highwayLanes);
    yield;
    buildRoadPaint(trafficStage, traffic.network, cityGrid.roadPaint);
    yield;
    yield* traffic.populate(cameraSystem.currentPos);
    yield revealStage(trafficStage);
    trafficSystem = traffic;
    highwayTraffic = highway;
    mapSystem.trafficSystem = traffic;
    audioSystem.attachCity({ trafficSystem, highwayTraffic, streetDetails });
    dynamicRoots.push(trafficSystem.group, highwayTraffic.group);

    // Island-wide static geometry: chunk & distance-cull the small props, shadow stand-ins for the big casters
    // (scene-culling.js)
    const cullingRoots = ['ManhattanCityGrid', 'ManhattanCityGridDetails', 'ManhattanCityBlocksNear', 'ManhattanCityBlocks', 'ManhattanCityBlocksFar', 'ManhattanStreetDetails', 'ManhattanLandmarks', 'Boroughs', 'RoadMarkings']
      .map((name) => scene.getObjectByName(name))
      .filter(Boolean);
    yield* setupSceneCullingSteps(scene, cullingRoots, lightingSystem.sunLight.shadow, renderer.backend.isWebGPUBackend);
    setDrawDistance(quality.drawDistance);
    worldCompleteAt = performance.now();
    console.log(`[world] complete at ${Math.round(worldCompleteAt)} ms`);
  }

  // 6. Animation Loop
  let lastTime = performance.now();
  let elapsed = 0;
  let frameCount = 0;
  let fpsTimer = 0;
  let nextPlayerSave = 0;
  let firstFrameDone = false;
  const MAX_FRAMES_IN_FLIGHT = 2;
  let framesInFlight = 0;

  if (elFps) elFps.textContent = '60';

  // Read-only view for tools/play, which steers through real input events and only uses this to check the result.
  const debugFrames = new URLSearchParams(location.search).get('debug') === '1'
    ? { simMs: 0, submitMs: 0, count: 0, gaps: [], lastStart: performance.now() }
    : null;
  if (debugFrames) {
    window.__slopDebug = Object.freeze({
      avenueX,
      streetZ,
      places: TELEPORT_LOCATIONS,
      load: () => ({ stages: Object.fromEntries(initTimings), interactiveAt: interactiveAt ?? null }),
      clock: () => elapsed,
      paused: () => pauseMenu.isOpen,
      worldCompleteAt: () => worldCompleteAt,
      quality: () => ({ choice: quality.choice, level: quality.level, pixelRatio: renderer.getPixelRatio() }),
      audioState: () => audioSystem.context?.state ?? 'none',
      input: () => ({ ...controllerManager.keys }),
      player() {
        const entity = controllerManager.getActiveEntity();
        const { x, y, z } = entity.position;
        const mode = controllerManager.activeMode;
        return {
          mode, x, y, z, heading: entity.heading, speed: entity.speed,
          ground: controllerManager.getGroundHeight(x, z, mode),
          roof: controllerManager.roofHeightAt(x, z, y)
        };
      },
      camera: () => ({ aspect: cameraSystem.camera.aspect, fov: cameraSystem.camera.fov }),
      // Averages since the previous read, so a script can measure one stretch of play
      frameCost() {
        const { simMs, submitMs, count, gaps } = debugFrames;
        Object.assign(debugFrames, { simMs: 0, submitMs: 0, count: 0, gaps: [] });
        gaps.sort((a, b) => a - b);
        const at = (q) => Number((gaps[Math.floor(gaps.length * q)] ?? 0).toFixed(1));
        const seconds = gaps.reduce((sum, gap) => sum + gap, 0) / 1000;
        return {
          simMs: simMs / (count || 1), submitMs: submitMs / (count || 1), frames: count,
          fps: Number((count / (seconds || 1)).toFixed(1)), p50: at(0.5), p95: at(0.95), p99: at(0.99)
        };
      },
      renderInfo() {
        const { render } = renderer.info;
        return { backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2', drawCalls: render.drawCalls, triangles: render.triangles };
      }
    });
  }

  const frameWatcher = new FrameWatcher(quality, {
    storage: localStorage,
    onPixelScale: (scale) => renderer.setPixelRatio(quality.pixelRatio / quality.pixelScale * scale)
  });

  renderer.setAnimationLoop((now) => {
    const resized = resizePending;
    if (resized) applyViewportSize();
    if (pauseMenu.isOpen) {
      lastTime = now;
      gamepadControls.update(0); // its pause button has to keep working
      if (resized) renderFrame();
      return;
    }

    // Submitting faster than the GPU finishes fills the queue until the browser stalls the page for several frames at
    // once, a 17, 17, 100 ms rhythm that feels worse than an even pace at the same average. Skip until it has caught up.
    // Two frames stay in flight: the completion signal arrives late, so waiting for every frame halves the frame rate.
    if (framesInFlight >= MAX_FRAMES_IN_FLIGHT) return;

    const frameStart = debugFrames && performance.now();
    const rawDt = (now - lastTime) * 0.001;
    lastTime = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    if (worldCompleteAt !== null) frameWatcher.update(rawDt); // building the city slows frames on purpose
    elapsed += dt;

    // Update 3rd-person controllers, camera, signals, traffic & vehicle collisions, building LODs, and dynamic shadow focus
    gamepadControls.update(dt);
    controllerManager.update(dt, elapsed, cameraSystem.initialized ? cameraSystem.currentPos : null);
    cameraSystem.update(dt, elapsed);
    if (streetDetails) streetDetails.signalClock.value = elapsed;
    trafficSystem?.update(
      dt,
      elapsed,
      cameraSystem.currentPos,
      controllerManager.getActiveEntity(),
      controllerManager.activeMode,
      cameraSystem.camera
    );
    highwayTraffic?.update(dt, cameraSystem.camera, controllerManager.getActiveEntity(), controllerManager.activeMode);
    if (!document.hidden && now >= nextPlayerSave) {
      savePlayerState();
      nextPlayerSave = now + 5000;
    }
    boroughs?.update?.(elapsed); // Roosevelt Island Tramway cabins
    cityBlocks.update(cameraSystem.currentPos.x, cameraSystem.currentPos.z);
    if (cityBlocks.updateLights) cityBlocks.updateLights(cameraSystem.camera);
    streetDetails?.update?.(cameraSystem.camera);
    lightingSystem.update(cameraSystem.currentPos);
    mapSystem.update();
    audioSystem.update(dt, elapsed, cameraSystem.camera, lightingSystem.activePresetId === 'midnight');
    updateSceneCulling(cameraSystem.camera.position);
    // Traffic collisions can move the player after controller updates; finalize moving hierarchies here.
    for (const root of dynamicRoots) root.updateMatrixWorld();

    const simEnd = debugFrames && performance.now();

    // Render frame via TSL RenderPipeline (SSR + Bloom)
    renderFrame();
    if (firstFrameDone && renderer.backend.device) {
      framesInFlight++;
      renderer.backend.device.queue.onSubmittedWorkDone().catch(() => {}).then(() => { framesInFlight--; });
    }
    // The rest of the city gets what this frame left of a 30 FPS budget
    worldBuilder?.step(Math.max(4, Math.min(20, 33 - (performance.now() - frameStart))));
    if (debugFrames) {
      debugFrames.simMs += simEnd - frameStart;
      debugFrames.submitMs += performance.now() - simEnd;
      debugFrames.count++;
      debugFrames.gaps.push(frameStart - debugFrames.lastStart);
      debugFrames.lastStart = frameStart;
    }
    if (!firstFrameDone) {
      firstFrameDone = true;
      markInit('firstFrame');
      // The loading screen stays up until the GPU has got through the first frame, i.e. until the city is on screen
      const device = renderer.backend.device;
      if (loadingStatus) loadingStatus.textContent = 'Waiting for graphics to finish the first frame...';
      Promise.resolve(device && device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => {
        markInit('gpu');
        console.log(`[init] ${initTimings.map(([label, ms]) => `${label} ${ms}ms`).join(', ')}`);
        interactiveAt = performance.now();
        interactive = true;
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
        audioSystem.ready = true;
        setLoadingProgress(1);
        worldBuilder = new WorldBuilder(buildRestOfWorld());
      });
    }

    // Telemetry uses wall time, not the clamped simulation step, so slow frames and high-refresh displays report
    // their actual frame rate (updates DOM every 250ms).
    frameCount++;
    fpsTimer += Math.max(0, rawDt);
    if (fpsTimer >= 0.25) {
      const currentFps = Math.round(frameCount / fpsTimer);
      frameCount = 0;
      fpsTimer = 0;

      const activeEnt = controllerManager.getActiveEntity();
      const mode = controllerManager.activeMode;
      const mph = Math.round(Math.abs(activeEnt.speed) * 2.237);
      const altFt = Math.max(0, Math.round(activeEnt.position.y * 3.281));

      if (elFps) {
        elFps.textContent = String(currentFps);
        elFps.className = currentFps >= 50 ? 'fps-ok' : currentFps >= 30 ? 'fps-warn' : 'fps-bad';
      }
      if (elSpeed) elSpeed.textContent = String(mph);
      if (elSpeedMeter) elSpeedMeter.style.transform = `scaleX(${Math.min(1, mph / (topSpeedMph[mode] || 80))})`;
      if (elAltitude) elAltitude.textContent = altFt.toLocaleString('en-US');
      // The street corner of the player on the follow cameras, of the camera itself on the scenic ones
      const where = cameraSystem.getActivePreset().category === 'follow' ? activeEnt.position : cameraSystem.currentPos;
      renderLocation(getLocationLabel(where.x, where.z));
    }
  });
}

initApp();
