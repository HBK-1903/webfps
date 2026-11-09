// Grid navigation + A*. The map is flat and box-based, so a uniform grid with
// A* (8-way, corner-safe) is simpler and more predictable than a navmesh, and
// it can be validated headlessly. Bots path on this grid and slide along walls
// using the same collision code as the player.

import { MAP_AABBS, MAP } from './map.js';
import { circleOverlapsBox } from './collision.js';

export class NavGrid {
  constructor(boxes = MAP_AABBS, { cell = 1, radius = 0.45, bounds = MAP.bounds } = {}) {
    this.cell = cell;
    this.radius = radius;
    this.minX = bounds.minX;
    this.minZ = bounds.minZ;
    this.cols = Math.ceil((bounds.maxX - bounds.minX) / cell);
    this.rows = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
    this.walkable = new Uint8Array(this.cols * this.rows);
    const inflated = radius;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const { x, z } = this.cellCenter(c, r);
        let ok = true;
        for (const b of boxes) {
          if (circleOverlapsBox(x, z, inflated, b)) {
            ok = false;
            break;
          }
        }
        this.walkable[r * this.cols + c] = ok ? 1 : 0;
      }
    }
  }

  index(c, r) {
    return r * this.cols + c;
  }

  cellCenter(c, r) {
    return {
      x: this.minX + (c + 0.5) * this.cell,
      z: this.minZ + (r + 0.5) * this.cell,
    };
  }

  cellOf(x, z) {
    return {
      c: Math.floor((x - this.minX) / this.cell),
      r: Math.floor((z - this.minZ) / this.cell),
    };
  }

  inBounds(c, r) {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows;
  }

  isWalkable(c, r) {
    return this.inBounds(c, r) && this.walkable[r * this.cols + c] === 1;
  }

  isWalkableAt(x, z) {
    const { c, r } = this.cellOf(x, z);
    return this.isWalkable(c, r);
  }

  /** Nearest walkable cell (BFS ring search) for a world point. */
  nearestWalkable(x, z, maxRadius = 8) {
    const { c, r } = this.cellOf(x, z);
    if (this.isWalkable(c, r)) return { c, r };
    for (let radius = 1; radius <= maxRadius; radius++) {
      for (let dc = -radius; dc <= radius; dc++) {
        for (let dr = -radius; dr <= radius; dr++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue;
          if (this.isWalkable(c + dc, r + dr)) return { c: c + dc, r: r + dr };
        }
      }
    }
    return null;
  }

  /** A* over walkable cells. Returns array of {x,z} waypoints (excluding start). */
  findPath(startX, startZ, goalX, goalZ, { maxNodes = 6000 } = {}) {
    const start = this.nearestWalkable(startX, startZ);
    const goal = this.nearestWalkable(goalX, goalZ);
    if (!start || !goal) return [];
    const startIdx = this.index(start.c, start.r);
    const goalIdx = this.index(goal.c, goal.r);
    if (startIdx === goalIdx) return [{ x: goalX, z: goalZ }];

    const total = this.cols * this.rows;
    const gScore = new Float32Array(total).fill(Infinity);
    const fScore = new Float32Array(total).fill(Infinity);
    const cameFrom = new Int32Array(total).fill(-1);
    const closed = new Uint8Array(total);
    const open = new MinHeap();

    const h = (idx) => {
      const c = idx % this.cols;
      const r = (idx - c) / this.cols;
      const dc = Math.abs(c - goal.c);
      const dr = Math.abs(r - goal.r);
      // Octile distance
      return (dc + dr) + (Math.SQRT2 - 2) * Math.min(dc, dr);
    };

    gScore[startIdx] = 0;
    fScore[startIdx] = h(startIdx);
    open.push(startIdx, fScore[startIdx]);

    let expanded = 0;
    while (open.size > 0) {
      const current = open.pop();
      if (current === goalIdx) break;
      if (closed[current]) continue;
      closed[current] = 1;
      if (++expanded > maxNodes) return [];
      const cc = current % this.cols;
      const cr = (current - cc) / this.cols;
      for (let dc = -1; dc <= 1; dc++) {
        for (let dr = -1; dr <= 1; dr++) {
          if (dc === 0 && dr === 0) continue;
          const nc = cc + dc;
          const nr = cr + dr;
          if (!this.isWalkable(nc, nr)) continue;
          // No cutting corners diagonally through walls.
          if (dc !== 0 && dr !== 0 && (!this.isWalkable(cc + dc, cr) || !this.isWalkable(cc, cr + dr))) continue;
          const ni = this.index(nc, nr);
          if (closed[ni]) continue;
          const step = dc !== 0 && dr !== 0 ? Math.SQRT2 : 1;
          const tentative = gScore[current] + step;
          if (tentative < gScore[ni]) {
            cameFrom[ni] = current;
            gScore[ni] = tentative;
            fScore[ni] = tentative + h(ni);
            open.push(ni, fScore[ni]);
          }
        }
      }
    }

    if (cameFrom[goalIdx] === -1 && goalIdx !== startIdx) return [];
    const cells = [];
    let node = goalIdx;
    let guard = 0;
    while (node !== startIdx && node !== -1 && guard++ < total) {
      const c = node % this.cols;
      const r = (node - c) / this.cols;
      cells.push(this.cellCenter(c, r));
      node = cameFrom[node];
    }
    cells.reverse();
    if (cells.length) cells[cells.length - 1] = { x: goalX, z: goalZ };
    return smoothPath(cells, this);
  }

  /** Random walkable point, optionally inside a rectangle. */
  randomWalkable(rand, region) {
    const minX = region ? region.minX : this.minX;
    const maxX = region ? region.maxX : this.minX + this.cols * this.cell;
    const minZ = region ? region.minZ : this.minZ;
    const maxZ = region ? region.maxZ : this.minZ + this.rows * this.cell;
    for (let i = 0; i < 60; i++) {
      const x = minX + rand() * (maxX - minX);
      const z = minZ + rand() * (maxZ - minZ);
      if (this.isWalkableAt(x, z)) return { x, z };
    }
    const cell = this.nearestWalkable((minX + maxX) / 2, (minZ + maxZ) / 2);
    return cell ? this.cellCenter(cell.c, cell.r) : { x: 0, z: 0 };
  }
}

/** Binary min-heap keyed by priority. */
class MinHeap {
  constructor() {
    this.items = [];
    this.prios = [];
  }
  get size() {
    return this.items.length;
  }
  push(item, prio) {
    this.items.push(item);
    this.prios.push(prio);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.prios[p] <= this.prios[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop() {
    const top = this.items[0];
    const lastItem = this.items.pop();
    const lastPrio = this.prios.pop();
    if (this.items.length) {
      this.items[0] = lastItem;
      this.prios[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.prios[l] < this.prios[m]) m = l;
        if (r < this.items.length && this.prios[r] < this.prios[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  swap(a, b) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.prios[a], this.prios[b]] = [this.prios[b], this.prios[a]];
  }
}

/** Drop intermediate waypoints when the straight line is walkable. */
function smoothPath(points, grid) {
  if (points.length < 3) return points;
  const out = [points[0]];
  let i = 0;
  while (i < points.length - 1) {
    let j = points.length - 1;
    for (; j > i + 1; j--) {
      if (grid.lineWalkable(points[i], points[j])) break;
    }
    out.push(points[j]);
    i = j;
  }
  return out;
}

NavGrid.prototype.lineWalkable = function lineWalkable(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(dist / (this.cell * 0.5)));
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    if (!this.isWalkableAt(a.x + dx * t, a.z + dz * t)) return false;
  }
  return true;
};
