// Transient combat FX: tracers, impact sparks and a small pool of decals.
// One instanced line mesh + one instanced quad mesh keeps draw calls flat.

import * as THREE from 'three';

const MAX_TRACERS = 48;
const MAX_IMPACTS = 36;
const MAX_MARKS = 96;
const MAX_SPARKS = 192;

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

  // Bullet marks: small dark quads laid flat on the surface that was hit.
  // They last long enough to read as "this wall has been shot", which is the
  // whole point — an impact flash alone leaves no trace that anything happened.
  // Marks come in two layers. A single dark dot was invisible: the walls are
  // already dark blue-grey, so `0x14181c` on `#16222b` disappeared completely —
  // measured on screen, not guessed. The light dust ring is what actually reads
  // as damage; the dark core on top of it gives the hole its depth.
  const dustGeo = new THREE.PlaneGeometry(0.15, 0.15);
  const dustMat = new THREE.MeshBasicMaterial({
    color: 0xa8b4b8,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const dust = new THREE.InstancedMesh(dustGeo, dustMat, MAX_MARKS);
  dust.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  dust.frustumCulled = false;
  dust.count = 0;

  const markGeo = new THREE.PlaneGeometry(0.055, 0.055);
  const markMat = new THREE.MeshBasicMaterial({
    color: 0x0a0d10,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
    // Without this a mark on a wall next to a box z-fights at grazing angles.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const marks = new THREE.InstancedMesh(markGeo, markMat, MAX_MARKS);
  marks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  marks.frustumCulled = false;
  marks.count = 0;

  // Sparks: tiny stretched boxes, the cheapest thing that reads as debris at
  // arm's length. Deliberately additive so a burst reads as light, not paint.
  const sparkGeo = new THREE.BoxGeometry(0.022, 0.022, 0.022);
  const sparkMat = new THREE.MeshBasicMaterial({
    color: 0xffd08a,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sparks = new THREE.InstancedMesh(sparkGeo, sparkMat, MAX_SPARKS);
  sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sparks.frustumCulled = false;
  sparks.count = 0;

  const group = new THREE.Group();
  group.add(tracers, impacts, dust, marks, sparks);

  return { group, tracers, impacts, dust, marks, sparks, camera };
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
  const { tracers: tMesh, impacts: iMesh, dust: dMesh, marks: mMesh, sparks: sMesh, camera } = fx;
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

  // Marks: a flat quad on the surface, oriented by the face normal that was
  // recorded at hit time. Without that normal there is no way to lay the quad
  // down — a camera-facing billboard would float off the wall and look wrong
  // from every angle except the one you happened to be standing at.
  let k = 0;
  for (const mk of fxState.marks || []) {
    if (k >= MAX_MARKS) break;
    posVec.set(mk.x, mk.y, mk.z);
    nVec.set(mk.nx, mk.ny, mk.nz).normalize();
    q.setFromUnitVectors(_planeNormal, nVec);
    // Stable per-mark roll so a burst of hits on one wall does not produce a
    // row of identical squares.
    q.multiply(markRoll(mk));
    // Slight size variation, derived from position so it does not jitter.
    const size = 0.8 + Math.abs((mk.x * 7.3 + mk.z * 3.1) % 0.5);
    scaleVec.set(size, size, size);
    m4.compose(posVec, q, scaleVec);
    mMesh.setMatrixAt(k, m4);
    dMesh.setMatrixAt(k, m4);
    k += 1;
  }
  mMesh.count = k;
  dMesh.count = k;
  mMesh.instanceMatrix.needsUpdate = true;
  dMesh.instanceMatrix.needsUpdate = true;

  // Sparks. Brightness falls with age; the material is additive so fading the
  // whole material is not possible per instance without a shader, and a single
  // shared opacity would fade every spark at the same rate regardless of when
  // it was born. Instead the scale shrinks, which reads as a spark going out.
  let sp = 0;
  for (const sk of fxState.sparks || []) {
    if (sp >= MAX_SPARKS) break;
    const life = sk.life || 0.4;
    const t = Math.min(1, Math.max(0, sk.age / life));
    const grow = (1 - t) * 1.1 + 0.25;
    posVec.set(sk.x, sk.y, sk.z);
    scaleVec.set(grow, grow, grow);
    m4.compose(posVec, _identityQuat, scaleVec);
    sMesh.setMatrixAt(sp, m4);
    sp += 1;
  }
  sMesh.count = sp;
  sMesh.instanceMatrix.needsUpdate = true;
}

const nVec = new THREE.Vector3();
const _planeNormal = new THREE.Vector3(0, 0, 1);
const _identityQuat = new THREE.Quaternion();
const _markQuats = new Map();

/**
 * A stable per-mark roll.
 *
 * Derived from the mark's position rather than Math.random so a mark does not
 * spin when the frame is redrawn — the quaternion is rebuilt every frame from
 * these inputs.
 */
function markRoll(mk) {
  const key = `${mk.x.toFixed(3)},${mk.y.toFixed(3)},${mk.z.toFixed(3)}`;
  let qq = _markQuats.get(key);
  if (!qq) {
    const angle = ((mk.x * 12.9898 + mk.y * 78.233 + mk.z * 37.719) % 1) * Math.PI * 2;
    qq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle);
    _markQuats.set(key, qq);
    // Bounded: a long session should not accumulate a growing cache of
    // quaternions for marks that have long since been recycled.
    if (_markQuats.size > 512) _markQuats.clear();
  }
  return qq;
}

