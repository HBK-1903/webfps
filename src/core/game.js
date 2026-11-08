// Headless game orchestration: owns the match, the player controller, the bots
// and all transient feedback (tracers, hitmarkers, sounds). The renderer is a
// pure consumer of this state, which is what makes the whole game testable.

import { PLAYER, MATCH, DIFFICULTY } from './config.js';
import { MAP_AABBS } from './map.js';
import { NavGrid } from './navgrid.js';
import { createMatch, startMatch, updateMatch, matchSnapshot, drainEvents, aliveCount, playerActor, registerDamage, PHASE } from './match.js';
import { createPlayerController, updatePlayer, playerTryFire, playerReload, playerSwitch, playerReleaseTrigger, addLook, stopPlayerWeapon } from './player.js';
import { createBrain, createCoordinator, assignLanes, updateBot, BOT_STATE, refreshHuntZones } from './bot.js';
import { activeWeapon, ammoInfo, releaseTrigger } from './weapon.js';
import { eyePoint } from './actor.js';
import { notifyHit, hearSound, canSee } from './bot.js';

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
    paused: false,
    started: false,
    fx: createFxState(),
    input: { forward: 0, right: 0, sprint: false, crouch: false, fire: false, ads: false },
    adsTarget: 0,
    fov: 78,
    shake: true,
    stats: { shots: 0, hits: 0, headshots: 0, damageDealt: 0 },
    onSound: null,
    deathHandled: false,
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

export function createFxState() {
  return {
    tracers: [],
    impacts: [],
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

export function clearTransientFx(fx) {
  fx.tracers.length = 0;
  fx.impacts.length = 0;
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
    updatePlayer(game.pc, game.input, { boxes: MAP_AABBS, dt, advanceTime: true });
    game.pc.ads = game.input.ads && game.player.alive;
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
        addTracer(fx, s.origin, s.result.cast.point, s.result.cast.type);
        if (s.result.cast.type === 'actor') {
          game.stats.hits += 1;
          if (s.result.cast.headshot) game.stats.headshots += 1;
          const reg = registerDamage(match, game.player, s.result.cast.actor, s.result.hit);
          notifyHit(s.result.cast.actor, game.player.id, match.time);
          // Your own shot is the most reliable contact there is: you just hit
          // them, so you know exactly where they were. It still expires like
          // any other contact — knowing where someone *was* is not the same as
          // knowing where they are.
          reportContact(game, s.result.cast.actor);
          fx.hitmarker = 0.22;
          fx.hitmarkerKill = reg.died;
          if (s.result.hit) game.stats.damageDealt += s.result.hit.raw;
          pushSound(fx, { type: s.result.hit && s.result.hit.headshot ? 'headshot' : 'hit' });
        } else if (s.result.cast.type === 'wall') {
          addImpact(fx, s.result.cast.point, s.result.cast.box);
        } else if (s.result.cast.type === 'friendly') {
          addImpact(fx, s.result.cast.point, null);
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
          if (result.cast.type === 'wall') addImpact(fx, result.cast.point, result.cast.box);
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

function onPlayerDeath(game) {
  if (game.deathHandled) return;
  game.deathHandled = true;
  game.input.fire = false;
  game.input.forward = 0;
  game.input.right = 0;
  stopPlayerWeapon(game.pc);
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

function addImpact(fx, point, box) {
  fx.impacts.push({ x: point.x, y: point.y, z: point.z, age: 0, life: 0.25, kind: box ? box.kind : 'actor' });
  if (fx.impacts.length > 30) fx.impacts.shift();
}

function decayFx(fx, dt) {
  for (const t of fx.tracers) t.age += dt;
  fx.tracers = fx.tracers.filter((t) => t.age < t.life);
  for (const i of fx.impacts) i.age += dt;
  fx.impacts = fx.impacts.filter((i) => i.age < i.life);
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
}
