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


/**
 * Update one rig from the actor's positional state.
 * `yaw` is the render yaw (bots use actor.yaw, player rig is hidden).
 */
export function updateRig(rig, actor, dt, time, isPlayer) {
  const u = rig.userData;
  rig.visible = actor.alive;
  rig.position.set(actor.x, 0, actor.z);
  rig.rotation.y = renderYaw(actor.yaw);

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
