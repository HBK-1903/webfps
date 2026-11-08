// First-person viewmodel: a simple low-poly gun held in the camera, with sway,
// bob, recoil kick and ADS blending. Purely cosmetic.

import * as THREE from 'three';
import { PLAYER } from '../core/config.js';

// Viewmodel albedos. The gun was 0x232c31 — 35/255 at best — and because the
// model is parented to the camera it sits outside the room's light pools, so in
// practice it rendered as a solid black silhouette holding up a black rifle.
// A weapon you cannot see is a weapon you cannot read the state of, so the body
// is now a lit gunmetal and the accent is lighter still: the two are what tell
// pistol from rifle at a glance.
const MAT = () => new THREE.MeshLambertMaterial({ color: 0x39424a });
const MAT_ACCENT = () => new THREE.MeshLambertMaterial({ color: 0x55636d });

function buildPistol() {
  const g = new THREE.Group();
  const slide = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.062, 0.3), MAT());
  slide.position.set(0, 0, -0.09);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.07), MAT_ACCENT());
  grip.position.set(0, -0.1, 0.03);
  grip.rotation.x = -0.22;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.08, 6), MAT_ACCENT());
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.005, -0.24);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.02), MAT_ACCENT());
  sight.position.set(0, 0.038, -0.2);
  const flash = muzzleFlash();
  flash.position.set(0, 0.005, -0.3);
  g.add(slide, grip, barrel, sight, flash);
  return { group: g, flash };
}

function buildRifle() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.46), MAT());
  body.position.set(0, 0, -0.16);
  const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 0.26), MAT_ACCENT());
  handguard.position.set(0, 0.004, -0.5);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.18, 6), MAT_ACCENT());
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.006, -0.68);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.16, 0.075), MAT_ACCENT());
  mag.position.set(0, -0.11, -0.16);
  mag.rotation.x = 0.14;
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.12, 0.06), MAT());
  grip.position.set(0, -0.09, 0.02);
  grip.rotation.x = -0.3;
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.18), MAT());
  stock.position.set(0, -0.006, 0.14);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.016, 0.22), MAT_ACCENT());
  rail.position.set(0, 0.055, -0.18);
  const sightRear = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.02), MAT_ACCENT());
  sightRear.position.set(0, 0.075, -0.06);
  const sightFront = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.03, 0.012), MAT_ACCENT());
  sightFront.position.set(0, 0.075, -0.56);
  const flash = muzzleFlash();
  flash.position.set(0, 0.006, -0.78);
  g.add(body, handguard, barrel, mag, grip, stock, rail, sightRear, sightFront, flash);
  return { group: g, flash };
}

function muzzleFlash() {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.055, 6, 4),
    new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.95 }),
  );
  m.visible = false;
  return m;
}

// Hip and ADS anchors, blended per frame (module scope: applyPose needs them).
const HIP = new THREE.Vector3(0.19, -0.19, -0.42);

/**
 * How high the sights sit above the gun's origin, per weapon. Measured from the
 * geometry below (rifle sights and pistol slide top both sit at +0.075).
 *
 * This number is the whole point of ADS: the sight must end up exactly on the
 * camera axis, or the reticle promises a shot the bullets will not take.
 * It used to be a hand-tuned -0.115, which left the sights 4-6 cm *below* the
 * centre of the screen - about 1.2 m of miss at 30 m.
 */
// Pistol: the single sight blade on the slide top (0.038), not the rifle's rail.
const SIGHT_HEIGHT = { rifle: 0.075, pistol: 0.038 };

/** ADS position that puts the iron sights dead centre for a given weapon. */
function adsPosition(id) {
  const y = -(SIGHT_HEIGHT[id] ?? 0.075);
  return new THREE.Vector3(0, y, -0.3);
}

export function createViewModel(camera) {
  const root = new THREE.Group();
  camera.add(root);

  const pistol = buildPistol();
  const rifle = buildRifle();
  root.add(pistol.group, rifle.group);

  const flashLight = new THREE.PointLight(0xffcf8a, 0, 6, 2);
  flashLight.position.set(0.1, -0.05, -0.7);
  camera.add(flashLight);

  // A dedicated viewmodel key light, parented to the camera so it travels with
  // the gun and never depends on where the player is standing. Without it the
  // weapon is lit only by whatever happens to spill onto it, which is usually
  // nothing — it is centimetres from the near plane and below every wall lamp.
  // Short range (4 m) so it cannot leak into the room and change the scene.
  // Intensity is in candela and the gun is ~0.3 m away, so illuminance scales
  // as 1/d^2 and a small number goes a long way: 5.5 blew the receiver out to
  // near-white chrome. These are tuned against a measured frame, not by eye.
  const gunKey = new THREE.PointLight(0xf2f6ff, 0.55, 4, 2);
  gunKey.position.set(0.28, 0.18, 0.22);
  camera.add(gunKey);
  // A dim warm fill from the opposite side stops the far face of the receiver
  // from going fully black, which is what made the shape unreadable.
  const gunFill = new THREE.PointLight(0xffd8b0, 0.14, 4, 2);
  gunFill.position.set(-0.35, -0.12, 0.1);
  camera.add(gunFill);

  const state = {
    root,
    camera,
    pistol,
    rifle,
    flashLight,
    current: 'rifle',
    flashTimer: 0,
    kick: 0,
    kickRot: 0,
    sway: new THREE.Vector2(),
    bob: 0,
    adsBlend: 0,
    reloadSpin: 0,
  };
  setViewModelWeapon(state, 'rifle');
  applyPose(state, { speedFactor: 0, adsBlend: 0, dt: 0 });
  return state;
}

export function setViewModelWeapon(state, id) {
  state.current = id;
  state.pistol.group.visible = id === 'pistol';
  state.rifle.group.visible = id === 'rifle';
}

export function triggerMuzzleFlash(state) {
  const w = state.current === 'rifle' ? state.rifle : state.pistol;
  state.flashTimer = 0.045;
  w.flash.visible = true;
  w.flash.rotation.z = Math.random() * Math.PI;
  w.flash.scale.setScalar(0.75 + Math.random() * 0.6);
  state.flashLight.intensity = 2.4;
  state.kick = 1;
  state.kickRot = 1;
}

export function addSway(state, dx, dy) {
  state.sway.x += dx * 0.00035;
  state.sway.y += dy * 0.00035;
  state.sway.x = Math.max(-0.05, Math.min(0.05, state.sway.x));
  state.sway.y = Math.max(-0.05, Math.min(0.05, state.sway.y));
}

export function setReloadVisual(state, progress) {
  state.reloadProgress = progress;
}

/** @param {object} actor player actor @param {object} p pose info */
export function applyPose(state, { speedFactor, adsBlend, dt, sprinting }) {
  // Since the core now hands us its own 0..1 blend, this is a smoothing pass
  // over an already-smoothed value (it converges slightly slower than the core,
  // which keeps the sight from ever leading the cone). The literal 14 used to be
  // an independent rate that had nothing to do with the shooting code.
  state.adsBlend += (adsBlend - state.adsBlend) * Math.min(1, PLAYER.adsLerpSpeed * dt);
  const w = state.current === 'rifle' ? state.rifle : state.pistol;
  const hip = HIP.clone();
  const ads = adsPosition(state.current);
  if (state.current === 'pistol') {
    hip.set(0.16, -0.17, -0.4);
    ads.z = -0.34;
  }
  const target = hip.clone().lerp(ads, state.adsBlend);
  // Sprint lowers the weapon so it doesn't block the view.
  if (sprinting && state.adsBlend < 0.3) {
    target.y -= 0.06;
    target.x += 0.03;
    target.z += 0.04;
  }
  // Bob + sway.
  state.bob += dt * (5 + speedFactor * 7);
  const bobAmt = (1 - state.adsBlend * 0.8) * speedFactor;
  target.x += Math.sin(state.bob) * 0.012 * bobAmt;
  target.y += Math.abs(Math.cos(state.bob)) * 0.012 * bobAmt;
  target.x += state.sway.x * (1 - state.adsBlend * 0.7);
  target.y += state.sway.y * (1 - state.adsBlend * 0.7);
  // Recoil kick decays.
  state.kick = Math.max(0, state.kick - dt * 9);
  target.z += state.kick * 0.05 * (1 - state.adsBlend * 0.5);
  target.y += state.kick * 0.012;

  state.root.position.copy(target);
  const rotZ = state.sway.x * 1.6;
  const rotX = (state.sway.y * 1.2) - state.kick * 0.09;
  state.root.rotation.set(rotX, 0, rotZ);

  // Reload: rotate the gun down and back.
  if (state.reloadProgress !== undefined && state.reloadProgress > 0 && state.reloadProgress < 1) {
    const t = Math.sin(state.reloadProgress * Math.PI);
    state.root.position.y -= t * 0.14;
    state.root.rotation.z += t * 0.5;
    state.root.rotation.x -= t * 0.35;
  }

  if (state.flashTimer > 0) {
    state.flashTimer -= dt;
    if (state.flashTimer <= 0) {
      w.flash.visible = false;
      state.flashLight.intensity = 0;
    }
  }
  state.flashLight.intensity = Math.max(0, state.flashLight.intensity - dt * 55);
}
