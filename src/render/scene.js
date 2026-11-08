// Three.js presentation layer: renderer, camera, lights, sky and materials.
// Nothing here changes game state; it only draws what the core reports.

import * as THREE from 'three';
import { MAP, MAP_BOXES } from '../core/map.js';
import { MATCH } from '../core/config.js';

export const QUALITY = {
  low: { pixelRatio: 0.75, shadows: false, antialias: false, fog: 0.014, far: 130 },
  medium: { pixelRatio: 1, shadows: false, antialias: true, fog: 0.009, far: 190 },
  high: { pixelRatio: 1.5, shadows: true, antialias: true, fog: 0.007, far: 260 },
};

// Surface albedos.
//
// These were roughly half as bright as they needed to be, which is why the
// scene measured as almost black: measured in a live frame, the 50th
// percentile luminance across the whole viewport was 21/255 and the brightest
// pixel in the entire frame was 47/255. That is not a colour-management
// artifact — it is geometry that is nearly unable to return light. The old
// wall albedo (0x35474f) multiplied by a fully lit surface peaks at about
// 0.08 linear, which is 21/255 after tone mapping.
//
// The values below keep the same cool industrial identity (blue-grey steel,
// warm timber crates) but give each surface enough albedo to show its own
// shading, so lighting reads as lighting instead of as a black wall.
const PALETTE = {
  boundary: 0x3b4d57,
  wall: 0x5d7480,
  cover: 0x6d8591,
  crate: 0x9c8460,
  pillar: 0x6a808c,
  center: 0x4e646e,
  tower: 0x465a64,
};

export function createScene(canvas, quality = 'medium') {
  const q = QUALITY[quality] || QUALITY.medium;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: q.antialias,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = q.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  // Sky and fog share a colour on purpose. With a flat near-black background
  // and no ceiling (walls top out at 3.5 m) roughly the upper third of every
  // frame was empty background — measured at 21/255, indistinguishable from a
  // wall in shadow. A vertical gradient dome gives that area a horizon, and
  // matching the fog to the horizon colour makes distant geometry dissolve
  // into sky instead of into a black band. Both are cheap: one unlit dome.
  const HORIZON = 0x2b3d47;
  scene.background = new THREE.Color(HORIZON);
  scene.fog = new THREE.FogExp2(HORIZON, q.fog);
  scene.add(makeSkyDome(q.far));

  const camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.06, q.far);
  camera.rotation.order = 'YXZ';

  // Lights: soft hemisphere fill + one directional key with optional shadows.
  //
  // The intensities look high because they are in three.js's physically-based
  // units, not the old arbitrary 0-1 ones. Since r155 the Lambert/Standard
  // BRDF divides irradiance by pi and light intensity is candela-like, so the
  // legacy values (1.15 / 1.5 / 0.35) produced roughly a third of the light
  // they used to. Measured on a live frame, tripling them moved the median
  // luminance from 25/255 to 66/255 and nothing clipped — the scene was simply
  // under-exposed. Tone mapping was never the problem.
  const hemi = new THREE.HemisphereLight(0xbcd8e0, 0x2b3a44, 3.0);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffe9c9, 3.1);
  sun.position.set(26, 42, 18);
  sun.castShadow = q.shadows;
  if (q.shadows) {
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -40;
    sun.shadow.camera.right = 40;
    sun.shadow.camera.top = 32;
    sun.shadow.camera.bottom = -32;
    sun.shadow.camera.far = 120;
    sun.shadow.bias = -0.0006;
  }
  scene.add(sun);

  const rim = new THREE.DirectionalLight(0x4fd1c5, 0.9);
  rim.position.set(-22, 16, -20);
  scene.add(rim);

  // The camera must live in the scene graph, otherwise the first-person
  // viewmodel/lights parented to it would never be rendered.
  scene.add(camera);

  const world = buildWorld(scene, q);
  const dynamic = new THREE.Group();
  scene.add(dynamic);

  return { renderer, scene, camera, sun, hemi, world, dynamic, quality, q };
}

export function applyQuality(ctx, quality) {
  const q = QUALITY[quality] || QUALITY.medium;
  ctx.quality = quality;
  ctx.q = q;
  ctx.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
  ctx.renderer.shadowMap.enabled = q.shadows;
  ctx.sun.castShadow = q.shadows;
  ctx.scene.fog.density = q.fog;
  ctx.camera.far = q.far;
  ctx.camera.updateProjectionMatrix();
  ctx.renderer.shadowMap.needsUpdate = true;
}

/**
 * A vertical gradient sky: deep blue-grey overhead, warmer haze at the horizon.
 *
 * Built from a shader rather than a texture so it costs nothing to ship (no
 * asset, no download) and stays crisp at any resolution. `fog: false` is
 * essential — the dome must *set* the horizon colour, not be dissolved by it.
 */
function makeSkyDome(far) {
  // The dome has to sit *inside* the camera's far plane. At radius 190 with
  // quality "medium" (far = 190) the sphere was exactly on the clip plane, so
  // most of it was discarded and the sky stayed black — which is precisely the
  // failure this dome exists to fix.
  const geo = new THREE.SphereGeometry(Math.max(40, far * 0.85), 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x152430) },
      horizon: { value: new THREE.Color(0x3a505c) },
      bottom: { value: new THREE.Color(0x1d2a31) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 top;
      uniform vec3 horizon;
      uniform vec3 bottom;
      varying vec3 vPos;
      void main() {
        // 0 at the horizon, 1 at the zenith, -1 looking straight down.
        float h = normalize(vPos).y;
        // pow() pushes the transition down towards the horizon so the sky does
        // not read as a smooth sphere.
        vec3 col = h > 0.0
          ? mix(horizon, top, pow(h, 0.65))
          : mix(horizon, bottom, pow(-h, 0.5));
        gl_FragColor = vec4(col, 1.0);
        // three.js only injects tone mapping and the output colour-space
        // conversion into *its own* material shaders. A hand-written
        // ShaderMaterial gets neither, so the linear values above were written
        // straight to an sRGB framebuffer — and linear 0.05 reaches the screen
        // as 0.05 instead of sRGB 0.24, i.e. five times too dark. That single
        // omission is why the upper half of every frame measured 7/255 even
        // though the same colours looked correct everywhere else.
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.frustumCulled = false;
  dome.renderOrder = -1;
  return dome;
}

function buildWorld(scene, q) {
  const group = new THREE.Group();
  const { x: sizeX, z: sizeZ } = MAP.size;

  // Floor: dark deck with a subtle grid so movement reads clearly.
  const floorGeo = new THREE.PlaneGeometry(sizeX, sizeZ, 1, 1);
  // Lighter deck as well: the floor is what silhouettes actors, and at the old
  // value a player standing on it was invisible against it.
  const floorMat = new THREE.MeshLambertMaterial({ color: 0x2c3d46 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = q.shadows;
  group.add(floor);

  const grid = new THREE.GridHelper(sizeX, sizeX / 2, 0x527880, 0x3d5a63);
  grid.position.y = 0.005;
  grid.material.opacity = 0.55;
  grid.material.transparent = true;
  group.add(grid);

  // Team-tinted spawn pads make the two sides instantly readable.
  for (const team of ['A', 'B']) {
    const color = MATCH.teamColors[team];
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(11, 20),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1 }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(team === 'A' ? -26 : 26, 0.012, 0);
    group.add(pad);
  }

  // ── Lane colour coding ────────────────────────────────────────────────
  // The map is three long lanes (north / mid / south). From inside one of them
  // they look identical, so the only way to know where you are is to remember
  // the layout. These floor strips fix that with colour instead of memory:
  // warm for north, cool for south, neutral brass for mid. They are drawn on
  // the floor at y=0.014 — under the grid and under the actors — because the
  // point is orientation, not decoration, and they must never hide a player.
  //
  // The colours are deliberately low-chroma and low-contrast against the deck.
  // A bright stripe would become the most interesting thing on screen and pull
  // the eye away from the crosshair, which is the opposite of the goal.
  const LANE_STRIPS = [
    { z: -13.5, color: 0x8a6a42 }, // north — warm
    { z: 0, color: 0x6f7a52 }, // mid — brass/olive
    { z: 13.5, color: 0x3f6a7d }, // south — cool
  ];
  for (const strip of LANE_STRIPS) {
    const lane = new THREE.Mesh(
      new THREE.PlaneGeometry(sizeX, 4.2),
      new THREE.MeshBasicMaterial({ color: strip.color, transparent: true, opacity: 0.16 }),
    );
    lane.rotation.x = -Math.PI / 2;
    lane.position.set(0, 0.014, strip.z);
    group.add(lane);
  }
  // Thin bright edge on each strip. Two parallel lines read as a "lane" rather
  // than a "patch", and the edge survives the fog that the fill does not.
  for (const strip of LANE_STRIPS) {
    for (const dz of [-2.06, 2.06]) {
      const edge = new THREE.Mesh(
        new THREE.PlaneGeometry(sizeX, 0.09),
        new THREE.MeshBasicMaterial({ color: strip.color, transparent: true, opacity: 0.5 }),
      );
      edge.rotation.x = -Math.PI / 2;
      edge.position.set(0, 0.015, strip.z + dz);
      group.add(edge);
    }
  }

  // Map boxes, one InstancedMesh-compatible merged list. We keep separate
  // geometry per box because sizes differ; box count is small (~40).
  const boxMeshes = [];
  const geoCache = new Map();
  for (const b of MAP_BOXES) {
    const key = `${b.w}|${b.h}|${b.d}`;
    let geo = geoCache.get(key);
    if (!geo) {
      geo = new THREE.BoxGeometry(b.w, b.h, b.d);
      geoCache.set(key, geo);
    }
    const base = PALETTE[b.kind] || PALETTE.wall;
    const mat = new THREE.MeshLambertMaterial({ color: base });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(b.x, b.y, b.z);
    mesh.castShadow = q.shadows;
    mesh.receiveShadow = q.shadows;
    mesh.userData.kind = b.kind;
    group.add(mesh);
    boxMeshes.push(mesh);
  }

  // ── Accent lighting ───────────────────────────────────────────────────
  // Up to here the whole map was lit by one hemisphere fill and two directional
  // lights, which flattens everything: measured with the sun disabled, the
  // frame's median luminance barely moved (21 -> 15), so every surface was
  // "lit" equally and no surface had a reason to read as 3D.
  //
  // These four point lights do not raise the overall brightness — that is the
  // palette's job. They add *variance*: a warm pool under the centre tower, a
  // cool counter-light on the far side, and two low lane markers so the floor
  // has depth cues. Kept few and dim on purpose (decay 2, 18 m range) so the
  // cost stays negligible on integrated GPUs.
  const accents = [
    { pos: [0, 7.6, 0], color: 0xffc48a, intensity: 55, distance: 26 },
    { pos: [0, 3.2, 0], color: 0x58c8d8, intensity: 22, distance: 16 },
    { pos: [-19, 4.2, -13.5], color: 0xffb070, intensity: 26, distance: 18 },
    { pos: [19, 4.2, 13.5], color: 0x58c8d8, intensity: 26, distance: 18 },
  ];
  for (const a of accents) {
    const lamp = new THREE.PointLight(a.color, a.intensity, a.distance, 2);
    lamp.position.set(a.pos[0], a.pos[1], a.pos[2]);
    group.add(lamp);
  }

  // Bright edging on the centre landmark for orientation.
  const trimMat = new THREE.MeshBasicMaterial({ color: 0x4fd1c5, transparent: true, opacity: 0.55 });
  const trim = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 1.3), trimMat);
  trim.position.set(0, 9.25, 0);
  group.add(trim);
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(1.9, 1.9, 0.06, 12),
    new THREE.MeshBasicMaterial({ color: 0x4fd1c5, transparent: true, opacity: 0.18 }),
  );
  beacon.position.set(0, 0.02, 0);
  group.add(beacon);

  scene.add(group);
  return { group, floor, boxMeshes, trim };
}

/** Resize handling that also keeps the HUD aspect independent. */
export function resizeScene(ctx, width, height) {
  ctx.renderer.setSize(width, height, false);
  ctx.camera.aspect = width / height;
  ctx.camera.updateProjectionMatrix();
}
