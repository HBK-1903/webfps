// Application shell: owns the DOM flow (menu → difficulty → match → pause →
// match end), input, pointer lock and the render loop. All gameplay lives in
// src/core and is driven exclusively through updateGame().

import { GAME_TITLE, GAME_VERSION, WEAPONS, DIFFICULTY } from './core/config.js';
import {
  createGame,
  updateGame,
  hudState,
  setPaused,
  restartMatch,
  addLookInput,
  setInput,
  playerReloadNow,
  playerSwitchTo,
  playerToggleAds,
  drainSounds,
  gameSnapshot,
} from './core/game.js';
import { eyePoint } from './core/actor.js';
import { createScene, resizeScene, applyQuality } from './render/scene.js';
import { createRig, updateRig, disposeRig } from './render/actorRigs.js';
import {
  createViewModel,
  setViewModelWeapon,
  triggerMuzzleFlash,
  applyPose,
  addSway,
  setReloadVisual,
} from './render/viewmodel.js';
import { createFx, syncFx } from './render/fx.js';
import { applyCameraAngles } from './render/math.js';
import { createHud } from './ui/hud.js';
import { createAudio } from './ui/audio.js';
import { loadSettings, saveSettings, sanitize } from './ui/settings.js';

const $ = (id) => document.getElementById(id);

const screens = {
  menu: $('menu'),
  difficulty: $('difficulty-screen'),
  settings: $('settings-screen'),
  controls: $('controls-screen'),
  pause: $('pause-screen'),
  matchEnd: $('match-end-screen'),
};

const app = {
  settings: loadSettings(),
  game: null,
  hud: createHud(),
  audio: createAudio(),
  scene: null,
  viewmodel: null,
  fx: null,
  rigs: new Map(),
  state: 'menu', // menu | playing | paused | ended
  debug: false,
  debugEl: null,
  debugTimer: 0,
  settingsReturn: 'menu',
  lockHintTimer: 0,
  lastShots: 0,
  stepAccum: 0,
  matchEndShown: false,
  wantsLock: false,
};

// ---------------------------------------------------------------- boot ---
function boot() {
  const canvas = $('view');
  app.scene = createScene(canvas, app.settings.quality);
  app.viewmodel = createViewModel(app.scene.camera);
  app.fx = createFx(app.scene.camera);
  app.scene.scene.add(app.fx.group);

  applySettings(app.settings, { persist: false });
  syncSettingsUI(app.settings);
  $('build-tag').textContent = `${GAME_TITLE} v${GAME_VERSION}`;

  bindUI();
  bindInput(canvas);
  window.addEventListener('resize', onResize);
  onResize();

  showScreen('menu');
  requestAnimationFrame(loop);

  // Debug/test hook: lets the automated suite (and the browser console) inspect
  // the live app. It is read-only by convention and costs nothing at runtime.
  window.SIFIR_NOKTA = app;

  // F3 debug overlay (bot states, lanes, timings) — useful for tuning and QA.
  const dbg = document.createElement('pre');
  dbg.id = 'debug-overlay';
  dbg.className = 'debug-overlay hidden';
  document.getElementById('app').appendChild(dbg);
  app.debugEl = dbg;
}

function onResize() {
  resizeScene(app.scene, window.innerWidth, window.innerHeight);
}

// ---------------------------------------------------------------- flow ---
function showScreen(name) {
  for (const [key, node] of Object.entries(screens)) {
    node.classList.toggle('hidden', key !== name);
  }
  const inGame = name === null;
  app.hud.show(inGame);
  if (!inGame) {
    app.hud.el.lockHint = null;
    $('lock-hint').classList.add('hidden');
  }
}

function hideAllScreens() {
  for (const node of Object.values(screens)) node.classList.add('hidden');
}

function startMatchFlow(difficulty) {
  app.audio.resume();
  app.settings.difficulty = difficulty;
  saveSettings(app.settings);

  disposeGame();
  app.game = createGame({ difficulty, seed: (Math.random() * 1e9) | 0 });
  app.rigs.clear();
  for (const actor of app.game.match.actors) {
    if (actor.isPlayer) continue;
    const rig = createRig(actor);
    app.scene.dynamic.add(rig);
    app.rigs.set(actor.id, rig);
  }
  app.lastShots = 0;
  app.matchEndShown = false;
  app.matchEndTimer = 0;
  app.state = 'playing';
  hideAllScreens();
  app.hud.show(true);
  app.hud.resetTeamLists();
  // Paint the HUD immediately with the fresh round state (no 1-frame stale HUD).
  app.hud.update(hudState(app.game), 0);
  showToast(`Zorluk: ${DIFFICULTY[difficulty].label} · İlk 3 raundu alan kazanır`, 2600);
  lockPointer();
}

function disposeGame() {
  if (!app.game) return;
  for (const rig of app.rigs.values()) {
    app.scene.dynamic.remove(rig);
    disposeRig(rig);
  }
  app.rigs.clear();
  app.game = null;
}

function goToMenu() {
  exitPointerLock();
  setPaused(app.game || { paused: false }, true);
  disposeGame();
  app.state = 'menu';
  showScreen('menu');
}

function pauseGame() {
  if (app.state !== 'playing' || !app.game) return;
  setPaused(app.game, true);
  app.state = 'paused';
  exitPointerLock();
  showScreen('pause');
}

function resumeGame() {
  if (!app.game) return;
  setPaused(app.game, false);
  app.state = 'playing';
  hideAllScreens();
  app.hud.show(true);
  lockPointer();
}

function showMatchEnd() {
  if (app.matchEndShown || !app.game) return;
  app.matchEndShown = true;
  app.state = 'ended';
  exitPointerLock();
  const snap = hudState(app.game);
  const winner = snap.matchWinner;
  const pTeam = snap.playerTeam;
  const won = winner === pTeam;
  $('match-end-title').textContent = winner === 'draw' ? 'MAÇ BERABERE' : won ? 'MAÇI KAZANDIN' : 'MAÇI KAYBETTİN';
  $('match-end-title').style.color = won ? 'var(--accent)' : 'var(--danger)';
  $('match-end-score').textContent = `${snap.teamNames.A} ${snap.scores.A} — ${snap.scores.B} ${snap.teamNames.B}`;
  const kd = app.game.player.kills / Math.max(1, app.game.player.deaths);
  const stats = {
    'Zorluk': DIFFICULTY[app.game.match.difficulty].label,
    'Elenme (öldürme)': String(app.game.player.kills),
    'Ölüm': String(app.game.player.deaths),
    'K/D': kd.toFixed(2),
    'İsabet': app.game.stats.shots ? `${Math.round((app.game.stats.hits / app.game.stats.shots) * 100)}%` : '—',
    'Kafa isabeti': String(app.game.stats.headshots),
    'Toplam raund': String(snap.round),
  };
  const box = $('match-end-stats');
  box.innerHTML = '';
  for (const [k, v] of Object.entries(stats)) {
    const d = document.createElement('div');
    d.innerHTML = `<span>${k}</span><b>${v}</b>`;
    box.appendChild(d);
  }
  showScreen('matchEnd');
}

// ---------------------------------------------------------------- settings
function syncSettingsUI(s) {
  $('sense').value = String(s.sensitivity);
  $('sense-value').textContent = s.sensitivity.toFixed(2);
  $('volume').value = String(s.volume);
  $('volume-value').textContent = `${Math.round(s.volume * 100)}%`;
  $('fov').value = String(s.fov);
  $('fov-value').textContent = String(Math.round(s.fov));
  $('quality').value = s.quality;
  $('shake').checked = s.shake;
  $('shake-value').textContent = s.shake ? 'AÇIK' : 'KAPALI';
  for (const card of document.querySelectorAll('.diff-card')) {
    card.classList.toggle('selected', card.dataset.difficulty === s.difficulty);
  }
}

function readSettingsUI() {
  return sanitize({
    sensitivity: Number($('sense').value),
    volume: Number($('volume').value),
    fov: Number($('fov').value),
    quality: $('quality').value,
    shake: $('shake').checked,
    difficulty: document.querySelector('.diff-card.selected')?.dataset.difficulty || app.settings.difficulty,
  });
}

function applySettings(s, { persist = true } = {}) {
  app.settings = s;
  app.audio.setVolume(s.volume);
  applyQuality(app.scene, s.quality);
  if (app.game) app.game.shake = s.shake;
  if (persist) saveSettings(s);
  syncSettingsUI(s);
}

// ---------------------------------------------------------------- input ---
function bindUI() {
  document.body.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button, [data-action], [data-difficulty]');
    if (!btn) return;
    app.audio.play('ui');

    if (btn.dataset.difficulty) {
      for (const card of document.querySelectorAll('.diff-card')) card.classList.remove('selected');
      btn.classList.add('selected');
      app.settings.difficulty = btn.dataset.difficulty;
      saveSettings(app.settings);
      return;
    }

    switch (btn.dataset.action) {
      case 'play':
        showScreen('difficulty');
        break;
      case 'settings':
        app.settingsReturn = 'menu';
        syncSettingsUI(app.settings);
        showScreen('settings');
        break;
      case 'controls':
        showScreen('controls');
        break;
      case 'back':
        showScreen(app.settingsReturn || 'menu');
        break;
      case 'apply-settings':
        applySettings(readSettingsUI());
        showToast('Ayarlar kaydedildi');
        showScreen(app.settingsReturn || 'menu');
        break;
      case 'menu':
        goToMenu();
        break;
      case 'start-match':
        startMatchFlow(app.settings.difficulty);
        break;
      case 'resume':
        resumeGame();
        break;
      case 'pause-settings':
        app.settingsReturn = 'pause';
        syncSettingsUI(app.settings);
        hideAllScreens();
        showScreen('settings');
        break;
      case 'restart':
        if (app.game) {
          restartMatch(app.game, app.settings.difficulty);
          resetRigsForNewMatch();
          app.matchEndShown = false;
          app.matchEndTimer = 0;
          app.lastShots = 0;
          resumeGame();
        }
        break;
      case 'rematch':
        startMatchFlow(app.settings.difficulty);
        break;
      case 'quit':
        quitGame();
        break;
      default:
        break;
    }
  });

  // Live preview of sliders.
  $('sense').addEventListener('input', (e) => {
    $('sense-value').textContent = Number(e.target.value).toFixed(2);
  });
  $('volume').addEventListener('input', (e) => {
    $('volume-value').textContent = `${Math.round(Number(e.target.value) * 100)}%`;
    app.audio.setVolume(Number(e.target.value));
  });
  $('fov').addEventListener('input', (e) => {
    $('fov-value').textContent = String(Math.round(Number(e.target.value)));
  });
  $('shake').addEventListener('change', (e) => {
    $('shake-value').textContent = e.target.checked ? 'AÇIK' : 'KAPALI';
  });
}

function resetRigsForNewMatch() {
  for (const [id, rig] of app.rigs) {
    const actor = app.game.match.actors.find((a) => a.id === id);
    if (!actor) {
      app.scene.dynamic.remove(rig);
      disposeRig(rig);
      app.rigs.delete(id);
    }
  }
  for (const actor of app.game.match.actors) {
    if (actor.isPlayer) continue;
    if (!app.rigs.has(actor.id)) {
      const rig = createRig(actor);
      app.scene.dynamic.add(rig);
      app.rigs.set(actor.id, rig);
    }
  }
}

const keys = new Set();

function bindInput(canvas) {
  const updateMoveInput = () => {
    if (!app.game) return;
    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const right = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    setInput(app.game, {
      forward,
      right,
      sprint: keys.has('ShiftLeft') || keys.has('ShiftRight'),
      crouch: keys.has('ControlLeft') || keys.has('ControlRight'),
    });
  };

  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      e.preventDefault();
      app.debug = !app.debug;
      app.debugEl.classList.toggle('hidden', !app.debug);
      // Never let bots be invisible to the player without telling them.
      if (app.debug) showToast('Hata ayıklama katmanı açık (bilgi amaçlı)', 2000);
      return;
    }
    if (e.code === 'Escape') {
      if (app.state === 'playing') pauseGame();
      else if (app.state === 'paused') resumeGame();
      return;
    }
    if (app.state !== 'playing' || !app.game) return;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight'].includes(e.code)) {
      keys.add(e.code);
      updateMoveInput();
      if (e.code === 'ControlLeft' || e.code === 'ControlRight') e.preventDefault();
      return;
    }
    if (e.repeat) return;
    switch (e.code) {
      case 'KeyR':
        if (playerReloadNow(app.game)) app.audio.play('reload_start');
        break;
      case 'Digit1':
        if (playerSwitchTo(app.game, 'pistol')) app.audio.play('switch');
        break;
      case 'Digit2':
        if (playerSwitchTo(app.game, 'rifle')) app.audio.play('switch');
        break;
      default:
        break;
    }
  });

  window.addEventListener('keyup', (e) => {
    keys.delete(e.code);
    updateMoveInput();
  });

  window.addEventListener('blur', () => {
    keys.clear();
    updateMoveInput();
    if (app.game) setInput(app.game, { fire: false, forward: 0, right: 0 });
    if (app.state === 'playing') pauseGame();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && app.state === 'playing') pauseGame();
  });

  canvas.addEventListener('mousedown', (e) => {
    if (app.state === 'paused') {
      // Clicking the frozen frame resumes.
      if (e.button === 0) resumeGame();
      return;
    }
    if (app.state !== 'playing' || !app.game) return;
    if (!isPointerLocked()) {
      lockPointer();
      return;
    }
    if (e.button === 0) {
      setInput(app.game, { fire: true });
      app.audio.resume();
    } else if (e.button === 2) {
      playerToggleAds(app.game, true);
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (!app.game) return;
    if (e.button === 0) setInput(app.game, { fire: false });
    else if (e.button === 2) playerToggleAds(app.game, false);
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('mousemove', (e) => {
    if (app.state !== 'playing' || !app.game) return;
    if (!isPointerLocked()) return;
    addLookInput(app.game, e.movementX || 0, e.movementY || 0, app.settings.sensitivity);
    addSway(app.viewmodel, e.movementX || 0, e.movementY || 0);
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      if (app.state !== 'playing' || !app.game) return;
      e.preventDefault();
      const next = app.game.player.loadout.current === 'rifle' ? 'pistol' : 'rifle';
      if (playerSwitchTo(app.game, next)) app.audio.play('switch');
    },
    { passive: false },
  );

  document.addEventListener('pointerlockchange', () => {
    if (!isPointerLocked() && app.state === 'playing') {
      // Esc / Alt-Tab released the lock: pause so nothing runs unattended.
      pauseGame();
    }
  });

  // Clicking anywhere while playing but unlocked re-acquires the lock.
  document.addEventListener('click', () => {
    if (app.state === 'playing' && !isPointerLocked()) lockPointer();
  });
}

function lockPointer() {
  const canvas = $('view');
  app.audio.resume();
  if (canvas.requestPointerLock) {
    const p = canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        try {
          canvas.requestPointerLock();
        } catch {
          /* ignore */
        }
      });
    }
  }
  $('lock-hint').classList.add('hidden');
}

function exitPointerLock() {
  if (isPointerLocked() && document.exitPointerLock) document.exitPointerLock();
}

function isPointerLocked() {
  return document.pointerLockElement === $('view');
}

function quitGame() {
  if (typeof window.close === 'function') window.close();
  showToast('Tarayıcı penceresi kapatılamadı. Sekmeyi kapatabilirsin.', 3000);
}

let toastTimer = 0;
function showToast(text, ms = 1800) {
  const node = $('toast');
  node.textContent = text;
  node.classList.remove('hidden');
  toastTimer = ms / 1000;
}

// ---------------------------------------------------------------- loop ---
let lastTime = performance.now();
let fpsAccum = 0;
let fpsFrames = 0;

function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  fpsAccum += dt;
  fpsFrames += 1;
  if (fpsAccum >= 0.5) {
    app.hud.setFps(fpsFrames / fpsAccum);
    fpsAccum = 0;
    fpsFrames = 0;
  }

  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) $('toast').classList.add('hidden');
  }

  if (app.game) {
    updateGame(app.game, dt);
    afterGameUpdate(dt);
    renderGame(dt);
  } else {
    renderMenuScene(dt);
  }

  requestAnimationFrame(loop);
}

function afterGameUpdate(dt) {
  const game = app.game;
  const snap = hudState(game);
  app.hud.update(snap, dt);

  // Audio cues raised by the core.
  for (const s of drainSounds(game)) {
    switch (s.type) {
      case 'shot': {
        const fromElswhere = s.x !== undefined;
        if (fromElswhere) {
          const d = Math.hypot(game.player.x - s.x, game.player.z - s.z);
          if (d > 6) app.audio.play('tail', { distance: d });
          else app.audio.play(s.weapon === 'pistol' ? 'shot_pistol' : 'shot_rifle', { distance: d });
        }
        break;
      }
      case 'hit':
        app.audio.play('hit');
        break;
      case 'headshot':
        app.audio.play('headshot');
        break;
      case 'empty':
        app.audio.play('empty');
        break;
      case 'reload_done':
        app.audio.play('reload_end');
        break;
      case 'death':
        app.audio.play('death');
        break;
      case 'go':
        app.audio.play('go');
        break;
      case 'round_win':
      case 'round_loss':
      case 'match_win':
      case 'match_loss':
        app.audio.play(s.type);
        break;
      default:
        break;
    }
  }

  // Player gunfire feedback (viewmodel + audio) derived from shot count.
  if (game.stats.shots > app.lastShots) {
    app.lastShots = game.stats.shots;
    triggerMuzzleFlash(app.viewmodel);
    app.audio.play(game.player.loadout.current === 'pistol' ? 'shot_pistol' : 'shot_rifle');
    if (game.fx.hitmarkerKill) app.audio.play('kill');
  }
  setReloadVisual(app.viewmodel, snap.reloadProgress);

  if (app.debug) {
    app.debugTimer = (app.debugTimer || 0) - dt;
    if (!(app.debugTimer > 0)) {
      app.debugTimer = 0.2;
      app.debugEl.textContent = formatDebug(gameSnapshot(game));
    }
  }

  // Footsteps while the player is actually moving on the ground.
  if (game.player.alive && snap.phase === 'live' && game.player.speedFactor > 0.35) {
    app.stepAccum += dt * (0.6 + game.player.speedFactor);
    if (app.stepAccum > 0.42) {
      app.stepAccum = 0;
      app.audio.play('step');
    }
  }

  if (snap.phase === 'match_end' && !app.matchEndShown) {
    // Small delay so the final kill reads on screen before the panel appears.
    app.matchEndTimer = (app.matchEndTimer || 0) + dt;
    if (app.matchEndTimer > 1.3) showMatchEnd();
  }
}

function renderGame(dt) {
  const game = app.game;
  const { camera, sun } = app.scene;
  const eye = eyePoint(game.player);

  // Camera: yaw/pitch from the controller plus a gentle bob and a small kick.
  const bob = Math.sin(game.pc.bobPhase) * 0.018 * game.player.speedFactor;
  camera.position.set(eye.x, eye.y + bob, eye.z);
  const kick = (game.pc.kickPitch * Math.PI) / 180;
  applyCameraAngles(camera, game.pc.yaw, game.pc.pitch - kick);

  // FOV blend between hip and ADS.
  const w = WEAPONS[game.player.loadout.current];
  const baseFov = app.settings.fov;
  const targetFov = game.pc.ads ? w.adsFov : baseFov;
  camera.fov += (targetFov - camera.fov) * Math.min(1, 12 * dt);
  camera.updateProjectionMatrix();

  // Keep the shadow frustum centred on the player so shadows stay crisp.
  sun.position.set(game.player.x + 26, 42, game.player.z + 18);
  sun.target.position.set(game.player.x, 0, game.player.z);
  sun.target.updateMatrixWorld();

  // Actor rigs.
  for (const actor of game.match.actors) {
    if (actor.isPlayer) continue;
    const rig = app.rigs.get(actor.id);
    if (!rig) continue;
    if (actor.muzzleTimer === undefined) actor.muzzleTimer = 0;
    updateRig(rig, actor, dt, performance.now() / 1000, false);
    // Show a muzzle flash frame when a bot fires.
    if (actor.brain && actor.brain.shots > (actor._lastShots || 0)) {
      actor._lastShots = actor.brain.shots;
      actor.muzzleTimer = 0.05;
    }
  }

  // Viewmodel pose (only in-game states).
  app.viewmodel.root.visible = app.state === 'playing' || app.state === 'paused' || app.state === 'ended';
  setViewModelWeapon(app.viewmodel, game.player.loadout.current);
  applyPose(app.viewmodel, {
    speedFactor: game.player.speedFactor,
    adsBlend: game.pc.ads ? 1 : 0,
    dt,
    sprinting: game.pc.sprint,
  });

  syncFx(app.fx, game.fx);
  app.scene.renderer.render(app.scene.scene, camera);
}

function formatDebug(s) {
  const bars = '─'.repeat(46);
  const lines = [
    `SIFIR NOKTA · debug (F3)`,
    bars,
    `tur ${s.phase}  raund ${s.round}  skor ${s.score.A}:${s.score.B}  zorluk ${s.difficulty}`,
    `süre ${s.elapsed}s  raund ${s.roundElapsed}s  canlı ${s.alive.A}-${s.alive.B}  ${s.paused ? 'DURAKLATILDI' : ''}`,
    `oyuncu hp ${s.player.health} zırh ${s.player.armor} ${s.player.weapon} ${s.player.mag}/${s.player.reserve} ` +
      `(${s.player.x}, ${s.player.z}) k/d ${s.player.kills}/${s.player.deaths}`,
    `fx: tracer ${s.fx.tracers} impact ${s.fx.impacts}  isabet ${s.stats.hits}/${s.stats.shots}`,
    bars,
  ];
  for (const p of s.players) {
    if (p.isPlayer) continue;
    lines.push(
      `${p.team} ${p.name.padEnd(8)} ${p.alive ? `${String(p.health).padStart(3)}hp` : '  ölü'} ` +
        `${(p.state || '').padEnd(11)} ${(p.lane || '-').padEnd(5)} ` +
        `(${String(p.x).padStart(6)},${String(p.z).padStart(6)}) k/d ${p.kills}/${p.deaths}`,
    );
  }
  return lines.join('\n');
}

let menuAngle = 0;
function renderMenuScene(dt) {
  menuAngle += dt * 0.06;
  const { camera, renderer, scene } = app.scene;
  camera.position.set(Math.cos(menuAngle) * 24, 12.5, Math.sin(menuAngle) * 24);
  camera.lookAt(0, 1.4, 0);
  camera.fov = 62;
  camera.updateProjectionMatrix();
  app.viewmodel.root.visible = false;
  renderer.render(scene, camera);
}


// ---------------------------------------------------------------- start ---
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export { app };
