// Cover points: tactical positions derived from the map geometry, not hand-
// authored coordinates. Everything here is computed once from the same box list
// the player collides with, so a bot can never be told to hide behind something
// that does not exist — and the map stays a single source of truth.

import { MAP_AABBS, MAP } from './map.js';
import { raycastBoxes, circleOverlapsBox } from './collision.js';
import { PLAYER } from './config.js';

/** Minimum box height that actually blocks a standing/crouched shot. */
const MIN_COVER_HEIGHT = 1.0;
/** Farthest an enemy may be for a spot to still count as cover against them. */
const MAX_COVER_RANGE = 45;

/** Height used for "can I be seen while crouched" tests. */
const CROUCH_EYE = PLAYER.crouchEyeHeight;
/** Chest height used as the thing we want hidden. */
const CHEST = 1.15;

/**
 * Candidate cover positions around one box: the four faces, offset by the body
 * radius, plus the four corners. Only positions the player could physically
 * stand on are kept.
 */
function candidateSpots(b) {
  const pad = PLAYER.radius + 0.26;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const hx = (b.maxX - b.minX) / 2;
  const hz = (b.maxZ - b.minZ) / 2;
  const spots = [];
  const push = (x, z, faceX, faceZ) => {
    // `face` is the normal pointing from the cover box towards the spot: an
    // enemy standing along that normal is what this spot hides us from.
    spots.push({ x, z, faceX, faceZ, box: b });
  };
  // Side faces (the useful ones on this map: walls are long on one axis).
  push(b.minX - pad, cz, -1, 0);
  push(b.maxX + pad, cz, 1, 0);
  push(cx, b.minZ - pad, 0, -1);
  push(cx, b.maxZ + pad, 0, 1);
  // Corners, pulled back diagonally — these give partial cover from two angles.
  const dx = hx + pad * 0.75;
  const dz = hz + pad * 0.75;
  push(cx - dx, cz - dz, -1, -1);
  push(cx + dx, cz - dz, 1, -1);
  push(cx - dx, cz + dz, -1, 1);
  push(cx + dx, cz + dz, 1, 1);
  return spots;
}

// Clearance must match the nav grid's radius, otherwise a "cover point" can sit
// in a cell the pathfinder considers blocked and the bot can never reach it.
const NAV_CLEARANCE = 0.45;

function insideAnyBox(x, z) {
  for (const b of MAP_AABBS) {
    if (circleOverlapsBox(x, z, NAV_CLEARANCE, b)) return true;
  }
  return false;
}

/**
 * True when a crouched actor at (x,z) is hidden from an eye at `from`.
 * Two rays are tested (chest and crouched head) so a low crate only counts when
 * it really hides the body, not just the feet.
 */
export function hiddenFrom(x, z, from, boxes = MAP_AABBS) {
  const chest = { x, y: CROUCH_EYE + 0.1, z };
  const head = { x, y: CROUCH_EYE, z };
  return !losFrom(from, chest, boxes) && !losFrom(from, head, boxes);
}

function losFrom(from, to, boxes) {
  const dx = to.x - from.x;
  const dy = (to.y ?? CHEST) - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  const hit = raycastBoxes(from.x, from.y, from.z, dx / len, dy / len, dz / len, boxes, len - 0.05);
  return !hit;
}

/**
 * Cover points around the map. A point is kept when it is standable and it
 * actually hides a crouched body from at least one direction that a threat can
 * approach from. Computed once and shared (`getCoverPoints`), like the nav grid.
 */
export function buildCoverPoints(boxes = MAP_AABBS) {
  const points = [];
  const seen = new Set();
  for (const b of boxes) {
    if (b.kind === 'boundary') continue;
    const height = (b.maxY ?? 3) - (b.minY ?? 0);
    if (height < MIN_COVER_HEIGHT) continue;
    for (const s of candidateSpots(b)) {
      const x = Math.round(s.x * 2) / 2;
      const z = Math.round(s.z * 2) / 2;
      if (seen.has(`${x},${z}`)) continue;
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      if (x < MAP.bounds.minX + 1 || x > MAP.bounds.maxX - 1) continue;
      if (z < MAP.bounds.minZ + 1 || z > MAP.bounds.maxZ - 1) continue;
      if (insideAnyBox(x, z)) continue;
      // Threat probe: stand a few metres off, along the face normal.
      const len = Math.hypot(s.faceX, s.faceZ) || 1;
      const fx = s.faceX / len;
      const fz = s.faceZ / len;
      const probe = { x: x + fx * 5, y: 1.55, z: z + fz * 5 };
      if (!hiddenFrom(x, z, probe, boxes)) continue;
      seen.add(`${x},${z}`);
      points.push({
        x,
        z,
        // Direction the cover is "open" towards (the threat side).
        faceX: fx,
        faceZ: fz,
        kind: b.kind,
        // Prefer chest-high cover: it hides you crouched but lets you peek.
        quality: height >= 1.2 && height <= 2.2 ? 1 : 0.7,
      });
    }
  }
  return points;
}

const cache = new WeakMap();
let rawCache = null;

/**
 * Shared cover point list, made reachable for the A* grid.
 *
 * A point can pass the geometric clearance test and still sit in a cell the
 * pathfinder rejects (cell centres are tested, not the point itself). Snapping to
 * the nearest cell centre breaks the map's 180° mirror symmetry, which silently
 * favours one team, so instead the point slides outwards along its own face
 * normal in small steps — a mirror-symmetric operation.
 */
export function getCoverPoints(grid = null) {
  if (!rawCache) rawCache = buildCoverPoints();
  if (!grid) return rawCache;
  const hit = cache.get(grid);
  if (hit) return hit;

  // Snap one point onto a standable grid cell, or null when there is none.
  const snapOne = (p) => {
    const STEPS = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
    for (const step of STEPS) {
      const cx = p.x + p.faceX * step;
      const cz = p.z + p.faceZ * step;
      const cell = grid.cellOf(cx, cz);
      if (!grid.isWalkable(cell.c, cell.r)) continue;
      const center = grid.cellCenter(cell.c, cell.r);
      if (insideAnyBox(center.x, center.z)) continue;
      // Stepping outwards must not expose us to the threat we hide from.
      if (!hiddenFrom(center.x, center.z, { x: p.x + p.faceX * 5, y: 1.55, z: p.z + p.faceZ * 5 })) continue;
      return { ...p, x: center.x, z: center.z };
    }
    return null;
  };

  // The nav grid has no cell centred on x=0, so snapping a point that sits on the
  // mirror axis has to round one way or the other — which would silently make the
  // cover set asymmetric and favour one team. Every point is therefore paired with
  // its mirrored twin and both are kept, or neither is. Symmetry by construction.
  const out = [];
  const seen = new Set();
  for (const p of rawCache) {
    if (p.x > 0 || (p.x === 0 && p.z < 0)) continue; // visit each pair once
    const twin = rawCache.find((q) => Math.abs(q.x + p.x) < 1e-9 && Math.abs(q.z + p.z) < 1e-9);
    const a = snapOne(p);
    const b = twin ? snapOne(twin) : null;
    if (!a || !b) continue; // one half unreachable -> drop the pair
    // The two snapped positions must still be mirrors of each other, otherwise the
    // pair landed in cells that are not reflections (axis-adjacent rounding).
    if (Math.abs(a.x + b.x) > 1e-9 || Math.abs(a.z + b.z) > 1e-9) continue;
    for (const pt of [a, b]) {
      const key = `${pt.x.toFixed(2)},${pt.z.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(pt);
    }
  }
  cache.set(grid, out);
  return out;
}

/**
 * Best cover spot near (x,z) that hides a crouched bot from `threat` and is
 * within `maxDist` of the search centre. Returns null when nothing qualifies —
 * callers must treat that as "no cover available", never as "stay put".
 */
export function findCoverNear(points, x, z, threat, { maxDist = 12 } = {}) {
  if (!points || !points.length || !threat) return null;
  let best = null;
  let bestScore = Infinity;
  for (const p of points) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d > maxDist) continue;
    const toThreat = Math.hypot(threat.x - p.x, threat.z - p.z);
    if (toThreat > MAX_COVER_RANGE) continue;
    // The spot must sit on the far side of its box from the threat.
    const facing = ((threat.x - p.x) * p.faceX + (threat.z - p.z) * p.faceZ) / (toThreat || 1);
    if (facing < 0.35) continue;
    const score = d + (1 - p.quality) * 6 + Math.abs(toThreat - 14) * 0.12;
    // Mirrored situations produce exactly equal scores, and on this 180°-mirrored
    // map that happens constantly (the two teams are reflections of each other).
    // Breaking those ties by list order silently favours one side, so the tie-break
    // is symmetric: prefer the point on our own half of the map.
    const sameSide = (p.x >= 0) === (x >= 0);
    const tie = sameSide ? 0 : 1e-6;
    if (score + tie < bestScore) {
      bestScore = score + tie;
      best = p;
    }
  }
  return best;
}

/** Cover spot that keeps the bot's current enemy in view but gives protection. */
export function pickCoverFor(bot, points, threat) {
  if (!points || !threat) return null;
  let spot = null;
  // Selection is by score, but the winner is only accepted if it really hides a
  // crouched body from this threat (real raycast). Without this check a bot could
  // be sent to "cover" that its own enemy can see straight through.
  const ranked = [];
  for (const p of points) {
    const d = Math.hypot(p.x - bot.x, p.z - bot.z);
    if (d > 10) continue;
    const toThreat = Math.hypot(threat.x - p.x, threat.z - p.z);
    if (toThreat > MAX_COVER_RANGE) continue;
    const facing = ((threat.x - p.x) * p.faceX + (threat.z - p.z) * p.faceZ) / (toThreat || 1);
    if (facing < 0.35) continue;
    ranked.push({ p, score: d + (1 - p.quality) * 6 + Math.abs(toThreat - 14) * 0.12 });
  }
  ranked.sort((a, b) => a.score - b.score);
  for (const { p } of ranked) {
    if (hiddenFrom(p.x, p.z, { x: threat.x, y: 1.55, z: threat.z })) {
      spot = p;
      break;
    }
  }
  return spot;
}
