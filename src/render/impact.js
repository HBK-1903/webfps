// Impact geometry: given a point and the box that stopped the round, work out
// which face was hit and how to lay an effect flat on it.
//
// Why this is its own module: the maths is fiddly, it is the part that produces
// the visible artefact (a decal floating in mid-air, or sparks firing into the
// wall they came from), and it is pure — so it can be tested without a GPU,
// a renderer, or a browser. Everything here is arithmetic on numbers.

/**
 * Which face of an axis-aligned box does a point sit on?
 *
 * Returns the axis and sign of the face whose plane the point lies closest to.
 * A point exactly on an edge is ambiguous; picking the dominant axis is fine
 * because the decal is a few centimetres across.
 *
 * @returns {{axis:'x'|'y'|'z', sign:1|-1, normal:[number,number,number]}}
 */
export function faceNormal(box, point) {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const cz = (box.minZ + box.maxZ) / 2;
  // Distance from the centre along each axis, normalised by half-extent, so a
  // long thin box does not always win on its long axis.
  const hx = Math.max(1e-6, (box.maxX - box.minX) / 2);
  const hy = Math.max(1e-6, (box.maxY - box.minY) / 2);
  const hz = Math.max(1e-6, (box.maxZ - box.minZ) / 2);
  const dx = (point.x - cx) / hx;
  const dy = (point.y - cy) / hy;
  const dz = (point.z - cz) / hz;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const az = Math.abs(dz);
  if (ay >= ax && ay >= az) return { axis: 'y', sign: dy >= 0 ? 1 : -1, normal: [0, dy >= 0 ? 1 : -1, 0] };
  if (ax >= az) return { axis: 'x', sign: dx >= 0 ? 1 : -1, normal: [dx >= 0 ? 1 : -1, 0, 0] };
  return { axis: 'z', sign: dz >= 0 ? 1 : -1, normal: [0, 0, dz >= 0 ? 1 : -1] };
}

/**
 * Push a decal a hair off its surface so it does not z-fight with the wall it is
 * painted on. 3 mm is invisible at any distance a player stands from a wall and
 * comfortably larger than depth-buffer noise at 20 m.
 */
export function offsetAlong(point, normal, distance = 0.003) {
  return {
    x: point.x + normal[0] * distance,
    y: point.y + normal[1] * distance,
    z: point.z + normal[2] * distance,
  };
}

/**
 * Scatter velocities for an impact.
 *
 * Direction matters more than realism: the cone must point *away* from the
 * surface, otherwise sparks fire into the wall and are never seen. `rng` is
 * injected so the scatter is reproducible in a test — the first version of this
 * used Math.random inline and could only be tested statistically.
 */
export function sparkBurst(normal, count, rng = Math.random, spread = 0.85, speed = 3.2) {
  const out = [];
  // A floor impact throws debris *up*, not down. The face normal points out of
  // the surface, which on a floor means straight down — so using it literally
  // fires every spark under the map, where nobody sees them, and a bullet
  // hitting the ground reads as having done nothing at all. The round buries
  // itself and the chips come back out the way it went in.
  const [nx, ny, nz] = normal[1] < -0.5 ? [0, 1, 0] : normal;
  // Two vectors perpendicular to the normal, to build a cone.
  let tx = 0;
  let ty = 0;
  const tz = 0;
  if (Math.abs(ny) < 0.9) {
    ty = 1;
  } else {
    tx = 1;
  }
  // t = normal x (up or right), then u = normal x t
  let ux = ny * tz - nz * ty;
  let uy = nz * tx - nx * tz;
  let uz = nx * ty - ny * tx;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;
  for (let i = 0; i < count; i++) {
    const theta = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * spread;
    const sx = Math.cos(theta) * r;
    const sy = Math.sin(theta) * r;
    const sp = speed * (0.45 + rng() * 0.9);
    // Normal component is always positive: sparks go outward, never into the
    // surface they came from.
    out.push({
      vx: (nx + ux * sx + vx * sy) * sp,
      vy: (ny + uy * sx + vy * sy) * sp + 1.2, // a little lift so debris arcs
      vz: (nz + uz * sx + vz * sy) * sp,
      speed: sp,
    });
  }
  return out;
}

/**
 * Advance one spark under gravity and return its new state.
 *
 * Separate from the renderer so the arc can be asserted numerically: a spark
 * that never falls, or falls through the floor, is a visible bug.
 */
export function stepSpark(s, dt, gravity = 9.8) {
  return {
    ...s,
    x: s.x + s.vx * dt,
    y: s.y + s.vy * dt,
    z: s.z + s.vz * dt,
    vy: s.vy - gravity * dt,
    age: s.age + dt,
  };
}

/**
 * Sparks fade over `life`; this is the opacity a spark should be drawn with.
 *
 * `1 - t²` is deliberately slower than linear at the start: a spark stays near
 * full brightness for the first half of its life and then drops off sharply.
 * The previous `(1 - t)²` did the opposite — it dimmed immediately and then
 * trailed off — which at four frames of a fast spark means it was effectively
 * never bright at all.
 */
export function sparkAlpha(s) {
  const t = Math.min(1, Math.max(0, s.age / Math.max(1e-6, s.life)));
  return 1 - t * t;
}
