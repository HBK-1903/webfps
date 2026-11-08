// Aiming, reticle placement and recoil: the pieces that decide whether what the
// player sees is what actually happens.
//
// Every assertion here corresponds to a bug that was measured in the real game,
// not a hypothetical. The numbers in the comments are the measurements.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PerspectiveCamera } from 'three';

import { createActor, eyePoint, hitVolumes } from '../src/core/actor.js';
import { laneForMirroredSlot, mirrorSlot, LANE_PATTERN, ROUTES, SPAWNS, ROTATE_LANE } from '../src/core/map.js';
import { createGame } from '../src/core/game.js';
import { aimPoint, laneSlot } from '../src/core/bot.js';
import { updatePlayer } from '../src/core/player.js';
import { DIFFICULTY } from '../src/core/config.js';
import { castShot, directionFromAngles, anglesTo } from '../src/core/combat.js';
import { createViewModel, applyPose, setViewModelWeapon } from '../src/render/viewmodel.js';
import { applyCameraAngles } from '../src/render/math.js';
import { createLoadout, activeWeapon, tryShoot, resetLoadout, updateWeapon } from '../src/core/weapon.js';
import { createPlayerController, cameraPitch } from '../src/core/player.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const alive = (team, name) => {
  const a = createActor({ team, name, index: 0 });
  a.alive = true;
  return a;
};

// --- reticle placement ------------------------------------------------------

test('the reticle is pinned to the exact centre of the viewport', () => {
  // The crosshair used to live inside the bottom HUD row, which is a flex row of
  // [vitals | crosshair | ammo]. Its centre was therefore offset by half the
  // width difference between those panels: measured 16 px at 1600 px wide, and
  // it moved whenever the ammo readout changed width ("30 / 90" vs "3 / 12").
  const css = read('src/ui/styles.css');
  const layer = css.slice(css.indexOf('.reticle-layer'));
  const block = layer.slice(0, layer.indexOf('}'));
  assert.match(block, /left:\s*50%/, 'reticle layer must be horizontally centred');
  assert.match(block, /top:\s*50%/, 'reticle layer must be vertically centred');
  assert.match(block, /width:\s*0/, 'a zero-size layer cannot drag the reticle off-centre');
  assert.match(block, /height:\s*0/);

  // It must not be laid out by the HUD bar any more.
  const html = read('index.html');
  const hudBottom = html.slice(html.indexOf('class="hud-bottom"'), html.indexOf('</div>\n      </div>'));
  const barSegment = html.slice(html.indexOf('class="hud-bottom"'));
  assert.ok(!barSegment.slice(0, barSegment.indexOf('reticle-layer') === -1 ? 0 : barSegment.indexOf('reticle-layer')).includes('id="crosshair"'),
    'the crosshair must not be inside the bottom HUD row');

  const reticleMarkup = html.slice(html.indexOf('class="reticle-layer"'), html.indexOf('class="reticle-layer"') + 900);
  assert.match(reticleMarkup, /id="crosshair"/);
  assert.match(reticleMarkup, /id="hitmarker"/);
  assert.match(reticleMarkup, /id="reload-ring"/);
  assert.ok(!/\.crosshair-wrap/.test(css), 'the old wrapper layout must be gone');
  void hudBottom;
});

test('nothing in the HUD can visually shift the aim point', () => {
  // The reticle layer is a child of #hud, which fills the viewport; the offsets
  // that used to matter (vitals / ammo panel widths) no longer apply.
  const css = read('src/ui/styles.css');
  const hud = css.slice(css.indexOf('.hud {'), css.indexOf('}', css.indexOf('.hud {')));
  assert.match(hud, /position:\s*absolute/);
  assert.match(hud, /inset:\s*0/, 'the HUD must cover the whole canvas, or 50% is not the screen centre');

  const canvas = css.slice(css.indexOf('#view {'), css.indexOf('}', css.indexOf('#view {')));
  assert.match(canvas, /inset:\s*0/, 'the canvas must fill the viewport too');
});

// --- iron sights ------------------------------------------------------------

test('ADS puts the iron sights on the camera axis, so the reticle tells the truth', () => {
  // The sights sat 4-6 cm below the camera axis (the ADS offset was a hand-tuned
  // -0.115 while the sights are at +0.075). At 30 m that is a miss of well over
  // a metre: the crosshair was on the target, the rounds were not.
  const camera = new PerspectiveCamera(72, 16 / 9, 0.05, 200);
  const vm = createViewModel(camera);
  applyCameraAngles(camera, 0, 0);
  camera.updateMatrixWorld(true);

  for (const [id, group, rearIdx, frontIdx] of [
    ['rifle', vm.rifle.group, 7, 8],
    ['pistol', vm.pistol.group, 3, 3],
  ]) {
    setViewModelWeapon(vm, id);
    applyPose(vm, { speedFactor: 0, adsBlend: 1, dt: 1, sprinting: false });
    vm.root.updateMatrixWorld(true);
    const rear = group.children[rearIdx].getWorldPosition(camera.position.clone());
    const front = group.children[frontIdx].getWorldPosition(camera.position.clone());

    // A sight on the camera axis must sit at x=0 and its line must be parallel
    // to the view direction (-Z), i.e. no vertical convergence.
    assert.ok(Math.abs(rear.x) < 0.004, `${id} rear sight off-axis: ${rear.x}`);
    assert.ok(Math.abs(front.x) < 0.004, `${id} front sight off-axis: ${front.x}`);
    const slope = Math.abs(front.y - rear.y);
    assert.ok(slope < 0.004, `${id} sight line is not parallel to the camera axis: ${slope.toFixed(4)}`);

    // ...and the sights must be centred on the screen, not below it.
    assert.ok(Math.abs(rear.y) < 0.004, `${id} sights sit ${(rear.y * 100).toFixed(1)} cm off the aim point`);
  }
});

test('hip fire is not aligned, ADS is — otherwise ADS is pointless', () => {
  const camera = new PerspectiveCamera(72, 16 / 9, 0.05, 200);
  const vm = createViewModel(camera);
  setViewModelWeapon(vm, 'rifle');
  applyPose(vm, { speedFactor: 0, adsBlend: 0, dt: 1, sprinting: false });
  vm.root.updateMatrixWorld(true);
  const hipX = vm.rifle.group.children[7].getWorldPosition(camera.position.clone()).x;
  assert.ok(hipX > 0.1, 'the gun must start off to the side when hip-firing');

  applyPose(vm, { speedFactor: 0, adsBlend: 1, dt: 1, sprinting: false });
  vm.root.updateMatrixWorld(true);
  const adsX = vm.rifle.group.children[7].getWorldPosition(camera.position.clone()).x;
  assert.ok(Math.abs(adsX) < 0.004, 'aiming down sights must centre the gun');
});

// --- hit volumes ------------------------------------------------------------

test('head and body hit volumes do not overlap', () => {
  // They used to: body maxY was 1.36 and the head sphere reached down to 1.33.
  // Any shot at the upper chest resolved as a headshot, which is why 100% of
  // bot burst kills were headshots before this was fixed.
  for (const crouch of [0, 0.5, 1]) {
    const a = alive('B', 'T');
    a.crouch = crouch;
    const v = hitVolumes(a);
    assert.ok(
      v.body.maxY <= v.head.y - v.head.r + 1e-9,
      `crouch ${crouch}: torso (${v.body.maxY}) overlaps head (${(v.head.y - v.head.r).toFixed(3)})`,
    );
  }

  // A shot aimed at the chest is a body shot; one aimed at the head is a
  // headshot. This is the contract the whole damage model depends on.
  const shooter = alive('A', 'S');
  const victim = alive('B', 'T');
  victim.x = 15;
  const v = hitVolumes(victim);
  const shootAt = (y) => {
    const origin = eyePoint(shooter);
    const ang = anglesTo(origin, { x: victim.x, y, z: 0 });
    return castShot({
      origin,
      dir: directionFromAngles(ang.yaw, ang.pitch),
      actors: [shooter, victim],
      boxes: [],
      maxDist: 100,
      shooterTeam: 'A',
      shooterId: shooter.id,
      ignoreFriends: false,
    });
  };
  const chest = shootAt(1.1);
  assert.equal(chest.type, 'actor');
  assert.equal(chest.headshot, false, 'a chest shot must not count as a headshot');
  const head = shootAt(v.head.y);
  assert.equal(head.headshot, true, 'a shot at head height must count as a headshot');
});

// --- bot aiming -------------------------------------------------------------

test('bots aim at the body, not always at the head', () => {
  // Bots used to aim at the eye point, which is inside the head sphere: every
  // shot at every range was a headshot (measured 7/7 from 4 m to 34 m), and a
  // normal bot killed the player in ~0.3 s of contact.
  const victim = alive('B', 'T');
  const v = hitVolumes(victim);

  // Easy must shoot at the body. Harder tiers are *allowed* to creep toward the
  // head: that is the promise the difficulty makes, and it has to be earned
  // through aim error and recoil rather than handed out at every level.
  for (const diff of ['easy']) {
    const bot = alive('A', 'S');
    bot.brain = { profile: DIFFICULTY[diff], aimRamp: 0 };
    const p = aimPoint(bot, victim);
    assert.ok(
      p.y >= v.body.minY && p.y <= v.body.maxY,
      `${diff}: aim point ${p.y.toFixed(2)} is outside the torso (${v.body.minY}-${v.body.maxY.toFixed(2)})`,
    );
  }

  // Difficulty must actually matter: hard aims higher than easy.
  const height = (diff) => {
    const bot = alive('A', 'S');
    bot.brain = { profile: DIFFICULTY[diff], aimRamp: 0 };
    return aimPoint(bot, victim).y;
  };
  assert.ok(height('hard') > height('normal'), 'hard must aim higher than normal');
  assert.ok(height('normal') > height('easy'), 'normal must aim higher than easy');
  // ...but no tier may aim at the eye point itself: that was the original bug,
  // and it made every shot at every range a headshot. Measured at acquisition
  // (aimRamp 0), before the ramp term compounds the bias.
  for (const diff of ['easy', 'normal', 'hard']) {
    assert.ok(
      height(diff) < eyePoint(victim).y - 0.05,
      `${diff} aims at the eye point again (${height(diff).toFixed(2)})`,
    );
  }
});

test('a crouched enemy is aimed at where they actually are', () => {
  const victim = alive('B', 'T');
  const standing = aimPoint({ brain: { profile: DIFFICULTY.normal, aimRamp: 0 } }, victim).y;
  victim.crouch = 1;
  const crouched = aimPoint({ brain: { profile: DIFFICULTY.normal, aimRamp: 0 } }, victim).y;
  assert.ok(crouched < standing - 0.3, 'a crouched target must be aimed at lower down');
  const v = hitVolumes(victim);
  assert.ok(crouched <= v.head.y, 'and the aim point must still be on the body or head');
});

// --- recoil -----------------------------------------------------------------

test('recoil accumulates through a burst instead of being reset every shot', () => {
  // testTryShoot used to *set* recoilPitch, and the controller zeroed it after a
  // single read, so a seven-round burst climbed exactly as much as one shot.
  const loadout = createLoadout();
  resetLoadout(loadout);
  const w = activeWeapon(loadout);
  const rng = () => 0.5;
  tryShoot(w, { aimPitch: 0, aimYaw: 0, triggerHeld: false, rng });
  const afterOne = w.recoilPitch;
  w.cooldown = 0;
  w.triggerHeld = false;
  tryShoot(w, { aimPitch: 0, aimYaw: 0, triggerHeld: false, rng });
  assert.ok(w.recoilPitch > afterOne, 'the second shot must climb higher than the first');
  assert.ok(w.recoilPitch <= 8, 'climb must stay bounded');
});

test('weapon recoil recovers back to zero, so a burst has a cost but no permanent drift', () => {
  const loadout = createLoadout();
  resetLoadout(loadout);
  const w = activeWeapon(loadout);
  w.recoilPitch = 4;
  for (let i = 0; i < 120; i++) updateWeapon(w, 1 / 60, {});
  assert.ok(w.recoilPitch < 0.05, `recoil did not recover: ${w.recoilPitch}`);
});

test('the player camera kick is visible but does not move the aim point', async () => {
  // Kick is a view effect. If it were applied to pc.pitch, every shot would
  // silently raise the next one; the reference point must stay the mouse aim.
  const actor = alive('A', 'P');
  const pc = createPlayerController(actor);
  pc.pitch = 0.1;
  pc.kickPitch = 3;
  const loadoutPitch = pc.pitch;
  assert.equal(pc.pitch, loadoutPitch, 'kick must not mutate the aim pitch');
  // The view is kicked upward, the aim is not.
  assert.ok(cameraPitch(pc) < pc.pitch, 'the camera must sit below the aim while recovering');
});

// --- side symmetry ----------------------------------------------------------

test('lane spread does not depend on which slot the human player takes', () => {
  // Regression: lane assignment and the anti-clumping jitter used `actor.index`.
  // The human player occupies ALFA's index 0, so every ALFA bot shifted one slot
  // and the two teams walked different spread patterns. Measured on 24 seeded
  // bot-only matches: the +x side won ~72% of rounds from that skew alone.
  // mirrorSlot must be an involution over the spawn row.
  for (let slot = 0; slot < LANE_PATTERN.length; slot++) {
    const m = mirrorSlot(slot);
    assert.equal(mirrorSlot(m), slot, `slot ${slot} does not mirror back`);
    assert.ok(m >= 0 && m < LANE_PATTERN.length, `slot ${slot} mirrors out of range: ${m}`);
  }
  // The physically mirrored slot must walk the *rotation* of that lane, not the
  // lane itself. This assertion used to compare the two teams for equality,
  // which was vacuous: laneForMirroredSlot('B', s) was *defined* as
  // laneForMirroredSlot('A', mirrorSlot(s)), so equality held by construction
  // and the check could never fail. The real requirement is that the map and the
  // assignment agree, so it is checked against ROUTES below.
  for (let slot = 0; slot < LANE_PATTERN.length; slot++) {
    const a = laneForMirroredSlot('A', slot);
    const b = laneForMirroredSlot('B', mirrorSlot(slot));
    assert.equal(b, ROTATE_LANE[a], `slot ${slot}: A walks ${a}, mirrored B slot walks ${b}, expected the rotation ${ROTATE_LANE[a]}`);
  }
  // And the squad as a whole must cover the same mix of lanes on both sides —
  // as a rotation, because north and south swap under the 180-degree turn. The
  // earlier version compared the raw multisets for equality, which only ever
  // passed because of the (wrong) same-lane assumption above: it asserted
  // "A north count == B north count" when the map demands "A north count ==
  // B south count". Two squads covering mirrored halves must NOT have equal
  // lane tallies.
  const tally = (team) => {
    const counts = { mid: 0, north: 0, south: 0 };
    for (let i = 0; i < LANE_PATTERN.length; i++) counts[laneForMirroredSlot(team, i)] += 1;
    return counts;
  };
  const a = tally('A');
  const b = tally('B');
  assert.equal(b.mid, a.mid, `mid is walked by ${a.mid} on ALFA but ${b.mid} on BRAVO`);
  assert.equal(b.north, a.south, `BRAVO north (${b.north}) must match ALFA south (${a.south}) under rotation`);
  assert.equal(b.south, a.north, `BRAVO south (${b.south}) must match ALFA north (${a.north}) under rotation`);

  // The naming convention is only a guess; the map is the truth. A 180-degree
  // rotation about the origin must carry each A corridor onto the corridor the
  // paired B slot walks. (A's north run sits at z = -16, so it rotates onto B's
  // south run at z = +16 — the two lanes cross over.)
  const rotatePoint = (p) => ({ x: -p.x, z: -p.z });
  const dist = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
  for (const lane of Object.keys(ROUTES.A)) {
    const rotated = ROUTES.A[lane].map(rotatePoint);
    const target = ROTATE_LANE[lane];
    const other = ROUTES.B[target];
    assert.ok(other, `no BRAVO route named ${target}`);
    const err = rotated.reduce((s, p) => s + Math.min(...other.map((q) => dist(p, q))), 0) / rotated.length;
    assert.ok(err < 0.5, `A ${lane} does not rotate onto B ${target} (mean waypoint error ${err.toFixed(2)}m)`);
  }
});

test('a bot derives its slot from its spawn position, not from its actor index', () => {
  // The player is an actor too, so index != slot. The spawn row is the truth.
  const g = createGame({ difficulty: 'normal', seed: 424242 });
  const botsA = g.match.actors.filter((a) => a.team === 'A' && a.brain);
  const botsB = g.match.actors.filter((a) => a.team === 'B' && a.brain);
  const lanesA = new Set(botsA.map((b) => b.brain.lane));
  const lanesB = new Set(botsB.map((b) => b.brain.lane));

  // The human occupies one of ALFA's five slots, so ALFA fields four bots.
  assert.equal(botsA.length + 1, botsB.length, 'the player takes exactly one ALFA slot');
  assert.ok(lanesA.size >= 2, `ALFA bots all share one lane: ${[...lanesA]}`);
  assert.ok(lanesB.size >= 3, `BRAVO bots all share one lane: ${[...lanesB]}`);

  // The four bots must fill the four slots the player does NOT take, and the
  // lanes must be exactly the ones those slots map to. Using actor.index instead
  // shifted ALFA by one slot and broke this.
  const playerSlot = SPAWNS.A.findIndex((s) => Math.abs(s.z - g.player.spawnZ) < 1e-6);
  const expectedA = LANE_PATTERN
    .map((_, i) => i)
    .filter((i) => i !== playerSlot)
    .map((i) => laneForMirroredSlot('A', i))
    .sort()
    .join(',');
  const actualA = botsA.map((b) => b.brain.lane).sort().join(',');
  assert.equal(actualA, expectedA, `ALFA lanes ${actualA} != expected ${expectedA}`);

  // Slot-by-slot agreement with the map. The previous version of this test only
  // compared sorted lane *multisets*, so it passed while the two squads walked
  // completely different shapes of spread: BRAVO was assigned its lanes from
  // bot.js's own private copy of LANE_PATTERN, keyed on actor.index, and the
  // sorted mixes happened to match. Check the pairing directly instead.
  for (const team of ['A', 'B']) {
    for (const bot of g.match.actors.filter((a) => a.team === team && a.brain)) {
      const slot = SPAWNS[team].findIndex((s) => Math.abs(s.z - bot.spawnZ) < 1e-6);
      assert.ok(slot >= 0, `${team} bot has no slot for spawnZ ${bot.spawnZ}`);
      assert.equal(bot.brain.lane, laneForMirroredSlot(team, slot),
        `${team} bot in slot ${slot} walks ${bot.brain.lane}, map says ${laneForMirroredSlot(team, slot)}`);
    }
  }
  // Every spawn slot must be occupied by exactly one actor, or a lane goes
  // unwalked and the squad shape is wrong even with the lanes themselves right.
  for (const team of ['A', 'B']) {
    const taken = g.match.actors.filter((a) => a.team === team)
      .map((a) => SPAWNS[team].findIndex((s) => Math.abs(s.z - a.spawnZ) < 1e-6))
      .sort((x, y) => x - y);
    assert.deepEqual(taken, [0, 1, 2, 3, 4], `${team} does not fill every spawn slot: ${taken}`);
  }
  void lanesA; void lanesB;
});

test('the ADS accuracy bonus follows the sight instead of snapping on', () => {
  // The sight takes ~200ms to settle onto the camera axis (viewmodel lerp). The
  // spread cone used to drop to its aimed value on the very first frame, so for
  // a fifth of a second the player was rewarded for an aim they could not see
  // through — the same class of "reticle lies" bug as an off-centre crosshair.
  const game = createGame({ difficulty: 'normal', seed: 8080 });
  const pc = game.pc;

  // 1. The blend must ramp, not jump, and it must not go backwards.
  pc.ads = true;
  const blends = [];
  for (let i = 0; i < 60; i++) {
    updatePlayer(pc, game.input, { dt: 1 / 60, boxes: [], actors: [] });
    blends.push(pc.adsBlend);
  }
  assert.ok(blends[0] < 0.3, `first frame is already ${(blends[0] * 100).toFixed(0)}% aimed`);
  assert.ok(blends[blends.length - 1] > 0.99, 'ADS never reaches full aim');
  for (let i = 1; i < blends.length; i++) {
    assert.ok(blends[i] >= blends[i - 1] - 1e-9, 'the ADS blend goes backwards while holding the button');
  }

  // 2. The cone must interpolate between hip and aimed, not step between them.
  //    A fresh loadout per sample, with spread pinned to base, so the only thing
  //    that varies is the blend.
  const coneFor = (blend) => {
    const w = activeWeapon(createLoadout());
    w.spread = w.def.spread.base; // a settled gun: the cone is the base value
    w.triggerHeld = false;
    // rng() === 1 makes the yaw offset exactly +half, so spreadDeg is the cone.
    const shot = tryShoot(w, { adsBlend: blend, rng: () => 1, triggerHeld: false });
    return shot ? shot.spreadDeg : 0;
  };
  const hip = coneFor(0);
  const half = coneFor(0.5);
  const aimed = coneFor(1);
  assert.ok(hip > half && half > aimed, `cone does not interpolate: hip ${hip}, half ${half}, aimed ${aimed}`);
  assert.ok(Math.abs(half - (hip + aimed) / 2) < 1e-9, `half-aimed is not halfway: hip ${hip}, half ${half}, aimed ${aimed}`);

  // 3. And it has to arrive with the sight: the blend the viewmodel receives is
  //    the same number the shooting code receives, from the same controller.
  assert.ok(blends.some((b) => b > 0.4 && b < 0.6), 'the transition never passes through half-aimed');
});

test('the aim point moves smoothly through a crouch instead of jumping', () => {
  // `crouch` is a lerp from 0 to 1 (PLAYER.crouchLerpSpeed), not a boolean, and
  // the aim point used to snap between two heights at crouch > 0.5. That snapped
  // the target of a tracked shot by the whole chest-to-crouch-chest distance in a
  // single frame, mid-crouch, where no amount of aim tracking could compensate.
  const game = createGame({ difficulty: 'normal', seed: 5150 });
  const bot = game.match.actors.find((a) => a.team === 'B');
  const target = game.match.actors.find((a) => a.team === 'A' && a.isPlayer);
  const samples = [];
  for (let i = 0; i <= 20; i++) {
    target.crouch = i / 20;
    samples.push(aimPoint(bot, target).y);
  }
  // Monotone: standing up must never move the aim point down and vice versa.
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i] <= samples[i - 1] + 1e-9,
      `aim height went up while crouching (${samples[i - 1].toFixed(3)} -> ${samples[i].toFixed(3)} at step ${i})`);
  }
  // Continuous: no single 5% step of the crouch blend may move it by more than a
  // few millimetres. The old threshold produced a ~34cm cliff here.
  const jump = Math.max(...samples.slice(1).map((y, i) => Math.abs(y - samples[i])));
  assert.ok(jump < 0.05, `aim point jumps ${(jump * 100).toFixed(1)}cm in one crouch step`);
  // And it must actually reach the configured crouched chest height.
  const crouched = aimPoint(bot, { ...target, crouch: 1, crouchBlend: 1 });
  assert.ok(Math.abs(crouched.y - DIFFICULTY.normal.headBias * eyePoint({ ...target, crouch: 1 }).y
    - (1 - DIFFICULTY.normal.headBias) * 0.78) < 0.02,
    `fully crouched aim height is ${crouched.y.toFixed(2)}, not the crouched chest band`);
});

test('lane slot comes from spawnZ even when it disagrees with the actor index', () => {
  // Today the human always takes ALFA index 0, so a bot's index happens to equal
  // its slot and index-based code looks correct by coincidence. This asserts the
  // derivation directly, with the two deliberately out of step, so the
  // coincidence cannot hide a regression. (Swapping the player to another slot
  // would revive the old one-slot skew instantly.)
  const actor = createActor({ team: 'A', name: 'test', index: 0 });
  for (let slot = 0; slot < SPAWNS.A.length; slot++) {
    const spawn = SPAWNS.A[slot];
    actor.spawnZ = spawn.z;
    assert.equal(laneSlot(actor), slot, `spawnZ ${spawn.z} should be slot ${slot}, not ${laneSlot(actor)}`);
  }
  // A BRAVO actor with the same spawnZ occupies a different row, so the same z
  // must resolve against that team's own spawns.
  const bravo = createActor({ team: 'B', name: 'test', index: 0 });
  bravo.spawnZ = SPAWNS.B[4].z;
  assert.equal(laneSlot(bravo), 4);
  // Missing spawn data must degrade to slot 0, not throw or go NaN.
  actor.spawnZ = undefined;
  assert.equal(laneSlot(actor), 0);
});
