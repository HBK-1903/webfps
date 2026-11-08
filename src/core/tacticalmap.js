// Tactical map and compass data.
//
// The map is 64 x 44 m and three lanes deep. Before this module the only way to
// know where you were was to remember the layout: the three lanes look the same
// from inside any one of them, and the HUD showed nothing but a crosshair. The
// floor strips added in the visual pass gave each lane a colour, but colour
// alone still does not answer "which way is the enemy spawn".
//
// Everything here is a pure function of game state. No canvas, no DOM, no
// THREE — so the interesting parts (what is revealed, and what is deliberately
// not) can be tested headlessly, and the renderer is free to draw it however it
// likes.

import { MAP } from './map.js';

/** Map extents used for normalising world positions to 0..1. */
export const MAP_BOUNDS = { ...MAP.bounds };

/**
 * Normalise a world position to the unit square, with x to the right and z
 * *down* the screen. The map's +z is towards the south end (team B spawn), so
 * drawing +z downwards puts team A at the top and team B at the bottom, which
 * is the orientation the compass text also uses.
 */
export function toUnit(x, z) {
  const { minX, maxX, minZ, maxZ } = MAP_BOUNDS;
  return {
    u: (x - minX) / (maxX - minX),
    v: (z - minZ) / (maxZ - minZ),
  };
}

/**
 * Compass bearing in degrees, 0 = north (up the map), increasing clockwise.
 *
 * NOTE the game's yaw convention: yaw 0 looks down -z, and positive yaw turns
 * right (see `anglesTo`). -z on this map is north, and turning right from north
 * goes to +x, which is east. So the bearing is simply `yaw` in degrees, wrapped
 * to 0..360. This is worth spelling out because the obvious alternative
 * (bearing = 90 - yaw, as if +z were north) would put every cardinal letter 90
 * degrees out, and the map draws +z at the bottom, which makes that mistake
 * look almost plausible.
 */
export function bearing(yaw) {
  const deg = (yaw * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

const CARDINALS = [
  { deg: 0, short: 'K', long: 'KUZEY' },
  { deg: 90, short: 'D', long: 'DOĞU' },
  { deg: 180, short: 'G', long: 'GÜNEY' },
  { deg: 270, short: 'B', long: 'BATI' },
];

/** Nearest cardinal, for the small letter beside the compass strip. */
export function cardinal(yaw) {
  const b = bearing(yaw);
  return CARDINALS[Math.round(b / 90) % 4];
}

/** All four, in order, for building the compass strip. */
export const CARDINAL_POINTS = CARDINALS;

/**
 * Which lane a z coordinate falls in.
 *
 * The lanes are 4.2 m wide floor strips centred on z = -13.5, 0 and 13.5 (see
 * LANE_STRIPS in render/scene.js). Anything outside them is reported as null
 * rather than being rounded to the nearest lane, because claiming the player is
 * "in the north lane" while they are actually in the open between lanes would
 * be worse than saying nothing.
 */
const LANE_CENTRES = [
  { z: -13.5, id: 'north', label: 'KUZEY', color: 0x8a6a42 },
  { z: 0, id: 'mid', label: 'ORTA', color: 0x6f7a52 },
  { z: 13.5, id: 'south', label: 'GÜNEY', color: 0x3f6a7d },
];
const LANE_HALF_WIDTH = 4.0;

export function laneAt(z) {
  for (const lane of LANE_CENTRES) {
    if (Math.abs(z - lane.z) <= LANE_HALF_WIDTH) return lane;
  }
  return null;
}

export const LANES = LANE_CENTRES;

/**
 * How long a contact stays on the map after it was last refreshed, in seconds.
 *
 * This is the single most important number in the module. A contact that never
 * expires turns the minimap into a wallhack: you would see where an enemy is
 * instead of where an enemy *was heard*. Six seconds is long enough that a
 * gunshot still gives useful information, short enough that acting on it
 * requires the enemy not to have moved.
 */
export const CONTACT_TTL = 6;

/**
 * The team a marker belongs to be drawn for.
 *
 * @typedef {{id:string, kind:'mate'|'contact'|'self', x:number, z:number,
 *            age:number, alive?:boolean}} Marker
 */

/**
 * Build the list of markers the player is allowed to see.
 *
 * Deliberately built from three separate streams rather than from a dump of
 * every actor's position:
 *
 *   self      the player, always exact
 *   mate      living teammates, always exact — you can see your own team
 *   contact   enemies that your side has *reported*, with an age in seconds
 *
 * Enemies are never taken from `match.actors` directly. If they were, this
 * function would be a cheat: it would reveal every enemy on the map regardless
 * of whether anyone could see or hear them. The contacts come from the team
 * coordinator, which is the same pool of information the bots are allowed to
 * act on, so the player is not given anything the AI does not have.
 *
 * @returns {Marker[]}
 */
export function buildMarkers({ player, teamMates, contacts, now }) {
  const out = [];
  if (player) {
    out.push({ id: player.id, kind: 'self', x: player.x, z: player.z, age: 0, alive: true });
  }
  for (const mate of teamMates || []) {
    if (mate.isPlayer || !mate.alive) continue;
    out.push({ id: mate.id, kind: 'mate', x: mate.x, z: mate.z, age: 0, alive: true });
  }
  for (const c of contacts || []) {
    const age = now - c.time;
    if (!(age >= 0) || age > CONTACT_TTL) continue;
    out.push({ id: c.id || `${c.x}:${c.z}`, kind: 'contact', x: c.x, z: c.z, age });
  }
  return out;
}

/**
 * Where the player is on the map, for the "you are here" heading text.
 *
 * Returns the lane label when the player is actually in a lane, and a fallback
 * based on which end of the map they are at otherwise. The point is to answer
 * the question without lying about precision.
 */
export function locationLabel(x, z) {
  const lane = laneAt(z);
  const { minX, maxX } = MAP_BOUNDS;
  const side = x < minX + (maxX - minX) * 0.34 ? 'ALFA' : x > minX + (maxX - minX) * 0.66 ? 'BRAVO' : 'MERKEZ';
  if (lane) return `${side} · ${lane.label}`;
  // Between two lanes. Naming the pair is honest and still useful: "between
  // mid and south" tells you which way to turn, whereas the earlier "ŞERİT
  // DIŞI" ("off-lane") was technically true and completely unhelpful — and it
  // was the first thing a player saw, because both spawns sit between lanes.
  const north = LANE_CENTRES[0];
  const mid = LANE_CENTRES[1];
  const south = LANE_CENTRES[2];
  let label;
  if (z < mid.z) label = `${north.label}–${mid.label} ARASI`;
  else label = `${mid.label}–${south.label} ARASI`;
  return `${side} · ${label}`;
}

/**
 * Bearing from one point to another, in degrees clockwise from north.
 * Used for the little arrow that points at a fresh contact.
 */
export function bearingTo(from, to) {
  return bearing(Math.atan2(to.x - from.x, -(to.z - from.z)));
}
