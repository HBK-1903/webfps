// Headless game orchestration: owns the match, the player controller, the bots
// and all transient feedback (tracers, hitmarkers, sounds). The renderer is a
// pure consumer of this state, which is what makes the whole game testable.

import { PLAYER, MATCH, DIFFICULTY } from './config.js';
import { MAP_AABBS, MAP } from './map.js';
import { NavGrid } from './navgrid.js';
import { raycastBoxes } from './collision.js';
import { createMatch, startMatch, updateMatch, matchSnapshot, drainEvents, aliveCount, playerActor, registerDamage, PHASE } from './match.js';
import { createPlayerController, updatePlayer, playerTryFire, playerReload, playerSwitch, playerReleaseTrigger, addLook, stopPlayerWeapon } from './player.js';
import { createBrain, createCoordinator, assignLanes, updateBot, BOT_STATE, refreshHuntZones } from './bot.js';
import { activeWeapon, ammoInfo, releaseTrigger } from './weapon.js';
import { eyePoint } from './actor.js';
import { notifyHit, hearSound, canSee } from './bot.js';
// Pure geometry, no THREE and no DOM: safe to import from the core layer.
import { faceNormal, sparkBurst, offsetAlong } from '../render/impact.js';
import {
  createKillcam,
  recordKillcam,
  KILLCAM_SECONDS,
  deathReport,
  spectateCandidates,
  cycleSpectate,
  clampCamera,
  spectateEye,
  cameraOccluded,
  freeCameraStep,
  deathFade,
  sampleKillcam,
  killcamFrame,
  killcamProgress,
  killcamUsable,
  lerpAngle,
} from './deathcam.js';

/**
 * Shortest distance from point `p` to the segment a-b, in the xz plane.
 * Used to decide whether an enemy bullet passed close enough to whizz.
 */
function distancePointToSegment(p, a, b) {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.z - a.z);
  let t = ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + abx * t;
  const cz = a.z + abz * t;
  return Math.hypot(p.x - cx, p.z - cz);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The navigation grid is immutable map data (a few ms to build), so every game
// instance shares one — important when a player rematches repeatedly.
let sharedGrid = null;
export function getNavGrid() {
  if (!sharedGrid) sharedGrid = new NavGrid(MAP_AABBS);
  return sharedGrid;
}

export function createGame({ difficulty = 'normal', seed = 12345, grid = null } = {}) {
  const rng = mulberry32(seed);
  const match = createMatch({ difficulty });
  const navGrid = grid || getNavGrid();
  const coordinator = createCoordinator();
  const player = playerActor(match);
  const pc = createPlayerController(player);

  // Attach a brain to every non-player actor. The RNG stream is per-actor so a
  // bot's decisions never depend on how many random draws other bots made.
  for (const a of match.actors) {
    if (a.isPlayer) continue;
    a.brain = createBrain(a, match.profile, { rng: mulberry32(seed + a.id * 7919), lane: 'mid' });
  }

  const game = {
    match,
    grid: navGrid,
    coordinator,
    player,
    pc,
    rng,
    // Remembered so a teammate handed back to a brain gets a deterministic RNG
    // rather than reseeding from Math.random.
    seedForBrains: seed,
    paused: false,
    started: false,
    fx: createFxState(),
    input: { forward: 0, right: 0, sprint: false, crouch: false, fire: false, ads: false },
    adsTarget: 0,
    fov: 78,
    shake: true,
    // Per-round stats: reset at every round start, used by the F3 overlay.
    stats: { shots: 0, hits: 0, headshots: 0, damageDealt: 0 },
    // Match-wide stats: never reset mid-match. The match-end screen used to
    // read `stats` above, which meant the "accuracy" it showed was really the
    // accuracy of the *last round only* — a silent, flattering lie whenever a
    // player had a good final round.
    matchStats: { shots: 0, hits: 0, headshots: 0, damageDealt: 0 },
    onSound: null,
    deathHandled: false,
    // ── death / spectator ──────────────────────────────────────────────────
    // `deathInfo` is filled the frame the player dies and drives the death
    // report. `spectate` holds the follow camera; `killcam` is a rolling
    // buffer of the player's own view, replayed from the killer's side.
    deathInfo: null,
    deathAt: 0,
    spectate: {
      mode: 'none', // 'none' | 'follow' | 'free'
      targetId: null,
      locked: false,
      cam: null,
      yaw: 0,
      pitch: 0,
    },
    killcam: createKillcam(),
    // Playback rate for the killcam. 1 in normal play; the headless visual test
    // lowers it because a 1.8 s replay at ~2 fps is a handful of frames and any
    // observation from outside the page races it.
    killcamSpeed: 1,
    // What the player's side currently knows about enemy positions. Deliberately
    // *not* a mirror of `match.actors`: the minimap reads this, and if it read
    // the actors directly it would reveal every enemy on the map regardless of
    // whether anyone could see or hear them, which is a wallhack.
    contacts: [],
  };

  startMatch(match, { difficulty });
  assignLanes(match, coordinator);
  game.started = true;
  return game;
}

// Caps. Marks are the only FX that accumulate, so they get a hard ceiling:
// 96 quads is invisible in cost and roughly "a firefight's worth of holes" —
// a hundred extra muzzle flashes is not worth a growing draw call.
const MARKS_MAX = 96;
const SPARKS_MAX = 160;

// Where the spectator camera is allowed to go. Derived from the map rather than
// hard-coded, and given headroom above the walls so a free camera can look down
// over the lanes without leaving the level.
const SPECTATE_BOUNDS = {
  minX: MAP.bounds.minX,
  maxX: MAP.bounds.maxX,
  minY: 0.4,
  maxY: 14,
  minZ: MAP.bounds.minZ,
  maxZ: MAP.bounds.maxZ,
  margin: 0.5,
};

function createFxState() {
  return {
    tracers: [],
    // Brief flash at the impact point.
    impacts: [],
    // Persistent bullet marks on surfaces, with the face normal they need in
    // order to lie flat against the thing they were shot into.
    marks: [],
    // Spark debris, simulated here and drawn by render/fx.js.
    sparks: [],
    hitmarker: 0,
    hitmarkerKill: false,
    damageFlash: 0,
    damageDir: 0,
    killfeed: [],
    roundBanner: null,
    sounds: [],
    // Countdown until the "magazine drops" sound fires (see the reload block).
    reloadMagOut: 0,
  };
}

function clearTransientFx(fx) {
  fx.tracers.length = 0;
  fx.impacts.length = 0;
  // Marks are cleared with the rest: they belong to the map, and the map is
  // rebuilt between rounds. A mark left over from a previous round would be
  // floating exactly where a wall used to be.
  fx.marks.length = 0;
  fx.sparks.length = 0;
  fx.hitmarker = 0;
  fx.damageFlash = 0;
  fx.sounds.length = 0;
}

function pushKillfeed(fx, entry) {
  fx.killfeed.unshift(entry);
  if (fx.killfeed.length > 5) fx.killfeed.length = 5;
  entry.age = 0;
}

/**
 * Record that the player's side knows an enemy is at (x, z).
 *
 * Kept as a short rolling list rather than a map keyed by actor id, because the
 * same enemy reported twice within a second should refresh one marker, not
 * produce two. The TTL that decides when a contact stops being drawn lives in
 * tacticalmap.js (CONTACT_TTL) so the policy sits in one place.
 */
function reportContact(game, actor) {
  const list = game.contacts;
  if (!actor.alive) {
    // A dead enemy is not a contact. Clearing the entry the moment they die is
    // what stops a corpse from sitting on the minimap for the rest of the TTL,
    // which would look like a standing target you could shoot.
    const dead = list.findIndex((c) => c.actorId === actor.id);
    if (dead >= 0) list.splice(dead, 1);
    return;
  }
  const existing = list.find((c) => c.actorId === actor.id);
  if (existing) {
    existing.x = actor.x;
    existing.z = actor.z;
    existing.time = game.match.time;
    return;
  }
  list.push({ id: actor.id, actorId: actor.id, x: actor.x, z: actor.z, time: game.match.time });
  if (list.length > 12) list.shift();
}

/**
 * Drop contacts whose actor has died since they were reported.
 *
 * Per-call cleanup inside `reportContact` is not enough: the team-awareness
 * pass can mark an enemy one line before that same enemy is killed later in the
 * same tick, and nothing would ever revisit the entry. The symptom is a corpse
 * sitting on the minimap for six seconds, which reads as a standing target you
 * can shoot. This runs once per tick, after all damage for the tick is in.
 */
function pruneContacts(game) {
  const list = game.contacts;
  for (let i = list.length - 1; i >= 0; i--) {
    const actor = game.match.actors.find((a) => a.id === list[i].actorId);
    if (!actor || !actor.alive) list.splice(i, 1);
  }
}

export function addLookInput(game, dxPixels, dyPixels, sensitivity) {
  if (game.paused) return;
  if (!game.player.alive) return;
  // 0.022 deg per pixel at sensitivity 1 is a comfortable desktop default.
  const scale = 0.022 * sensitivity;
  addLook(game.pc, dxPixels * scale, dyPixels * scale);
}

export function setInput(game, patch) {
  Object.assign(game.input, patch);
  if (patch.fire === false) playerReleaseTrigger(game.pc);
}

export function playerReloadNow(game) {
  if (game.match.phase !== PHASE.LIVE || !game.player.alive) return false;
  return playerReload(game.pc);
}

export function playerSwitchTo(game, slotId) {
  if (game.match.phase !== PHASE.LIVE || !game.player.alive) return false;
  return playerSwitch(game.pc, slotId);
}

export function playerToggleAds(game, on) {
  game.input.ads = on;
  game.pc.ads = on && game.match.phase === PHASE.LIVE && game.player.alive;
}

/** Main tick. `dt` is real seconds; the game freezes itself while paused. */
export function updateGame(game, dtRaw) {
  const dt = Math.min(dtRaw, 0.05); // clamp to keep physics stable on hitches
  const { match, fx } = game;
  if (game.paused) return { phaseChanged: false };
  const dtGame = match.phase === PHASE.MATCH_END ? 0 : dt;
  const phaseBefore = match.phase;

  updateMatch(match, dtGame);
  const phaseChanged = match.phase !== phaseBefore;

  if (match.phase === PHASE.FREEZE) {
    // No movement, no firing before "GO". Look is still allowed.
    game.player.vx = 0;
    game.player.vz = 0;
    // Movement/look inputs are kept but not applied until the round goes live.
    stopPlayerWeapon(game.pc);
    game.pc.ads = false;
    fx.damageFlash = Math.max(0, fx.damageFlash - dt * 2);
    decayFx(fx, dt);
    return { phaseChanged };
  }

  if (match.phase === PHASE.LIVE) {
    // --- player -------------------------------------------------------
    // While dead the controller is not stepped: it would keep applying
    // movement to a corpse. The spectator camera takes over instead, and the
    // renderer reads `spectateCamera()`.
    updatePlayer(game.pc, game.input, { boxes: MAP_AABBS, dt, advanceTime: true });
    game.pc.ads = game.input.ads && game.player.alive;
    if (!game.player.alive) updateSpectate(game, dt);
    // Recoil: transfer weapon recoil into the visual camera kick.
    const w = activeWeapon(game.player.loadout);
    if (w.recoilPitch !== 0) {
      game.pc.kickPitch = Math.min(6, game.pc.kickPitch + w.recoilPitch);
      // tiny yaw kick, scaled by shake setting
      if (game.shake && w.recoilYaw) {
        addLook(game.pc, (game.rng() * 2 - 1) * w.recoilYaw * 0.35, 0);
      }
      w.recoilPitch = 0;
      w.recoilYaw = 0;
    }

    // Feedback for dry-fire and reload completion.
    {
      const w2 = activeWeapon(game.player.loadout);
      if (game.input.fire && game.player.alive && !w2.reloading && !w2.switching && w2.cooldown <= 0 && w2.mag <= 0) {
        if (!game.dryFireLatched) {
          game.dryFireLatched = true;
          pushSound(fx, { type: 'empty' });
          if (w2.reserve > 0) playerReloadNow(game);
        }
      } else {
        game.dryFireLatched = false;
      }
      const wasReloading = game.wasReloading || false;
      const nowReloading = w2.reloading;
      if (!wasReloading && nowReloading) {
        // The magazine drops almost immediately; the new one seats at the end.
        pushSound(fx, { type: 'reload_start' });
        fx.reloadMagOut = 0.28;
      }
      if (fx.reloadMagOut > 0) {
        fx.reloadMagOut -= dt;
        if (fx.reloadMagOut <= 0) pushSound(fx, { type: 'reload_mag_out' });
      }
      if (wasReloading && !nowReloading && w2.mag > 0) {
        pushSound(fx, { type: 'reload_mag_in' });
        pushSound(fx, { type: 'reload_done' });
      }
      game.wasReloading = nowReloading;
    }

    if (game.input.fire && game.player.alive) {
      const shots = playerTryFire(game.pc, { actors: match.actors, boxes: MAP_AABBS, rng: game.rng });
      for (const s of shots) {
        game.stats.shots += 1;
      game.matchStats.shots += 1;
        addTracer(fx, s.origin, s.result.cast.point, s.result.cast.type);
        if (s.result.cast.type === 'actor') {
          game.stats.hits += 1;
          game.matchStats.hits += 1;
          if (s.result.cast.headshot) {
            game.stats.headshots += 1;
            game.matchStats.headshots += 1;
          }
          const reg = registerDamage(match, game.player, s.result.cast.actor, s.result.hit);
          notifyHit(s.result.cast.actor, game.player.id, match.time);
          // Your own shot is the most reliable contact there is: you just hit
          // them, so you know exactly where they were. It still expires like
          // any other contact — knowing where someone *was* is not the same as
          // knowing where they are.
          reportContact(game, s.result.cast.actor);
          fx.hitmarker = 0.22;
          fx.hitmarkerKill = reg.died;
          if (s.result.hit) {
            game.stats.damageDealt += s.result.hit.raw;
            game.matchStats.damageDealt += s.result.hit.raw;
          }
          pushSound(fx, { type: s.result.hit && s.result.hit.headshot ? 'headshot' : 'hit' });
        } else if (s.result.cast.type === 'wall') {
          addImpact(fx, s.result.cast.point, s.result.cast.box, game.rng);
        } else if (s.result.cast.type === 'friendly') {
          addImpact(fx, s.result.cast.point, null, game.rng);
        }
        pushSound(fx, { type: 'shot', weapon: s.shot.weaponId });
        alertBotsToSound(game, s.origin);
      }
    }

    // --- bots ---------------------------------------------------------
    refreshHuntZones(game.coordinator, game.grid, game.rng, match);
    // Alternate which team updates first: a fixed order would let ALFA react to
    // BRAVO's new positions every tick while BRAVO sees stale ones, which shows
    // up as a measurable side bias over thousands of ticks.
    const bots = [];
    // `bot.brain` is the filter, not `!isPlayer`: the actor the player is
    // currently driving has had its brain detached, and the body it was
    // transferred out of has a fresh one. Keeping `isPlayer` out of this test
    // means possession works without special-casing, and a teammate can never
    // be simulated and controlled at the same time.
    for (const bot of match.actors) if (bot.brain && bot.alive) bots.push(bot);
    const flip = match.actors.length > 0 && Math.floor(match.time * 60) % 2 === 0;
    if (flip) bots.reverse();
    // --- team awareness ---------------------------------------------------
    // A teammate who can see an enemy reports it, exactly like a bot calling a
    // contact over comms. This is what makes the minimap a *team* picture
    // rather than a solo one, and it is bounded: only bots on the player's own
    // side, only enemies they can actually see through `canSee` (FOV + line of
    // sight + view distance), and only while they are alive.
    for (const mate of match.actors) {
      if (!mate.brain || !mate.alive || mate.team !== game.player.team) continue;
      for (const foe of match.actors) {
        if (!foe.alive || foe.team === mate.team) continue;
        if (canSee(mate, foe, MAP_AABBS)) reportContact(game, foe);
      }
    }

    for (const bot of bots) {
      // Bots reload where you cannot see them, so the magazine clack is the
      // only cue that they are vulnerable. Emit it on the transition.
      const bw = activeWeapon(bot.loadout);
      const botWasReloading = bot.wasReloading || false;
      const botReloadingNow = !!(bw && bw.reloading);
      if (!botWasReloading && botReloadingNow) {
        pushSound(fx, { type: 'enemy_reload', x: bot.x, z: bot.z });
      }
      bot.wasReloading = botReloadingNow;
      updateBot(match, bot, dt, {
        grid: game.grid,
        boxes: MAP_AABBS,
        coordinator: game.coordinator,
        onShot: ({ shooter, shot, result, origin }) => {
          addTracer(fx, origin, result.cast.point, result.cast.type);
          // Near miss: a bullet that passes close but does not hit should be
          // audible as a whizz. Without it, incoming fire you survive is
          // completely silent, which reads as the bots shooting blanks.
          const hitMe = result.cast.type === 'actor' && result.cast.actor.isPlayer;
          const miss = result.cast.point && origin
            ? distancePointToSegment(
                { x: game.player.x, z: game.player.z },
                { x: origin.x, z: origin.z },
                { x: result.cast.point.x, z: result.cast.point.z },
              )
            : Infinity;
          if (!hitMe && miss < 2.2 && game.player.alive) {
            pushSound(fx, { type: 'whizz', x: origin.x, z: origin.z });
          }
          if (result.cast.type === 'wall') addImpact(fx, result.cast.point, result.cast.box, game.rng);
          if (result.cast.type === 'actor' && result.cast.actor.isPlayer) {
            const reg = registerDamage(match, shooter, result.cast.actor, result.hit);
            notifyHit(result.cast.actor, shooter.id, match.time);
            // Being shot from somewhere tells you exactly where that somewhere
            // is, hit or miss. This is what makes the damage-direction arrow
            // and the minimap agree instead of contradicting each other.
            reportContact(game, shooter);
            if (result.hit) {
              fx.damageFlash = Math.min(1, fx.damageFlash + (result.hit.headshot ? 0.9 : 0.55));
              const eye = eyePoint(game.player);
              fx.damageDir = Math.atan2(shooter.x - eye.x, -(shooter.z - eye.z)) - game.pc.yaw;
            }
            if (reg.died) onPlayerDeath(game);
          } else if (result.cast.type === 'actor') {
            const reg = registerDamage(match, shooter, result.cast.actor, result.hit);
            notifyHit(result.cast.actor, shooter.id, match.time);
            if (reg.died) {
              // no UI needed for bot-vs-bot deaths, killfeed handled by events
            }
          }
          pushSound(fx, { type: 'shot', weapon: shot.weaponId, x: shooter.x, z: shooter.z, bot: true });
          alertBotsToSound(game, origin);
        },
        onSound: null,
      });
    }
  } else if (match.phase === PHASE.ROUND_END || match.phase === PHASE.MATCH_END) {
    // Freeze everyone, drop held triggers, keep the camera alive.
    game.player.vx = 0;
    game.player.vz = 0;
    stopPlayerWeapon(game.pc);
    game.pc.ads = false;
    for (const a of match.actors) {
      if (a.brain) {
        a.brain.targetVisible = false;
        a.brain.state = a.alive ? BOT_STATE.HOLD : BOT_STATE.DEAD;
        releaseTrigger(activeWeapon(a.loadout));
      }
    }
  }

  // --- killcam ---------------------------------------------------------
  // Recorded every frame while alive, from the player's own eyes. The replay
  // runs from the killer's position, and a buffer that only started at the
  // moment of death would have nothing to show.
  if (game.player.alive) {
    const eye = eyePoint(game.player);
    recordKillcam(game.killcam, match.time, {
      x: eye.x,
      y: eye.y,
      z: eye.z,
      yaw: game.pc.yaw,
      pitch: game.pc.pitch,
    });
  }

  // --- feedback / bookkeeping -----------------------------------------
  decayFx(fx, dt);
  pruneContacts(game);
  const events = drainEvents(match);
  for (const e of events) {
    if (e.type === 'death') {
      if (!game.player.alive && e.actorId === game.player.id) onPlayerDeath(game);
      pushKillfeed(fx, { text: `${e.name} elendi`, team: e.team, age: 0, kind: 'death' });
      pushSound(fx, { type: 'death' });
    } else if (e.type === 'round_start') {
      clearTransientFx(fx);
      fx.killfeed.length = 0;
      // Contacts belong to a round. Carrying them over would put markers on an
      // empty map at the start of the next round, which is both wrong and
      // confusing.
      game.contacts.length = 0;
      fx.roundBanner = { text: `RAUND ${e.round}`, until: 1.6 };
      game.coordinator.contacts = {};
      game.coordinator.hot.length = 0;
      game.coordinator.hunt = { A: null, B: null };
      game.stats = { shots: 0, hits: 0, headshots: 0, damageDealt: 0 };
      // New round: everyone is alive again, so drop the death report and the
      // spectator camera. Forgetting this leaves the camera detached in a
      // respawned round, where the player can move but cannot see.
      game.deathInfo = null;
      game.spectate.mode = 'none';
      game.spectate.cam = null;
      game.spectate.targetId = null;
      game.killcam.frames.length = 0;
      // The playback handle has to go with the buffer. Clearing the frames but
      // leaving the playback alive left the camera bound to a replay whose
      // footage had just been deleted — the first tick after respawning read
      // an empty buffer and the camera stayed wherever the replay left it.
      game.killcamPlayback = null;
    } else if (e.type === 'round_end') {
      fx.roundBanner = null;
      pushSound(fx, { type: e.winner === 'A' ? 'round_win' : 'round_loss' });
    } else if (e.type === 'match_end') {
      pushSound(fx, { type: e.winner === 'A' ? 'match_win' : 'match_loss' });
    } else if (e.type === 'round_live') {
      pushSound(fx, { type: 'go' });
    }
  }

  // Safety net: if the last enemy dies exactly as the round ticks over, the
  // match still resolves (never two triggers because endRound is idempotent).
  return { phaseChanged };
}

/**
 * The player just died.
 *
 * This used to zero the input and stop. Nothing was shown, the camera stayed
 * frozen where it was, and there was no way to learn who had killed you or
 * from where — for the rest of the round, which can be most of a minute.
 */
function onPlayerDeath(game) {
  if (game.deathHandled) return;
  game.deathHandled = true;
  game.input.fire = false;
  game.input.forward = 0;
  game.input.right = 0;
  stopPlayerWeapon(game.pc);

  const { match } = game;
  const d = match.lastDeath && match.lastDeath.victimId === game.player.id ? match.lastDeath : null;
  const killer = d ? match.actors.find((a) => a.id === d.attackerId) : null;
  const teammates = match.actors.filter((a) => a.team === game.player.team && !a.isPlayer);

  game.deathAt = match.time;
  game.deathInfo = {
    ...deathReport({
      attacker: killer || (d ? { id: d.attackerId, name: d.attackerName, team: null, health: 0 } : null),
      weapon: d ? d.weapon : '',
      headshot: d ? d.headshot : false,
      distance: d ? d.distance : 0,
      round: match.round,
      remaining: teammates,
    }),
    // The killcam only replays when there is actually something to replay.
    killerId: d ? d.attackerId : null,
    // Seconds since the player died; advanced by the caller so the UI can time
    // the report -> spectate transition without its own clock.
    age: 0,
  };
  // Enter spectate immediately so the camera never sits dead on the corpse.
  // The report renders on top of it; there is no reason to stare at the floor
  // while reading who shot you.
  enterSpectate(game);

  // ── killcam replay ──────────────────────────────────────────────────────
  // Replay the seconds before the shot from the killer's side. Positions come
  // from the buffer of the player's own camera, so the replay shows the real
  // approach rather than a reconstruction.
  //
  // The camera is fixed at the killer's eyes and *tracks* the victim across the
  // replay: the recorded buffer holds where the player's own eyes were, so the
  // replay shows the real path the victim walked rather than a straight line
  // drawn from where they started to where they died. The killer's position is
  // not reconstructed, because it was never recorded and inventing it would
  // show a replay of something that did not happen.
  const kc = game.killcam;
  game.killcamPlayback = null;
  if (killer && killcamUsable(kc, match.time)) {
    const start = Math.max(kc.frames[0].t, match.time - KILLCAM_SECONDS);
    game.killcamPlayback = {
      start,
      end: match.time,
      t: start,
      killerEye: { x: killer.x, y: eyePoint(killer).y, z: killer.z },
      killerName: killer.name,
      done: false,
    };
  }
}

/**
 * Choose what the camera follows after death.
 *
 * Free camera when the whole team is down (`nobody left to follow`), otherwise
 * the first living teammate. This runs on death and again whenever the current
 * spectate target dies.
 */
function enterSpectate(game) {
  const { match } = game;
  const candidates = spectateCandidates({
    actors: match.actors,
    playerId: game.player.id,
    team: game.player.team,
  });
  const sp = game.spectate;
  if (!candidates.length) {
    // Nobody left. Detach into a free camera at the corpse's eye height rather
    // than leaving the camera inside the body.
    sp.mode = 'free';
    sp.targetId = null;
    sp.locked = false;
    sp.cam = sp.cam || {
      x: game.player.x,
      y: eyePoint(game.player).y + 0.4,
      z: game.player.z,
      yaw: game.pc.yaw,
      pitch: game.pc.pitch,
    };
    return;
  }
  sp.mode = 'follow';
  sp.targetId = candidates[0].id;
  sp.locked = false;
}

/** Q / E: step the spectate target. Ignored once the camera is free-camming. */
export function cycleSpectateTarget(game, dir) {
  const sp = game.spectate;
  if (!sp || sp.mode === 'none') return null;
  if (sp.mode === 'free') {
    // Once the camera has detached there is nothing to cycle between; take the
    // controls back out of free mode if a teammate is somehow still alive.
    const candidates = spectateCandidates({
      actors: game.match.actors,
      playerId: game.player.id,
      team: game.player.team,
    });
    if (!candidates.length) return null;
    sp.mode = 'follow';
    sp.locked = false;
    sp.targetId = cycleSpectate(candidates, null, dir).id;
    return sp.targetId;
  }
  const candidates = spectateCandidates({
    actors: game.match.actors,
    playerId: game.player.id,
    team: game.player.team,
  });
  const next = cycleSpectate(candidates, sp.targetId, dir);
  if (next) {
    sp.targetId = next.id;
    sp.locked = false;
  }
  return next ? next.id : null;
}

/**
 * Advance the spectator camera. Called every tick while the player is dead.
 *
 * Returns nothing; it writes `game.camera` which the renderer reads. Keeping
 * the camera math in the core means the tests can drive it without a renderer.
 */
function updateSpectate(game, dt) {
  const sp = game.spectate;
  if (!sp || sp.mode === 'none') return;
  const { match } = game;

  if (game.deathInfo) game.deathInfo.age += dt;

  // Killcam runs first and briefly: while it is playing the camera is the
  // killer's, not the spectator's.
  const kb = game.killcamPlayback;
  if (kb && !kb.done) {
    // `speed` exists for the headless visual test: at ~2 fps the 1.8 s window
    // is only a handful of frames and a poll on the test side can miss it
    // entirely, which made the check pass and fail on alternate runs. The game
    // never changes it.
    kb.t += dt * (kb.speed ?? game.killcamSpeed ?? 1);
    if (kb.t >= kb.end) {
      kb.done = true;
      kb.cam = null;
      // Hand the camera over cleanly: without this the first spectate frame
      // jumps from the killer's eye to the teammate in a single tick.
      sp.cam = null;
    } else {
      const victim = sampleKillcam(game.killcam, kb.t);
      const frame = victim ? killcamFrame(kb.killerEye, victim) : null;
      if (frame) {
        sp.cam = frame;
        // The replay camera is mirrored onto its own field. `sp.cam` is also
        // written by the spectator follow logic, so anything asking "is the
        // killcam running, and from where" cannot tell the two apart from that
        // field alone. This one is only ever the replay.
        kb.cam = frame;
      }
      return;
    }
  }

  if (sp.mode === 'follow') {
    const target = match.actors.find((a) => a.id === sp.targetId);
    if (!target || !target.alive) {
      // The teammate we were watching just died. Move on rather than staring
      // at their corpse from a camera that has stopped responding.
      const candidates = spectateCandidates({
        actors: match.actors,
        playerId: game.player.id,
        team: game.player.team,
      });
      const next = cycleSpectate(candidates, sp.targetId, 1);
      if (next) {
        sp.targetId = next.id;
        sp.locked = false;
      } else {
        enterSpectate(game);
      }
      return;
    }

    const eye = spectateEye(target);
    // Keep the camera out of walls: if the pulled-back position is behind
    // geometry, walk it toward the target until the view is clear.
    let cam = clampCamera(eye.x, eye.y, eye.z, SPECTATE_BOUNDS);
    if (cameraOccluded(cam, { x: target.x, y: eye.y, z: target.z }, (ox, oy, oz, dx, dy, dz, max) => raycastBoxes(ox, oy, oz, dx, dy, dz, MAP_AABBS, max))) {
      // Two fallbacks, cheapest first: half the distance, then the actor's own
      // head. A camera that never clips is worth more than a perfect angle.
      const half = spectateEye(target, { back: 1.2, up: 0.25 });
      const halfCam = clampCamera(half.x, half.y, half.z, SPECTATE_BOUNDS);
      const blocked = cameraOccluded(halfCam, { x: target.x, y: half.y, z: target.z }, (ox, oy, oz, dx, dy, dz, max) => raycastBoxes(ox, oy, oz, dx, dy, dz, MAP_AABBS, max));
      cam = blocked ? { x: target.x, y: eyePoint(target).y, z: target.z } : halfCam;
    }

    // Smooth the camera rather than snapping: the target moves, and a rigid
    // follow at 60 fps reads as a jitter.
    if (!sp.cam) sp.cam = { ...cam, yaw: target.yaw, pitch: target.pitch };
    const k = Math.min(1, 8 * dt);
    sp.cam.x += (cam.x - sp.cam.x) * k;
    sp.cam.y += (cam.y - sp.cam.y) * k;
    sp.cam.z += (cam.z - sp.cam.z) * k;
    // Look where the *target* is looking, smoothed the short way round.
    sp.cam.yaw = lerpAngle(sp.cam.yaw, target.yaw, k);
    sp.cam.pitch += (target.pitch - sp.cam.pitch) * k;

    // Pressing a movement key detaches into free flight.
    //
    // Not while the killcam is playing: the replay owns the camera and the
    // player's hands are still on WASD from the fight they just lost. The first
    // version checked this unconditionally, so a player who died while holding
    // forward dropped out of the replay on its first frame and never saw it.
    const replaying = game.killcamPlayback && !game.killcamPlayback.done;
    if (!replaying && wantsFreeCam(game.input)) {
      sp.mode = 'free';
      sp.locked = false;
    }
  }

  // Free flight is skipped entirely while a replay owns the camera, even if an
  // earlier tick already flipped the mode.
  if (sp.mode === 'free' && !(game.killcamPlayback && !game.killcamPlayback.done)) {
    const step = freeCameraStep(sp.cam, game.input, dt);
    const clamped = clampCamera(step.x, step.y, step.z, SPECTATE_BOUNDS);
    sp.cam = { ...sp.cam, x: clamped.x, y: clamped.y, z: clamped.z };
    // Look is applied by the normal mouse path into sp.yaw / sp.pitch.
    sp.cam.yaw = sp.yaw;
    sp.cam.pitch = sp.pitch;
  }
}

function wantsFreeCam(input) {
  return Boolean(input.forward || input.right || input.up || input.down);
}

/**
 * Take control of a living teammate, CS2-style.
 *
 * This is the one place the game changes *who the player is*. It is written as
 * an explicit transfer rather than a swap so the invariants are obvious:
 *
 *   - The teammate must be alive, on the player's team, and not the player.
 *   - Their brain is detached: a bot that keeps thinking would fight the
 *     controller for the same actor, and the player would lose control of
 *     their own movement every time the bot decided to strafe.
 *   - The controller's actor is repointed, so every existing call site —
 *     `game.pc`, `game.player`, firing, movement — keeps working unchanged.
 *   - The body you left behind is marked so it cannot be re-entered as a
 *     teammate later, and it is removed from the round's alive count only by
 *     the normal death rules, not by this.
 *
 * Returns the new actor, or null if the transfer was refused.
 */
export function possessTeammate(game, actorId) {
  const { match } = game;
  const from = game.player;
  const target = match.actors.find((a) => a.id === actorId);
  if (!target) return null;
  if (target === from) return null;
  if (!target.alive) return null;
  if (target.team !== from.team) return null;
  if (target.isPlayer) return null;

  // Detach the brain. The controller's own state is rebuilt around the new
  // body so the camera does not inherit the previous actor's momentum.
  target.brain = null;
  target.isPlayer = true;
  target.name = from.name + ' (devraldı)';

  // The old body stops being the player's, keeps its brain-less stillness, and
  // is marked so the minimap and the team list still show it honestly.
  from.isPlayer = false;
  from.possessedFrom = true;
  // A body that was being driven by the player has no brain of its own. Handing
  // it a fresh one keeps it from standing frozen in the open — but only if it
  // is still alive to act. Its RNG is seeded from its id so the whole match
  // stays reproducible.
  if (from.alive) {
    from.brain = createBrain(from, match.profile, {
      rng: mulberry32(game.seedForBrains + from.id * 7919),
      lane: 'mid',
    });
  }

  game.player = target;
  game.pc.actor = target;
  // Rebuild the camera on the new body: keeping the old yaw would snap the view
  // to wherever the previous actor happened to be facing.
  game.pc.yaw = target.yaw;
  game.pc.pitch = 0;
  game.pc.kickPitch = 0;
  game.pc.ads = false;
  game.pc.adsBlend = 0;

  // Stop spectating: the player is in control again.
  game.spectate.mode = 'none';
  game.spectate.cam = null;
  game.spectate.targetId = null;
  return target;
}

/** The camera transform the renderer should use while dead. */
export function spectateCamera(game) {
  const sp = game.spectate;
  if (!sp || sp.mode === 'none' || !sp.cam) return null;
  return {
    x: sp.cam.x,
    y: sp.cam.y,
    z: sp.cam.z,
    yaw: sp.cam.yaw,
    pitch: sp.cam.pitch,
  };
}

function alertBotsToSound(game, origin) {
  const { match } = game;
  for (const bot of match.actors) {
    if (!bot.brain || !bot.alive) continue;
    if (bot.team === game.player.team) {
      // teammates still react to nearby enemy gunfire through the same rules
    }
    hearSound(bot, origin, match);
  }
}

function addTracer(fx, from, to, type) {
  if (!to) return;
  fx.tracers.push({
    x1: from.x, y1: from.y, z1: from.z,
    x2: to.x, y2: to.y, z2: to.z,
    age: 0,
    life: 0.06,
    type,
  });
  if (fx.tracers.length > 40) fx.tracers.shift();
}

/**
 * Register a bullet impact: a flash, a persistent mark and a burst of debris.
 *
 * `box` is the map box that was hit, or null for a body. The face normal is
 * computed here rather than in the renderer because it belongs to the same
 * moment as the hit — the renderer only knows where, not what it stuck into.
 */
/**
 * `rng` is threaded in rather than read from Math.random: this is simulation
 * code, and the whole point of the seeded generator is that a match replays
 * identically. Sparks were the one place that quietly broke it.
 */
function addImpact(fx, point, box, rng = Math.random) {
  const face = box ? faceNormal(box, point) : null;
  const normal = face ? face.normal : [0, 1, 0];

  // The flash: brief and bright.
  fx.impacts.push({ x: point.x, y: point.y, z: point.z, age: 0, life: 0.25, kind: box ? box.kind : 'actor' });
  if (fx.impacts.length > 30) fx.impacts.shift();

  // The mark: stays. Skipped on body hits, where a decal would be attached to
  // nothing and would hang in the air after the corpse is gone.
  if (box) {
    const p = offsetAlong(point, normal);
    fx.marks.push({ x: p.x, y: p.y, z: p.z, nx: normal[0], ny: normal[1], nz: normal[2], age: 0, kind: box.kind });
    if (fx.marks.length > MARKS_MAX) fx.marks.shift();
  }

  // The debris. Sparks only come off hard surfaces; a body hit already has a
  // hitmarker and blood is a separate question.
  if (box && fx.sparks.length < SPARKS_MAX) {
    const burst = sparkBurst(normal, 6, rng, 0.8, 3.4);
    for (const b of burst) {
      if (fx.sparks.length >= SPARKS_MAX) break;
      fx.sparks.push({
        x: point.x, y: point.y, z: point.z,
        vx: b.vx, vy: b.vy, vz: b.vz,
        age: 0, life: 0.35 + rng() * 0.25,
      });
    }
  }
}

function decayFx(fx, dt) {
  for (const t of fx.tracers) t.age += dt;
  fx.tracers = fx.tracers.filter((t) => t.age < t.life);
  for (const i of fx.impacts) i.age += dt;
  fx.impacts = fx.impacts.filter((i) => i.age < i.life);
  // Sparks integrate here, in the deterministic simulation, so their arc is
  // part of the game state rather than something the renderer invents per
  // frame. That also means a test can assert they fall.
  for (const sp of fx.sparks) {
    sp.x += sp.vx * dt;
    sp.y += sp.vy * dt;
    sp.z += sp.vz * dt;
    sp.vy -= 9.8 * dt;
    sp.age += dt;
  }
  fx.sparks = fx.sparks.filter((sp) => sp.age < sp.life);
  fx.hitmarker = Math.max(0, fx.hitmarker - dt);
  fx.damageFlash = Math.max(0, fx.damageFlash - dt * 1.8);
  for (const k of fx.killfeed) k.age += dt;
  fx.killfeed = fx.killfeed.filter((k) => k.age < 6);
  if (fx.roundBanner) {
    fx.roundBanner.until -= dt;
    if (fx.roundBanner.until <= 0) fx.roundBanner = null;
  }
}

function pushSound(fx, s) {
  fx.sounds.push(s);
  if (fx.sounds.length > 24) fx.sounds.shift();
}

/** Drain audio cues for the audio layer. */
export function drainSounds(game) {
  const s = game.fx.sounds;
  game.fx.sounds = [];
  return s;
}

/** Everything the HUD needs in one object. */
export function hudState(game) {
  const p = game.player;
  const w = activeWeapon(p.loadout);
  return {
    ...matchSnapshot(game.match),
    health: Math.round(p.health),
    armor: Math.round(p.armor),
    maxHealth: PLAYER.maxHealth,
    maxArmor: PLAYER.maxArmor,
    playerAlive: p.alive,
    ammo: ammoInfo(p.loadout),
    weaponName: w.def.name,
    weaponId: w.id,
    reloading: w.reloading,
    reloadProgress: w.reloading ? 1 - w.reloadTimer / w.def.reloadTime : 0,
    ads: game.pc.ads,
    spreadDeg: w.spread,
    hitmarker: game.fx.hitmarker,
    hitmarkerKill: game.fx.hitmarkerKill,
    damageFlash: game.fx.damageFlash,
    damageDir: game.fx.damageDir,
    killfeed: game.fx.killfeed.map((k) => ({ text: k.text, team: k.team, kind: k.kind, age: k.age })),
    roundBanner: game.fx.roundBanner ? game.fx.roundBanner.text : null,
    scores: { A: game.match.score.A, B: game.match.score.B },
    teamNames: MATCH.teamNames,
    playerTeam: p.team,
    teamMates: game.match.actors
      .filter((a) => a.team === p.team)
      // Positions are included because the minimap draws teammates, and a
      // teammate you cannot place on the map is not much help. Enemy positions
      // are deliberately absent — they arrive through `contacts` instead.
      .map((a) => ({ id: a.id, name: a.name, alive: a.alive, isPlayer: a.isPlayer, health: Math.round(a.health), x: a.x, z: a.z })),
    enemiesAlive: aliveCount(game.match, p.team === 'A' ? 'B' : 'A'),
    difficulty: game.match.difficulty,
    paused: game.paused,
    // Tactical-map inputs. `contacts` is the player's side's knowledge of enemy
    // positions, not the enemies themselves; see reportContact().
    contacts: game.contacts.map((c) => ({ id: c.id, x: c.x, z: c.z, time: c.time })),
    now: game.match.time,
    playerPos: { x: p.x, z: p.z },
    yaw: game.pc.yaw,
    // ── death / spectator ────────────────────────────────────────────────
    // These belong on the HUD state, not the debug snapshot: they drive the
    // death report and the spectator bar, which are player-facing.
    deathInfo: game.deathInfo,
    deathFade: game.deathInfo ? deathFade(game.deathInfo.age, 0.45) : 0,
    killcam: game.killcamPlayback
      ? {
          playing: !game.killcamPlayback.done,
          progress: killcamProgress(game.killcamPlayback),
          killerName: game.killcamPlayback.killerName,
        }
      : null,
    spectate: {
      mode: game.spectate.mode,
      targetId: game.spectate.targetId,
      targetName: game.spectate.targetId
        ? (game.match.actors.find((a) => a.id === game.spectate.targetId) || {}).name || null
        : null,
    },
  };
}

/** Pause / resume: everything stops because updateGame early-returns. */
export function setPaused(game, paused) {
  game.paused = Boolean(paused);
  if (game.paused) {
    game.input.fire = false;
    game.input.forward = 0;
    game.input.right = 0;
    stopPlayerWeapon(game.pc);
  }
}

/**
 * Change difficulty mid-match. Only bot *behaviour* parameters are swapped;
 * damage, health and armour stay identical, so this cannot be used to gain an
 * unfair advantage (or to punish the player silently).
 */
export function setDifficulty(game, difficulty) {
  const next = DIFFICULTY[difficulty];
  if (!next) return false;
  game.match.difficulty = next.id;
  game.match.profile = next;
  for (const a of game.match.actors) {
    if (a.brain) a.brain.profile = next;
  }
  return true;
}

/**
 * Structured runtime snapshot: the running game's health, used by tests, the
 * headless simulator and the F3 debug overlay.
 */
export function gameSnapshot(game) {
  const p = game.player;
  return {
    phase: game.match.phase,
    round: game.match.round,
    score: { ...game.match.score },
    elapsed: Number(game.match.time.toFixed(1)),
    roundElapsed: Number((game.match.roundElapsed || 0).toFixed(1)),
    difficulty: game.match.difficulty,
    paused: game.paused,
    player: {
      alive: p.alive,
      health: Math.round(p.health),
      armor: Math.round(p.armor),
      x: Number(p.x.toFixed(2)),
      z: Number(p.z.toFixed(2)),
      yaw: Number(p.yaw.toFixed(2)),
      weapon: p.loadout.current,
      mag: p.loadout.slots[p.loadout.current].mag,
      reserve: p.loadout.slots[p.loadout.current].reserve,
      kills: p.kills,
      deaths: p.deaths,
    },
    alive: { A: aliveCount(game.match, 'A'), B: aliveCount(game.match, 'B') },
    players: game.match.actors.map((a) => ({
      id: a.id,
      name: a.name,
      team: a.team,
      isPlayer: a.isPlayer,
      alive: a.alive,
      health: Math.round(a.health),
      armor: Math.round(a.armor),
      x: Number(a.x.toFixed(2)),
      z: Number(a.z.toFixed(2)),
      state: a.brain ? a.brain.state : 'player',
      lane: a.brain ? a.brain.lane : null,
      // Tactical read-out for the F3 overlay: is this bot in cover, crouched,
      // helping a teammate, and what is it trying to reach?
      cover: Boolean(a.brain && a.brain.coverSpot),
      crouch: a.crouch > 0.5,
      support: Boolean(a.brain && a.brain.supportCall),
      goal: a.brain && a.brain.pathGoal
        ? [Math.round(a.brain.pathGoal.x), Math.round(a.brain.pathGoal.z)]
        : null,
      kills: a.kills,
      deaths: a.deaths,
    })),
    stats: { ...game.stats },
    matchStats: { ...game.matchStats },
    fx: {
      tracers: game.fx.tracers.length,
      impacts: game.fx.impacts.length,
      killfeed: game.fx.killfeed.length,
    },
  };
}

/** Restart the current match from round 1 with the same difficulty. */
export function restartMatch(game, difficulty = game.match.difficulty) {
  game.deathHandled = false;
  game.paused = false;
  game.input = { forward: 0, right: 0, sprint: false, crouch: false, fire: false, ads: false };
  game.pc.ads = false;
  clearTransientFx(game.fx);
  game.fx.killfeed.length = 0;
  startMatch(game.match, { difficulty });
  assignLanes(game.match, game.coordinator);
  // Reset camera behind the new spawn.
  game.pc.yaw = game.player.yaw;
  game.pc.pitch = 0;
  game.pc.kickPitch = 0;
  game.coordinator.contacts = {};
  game.stats = { shots: 0, hits: 0, headshots: 0, damageDealt: 0 };
  // A new match means new match-wide numbers. Forgetting this would make the
  // second match of a session inherit the first match's accuracy.
  game.matchStats = { shots: 0, hits: 0, headshots: 0, damageDealt: 0 };
}
