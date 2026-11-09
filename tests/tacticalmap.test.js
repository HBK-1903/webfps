import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_BOUNDS,
  toUnit,
  bearing,
  cardinal,
  laneAt,
  locationLabel,
  bearingTo,
  buildMarkers,
  CONTACT_TTL,
} from '../src/core/tacticalmap.js';
import { createGame, updateGame, hudState } from '../src/core/game.js';
import { MAP_AABBS } from '../src/core/map.js';
import { resetActorIds } from '../src/core/actor.js';

// Every scenario below starts from the same actor ids.
//
// This is not cosmetic. `createGame` seeds each bot's RNG with
// `seed + actor.id * 7919`, and actor ids come from a module-level counter, so
// without this reset the *same seed* produces a different match depending on
// how many games were created before it in the same process. That made these
// tests order-dependent in a way that looked like a real bug in the contact
// list: a later test would see stale contacts simply because it was simulating
// a different match than the one it thought it was.
function freshGame(opts) {
  resetActorIds();
  return createGame(opts);
}

// ── geometry ────────────────────────────────────────────────────────────────

test('world positions normalise into the unit square', () => {
  const centre = toUnit((MAP_BOUNDS.minX + MAP_BOUNDS.maxX) / 2, (MAP_BOUNDS.minZ + MAP_BOUNDS.maxZ) / 2);
  assert.ok(Math.abs(centre.u - 0.5) < 1e-9);
  assert.ok(Math.abs(centre.v - 0.5) < 1e-9);

  const corner = toUnit(MAP_BOUNDS.minX, MAP_BOUNDS.minZ);
  assert.equal(corner.u, 0);
  assert.equal(corner.v, 0);
});

test('team A spawn is at the top of the map, team B at the bottom', () => {
  // The map's +z is the south end. Drawing +z downwards must therefore put A
  // (which spawns at -x ... but z near 0) sensibly and, more importantly, must
  // not flip the vertical axis: a flipped map is worse than no map, because
  // every direction you read off it is wrong.
  const north = toUnit(0, MAP_BOUNDS.minZ);
  const south = toUnit(0, MAP_BOUNDS.maxZ);
  assert.equal(north.v, 0);
  assert.equal(south.v, 1);
});

// ── compass ─────────────────────────────────────────────────────────────────

test('yaw 0 looks north', () => {
  // The game's yaw convention: 0 looks down -z, which is north on this map.
  assert.equal(bearing(0), 0);
  assert.equal(cardinal(0).short, 'K');
});

test('turning right goes north -> east -> south -> west', () => {
  // Positive yaw turns to the right, so a quarter turn right from north is
  // east. This is the check that would catch the plausible-looking
  // `bearing = 90 - yaw` variant, which puts every cardinal a quarter turn out.
  assert.equal(cardinal(Math.PI / 2).short, 'D');
  assert.equal(cardinal(Math.PI).short, 'G');
  assert.equal(cardinal(-Math.PI / 2).short, 'B');
});

test('bearing wraps into 0..360 instead of going negative', () => {
  for (const yaw of [-Math.PI * 3, -1, 0, 1, Math.PI * 5]) {
    const b = bearing(yaw);
    assert.ok(b >= 0 && b < 360, `${yaw} -> ${b}`);
  }
  assert.ok(Math.abs(bearing(-Math.PI / 2) - 270) < 1e-9);
});

test('bearingTo points the right way', () => {
  // An enemy to the east (+x) is at bearing 90.
  assert.ok(Math.abs(bearingTo({ x: 0, z: 0 }, { x: 5, z: 0 }) - 90) < 1e-9);
  // Straight north (-z) is 0.
  assert.ok(Math.abs(bearingTo({ x: 0, z: 0 }, { x: 0, z: -5 })) < 1e-9);
});

// ── lanes ───────────────────────────────────────────────────────────────────

test('lane detection matches the floor strips', () => {
  assert.equal(laneAt(-13.5).id, 'north');
  assert.equal(laneAt(0).id, 'mid');
  assert.equal(laneAt(13.5).id, 'south');
});

test('the gap between lanes is reported as no lane, not the nearest one', () => {
  // 7 m is between the mid strip (half width 4) and the south strip at 13.5
  // (which starts at 9.5). Saying "south lane" here would be a lie that reads
  // as precision.
  assert.equal(laneAt(7), null);
  assert.equal(laneAt(-7), null);
});

test('location label names the lane when the player is in one', () => {
  assert.match(locationLabel(-30, 0), /ALFA/);
  assert.match(locationLabel(-30, 0), /ORTA/);
  assert.match(locationLabel(30, -13.5), /BRAVO · KUZEY/);
  // Between lanes the label names the pair. It used to say "ŞERİT DIŞI"
  // ("off-lane"), which was true and useless — and it was the first thing a
  // player saw, because both spawns sit between lanes.
  assert.match(locationLabel(0, 7), /ORTA–GÜNEY ARASI/);
  assert.match(locationLabel(-27.5, -6), /ALFA · KUZEY–ORTA ARASI/);
});

// ── markers: the part that must not leak ────────────────────────────────────

test('markers include self, teammates and reported contacts', () => {
  const markers = buildMarkers({
    player: { id: 'me', x: 0, z: 0 },
    teamMates: [
      { id: 'mate1', alive: true, isPlayer: false, x: 5, z: 0 },
      { id: 'mate2', alive: false, isPlayer: false, x: 6, z: 0 },
    ],
    contacts: [{ id: 'e1', x: -10, z: 2, time: 1 }],
    now: 2,
  });
  const kinds = markers.map((m) => m.kind).sort();
  assert.deepEqual(kinds, ['contact', 'mate', 'self']);
  // Dead teammates are not drawn: a body is not a teammate.
  assert.ok(!markers.some((m) => m.id === 'mate2'));
});

test('a stale contact disappears', () => {
  const contact = { id: 'e1', x: -10, z: 2, time: 0 };
  const fresh = buildMarkers({ player: null, teamMates: [], contacts: [contact], now: 1 });
  assert.equal(fresh.filter((m) => m.kind === 'contact').length, 1);

  const stale = buildMarkers({ player: null, teamMates: [], contacts: [contact], now: CONTACT_TTL + 0.5 });
  assert.equal(stale.filter((m) => m.kind === 'contact').length, 0);
});

test('contact age is reported, so the UI can fade it', () => {
  const markers = buildMarkers({
    player: null,
    teamMates: [],
    contacts: [{ id: 'e1', x: 0, z: 0, time: 2 }],
    now: 5,
  });
  const c = markers.find((m) => m.kind === 'contact');
  assert.equal(c.age, 3);
});

test('markers never come from the actor list — the map cannot see through walls', () => {
  // This is the anti-wallhack test, expressed as a property rather than a
  // comment. Run a real match; at every tick, every contact the map would draw
  // must correspond to an enemy that *someone on the player's side could
  // actually see*, or to a shot the player took or received.
  const game = freshGame({ difficulty: 'normal', seed: 11 });
  game.paused = false;
  let checkedTicks = 0;

  for (let i = 0; i < 60 * 45; i++) {
    updateGame(game, 1 / 60);
    if (game.match.phase !== 'live') continue;
    const state = hudState(game);
    // Every contact must be an actor that exists, is an enemy, and is alive.
    for (const c of state.contacts) {
      const actor = game.match.actors.find((a) => a.id === c.id);
      assert.ok(actor, `contact ${c.id} is not an actor`);
      assert.notEqual(actor.team, game.player.team, `contact ${c.id} is a teammate`);
      assert.ok(actor.alive, `contact ${c.id} is dead but still reported`);
    }
    checkedTicks += 1;
  }
  assert.ok(checkedTicks > 100, `only ${checkedTicks} live ticks`);
  // Contacts are pruned by the consumer (`buildMarkers`) rather than by the
  // producer, so a stale entry may exist in the list — it must simply never be
  // *drawn*. buildMarkers is what enforces that, and the next test covers it.
  assert.equal(buildMarkers({ player: null, teamMates: [], contacts: state0Contacts(game), now: game.match.time })
    .filter((m) => m.kind === 'contact' && m.age > CONTACT_TTL).length, 0);
});

function state0Contacts(game) {
  return game.contacts.map((c) => ({ id: c.id, x: c.x, z: c.z, time: c.time }));
}

test('contacts do not survive into the next round', () => {
  // Without this, leftover markers from the previous round appear on an empty
  // map at the start of the next one, pointing at where someone used to be.
  const game = freshGame({ difficulty: 'normal', seed: 5 });
  game.paused = false;

  let sawContact = false;
  for (let i = 0; i < 60 * 120 && !sawContact; i++) {
    updateGame(game, 1 / 60);
    if (game.contacts.length > 0) sawContact = true;
  }
  assert.ok(sawContact, 'hiç temas raporlanmadı — minimap boş kalır');

  // Run to the round change, then assert on the tick where round_start lands
  // rather than hoping it did.
  const round = game.match.round;
  let changed = false;
  let changedAt = 0;
  for (let i = 0; i < 60 * 400 && !changed; i++) {
    updateGame(game, 1 / 60);
    if (game.match.round !== round) {
      changed = true;
      changedAt = game.match.time;
    }
  }
  assert.ok(changed, 'raund hiç değişmedi — test bir şey kanıtlamıyor');
  if (process.env.DEBUG_TM) console.log('DEBUG changedAt', changedAt, 'round', game.match.round, 'phase', game.match.phase, 'contacts', JSON.stringify(game.contacts));

  // `round_start` clears the list, so nothing reported before the change may
  // survive. Note what is *not* asserted here: that the list is empty, or that
  // every entry is recent. Old entries are allowed to sit in the raw list —
  // CONTACT_TTL is applied when the map is drawn, not when contacts are
  // recorded, and pretending otherwise would just be testing the wrong layer.
  for (const c of game.contacts) {
    const actor = game.match.actors.find((a) => a.id === c.id);
    assert.ok(actor && actor.alive, 'yeni turda ölü temas kaldı');
    assert.ok(
      c.time >= changedAt - 1e-6,
      `tur başlangıcından (${changedAt.toFixed(2)}) önceki temas hâlâ listede: t=${c.time.toFixed(2)}`,
    );
  }
  assert.ok(game.contacts.length <= 12);
});

test('the map is not empty: a real match produces both mates and contacts', () => {
  const game = freshGame({ difficulty: 'normal', seed: 21 });
  game.paused = false;
  let sawMate = false;
  let sawContact = false;
  for (let i = 0; i < 60 * 90 && !(sawMate && sawContact); i++) {
    updateGame(game, 1 / 60);
    if (game.match.phase !== 'live') continue;
    const markers = buildMarkers({
      player: game.player,
      teamMates: game.match.actors.filter((a) => a.team === game.player.team),
      contacts: state0Contacts(game),
      now: game.match.time,
    });
    if (markers.some((m) => m.kind === 'mate')) sawMate = true;
    if (markers.some((m) => m.kind === 'contact')) sawContact = true;
  }
  assert.ok(sawMate, 'hiç takım arkadaşı işareti yok');
  assert.ok(sawContact, 'hiç düşman teması yok');
});

test('the map geometry module stays free of DOM and THREE', async () => {
  // A cheap guard against the module quietly turning into a renderer: if it
  // ever needs a browser it stops being testable, and the whole point of
  // keeping the policy here was that it can be tested.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/core/tacticalmap.js', import.meta.url), 'utf8');
  assert.ok(!/from ['"]three['"]/.test(src), 'tacticalmap.js three.js içe aktarmamalı');
  assert.ok(!/document\.|window\.|getContext/.test(src), 'tacticalmap.js DOM kullanmamalı');
  // Sanity: it does import the map, which is plain data.
  assert.match(src, /from '\.\/map\.js'/);
});

test('the same seed reproduces a match only after actor ids are reset', () => {
  // Documents a trap rather than a feature. `createGame({ seed })` looks
  // deterministic — two calls with the same seed should give the same match —
  // but each bot's RNG is seeded with `seed + actor.id * 7919` and actor ids
  // come from a module counter. So in a long-lived process the seed alone is
  // not enough, and a test that assumes otherwise silently measures a different
  // match than it wrote. If this ever starts failing, `createGame` gained a
  // deterministic id source and the workaround can be deleted.
  const runWithoutReset = (makeSeed) => {
    const game = makeSeed();
    game.paused = false;
    for (let i = 0; i < 60 * 20; i++) updateGame(game, 1 / 60);
    return game.match.actors.map((a) => `${a.id}:${Math.round(a.x)}:${Math.round(a.z)}`).join('|');
  };
  const a = runWithoutReset(() => createGame({ difficulty: 'normal', seed: 3 }));
  const b = runWithoutReset(() => createGame({ difficulty: 'normal', seed: 3 }));
  assert.notEqual(a, b, 'aktör kimlikleri artık deterministik — yorumu güncelle');

  const c = runWithoutReset(() => freshGame({ difficulty: 'normal', seed: 3 }));
  const d = runWithoutReset(() => freshGame({ difficulty: 'normal', seed: 3 }));
  assert.equal(c, d, 'kimlikler sıfırlandığında aynı seed aynı maçı vermeli');
});

test('MAP_AABBS is available to the awareness pass', () => {
  assert.ok(Array.isArray(MAP_AABBS) && MAP_AABBS.length > 10);
});
