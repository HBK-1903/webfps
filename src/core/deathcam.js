// Death, spectating and the killcam.
//
// Before this the player died and nothing happened. `onPlayerDeath` zeroed the
// input and that was it: the camera stayed exactly where it was, frozen, with
// no message, for however long the round had left to run. You could not tell
// who had killed you, from where, or with what. Forty seconds of looking at a
// motionless wall.
//
// Everything here is pure: report generation, candidate selection, and the
// killcam delay buffer. No DOM, no THREE, so all of it is testable — which
// matters, because the interesting bugs are not "does it show a name" but "can
// the player spectate through a wall", "can the camera end up inside geometry",
// and "does the buffer leak".

/** How long the death report is shown before spectating begins. */
export const DEATH_REPORT_SECONDS = 2.6;

/** Killcam length, in seconds of real time before the death. */
export const KILLCAM_SECONDS = 1.8;

/** A camera sample older than this is not worth storing. */
const MAX_SAMPLE_GAP = 0.5;

/**
 * The closing seconds of one actor's life, recorded so they can be replayed
 * from the killer's point of view.
 *
 * Bounded on purpose: this runs every frame for the player, and an unbounded
 * buffer is a memory leak with a friendly name.
 */
export function createKillcam(seconds = KILLCAM_SECONDS) {
  return { seconds, frames: [] };
}

/**
 * Record one frame of camera state.
 *
 * `t` is match time, not wall-clock, so a paused game does not fill the buffer
 * with duplicates of the same instant.
 */
export function recordKillcam(killcam, t, camera, extra = {}) {
  if (!camera) return;
  const last = killcam.frames[killcam.frames.length - 1];
  // Skip duplicate timestamps (a frame that did not advance the clock).
  if (last && Math.abs(last.t - t) < 1e-4) return;
  killcam.frames.push({
    t,
    x: camera.x,
    y: camera.y,
    z: camera.z,
    yaw: camera.yaw,
    pitch: camera.pitch,
    ...extra,
  });
  const cutoff = t - killcam.seconds;
  // Shift rather than filter: this runs every frame, and filter allocates a new
  // array each time.
  let drop = 0;
  while (drop < killcam.frames.length - 1 && killcam.frames[drop].t < cutoff) drop += 1;
  if (drop > 0) killcam.frames.splice(0, drop);
  // Belt and braces: if match time jumped (a long pause), the loop above can
  // still leave a huge tail. Cap the count outright.
  if (killcam.frames.length > 400) killcam.frames.splice(0, killcam.frames.length - 400);
}

/** A candidate killer: the actor, plus what the report needs to say about it. */
export function makeKillerInfo(attacker, victim, { distance = 0, headshot = false, weapon = '' } = {}) {
  return {
    id: attacker ? attacker.id : -1,
    name: attacker ? attacker.name : 'BİLİNMİYOR',
    team: attacker ? attacker.team : null,
    weapon,
    headshot,
    distance,
    // The victim's remaining health when the shot landed is always 0, so what
    // matters is what the killer had left.
    killerHealth: attacker ? Math.round(attacker.health) : 0,
  };
}

/**
 * Build the death report shown the moment the player dies.
 *
 * `attacker` may be null: you can be killed by something that no longer exists
 * (a bot that died the same tick), and the screen must still say something
 * coherent rather than throwing.
 */
export function deathReport({ attacker = null, victim = null, weapon = '', headshot = false, distance = 0, round = 1, remaining = [] } = {}) {
  return {
    killer: makeKillerInfo(attacker, victim, { distance, headshot, weapon }),
    round,
    // How many teammates are still up. This is the number that decides whether
    // the round is already lost, so it belongs on the death screen.
    teammatesAlive: remaining.filter((a) => a && a.alive).length,
    // The names of everyone still standing, in a stable order.
    aliveNames: remaining.filter((a) => a && a.alive).map((a) => a.name),
  };
}

/**
 * Which teammates may be spectated, in a stable order.
 *
 * Dead teammates are excluded: a spectator camera attached to a corpse shows
 * the inside of the floor, which is both useless and nauseating. The player
 * themselves is excluded too — you are dead, that is the whole premise.
 */
export function spectateCandidates({ actors = [], playerId = -1, team = null } = {}) {
  return actors
    .filter((a) => a && a.alive && a.id !== playerId && a.team === team)
    .map((a) => ({ id: a.id, name: a.name }))
    .sort((a, b) => a.id - b.id);
}

/**
 * Step the spectator target.
 *
 * `dir` is +1 for the next teammate and -1 for the previous one. Empty list
 * yields null and the caller keeps its own camera, rather than pointing at
 * whatever happened to be at index 0.
 */
export function cycleSpectate(candidates, currentId, dir) {
  if (!candidates.length) return null;
  const index = candidates.findIndex((c) => c.id === currentId);
  if (index === -1) {
    // Nothing selected yet: enter at the start, or at the end when stepping back.
    return dir >= 0 ? candidates[0] : candidates[candidates.length - 1];
  }
  const next = (index + (dir >= 0 ? 1 : -1) + candidates.length) % candidates.length;
  return candidates[next];
}

/**
 * Clamp a free spectator camera inside the map.
 *
 * The spectate camera can detach from any actor (see `freeCamera`), and an
 * unclamped one flies through the floor and out of the level in about a second
 * of held input.
 */
export function clampCamera(x, y, z, { minX, maxX, minY, maxY, minZ, maxZ, margin = 0.4 }) {
  return {
    x: Math.max(minX + margin, Math.min(maxX - margin, x)),
    y: Math.max(minY + margin, Math.min(maxY - margin, y)),
    z: Math.max(minZ + margin, Math.min(maxZ - margin, z)),
  };
}

/**
 * An eye position for the spectate camera, pulled back slightly behind the
 * followed actor's head.
 *
 * Third person on purpose: the camera has to show the teammate *and* what they
 * are looking at. A first-person spectator view of a bot is a view of a wall
 * half the time, because bots look at corners.
 */
export function spectateEye(actor, { back = 2.6, up = 0.35 } = {}) {
  const yaw = actor.yaw || 0;
  const pitch = actor.pitch || 0;
  // Behind means opposite to the facing direction: facing is (sin, -cos).
  const x = actor.x - Math.sin(yaw) * back;
  const z = actor.z + Math.cos(yaw) * back;
  const eyeHeight = (actor.eyeHeight || 1.6) * (1 - 0.25 * (actor.crouch || 0));
  const y = eyeHeight + up - Math.sin(pitch) * back * 0.35;
  return { x, y, z };
}

/**
 * The death fade: how dark the screen should be, given how long ago the player
 * died. Fades in quickly, holds, then the spectate HUD takes over.
 */
export function deathFade(elapsed, fadeIn = 0.35) {
  if (elapsed <= 0) return 0;
  if (elapsed >= fadeIn) return 1;
  const t = elapsed / fadeIn;
  return t * t * (3 - 2 * t); // smoothstep
}

/** Interpolate the killcam buffer at match time `t`. */
export function sampleKillcam(killcam, t) {
  const frames = killcam.frames;
  if (!frames.length) return null;
  if (t <= frames[0].t) return { ...frames[0] };
  const last = frames[frames.length - 1];
  if (t >= last.t) return { ...last };
  // Linear scan from the end: the requested time is almost always near the end
  // of the buffer, so this is a handful of comparisons in practice.
  for (let i = frames.length - 1; i > 0; i--) {
    const a = frames[i - 1];
    const b = frames[i];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const f = span > 1e-6 ? (t - a.t) / span : 0;
      return {
        t,
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f,
        yaw: lerpAngle(a.yaw, b.yaw, f),
        pitch: a.pitch + (b.pitch - a.pitch) * f,
      };
    }
  }
  return { ...frames[0] };
}

/**
 * Interpolate two angles the short way round.
 *
 * Reused for the spectator camera too: lerping yaw naively makes the view spin
 * the long way whenever the heading crosses the ±π wrap, which happens
 * constantly in a game where people turn around.
 */
export function lerpAngle(a, b, f) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * f;
}

/**
 * Would a shot from `from` to `to` be blocked by the map?
 *
 * Used to keep the spectate camera out of walls: if the camera would be behind
 * solid geometry, it is pulled forward toward the followed actor instead of
 * showing the inside of a box.
 */
export function cameraOccluded(from, to, raycast) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return false;
  const hit = raycast(from.x, from.y, from.z, dx / len, dy / len, dz / len, len - 0.2);
  return Boolean(hit);
}

/**
 * Which way the spectator should move the free camera this frame.
 *
 * Spectating a dead team is not the only case: when the last teammate dies
 * there is nobody to follow, and the camera detaches. It then has to be
 * steerable, or the player is back to staring at a frozen frame with a nicer
 * overlay.
 */
export function freeCameraStep(camera, input, dt, { speed = 6.5 } = {}) {
  const f = input.forward || 0;
  const r = input.right || 0;
  const up = input.up || 0;
  const yaw = camera.yaw || 0;
  const pitch = camera.pitch || 0;
  const len = Math.hypot(f, r) || 1;
  const fwd = f / len;
  const right = r / len;
  // Facing is (sin, -cos) in the XZ plane; up/down follows pitch.
  const cosP = Math.cos(pitch);
  const vx = (Math.sin(yaw) * fwd + Math.cos(yaw) * right) * speed * cosP;
  const vz = (-Math.cos(yaw) * fwd + Math.sin(yaw) * right) * speed * cosP;
  const vy = Math.sin(pitch) * fwd * speed + up * speed;
  return {
    x: camera.x + vx * dt,
    y: camera.y + vy * dt,
    z: camera.z + vz * dt,
    yaw,
    pitch,
  };
}

/** Killcam is only worth showing if it actually captured the moment. */
export function killcamUsable(killcam, deathTime) {
  if (!killcam || !killcam.frames.length) return false;
  const oldest = killcam.frames[0].t;
  // Needs at least half of the requested window, otherwise the replay is a
  // single frame and reads as a bug.
  return deathTime - oldest >= killcam.seconds * 0.5;
}

export { MAX_SAMPLE_GAP };

/**
 * Aim a fixed camera (the killer's eyes) at a moving point.
 *
 * The killcam is shot from where the killer stood. The killer does not move
 * during the replay — only their head turns — because a full reconstruction of
 * the killer's own path is not what was recorded, and inventing it would show
 * a replay that never happened. Locking the position and tracking the victim
 * is honest: it is exactly "what the killer saw".
 */
export function lookAt(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const horizontal = Math.hypot(dx, dz);
  // Yaw convention matches the game: 0 is north (-z), +yaw turns right (east).
  const yaw = Math.atan2(dx, -dz);
  const pitch = Math.atan2(dy, Math.max(1e-6, horizontal));
  return { yaw, pitch };
}

/**
 * One frame of the killcam: the killer's position, aimed at the victim at that
 * instant.
 *
 * `victimSample` comes from the buffer recorded around the player, which stores
 * where the player's eyes were — so the replay tracks the real path the victim
 * took, not a straight line to where they ended up.
 */
export function killcamFrame(killerEye, victimSample, offset = { back: 2.4, up: 0.45 }) {
  if (!killerEye || !victimSample) return null;
  // Step back along the aim direction over the killer's shoulder. The first
  // value tried was 0.9 m, which put the camera inside the killer's helmet:
  // measured on screen, the helmet filled half the frame and hid the person
  // who was actually shot. 2.4 m clears the body entirely while still reading
  // as "from where they stood".
  const aim = lookAt(killerEye, victimSample);
  const x = killerEye.x - Math.sin(aim.yaw) * offset.back;
  const z = killerEye.z + Math.cos(aim.yaw) * offset.back;
  const y = killerEye.y + offset.up;
  return { x, y, z, yaw: aim.yaw, pitch: aim.pitch };
}

/**
 * How much of the killcam has played, 0..1.
 *
 * Kept separate so the HUD and the letterbox can drive off the same number
 * rather than each doing their own arithmetic and drifting apart.
 */
export function killcamProgress(playback) {
  if (!playback) return 0;
  const span = Math.max(1e-6, playback.end - playback.start);
  return Math.max(0, Math.min(1, (playback.t - playback.start) / span));
}
