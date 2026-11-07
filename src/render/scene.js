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

const PALETTE = {
  boundary: 0x27343b,
  wall: 0x35474f,
  cover: 0x3d5158,
  crate: 0x6b5b40,
  pillar: 0x44575f,
  center: 0x2f4148,
  tower: 0x2a3b42,
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
  scene.background = new THREE.Color(0x0e171c);
  scene.fog = new THREE.FogExp2(0x101b21, q.fog);

  const camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.06, q.far);
  camera.rotation.order = 'YXZ';

  // Lights: soft hemisphere fill + one directional key with optional shadows.
  const hemi = new THREE.HemisphereLight(0xbcd8e0, 0x22303a, 1.15);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffe9c9, 1.5);
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

  const rim = new THREE.DirectionalLight(0x4fd1c5, 0.35);
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

function buildWorld(scene, q) {
  const group = new THREE.Group();
  const { x: sizeX, z: sizeZ } = MAP.size;

  // Floor: dark deck with a subtle grid so movement reads clearly.
  const floorGeo = new THREE.PlaneGeometry(sizeX, sizeZ, 1, 1);
  const floorMat = new THREE.MeshLambertMaterial({ color: 0x1b262c });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = q.shadows;
  group.add(floor);

  const grid = new THREE.GridHelper(sizeX, sizeX / 2, 0x2f4a52, 0x22343a);
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
