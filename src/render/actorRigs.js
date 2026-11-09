// Low-poly actor rigs built from primitives, plus per-frame animation.
// Each rig is a small hierarchy so limbs can swing without per-frame allocation.

import * as THREE from 'three';
import { MATCH } from '../core/config.js';
import { renderYaw } from './math.js';

const SKIN = 0xc8b39a;
const GEAR = 0x2b3940;
const GUN = 0x1d2428;

export function createRig(actor) {
  const teamColor = MATCH.teamColors[actor.team];
  const root = new THREE.Group();

  const bodyMat = new THREE.MeshLambertMaterial({ color: GEAR });
  const accentMat = new THREE.MeshLambertMaterial({ color: teamColor });
  const skinMat = new THREE.MeshLambertMaterial({ color: SKIN });
  const gunMat = new THREE.MeshLambertMaterial({ color: GUN });

  // torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.62, 0.34), bodyMat);
  torso.position.y = 1.12;
  root.add(torso);

  const vest = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.3, 0.4), accentMat);
  vest.position.y = 1.2;
  root.add(vest);

  // head
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.155, 0), skinMat);
  head.position.y = 1.62;
  root.add(head);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.175, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.52), accentMat);
  helmet.position.y = 1.655;
  root.add(helmet);

  // arms
  const armGeo = new THREE.BoxGeometry(0.14, 0.52, 0.14);
  const armL = new THREE.Mesh(armGeo, bodyMat);
  armL.position.set(-0.33, 1.18, 0);
  const armR = new THREE.Mesh(armGeo, bodyMat);
  armR.position.set(0.33, 1.18, 0);
  root.add(armL, armR);

  // legs (pivot at hip so they can swing)
  const legGeo = new THREE.BoxGeometry(0.18, 0.78, 0.2);
  legGeo.translate(0, -0.39, 0);
  const legL = new THREE.Mesh(legGeo, bodyMat);
  legL.position.set(-0.15, 0.8, 0);
  const legR = new THREE.Mesh(legGeo, bodyMat);
  legR.position.set(0.15, 0.8, 0);
  root.add(legL, legR);

  // weapon in hands
  const weaponPivot = new THREE.Group();
  weaponPivot.position.set(0.22, 1.26, -0.22);
  const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.62), gunMat);
  gunBody.position.z = -0.18;
  weaponPivot.add(gunBody);
  const gunMag = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.1), gunMat);
  gunMag.position.set(0, -0.12, -0.12);
  weaponPivot.add(gunMag);
  const flash = new THREE.Mesh(
    new THREE.ConeGeometry(0.09, 0.28, 6),
    new THREE.MeshBasicMaterial({ color: 0xffd08a, transparent: true, opacity: 0.9 }),
  );
  flash.rotation.x = -Math.PI / 2;
  flash.position.z = -0.55;
  flash.visible = false;
  weaponPivot.add(flash);
  root.add(weaponPivot);

  root.userData = { legL, legR, armL, armR, weaponPivot, flash, head, torso, vest, helmet };
  return root;
}


// How long the topple takes, and how long the body then stays on the floor.
// 0.55 s is long enough to read as a fall at 60 fps and short enough that it
// never delays the next round; 4 s of corpse is enough to register as "he is
// dead over there" without cluttering the lane.
const DEATH_SECONDS = 0.55;
const DEATH_LINGER = 4.5;

/**
 * Update one rig from the actor's positional state.
 * `yaw` is the render yaw (bots use actor.yaw, player rig is hidden).
 */
export function updateRig(rig, actor, dt, time, isPlayer) {
  const u = rig.userData;
  rig.position.set(actor.x, 0, actor.z);
  rig.rotation.y = renderYaw(actor.yaw);

  // ── death ────────────────────────────────────────────────────────────────
  // A bot used to vanish the instant it died: `rig.visible = actor.alive`. That
  // is the single most noticeable thing missing from a kill — no confirmation
  // in the world, only a hitmarker and a number. Instead the body topples.
  if (!actor.alive) {
    if (u.deathAt === undefined || u.deathAt === null) {
      u.deathAt = time;
      // Tip to one side or the other, derived from the actor id so it is
      // stable across frames. Without this every corpse in the match falls
      // forward in the same pose, which reads as a bug rather than as death.
      u.deathRoll = ((actor.id * 2654435761) % 1000) / 1000 * 0.7 - 0.35;
    }
    const t = (time - u.deathAt) / DEATH_SECONDS;
    if (t >= 1) {
      // Settled. Keep the body on the floor for a while, then let it go so a
      // stack of corpses cannot accumulate across a long match.
      rig.visible = time - u.deathAt < DEATH_LINGER;
      rig.rotation.x = -Math.PI / 2;
      rig.rotation.z = u.deathRoll || 0;
      rig.position.y = 0.18;
      return;
    }
    rig.visible = true;
    // Ease-out: fast at first, slowing as it lands. A linear fall reads as a
    // lift being lowered rather than a body dropping.
    const k = 1 - (1 - t) * (1 - t);
    rig.rotation.x = -k * (Math.PI / 2);
    rig.rotation.z = (u.deathRoll || 0) * k;
    // Sink slightly as it falls, so the feet do not stay above the floor plane.
    rig.position.y = k * 0.18;
    // Limbs go slack.
    u.legL.rotation.x = k * 0.6;
    u.legR.rotation.x = -k * 0.3;
    u.armL.rotation.x = k * 1.1;
    u.armR.rotation.x = -k * 0.7;
    u.weaponPivot.rotation.x = k * 1.4;
    u.flash.visible = false;
    return;
  }
  // Alive again (new round): forget the death so the next one animates.
  u.deathAt = null;
  rig.rotation.x = 0;
  rig.rotation.z = 0;
  rig.position.y = 0;
  rig.visible = true;

  const swing = Math.sin(time * (6 + actor.speedFactor * 6)) * (0.15 + actor.speedFactor * 0.75);
  u.legL.rotation.x = swing;
  u.legR.rotation.x = -swing;
  u.armL.rotation.x = -swing * 0.4;
  u.armR.rotation.x = swing * 0.25;

  // Crouch: squash the whole rig (cheap but reads well at low poly).
  const crouchSquash = 1 - 0.22 * actor.crouch;
  rig.scale.set(1, crouchSquash, 1);
  u.weaponPivot.rotation.x = actor.pitch * 0.85;
  u.flash.visible = actor.muzzleTimer > 0;
  if (u.flash.visible) {
    u.flash.scale.setScalar(0.8 + Math.random() * 0.5);
    actor.muzzleTimer -= dt;
  }
  if (isPlayer) rig.visible = false;
}


export function disposeRig(rig) {
  rig.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material.dispose();
    }
  });
}
