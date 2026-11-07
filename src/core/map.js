// Symmetric low-poly training facility layout.
// The map is defined once for the quarter x<=0, z<=0 and mirrored into all
// four quadrants, so both teams get identical cover and identical sightlines.
// All geometry is axis-aligned boxes on a flat floor: this keeps navigation,
// collision and raycasts deterministic and cheap (no mesh physics at all).

export const MAP = {
  name: 'EĞİTİM TESİSİ "SIFIR"',
  // Playable floor
  bounds: { minX: -31, maxX: 31, minZ: -21, maxZ: 21 },
  spawnRoom: { aWallX: -21.5, bWallX: 21.5 },
  // Footprint used for the floor + nav grid
  size: { x: 64, z: 44 },
};

/** @typedef {{x:number,y:number,z:number,w:number,h:number,d:number,kind?:string,color?:number}} Box */

/** Quarter geometry (x <= 0, z <= 0). `y` is the box centre height. */
const QUARTER = [
  // --- spawn room front wall, leaves a centre door and open north/south exits
  { x: -21.5, y: 1.5, z: -8.5, w: 1.0, h: 3.0, d: 9.0, kind: 'wall' },
  // --- spawn room cover
  { x: -25.5, y: 0.6, z: -5.2, w: 2.0, h: 1.2, d: 2.0, kind: 'crate' },
  { x: -29.2, y: 0.55, z: -2.2, w: 1.2, h: 1.1, d: 1.2, kind: 'crate' },
  // --- outer lane wall, shields the spawn approach from the north lane
  { x: -16.0, y: 1.2, z: -13.0, w: 8.0, h: 2.4, d: 1.0, kind: 'wall' },
  // --- north lane cover (long thin block, breaks cross-lane sightlines)
  { x: -12.0, y: 1.0, z: -17.5, w: 1.4, h: 2.0, d: 4.0, kind: 'cover' },
  { x: -20.0, y: 0.7, z: -18.5, w: 3.0, h: 1.4, d: 1.2, kind: 'crate' },
  // --- wall that separates the north lane from mid
  { x: -9.0, y: 1.5, z: -10.6, w: 10.0, h: 3.0, d: 1.0, kind: 'wall' },
  // --- mid approach: waist cover + a pillar to peek around
  { x: -7.0, y: 0.7, z: -3.2, w: 3.4, h: 1.4, d: 1.2, kind: 'cover' },
  { x: -13.0, y: 0.75, z: -5.0, w: 1.6, h: 1.5, d: 1.6, kind: 'cover' },
  { x: -4.6, y: 1.4, z: -6.6, w: 1.8, h: 2.8, d: 1.8, kind: 'pillar' },
  // --- north lane midpoint crate cluster
  { x: -6.0, y: 0.6, z: -16.0, w: 2.2, h: 1.2, d: 2.2, kind: 'crate' },
  // --- small flank cover between lanes
  { x: -17.0, y: 0.8, z: -8.0, w: 1.2, h: 1.6, d: 3.0, kind: 'cover' },
];

function expandQuarter(boxes) {
  const out = [];
  const seen = new Set();
  for (const b of boxes) {
    for (const sx of [1, -1]) {
      for (const sz of [1, -1]) {
        const x = round(b.x * sx);
        const z = round(b.z * sz);
        const key = `${x}|${b.y}|${z}|${b.w}|${b.h}|${b.d}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...b, x, z });
      }
    }
  }
  return out;
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

/** Perimeter walls (single instance each, they are on the symmetry axes). */
const PERIMETER = [
  { x: 0, y: 1.75, z: -21.5, w: 64, h: 3.5, d: 1.0, kind: 'boundary' },
  { x: 0, y: 1.75, z: 21.5, w: 64, h: 3.5, d: 1.0, kind: 'boundary' },
  { x: -31.5, y: 1.75, z: 0, w: 1.0, h: 3.5, d: 44, kind: 'boundary' },
  { x: 31.5, y: 1.75, z: 0, w: 1.0, h: 3.5, d: 44, kind: 'boundary' },
];

/** Landmark geometry on the symmetry axes: central block + beacon tower. */
const LANDMARKS = [
  { x: 0, y: 1.25, z: 0, w: 3.2, h: 2.5, d: 8.0, kind: 'center' },
  { x: 0, y: 4.6, z: 0, w: 1.2, h: 9.2, d: 1.2, kind: 'tower' },
  { x: 0, y: 1.5, z: -8.5, w: 2.2, h: 3.0, d: 2.2, kind: 'pillar' },
  { x: 0, y: 1.5, z: 8.5, w: 2.2, h: 3.0, d: 2.2, kind: 'pillar' },
];

/** All boxes (visual + collision + occlusion share this one list). */
export const MAP_BOXES = [...PERIMETER, ...LANDMARKS, ...expandQuarter(QUARTER)];

export function boxToAABB(b) {
  return {
    minX: b.x - b.w / 2,
    maxX: b.x + b.w / 2,
    minY: b.y - b.h / 2,
    maxY: b.y + b.h / 2,
    minZ: b.z - b.d / 2,
    maxZ: b.z + b.d / 2,
    kind: b.kind,
  };
}

export const MAP_AABBS = MAP_BOXES.map(boxToAABB);

/** Spawn positions are mirrored too, so neither side is favoured. */
export const SPAWNS = {
  A: [
    { x: -27.5, z: -6.0, yaw: 90 },
    { x: -27.5, z: -3.0, yaw: 90 },
    { x: -27.5, z: 0.0, yaw: 90 },
    { x: -27.5, z: 3.0, yaw: 90 },
    { x: -27.5, z: 6.0, yaw: 90 },
  ],
  B: [
    { x: 27.5, z: -6.0, yaw: -90 },
    { x: 27.5, z: -3.0, yaw: -90 },
    { x: 27.5, z: 0.0, yaw: -90 },
    { x: 27.5, z: 3.0, yaw: -90 },
    { x: 27.5, z: 6.0, yaw: -90 },
  ],
};

/** Named patrol/tactical waypoints per lane, mirrored per team. */
export const ROUTES = {
  A: {
    mid: [
      { x: -18, z: 0 },
      { x: -12, z: 0 },
      { x: -5, z: -2 },
      { x: 2, z: 2 },
      { x: 9, z: 0 },
      { x: 15, z: -3 },
    ],
    north: [
      { x: -24, z: -16 },
      { x: -17, z: -16 },
      { x: -8, z: -18 },
      { x: -1, z: -16 },
      { x: 8, z: -17 },
      { x: 15, z: -16 },
    ],
    south: [
      { x: -24, z: 16 },
      { x: -17, z: 16 },
      { x: -8, z: 18 },
      { x: -1, z: 16 },
      { x: 8, z: 17 },
      { x: 15, z: 16 },
    ],
  },
  B: {
    mid: [
      { x: 18, z: 0 },
      { x: 12, z: 0 },
      { x: 5, z: 2 },
      { x: -2, z: -2 },
      { x: -9, z: 0 },
      { x: -15, z: 3 },
    ],
    north: [
      { x: 24, z: -16 },
      { x: 17, z: -16 },
      { x: 8, z: -18 },
      { x: 1, z: -16 },
      { x: -8, z: -17 },
      { x: -15, z: -16 },
    ],
    south: [
      { x: 24, z: 16 },
      { x: 17, z: 16 },
      { x: 8, z: 18 },
      { x: 1, z: 16 },
      { x: -8, z: 17 },
      { x: -15, z: 16 },
    ],
  },
};

/** Where each team's home spawn room is (bots eventually hunt here). */
export const ENEMY_SPAWN_AREA = {
  A: { minX: 20, maxX: 29, minZ: -10, maxZ: 10 },
  B: { minX: -29, maxX: -20, minZ: -10, maxZ: 10 },
};
