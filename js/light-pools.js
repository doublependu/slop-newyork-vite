import * as THREE from 'three/webgpu';
import { createVehicleHeadlight } from './vehicle-lights.js';

// Pooled street and traffic lights exist from the first frame, parked out of sight. Every light's identity is part of
// each material's cache key, so adding one when its stage of the city arrives would recompile every shader in the game.
const STREETLIGHT_SPOT_POOL = 36;
const STREET_POINT_POOL = 48;
const HEADLIGHT_POOL_SIZE = 96;
const POLICE_LIGHT_POOL_SIZE = 6;

function park(light) {
  light.position.set(0, -1000, 0);
  if (light.target) light.target.position.set(0, -1001, 0);
  return light;
}

function createLightPools(scene) {
  const street = new THREE.Group();
  street.name = 'StreetClusteredLights';
  const streetSpots = [];
  for (let i = 0; i < STREETLIGHT_SPOT_POOL; i++) {
    // Cobra-head LED luminaire: wide downward spread (0.96 rad half-angle) illuminating both road and sidewalk
    const spot = park(new THREE.SpotLight(0xffe8c2, 0, 25, 0.96, 0.82, 1.25));
    street.add(spot, spot.target);
    streetSpots.push(spot);
  }
  const streetPoints = [];
  for (let i = 0; i < STREET_POINT_POOL; i++) {
    const point = park(new THREE.PointLight(0xffe4b4, 0, 12, 1.35));
    street.add(point);
    streetPoints.push(point);
  }

  const traffic = new THREE.Group();
  traffic.name = 'TrafficClusteredLights';
  const headlights = [];
  for (let i = 0; i < HEADLIGHT_POOL_SIZE; i++) {
    const spot = park(createVehicleHeadlight());
    traffic.add(spot, spot.target);
    headlights.push(spot);
  }
  const policeLights = [];
  for (let i = 0; i < POLICE_LIGHT_POOL_SIZE; i++) {
    const point = park(new THREE.PointLight(0xff1828, 0, 12.0, 1.25));
    traffic.add(point);
    policeLights.push(point);
  }

  scene.add(street, traffic);
  return { street, traffic, streetSpots, streetPoints, headlights, policeLights };
}

export { createLightPools };
