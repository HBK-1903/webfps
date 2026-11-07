// Core <-> render angle conversion.
//
// Core convention (used by shooting, movement and AI):
//   forward(yaw, pitch) = ( sin(yaw)·cos(pitch), sin(pitch), -cos(yaw)·cos(pitch) )
//   yaw 0 looks toward -Z, yaw +90° looks toward +X.
//
// Three.js rotates about +Y as  R_y(θ)·(0,0,-1) = (-sin θ, 0, -cos θ),
// so the Y rotation that reproduces the core direction is **-yaw**.
// Getting this wrong mirrors aiming (crosshair vs. bullets) and turns bots
// around, so it lives in one tested place instead of being inlined per file.

import * as THREE from 'three';

/** Three.js Y rotation (radians) for a core yaw. */
export function renderYaw(yaw) {
  return -yaw;
}

/** Apply a core yaw/pitch pair to a Three.js camera (order YXZ). */
export function applyCameraAngles(camera, yaw, pitch) {
  camera.rotation.set(pitch, renderYaw(yaw), 0, 'YXZ');
}

const tmp = new THREE.Vector3();

/**
 * The direction a Three.js camera currently looks at, expressed in core
 * convention. Used by tests and debug tooling.
 */
export function cameraForwardCore(camera) {
  tmp.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const yaw = Math.atan2(tmp.x, -tmp.z);
  const pitch = Math.asin(Math.max(-1, Math.min(1, tmp.y)));
  return { yaw, pitch, dir: { x: tmp.x, y: tmp.y, z: tmp.z } };
}
