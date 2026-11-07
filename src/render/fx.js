// Transient combat FX: tracers, impact sparks and a small pool of decals.
// One instanced line mesh + one instanced quad mesh keeps draw calls flat.

import * as THREE from 'three';

const MAX_TRACERS = 48;
const MAX_IMPACTS = 36;

export function createFx(camera) {
  // Tracers as thin stretched boxes (billboarded around their axis by
  // orienting toward the camera is overkill; a thin cylinder reads fine).
  const tracerGeo = new THREE.CylinderGeometry(0.014, 0.014, 1, 4, 1, true);
  tracerGeo.translate(0, 0.5, 0);
  tracerGeo.rotateX(Math.PI / 2);
  const tracerMat = new THREE.MeshBasicMaterial({
    color: 0xffd9a0,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const tracers = new THREE.InstancedMesh(tracerGeo, tracerMat, MAX_TRACERS);
  tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  tracers.frustumCulled = false;
  tracers.count = 0;

  const impactGeo = new THREE.PlaneGeometry(0.16, 0.16);
  const impactMat = new THREE.MeshBasicMaterial({
    color: 0xffe0b0,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const impacts = new THREE.InstancedMesh(impactGeo, impactMat, MAX_IMPACTS);
  impacts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  impacts.frustumCulled = false;
  impacts.count = 0;

  const group = new THREE.Group();
  group.add(tracers, impacts);

  return { group, tracers, impacts, camera };
}

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const up = new THREE.Vector3(0, 1, 0);
const dirVec = new THREE.Vector3();
const posVec = new THREE.Vector3();
const scaleVec = new THREE.Vector3(1, 1, 1);
const flipQuat = new THREE.Quaternion().setFromAxisAngle(up, Math.PI);
const dirN = new THREE.Vector3();

export function syncFx(fx, fxState) {
  const { tracers: tMesh, impacts: iMesh, camera } = fx;
  // camera is used to billboard impact sprites

  let n = 0;
  for (const t of fxState.tracers) {
    if (n >= MAX_TRACERS) break;
    const alpha = 1 - t.age / t.life;
    dirVec.set(t.x2 - t.x1, t.y2 - t.y1, t.z2 - t.z1);
    const len = dirVec.length();
    if (len < 0.02) continue;
    posVec.set(t.x1, t.y1, t.z1);
    dirN.copy(dirVec).normalize();
    q.setFromUnitVectors(up, dirN);
    // Cylinder is rotated to +Z; align -Z axis of geometry with the direction.
    q.multiply(flipQuat);
    scaleVec.set(alpha * 0.7 + 0.3, alpha * 0.7 + 0.3, len);
    m4.compose(posVec, q, scaleVec);
    tMesh.setMatrixAt(n, m4);
    n++;
  }
  tMesh.count = n;
  tMesh.instanceMatrix.needsUpdate = true;
  tMesh.material.opacity = 0.85;

  let m = 0;
  for (const im of fxState.impacts) {
    if (m >= MAX_IMPACTS) break;
    const a = 1 - im.age / im.life;
    posVec.set(im.x, im.y, im.z);
    q.copy(camera.quaternion);
    const s = 0.5 + (1 - a) * 1.2;
    scaleVec.set(s, s, s);
    m4.compose(posVec, q, scaleVec);
    iMesh.setMatrixAt(m, m4);
    m++;
  }
  iMesh.count = m;
  iMesh.instanceMatrix.needsUpdate = true;
  iMesh.material.opacity = 0.85;
}

export function disposeFx(fx) {
  fx.tracers.geometry.dispose();
  fx.tracers.material.dispose();
  fx.impacts.geometry.dispose();
  fx.impacts.material.dispose();
}
