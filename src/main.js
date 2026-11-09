// Application shell: owns the DOM flow (menu → difficulty → match → pause →
// match end), input, pointer lock and the render loop. All gameplay lives in
// src/core and is driven exclusively through updateGame().

import { GAME_TITLE, GAME_VERSION, WEAPONS, DIFFICULTY } from './core/config.js';
import {
  loadCareer,
  recordMatch,
  clearCareer,
  careerSummary,
  accuracyTrend,
  formatDuration,
} from './core/career.js';
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
  cycleSpectateTarget,
  possessTeammate,
  spectateCamera,
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
import { createAudio, soundPlacement } from './ui/audio.js';
import { loadSettings, saveSettings, sanitize } from './ui/settings.js';
import GUI from 'lil-gui';
import { WEAPONS as TUNING_WEAPONS, DIFFICULTY as TUNING_DIFFICULTY, PLAYER as TUNING_PLAYER, COMBAT as TUNING_COMBAT } from './core/config.js';
import { setDifficulty } from './core/game.js';
import { registerServiceWorker, createInstallControls } from './ui/pwa.js';


const $ = (id) => document.getElementById(id);

const screens = {
  menu: $('menu'),
  difficulty: $('difficulty-screen'),
  settings: $('settings-screen'),
  controls: $('controls-screen'),
  pause: $('pause-screen'),
  matchEnd: $('match-end-screen'),
  career: $('career-screen'),
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
  tuningGui: null,
  tuning: {
    difficulty: 'normal',
    playerHealth: 100,
    playerArmor: 50,
    headMultiplier: 2.5,
    armorAbsorb: 0.5,
    freezeTime: 3,
    easyAimError: 3.4,
    normalAimError: 1.9,
    hardAimError: 0.95,
    rifleDamage: 26,
    rifleRpm: 600,
    pistolDamage: 24,
    pistolRpm: 330,
  },
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

  // Installed-app support. On file:// this is a no-op, so the offline
  // single-file build keeps working exactly as before.
  setupInstallControls();
  registerServiceWorker();
  window.addEventListener('resize', onResize);
  onResize();

  showScreen('menu');
  requestAnimationFrame(loop);

  // Debug/test hook: lets the automated suite (and the browser console) inspect
  // the live app. It is read-only by convention and costs nothing at runtime.
  window.SIFIR_NOKTA = app;

  buildTuningPanel();

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
  // Settings are applied once at boot, before any game exists, so `applySettings`
  // skips every game-scoped option (`if (app.game)`). Without this line a saved
  // "screen shake off" was silently ignored and came back on at the first match.
  app.game.shake = app.settings.shake;
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
  // Playtime for the career record. Counted from the loop, not from wall-clock
  // start, so a match left paused on the pause screen does not inflate it.
  app.matchSeconds = 0;
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
  const g = app.game;
  const kd = g.player.kills / Math.max(1, g.player.deaths);
  // `matchStats`, not `stats`: the latter is reset at every round start, so
  // reading it here reported the accuracy of the final round as if it were the
  // accuracy of the whole match.
  const ms = g.matchStats || g.stats;
  const stats = {
    'Zorluk': DIFFICULTY[g.match.difficulty].label,
    'Elenme (öldürme)': String(g.player.kills),
    'Ölüm': String(g.player.deaths),
    'K/D': kd.toFixed(2),
    'İsabet': ms.shots ? `${Math.round((ms.hits / ms.shots) * 100)}%` : '—',
    'Kafa isabeti': String(ms.headshots),
    'Hasar': String(Math.round(ms.damageDealt)),
    'Toplam raund': String(snap.round),
  };
  const box = $('match-end-stats');
  box.innerHTML = '';
  for (const [k, v] of Object.entries(stats)) {
    const d = document.createElement('div');
    d.innerHTML = `<span>${k}</span><b>${v}</b>`;
    box.appendChild(d);
  }

  // Fold the result into the career exactly once. `matchEndShown` already
  // guarantees this function runs once per match, which matters: recording the
  // same match twice would double every counter and quietly corrupt the file.
  const roundsWon = g.player.team === 'A' ? snap.scores.A : snap.scores.B;
  app.lastCareer = recordMatch({
    difficulty: g.match.difficulty,
    win: won,
    draw: winner === 'draw',
    kills: g.player.kills,
    deaths: g.player.deaths,
    shots: ms.shots,
    hits: ms.hits,
    headshots: ms.headshots,
    damageDealt: ms.damageDealt,
    rounds: snap.round,
    roundsWon,
    scoreA: snap.scores.A,
    scoreB: snap.scores.B,
    durationSeconds: app.matchSeconds || 0,
  });

  const career = careerSummary(app.lastCareer);
  const line = $('match-end-career');
  if (career.matches > 1) {
    const prevAccuracy = career.accuracy;
    line.innerHTML =
      `Kariyer: <b>${career.matches}</b> maç · ` +
      `galibiyet <b>${Math.round(career.winRate * 100)}%</b> · ` +
      `K/D <b>${career.kd.toFixed(2)}</b> · ` +
      `isabet <b>${Math.round(prevAccuracy * 100)}%</b>`;
  } else {
    line.textContent = 'İlk maçın — kariyerin başladı.';
  }
  showScreen('matchEnd');
}

// ---------------------------------------------------------------- career
/**
 * Paint the career screen from persisted data.
 *
 * Everything here re-reads from storage rather than trusting an in-memory copy,
 * so the screen is correct after a reload, after clearing, and after a match
 * recorded in another tab.
 */
function renderCareerScreen() {
  const career = loadCareer();
  const s = careerSummary(career);

  $('career-sub').textContent = s.matches
    ? `${s.matches} maç · ${formatDuration(s.playtimeSeconds)} oynandı`
    : 'Henüz maç yok';

  // Highlights: the four numbers a player actually wants first.
  const highlights = $('career-highlights');
  highlights.innerHTML = '';
  const tiles = [
    ['GALİBİYET', s.matches ? `${Math.round(s.winRate * 100)}%` : '—'],
    ['K/D', s.deaths ? s.kd.toFixed(2) : s.kills ? String(s.kills) : '—'],
    ['İSABET', s.shots ? `${Math.round(s.accuracy * 100)}%` : '—'],
    ['KAFA İSABETİ', s.hits ? `${Math.round(s.headshotRate * 100)}%` : '—'],
  ];
  for (const [label, value] of tiles) {
    const d = document.createElement('div');
    d.className = 'career-highlight';
    d.innerHTML = `<b>${value}</b><span>${label}</span>`;
    highlights.appendChild(d);
  }

  const stats = {
    'Maç': String(career.matches),
    'Galibiyet / Mağlubiyet / Berabere': `${career.wins} / ${career.losses} / ${career.draws}`,
    'Toplam öldürme': String(career.kills),
    'Toplam ölüm': String(career.deaths),
    'Raund': `${career.roundsWon} / ${career.rounds}`,
    'Toplam hasar': String(Math.round(career.damageDealt)),
    'En iyi K/D': s.bestKd ? s.bestKd.toFixed(2) : '—',
    'En iyi isabet': s.bestAccuracy ? `${Math.round(s.bestAccuracy * 100)}%` : '—',
    'Oynanan süre': formatDuration(s.playtimeSeconds),
  };
  const statsBox = $('career-stats');
  statsBox.innerHTML = '';
  for (const [k, v] of Object.entries(stats)) {
    const d = document.createElement('div');
    d.innerHTML = `<span>${k}</span><b>${v}</b>`;
    statsBox.appendChild(d);
  }

  // Per difficulty. Empty buckets stay on screen, greyed: seeing "ZOR: 0 maç"
  // is the nudge that makes the difficulty setting feel like a ladder.
  const diffBox = $('career-difficulty');
  diffBox.innerHTML = '';
  for (const key of ['easy', 'normal', 'hard']) {
    const d = career.byDifficulty[key];
    const node = document.createElement('div');
    node.className = `career-diff${d.matches ? '' : ' empty'}`;
    const acc = d.shots ? `${Math.round((d.hits / d.shots) * 100)}%` : '—';
    const kd = d.deaths ? (d.kills / d.deaths).toFixed(2) : String(d.kills);
    const wr = d.matches ? `${Math.round((d.wins / d.matches) * 100)}%` : '—';
    node.innerHTML =
      `<b>${DIFFICULTY[key]?.label || key}</b>` +
      `<div class="diff-row"><span>maç</span><span>${d.matches}</span></div>` +
      `<div class="diff-row"><span>galibiyet</span><span>${wr}</span></div>` +
      `<div class="diff-row"><span>K/D</span><span>${kd}</span></div>` +
      `<div class="diff-row"><span>isabet</span><span>${acc}</span></div>`;
    diffBox.appendChild(node);
  }

  renderAccuracyTrend(accuracyTrend(career));

  // History, newest first.
  const hist = $('career-history');
  hist.innerHTML = '';
  if (!career.history.length) {
    const empty = document.createElement('div');
    empty.className = 'career-empty';
    empty.textContent = 'Henüz kayıtlı maç yok. Bir maç bitir, burada görünsün.';
    hist.appendChild(empty);
  } else {
    const head = document.createElement('div');
    head.className = 'career-row head';
    head.innerHTML = '<span>Tarih</span><span>Zorluk</span><span>Sonuç</span><span>K/D</span><span>İsabet</span>';
    hist.appendChild(head);
    for (const h of career.history) {
      const row = document.createElement('div');
      row.className = 'career-row';
      let when = '—';
      if (h.at) {
        const date = new Date(h.at);
        if (!Number.isNaN(date.getTime())) {
          when = date.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });
        }
      }
      const result = h.draw
        ? `<span class="drawn">Berabere ${h.scoreA}–${h.scoreB}</span>`
        : h.win
          ? `<span class="won">Galibiyet ${h.scoreA}–${h.scoreB}</span>`
          : `<span class="lost">Mağlubiyet ${h.scoreA}–${h.scoreB}</span>`;
      const acc = h.shots ? `${Math.round((h.hits / h.shots) * 100)}%` : '—';
      // Numbers are formatted defensively: history is stored data and a
      // hand-edited or half-written entry must render as a blank, not throw
      // inside a loop that is drawing the whole screen.
      const kdText = Number.isFinite(h.kd) ? h.kd.toFixed(2) : '—';
      row.innerHTML =
        `<span>${when}</span><span>${DIFFICULTY[h.difficulty]?.label || h.difficulty}</span>` +
        `<span>${result}</span><span>${kdText}</span><span>${acc}</span>`;
      hist.appendChild(row);
    }
  }

  $('career-clear').hidden = career.matches === 0;
}

/**
 * Accuracy sparkline.
 *
 * Drawn by hand rather than with a chart library: this file already ships one
 * canvas-free UI and adding a dependency for nine points would be absurd. The
 * y axis is pinned to 0–100% rather than auto-scaled, because an auto-scaled
 * axis makes a 3% wobble look like a collapse.
 */
function renderAccuracyTrend(points) {
  const canvas = $('career-trend-canvas');
  const text = $('career-trend-text');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 640;
  const h = 96;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Grid: 25 / 50 / 75 / 100.
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  for (const pct of [0.25, 0.5, 0.75, 1]) {
    const y = h - 10 - pct * (h - 26);
    ctx.beginPath();
    ctx.moveTo(8, y);
    ctx.lineTo(w - 8, y);
    ctx.stroke();
  }

  if (points.length === 0) {
    ctx.fillStyle = 'rgba(198,214,214,0.5)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('En az 20 atış yapılan maç yok', 12, h / 2);
    text.textContent = 'Trend için en az 20 atışlık bir maça ihtiyaç var.';
    return;
  }

  const x = (i) => (points.length === 1 ? w / 2 : 10 + (i / (points.length - 1)) * (w - 20));
  const y = (acc) => h - 10 - acc * (h - 26);

  // Area under the line, so a single point still reads as a value.
  ctx.beginPath();
  ctx.moveTo(x(0), h - 10);
  for (let i = 0; i < points.length; i++) ctx.lineTo(x(i), y(points[i].accuracy));
  ctx.lineTo(x(points.length - 1), h - 10);
  ctx.closePath();
  ctx.fillStyle = 'rgba(79, 209, 197, 0.12)';
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const px = x(i);
    const py = y(points[i].accuracy);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = 'rgb(79, 209, 197)';
  ctx.lineWidth = 2;
  ctx.stroke();

  for (let i = 0; i < points.length; i++) {
    ctx.beginPath();
    ctx.arc(x(i), y(points[i].accuracy), 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgb(79, 209, 197)';
    ctx.fill();
  }

  const first = points[0].accuracy;
  const last = points[points.length - 1].accuracy;
  const delta = Math.round((last - first) * 100);
  const arrow = delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : '±0';
  text.textContent =
    `${points.length} maç · son isabet ${Math.round(last * 100)}% ` +
    `(${arrow} puan) · en iyi ${Math.round(Math.max(...points.map((p) => p.accuracy)) * 100)}%`;
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
      case 'career':
        renderCareerScreen();
        // Returning from the career screen goes back where it was opened from,
        // which differs: the main menu before a match, the match summary after.
        app.settingsReturn = app.state === 'ended' ? 'matchEnd' : 'menu';
        showScreen('career');
        break;
      case 'career-clear':
        // Two-step rather than a confirm() dialog: the button relabels itself,
        // so a misclick is one more click away instead of a modal's OK button.
        if (app.careerClearArmed) {
          clearCareer();
          app.careerClearArmed = false;
          $('career-clear').textContent = 'KARİYERİ SIFIRLA';
          renderCareerScreen();
          showToast('Kariyer sıfırlandı', 1800);
        } else {
          app.careerClearArmed = true;
          $('career-clear').textContent = 'EMİN MİSİN? TEKRAR TIKLA';
          setTimeout(() => {
            if (!app.careerClearArmed) return;
            app.careerClearArmed = false;
            $('career-clear').textContent = 'KARİYERİ SIFIRLA';
          }, 4000);
        }
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
          app.matchSeconds = 0;
          resumeGame();
        }
        break;
      case 'rematch':
        startMatchFlow(app.settings.difficulty);
        break;
      case 'install':
        // The button has its own click handler; stop the nav handler from
        // firing a second prompt.
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

/** True while the player is dead and the round is still running. */
function isPlayerDead() {
  return Boolean(app.game && !app.game.player.alive);
}

/**
 * Take over the teammate currently being spectated.
 *
 * Refused — with a reason on screen — when there is nobody to take. A silent
 * no-op would read as the key being broken.
 */
function tryPossession() {
  const game = app.game;
  if (!game) return;
  const sp = game.spectate;
  const targetId = sp && sp.mode === 'follow' ? sp.targetId : null;
  if (!targetId) {
    showToast('Devralacak takım arkadaşı yok', 1600);
    return;
  }
  const target = game.match.actors.find((a) => a.id === targetId);
  const name = target ? target.name : 'Takım arkadaşı';
  const taken = possessTeammate(game, targetId);
  if (!taken) {
    showToast('Devralma başarısız', 1600);
    return;
  }
  // The rig for the new body has to stop being drawn: the player is first
  // person, and a rig left visible would put a model inside the camera.
  app.hud.show(true);
  showToast(`${name} devralındı`, 1800);
}

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
    if (e.code === 'F2') {
      e.preventDefault();
      toggleTuningPanel();
      return;
    }
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
    // ── dead? ────────────────────────────────────────────────────────────
    // While dead the movement keys steer the free spectator camera instead of
    // a body, so they must not be swallowed by the "add to keys" path above.
    if (isPlayerDead()) {
      switch (e.code) {
        case 'KeyQ':
          cycleSpectateTarget(app.game, -1);
          break;
        case 'KeyE':
          cycleSpectateTarget(app.game, 1);
          break;
        case 'KeyF':
          // Take control of whoever is on screen, CS2-style.
          tryPossession();
          break;
        default:
          break;
      }
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) {
        keys.add(e.code);
        updateMoveInput();
        return;
      }
    }

    switch (e.code) {
      case 'KeyR':
        playerReloadNow(app.game); // the sound comes back through drainSounds
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
  // Desktop build: the preload bridge can close the window for real.
  const desktop = window.SIFIR_NOKTA_DESKTOP;
  if (desktop && desktop.isDesktop) {
    desktop.quit();
    return;
  }
  if (typeof window.close === 'function') window.close();
  showToast('Tarayıcı penceresi kapatılamadı. Sekmeyi kapatabilirsin.', 3000);
}

// -------------------------------------------------------- install (PWA) ---
// The browser decides whether the game may be installed; src/ui/pwa.js owns
// that logic (and its tests). Here we only pass in the DOM and the toast.
function setupInstallControls() {
  app.installControls = createInstallControls({
    button: $('install-btn'),
    hint: $('install-hint'),
    notify: (message) => showToast(message, 2600),
  });
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
    // Only count time actually spent in a live match. Counting frames while
    // the match-end panel is open would inflate playtime by however long the
    // player leaves the results on screen.
    if (app.state === 'playing' && !app.game.paused) app.matchSeconds += dt;
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
        // Enemy fire: place it in the stereo field. Distance alone (what this
        // did before) made every off-screen shooter sound like it came from the
        // same direction, so you could not tell a flank from a corridor ahead.
        if (s.x !== undefined) {
          const place = soundPlacement(game.player, { x: s.x, z: s.z }, game.pc.yaw);
          const d = place.distance;
          if (d > 6) {
            app.audio.play('tail', { distance: d, pan: place.pan });
          } else {
            app.audio.play(s.weapon === 'pistol' ? 'shot_pistol' : 'shot_rifle', { distance: d, pan: place.pan });
          }
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
      case 'reload_start':
        app.audio.play('reload_start');
        break;
      case 'reload_mag_out':
        app.audio.play('reload_mag_out');
        break;
      case 'reload_mag_in':
        app.audio.play('reload_mag_in');
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

  // Footsteps while the player is actually moving on the ground. Three
  // flavours: crouch-walking is nearly silent, sprinting is loud and metallic.
  // The threshold used to be a single `speedFactor > 0.35`, which made
  // crouching inaudible *and* identical to walking — so the gait carried no
  // information at all.
  if (game.player.alive && snap.phase === 'live' && game.player.speedFactor > 0.12) {
    const sprinting = game.pc.sprint;
    const crouching = game.player.crouch > 0.5;
    // Stride rate follows speed; a crouch walk is slower as well as quieter.
    app.stepAccum += dt * (0.6 + game.player.speedFactor) * (crouching ? 0.6 : 1);
    if (app.stepAccum > 0.42) {
      app.stepAccum = 0;
      if (crouching) app.audio.play('step_crouch');
      else if (sprinting) app.audio.play('step_sprint');
      else app.audio.play('step_walk');
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
  //
  // The bob is a *cosmetic* offset applied after the aim direction is fixed, so
  // it must not move the crosshair relative to the world. It is tiny (1.8 cm)
  // and at 20 m that is still ~0.05 deg, so the reticle stays honest; the
  // recoil kick is the larger one and is deliberately visible.
  // While dead the camera comes from the spectator system: either following a
  // teammate in third person, replaying the killcam, or flying free. Falling
  // back to the player's own eye would park the camera inside a corpse.
  const spec = !game.player.alive ? spectateCamera(game) : null;
  if (spec) {
    camera.position.set(spec.x, spec.y, spec.z);
    applyCameraAngles(camera, spec.yaw, spec.pitch);
  } else {
    const bob = Math.sin(game.pc.bobPhase) * 0.018 * game.player.speedFactor;
    camera.position.set(eye.x, eye.y + bob, eye.z);
    const kick = (game.pc.kickPitch * Math.PI) / 180;
    applyCameraAngles(camera, game.pc.yaw, game.pc.pitch - kick);
  }

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
    // `actor.isPlayer` — not `actor.isPlayer at rig creation` — because
    // possession moves that flag onto a different body mid-match. The rig of
    // whoever the player is currently driving must be hidden, and the rig of
    // the body they left behind must come back.
    updateRig(rig, actor, dt, performance.now() / 1000, actor.isPlayer);
    // Show a muzzle flash frame when a bot fires.
    if (actor.brain && actor.brain.shots > (actor._lastShots || 0)) {
      actor._lastShots = actor.brain.shots;
      actor.muzzleTimer = 0.05;
    }
  }

  // Viewmodel pose (only in-game states).
  // A gun still floating in view while you are dead and watching someone else
  // is the most obvious tell that the camera changed without the player model
  // knowing.
  app.viewmodel.root.visible =
    game.player.alive && (app.state === 'playing' || app.state === 'paused' || app.state === 'ended');
  setViewModelWeapon(app.viewmodel, game.player.loadout.current);
  applyPose(app.viewmodel, {
    speedFactor: game.player.speedFactor,
    // The core's blend, not a 0/1 flag: the sight and the spread cone must
    // animate on the same curve or the reticle lies during the transition.
    adsBlend: game.pc.adsBlend,
    dt,
    sprinting: game.pc.sprint,
  });

  syncFx(app.fx, game.fx);
  app.scene.renderer.render(app.scene.scene, camera);
}

/**
 * Live balance tuning panel (lil-gui, MIT). Values write straight into the same
 * central config objects the game reads, so a designer can feel a change
 * instantly; "Kalıcı yap" (persist) writes the JSON to the console/download so it
 * can be pasted back into src/core/config.js.
 */
function buildTuningPanel() {
  const gui = new GUI({ title: 'DENGE AYARLARI (F2)', width: 300 });
  gui.domElement.classList.add('tuning-gui');
  gui.hide();
  app.tuningOpen = false;

  const t = app.tuning;
  const m = app.game ? app.game.match : null;
  const cfg = gui.addFolder('Can / Zırh');
  cfg
    .add(t, 'playerHealth', 50, 200, 5)
    .name('oyuncu canı')
    .onChange((v) => {
      TUNING_PLAYER.maxHealth = v;
      if (app.game) app.game.player.health = Math.min(app.game.player.health, v);
    });
  cfg
    .add(t, 'playerArmor', 0, 150, 5)
    .name('oyuncu zırhı')
    .onChange((v) => {
      TUNING_PLAYER.maxArmor = v;
    });
  cfg.add(t, 'headMultiplier', 1, 5, 0.1).name('kafa çarpanı').onChange((v) => {
    TUNING_COMBAT.headMultiplier = v;
  });
  cfg.add(t, 'armorAbsorb', 0, 0.9, 0.05).name('zırh absorbsiyonu').onChange((v) => {
    TUNING_COMBAT.armorAbsorb = v;
  });

  const ai = gui.addFolder('Bot zorluğu (nişan hatası, derece)');
  ai.add(t, 'easyAimError', 0.2, 8, 0.1).name('kolay hata').onChange((v) => {
    TUNING_DIFFICULTY.easy.aimError = v;
  });
  ai.add(t, 'normalAimError', 0.2, 8, 0.1).name('normal hata').onChange((v) => {
    TUNING_DIFFICULTY.normal.aimError = v;
  });
  ai.add(t, 'hardAimError', 0.2, 8, 0.1).name('zor hata').onChange((v) => {
    TUNING_DIFFICULTY.hard.aimError = v;
  });
  ai
    .add(t, 'difficulty', ['easy', 'normal', 'hard'])
    .name('maç zorluğu')
    .onChange((v) => {
      if (app.game) {
        setDifficulty(app.game, v);
        app.settings.difficulty = v;
        saveSettings(app.settings);
        syncSettingsUI(app.settings);
        app.hud.update(hudState(app.game), 0);
      }
    });

  const wp = gui.addFolder('Silahlar');
  wp.add(t, 'rifleDamage', 5, 80, 1).name('tüfek hasarı').onChange((v) => {
    TUNING_WEAPONS.rifle.damage = v;
  });
  wp.add(t, 'rifleRpm', 120, 1200, 10).name('tüfek atış hızı').onChange((v) => {
    TUNING_WEAPONS.rifle.rpm = v;
  });
  wp.add(t, 'pistolDamage', 5, 80, 1).name('tabanca hasarı').onChange((v) => {
    TUNING_WEAPONS.pistol.damage = v;
  });
  wp.add(t, 'pistolRpm', 120, 1200, 10).name('tabanca atış hızı').onChange((v) => {
    TUNING_WEAPONS.pistol.rpm = v;
  });

  const actions = {
    kalıcıYap() {
      const payload = {
        PLAYER: { maxHealth: TUNING_PLAYER.maxHealth, maxArmor: TUNING_PLAYER.maxArmor },
        COMBAT: { headMultiplier: TUNING_COMBAT.headMultiplier, armorAbsorb: TUNING_COMBAT.armorAbsorb },
        AIM_ERROR: {
          easy: TUNING_DIFFICULTY.easy.aimError,
          normal: TUNING_DIFFICULTY.normal.aimError,
          hard: TUNING_DIFFICULTY.hard.aimError,
        },
        WEAPONS: {
          rifle: { damage: TUNING_WEAPONS.rifle.damage, rpm: TUNING_WEAPONS.rifle.rpm },
          pistol: { damage: TUNING_WEAPONS.pistol.damage, rpm: TUNING_WEAPONS.pistol.rpm },
        },
      };
      console.info('[SIFIR NOKTA] denge ayarları (src/core/config.js içine taşı):', payload);
      showToast('Ayarlar konsola yazıldı — config.js içine kopyalayabilirsin', 3200);
    },
    sıfırla() {
      for (const k of Object.keys(TUNING_WEAPONS)) TUNING_WEAPONS[k].damage = k === 'rifle' ? 26 : 24;
      TUNING_WEAPONS.rifle.rpm = 600;
      TUNING_WEAPONS.pistol.rpm = 330;
      TUNING_PLAYER.maxHealth = 100;
      TUNING_PLAYER.maxArmor = 50;
      TUNING_COMBAT.headMultiplier = 2.5;
      TUNING_COMBAT.armorAbsorb = 0.5;
      TUNING_DIFFICULTY.easy.aimError = 3.4;
      TUNING_DIFFICULTY.normal.aimError = 1.9;
      TUNING_DIFFICULTY.hard.aimError = 0.95;
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      showToast('Denge ayarları varsayılana döndü');
    },
  };
  gui.add(actions, 'kalıcıYap').name('Değerleri konsola yaz');
  gui.add(actions, 'sıfırla').name('Varsayılana dön');

  app.tuningGui = gui;
  // Keep panel values in sync with the config at first open.
  void m;
}

function toggleTuningPanel() {
  if (!app.tuningGui) return;
  app.tuningOpen = !app.tuningOpen;
  if (app.tuningOpen) app.tuningGui.show();
  else app.tuningGui.hide();
  if (app.tuningOpen) {
    // Reflect the difficulty actually in use when opening the panel.
    app.tuning.difficulty = app.game ? app.game.match.difficulty : app.settings.difficulty;
    app.tuningGui.controllersRecursive().forEach((c) => c.updateDisplay());
  }
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
        `(${String(p.x).padStart(6)},${String(p.z).padStart(6)}) k/d ${p.kills}/${p.deaths} ` +
        `${p.cover ? 'SİPER ' : ''}${p.crouch ? 'ÇÖMELİK ' : ''}${p.support ? 'DESTEK ' : ''}` +
        `${p.goal ? `→${p.goal[0]},${p.goal[1]}` : ''}`,
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

// Exposed for the automated visual/feel tests (tools/visual.mjs): a headless
// page has no way to reach a module-scoped `app` otherwise, and dispatching real
// DOM events at a game it cannot inspect is not a measurement. Read-only by
// convention; nothing in the game reads this back.
globalThis.__SIFIR_NOKTA__ = app;

export { app };
