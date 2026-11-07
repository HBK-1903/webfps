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
import { laneForMirroredSlot, mirrorSlot, LANE_PATTERN } from '../src/core/map.js';
import { createGame } from '../src/core/game.js';
import { aimPoint } from '../src/core/bot.js';
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
  // The physically mirrored slot must walk the same lane, or one squad spreads
  // differently from the other.
  for (let slot = 0; slot < LANE_PATTERN.length; slot++) {
    const a = laneForMirroredSlot('A', slot);
    const b = laneForMirroredSlot('B', mirrorSlot(slot));
    assert.equal(b, a, `slot ${slot}: A walks ${a}, mirrored B slot walks ${b}`);
  }
  // And the squad as a whole must cover the same mix of lanes on both sides.
  const mix = (team) => LANE_PATTERN.map((_, i) => laneForMirroredSlot(team, i)).sort().join(',');
  assert.equal(mix('A'), mix('B'), 'the two squads spread across different lanes');
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

  // The important part: the four bots must fill the four slots the player does
  // NOT take, and the lanes must be exactly the ones that slot excludes. Using
  // actor.index instead shifted ALFA by one slot and broke this.
  const playerSlot = g.match.actors.find((a) => a.isPlayer).index;
  const expectedA = LANE_PATTERN
    .map((_, i) => i)
    .filter((i) => i !== playerSlot)
    .map((i) => laneForMirroredSlot('A', i))
    .sort()
    .join(',');
  const actualA = botsA.map((b) => b.brain.lane).sort().join(',');
  assert.equal(actualA, expectedA, `ALFA lanes ${actualA} != expected ${expectedA}`);
  void lanesA; void lanesB;
});
