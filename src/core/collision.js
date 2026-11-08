// Axis-aligned collision + ray intersection helpers. Pure functions over plain
// objects so the exact same code runs for the player, the bots and the bullets,
// and can be unit tested without a renderer.



export function circleOverlapsBox(x, z, radius, b) {
  const cx = Math.min(Math.max(x, b.minX), b.maxX);
  const cz = Math.min(Math.max(z, b.minZ), b.maxZ);
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz < radius * radius;
}

/**
 * Push a circle out of any overlapping axis-aligned boxes.
 * Returns a new position and whether a collision happened. Boxes shorter than
 * the actor's step height are treated as low cover the actor simply walks on
 * top of? No: this game is flat-floor only, every box is a full obstacle.
 */
export function resolveCircle(x, z, radius, boxes, skipBoxes) {
  let px = x;
  let pz = z;
  let hit = false;
  for (let i = 0; i < boxes.length; i++) {
    if (skipBoxes && skipBoxes.has(i)) continue;
    const b = boxes[i];
    if (!circleOverlapsBox(px, pz, radius, b)) continue;
    hit = true;
    const cx = Math.min(Math.max(px, b.minX), b.maxX);
    const cz = Math.min(Math.max(pz, b.minZ), b.maxZ);
    const dx = px - cx;
    const dz = pz - cz;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-6) {
      // Centre is inside the box: push out along the shallowest axis.
      const left = px - b.minX;
      const right = b.maxX - px;
      const back = pz - b.minZ;
      const front = b.maxZ - pz;
      const m = Math.min(left, right, back, front);
      if (m === left) px = b.minX - radius;
      else if (m === right) px = b.maxX + radius;
      else if (m === back) pz = b.minZ - radius;
      else pz = b.maxZ + radius;
      continue;
    }
    const push = radius - dist;
    px += (dx / dist) * push;
    pz += (dz / dist) * push;
  }
  return { x: px, z: pz, hit };
}

/** Move a circle by (dx,dz) with sliding, sub-stepped so fast moves don't tunnel. */
export function moveCircle(x, z, dx, dz, radius, boxes) {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (radius * 0.75)));
  let px = x;
  let pz = z;
  const sx = dx / steps;
  const sz = dz / steps;
  let blocked = false;
  for (let i = 0; i < steps; i++) {
    // Axis-separated moves give natural wall sliding.
    const r1 = resolveCircle(px + sx, pz, radius, boxes);
    px = r1.x;
    pz = r1.z;
    const r2 = resolveCircle(px, pz + sz, radius, boxes);
    px = r2.x;
    pz = r2.z;
    if (r1.hit || r2.hit) blocked = true;
  }
  return { x: px, z: pz, blocked };
}

/**
 * Ray vs axis-aligned box (slab method). Returns entry distance or -1.
 * `dir` must be normalised.
 */
export function rayBox(ox, oy, oz, dx, dy, dz, b, maxDist) {
  let tmin = 0;
  let tmax = maxDist;
  // X
  if (Math.abs(dx) < 1e-8) {
    if (ox < b.minX || ox > b.maxX) return -1;
  } else {
    let t1 = (b.minX - ox) / dx;
    let t2 = (b.maxX - ox) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  // Y
  if (Math.abs(dy) < 1e-8) {
    if (oy < b.minY || oy > b.maxY) return -1;
  } else {
    let t1 = (b.minY - oy) / dy;
    let t2 = (b.maxY - oy) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  // Z
  if (Math.abs(dz) < 1e-8) {
    if (oz < b.minZ || oz > b.maxZ) return -1;
  } else {
    let t1 = (b.minZ - oz) / dz;
    let t2 = (b.maxZ - oz) / dz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/** Nearest box hit along a ray, or null. */
export function raycastBoxes(ox, oy, oz, dx, dy, dz, boxes, maxDist) {
  let best = -1;
  let bestIndex = -1;
  for (let i = 0; i < boxes.length; i++) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, boxes[i], maxDist);
    if (t >= 0 && (best < 0 || t < best)) {
      best = t;
      bestIndex = i;
    }
  }
  if (best < 0) return null;
  return {
    distance: best,
    boxIndex: bestIndex,
    box: boxes[bestIndex],
    point: { x: ox + dx * best, y: oy + dy * best, z: oz + dz * best },
  };
}

/** Line of sight between two eye points. */
export function losClear(from, to, boxes, pad = 0) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  const hit = raycastBoxes(from.x, from.y, from.z, dx / len, dy / len, dz / len, boxes, len - 0.001);
  if (!hit) return true;
  return pad > 0 && hit.distance > pad ? false : false;
}
