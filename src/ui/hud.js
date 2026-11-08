// HUD binding. Reads a plain state object and writes only what changed, so the
// DOM is untouched on frames where nothing moved.

import { MATCH } from '../core/config.js';
import { MAP_BOXES } from '../core/map.js';
import {
  toUnit,
  bearing,
  cardinal,
  locationLabel,
  buildMarkers,
} from '../core/tacticalmap.js';

const $ = (id) => document.getElementById(id);

export function createHud() {
  const el = {
    hud: $('hud'),
    scoreA: $('score-a'),
    scoreB: $('score-b'),
    roundLabel: $('round-label'),
    pipsA: $('pips-a'),
    pipsB: $('pips-b'),
    roundTimer: $('round-timer'),
    roundStatus: $('round-status'),
    teamAList: $('team-a-list'),
    teamBList: $('team-b-list'),
    banner: $('banner'),
    killfeed: $('killfeed'),
    healthValue: $('health-value'),
    armorValue: $('armor-value'),
    healthBar: $('health-bar'),
    armorBar: $('armor-bar'),
    healthVital: document.querySelector('.vital.health'),
    crosshair: $('crosshair'),
    hitmarker: $('hitmarker'),
    reloadRing: $('reload-ring'),
    reloadFg: $('rr-fg'),
    weaponName: $('weapon-name'),
    ammoMag: $('ammo-mag'),
    ammoReserve: $('ammo-reserve'),
    slots: Array.from(document.querySelectorAll('.slot')),
    damageVignette: $('damage-vignette'),
    damageDir: $('damage-dir'),
    deathOverlay: $('death-overlay'),
    deathSub: $('death-sub'),
    fps: $('fps'),
    diffTag: $('difficulty-tag'),
    minimap: $('minimap'),
    minimapLane: $('minimap-lane'),
    compassStrip: $('compass-strip'),
    compassText: $('compass-text'),
  };

  const pips = { A: [], B: [] };
  for (let i = 0; i < MATCH.roundsToWin; i++) {
    const a = document.createElement('i');
    const b = document.createElement('i');
    el.pipsA.appendChild(a);
    el.pipsB.appendChild(b);
    pips.A.push(a);
    pips.B.push(b);
  }

  const cache = new Map();
  const setText = (node, value) => {
    if (!node) return;
    if (cache.get(node) === value) return;
    cache.set(node, value);
    node.textContent = value;
  };
  const setStyle = (node, prop, value) => {
    if (!node) return;
    const key = node.id + prop;
    if (cache.get(key) === value) return;
    cache.set(key, value);
    node.style[prop] = value;
  };
  const toggleClass = (node, cls, on) => {
    if (!node) return;
    const key = node.id + cls;
    if (cache.get(key) === on) return;
    cache.set(key, on);
    node.classList.toggle(cls, on);
  };

  // ── tactical map ──────────────────────────────────────────────────────
  // The box list never changes, so it is projected to unit space once instead
  // of per frame. Only the markers move.
  const mapCtx = el.minimap ? el.minimap.getContext('2d') : null;
  const CANVAS_W = el.minimap ? el.minimap.width : 0;
  const CANVAS_H = el.minimap ? el.minimap.height : 0;
  const mapBoxes = MAP_BOXES.map((b) => {
    // Footprint only: a top-down map of a single-storey arena does not need
    // height, and drawing every tall box at its full height would turn the
    // map into a solid block.
    const a = toUnit(b.x - b.w / 2, b.z - b.d / 2);
    const c = toUnit(b.x + b.w / 2, b.z + b.d / 2);
    return { x: a.u * CANVAS_W, y: a.v * CANVAS_H, w: (c.u - a.u) * CANVAS_W, h: (c.v - a.v) * CANVAS_H, kind: b.kind };
  });
  let lastCompassDeg = -1;
  let lastCompassText = '';

  function drawMinimap(p) {
    if (!mapCtx || !CANVAS_W) return;
    const ctx = mapCtx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Deck
    ctx.fillStyle = 'rgba(22, 34, 41, 0.92)';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Lane bands, matching the floor strips in the world: warm north, brass
    // mid, cool south. Same colours as render/scene.js LANE_STRIPS so the map
    // and the floor agree; a map that disagrees with the world is worse than
    // no map.
    const lanes = [
      { z: -13.5, color: 'rgba(138, 106, 66, 0.30)' },
      { z: 0, color: 'rgba(111, 122, 82, 0.26)' },
      { z: 13.5, color: 'rgba(63, 106, 125, 0.30)' },
    ];
    for (const lane of lanes) {
      const top = toUnit(0, lane.z - 2.1).v * CANVAS_H;
      const bot = toUnit(0, lane.z + 2.1).v * CANVAS_H;
      ctx.fillStyle = lane.color;
      ctx.fillRect(0, top, CANVAS_W, bot - top);
    }

    // Geometry. Walls read as solid, cover and crates as lighter, so the shape
    // of a corridor is legible at 168 px wide.
    for (const b of mapBoxes) {
      if (b.kind === 'boundary') continue; // the map edge is the map edge
      ctx.fillStyle = b.kind === 'crate' ? 'rgba(150, 128, 96, 0.75)' : 'rgba(150, 178, 190, 0.42)';
      ctx.fillRect(b.x, b.y, Math.max(1, b.w), Math.max(1, b.h));
    }

    // Spawn pads, so which end is whose is obvious.
    const padA = toUnit(-26, -10);
    const padA2 = toUnit(-26 + 5.5, 10);
    ctx.fillStyle = 'rgba(74, 163, 224, 0.16)';
    ctx.fillRect(padA.u * CANVAS_W, 0, (padA2.u - padA.u) * CANVAS_W, CANVAS_H);
    const padB = toUnit(26 - 5.5, -10);
    const padB2 = toUnit(26, 10);
    ctx.fillStyle = 'rgba(224, 138, 74, 0.16)';
    ctx.fillRect(padB.u * CANVAS_W, 0, (padB2.u - padB.u) * CANVAS_W, CANVAS_H);

    // Markers. Contacts are drawn with an age-based fade: a fresh report is
    // bright, a five-second-old one is a ghost. That difference is the whole
    // point — it tells you how much to trust the dot.
    const markers = buildMarkers({
      player: p.playerPos ? { id: 'me', x: p.playerPos.x, z: p.playerPos.z } : null,
      teamMates: p.teamMates,
      contacts: p.contacts,
      now: p.now,
    });
    for (const m of markers) {
      const { u, v } = toUnit(m.x, m.z);
      const px = u * CANVAS_W;
      const py = v * CANVAS_H;
      if (m.kind === 'mate') {
        ctx.fillStyle = 'rgba(74, 163, 224, 0.95)';
        ctx.beginPath();
        ctx.arc(px, py, 2.6, 0, Math.PI * 2);
        ctx.fill();
      } else if (m.kind === 'contact') {
        const alpha = Math.max(0.15, 1 - m.age / 6);
        ctx.strokeStyle = `rgba(224, 90, 74, ${alpha.toFixed(2)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, 3.4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // The player, as an arrow so the heading is readable at a glance.
    if (p.playerPos) {
      const { u, v } = toUnit(p.playerPos.x, p.playerPos.z);
      const px = u * CANVAS_W;
      const py = v * CANVAS_H;
      ctx.save();
      ctx.translate(px, py);
      // Screen +y is map +z; the camera looks along (sin yaw, -cos yaw), so the
      // arrow rotates by yaw with no sign flip. Getting this wrong points the
      // arrow backwards, which is the single most disorienting map bug there is.
      ctx.rotate(p.yaw);
      ctx.fillStyle = '#eafcfb';
      ctx.beginPath();
      ctx.moveTo(0, -5.2);
      ctx.lineTo(3.4, 3.6);
      ctx.lineTo(0, 1.6);
      ctx.lineTo(-3.4, 3.6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Frame
    ctx.strokeStyle = 'rgba(120, 200, 220, 0.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, CANVAS_W - 1, CANVAS_H - 1);
  }

  /**
   * Compass: shift the strip so the letter matching the heading sits under the
   * needle. One tick is 45 degrees and 74 px wide in CSS, so the strip moves
   * 74/45 px per degree.
   */
  function drawCompass(p) {
    const deg = bearing(p.yaw);
    if (el.compassStrip && Math.abs(deg - lastCompassDeg) > 0.3) {
      lastCompassDeg = deg;
      // Geometry: one tick per 45 degrees, so a tick is TICK_W px wide and the
      // strip moves TICK_W/45 px per degree. The strip holds two copies of the
      // 8 points (16 ticks) so there is always material on both sides of the
      // needle; the copy index is chosen to land in the middle of the strip.
      const ticks = el.compassStrip.children.length;
      const TICK_W = el.compassStrip.children[0] ? el.compassStrip.children[0].offsetWidth || 74 : 74;
      const perTurn = 8;
      const cycle = Math.floor(deg / 45);
      const index = cycle + perTurn; // always the second copy: 8..15
      const centreX = index * TICK_W + TICK_W / 2;
      const wrapperW = el.compassStrip.parentElement?.clientWidth || 220;
      // Put the chosen tick's centre under the wrapper's centre, then shift by
      // the fraction of the current 45-degree sector we have turned through.
      const sub = (deg % 45) * (TICK_W / 45);
      const offset = wrapperW / 2 - centreX - sub;
      el.compassStrip.style.transform = `translateX(${offset.toFixed(1)}px)`;
      // Highlight whichever point the needle is actually on. `delta` is the
      // absolute angular distance on the circle, so *small* means "under the
      // needle" — the first version compared it to 170 and therefore lit up
      // every tick except the one being looked at, which is why the centre
      // letter stayed dim.
      for (let i = 0; i < ticks; i++) {
        const tick = el.compassStrip.children[i];
        const tickDeg = Number(tick.dataset.bearing);
        const delta = Math.min(
          Math.abs(deg - tickDeg) % 360,
          360 - (Math.abs(deg - tickDeg) % 360),
        );
        tick.classList.toggle('major', delta <= 22);
      }
    }
    const c = cardinal(p.yaw);
    const label = `${c.long} ${Math.round(deg)}°`;
    if (el.compassText && label !== lastCompassText) {
      lastCompassText = label;
      el.compassText.textContent = label;
    }
  }

  let lastKillfeedKey = '';
  const teamKeys = { A: '', B: '' };
  let bannerText = '';

  function renderTeamList(listEl, actors, team) {
    const key = actors.map((a) => `${a.id}:${a.alive ? 1 : 0}:${a.health}`).join('|');
    if (key === teamKeys[team]) return;
    teamKeys[team] = key;
    const frag = document.createDocumentFragment();
    for (const a of actors) {
      const li = document.createElement('li');
      li.className = `${a.alive ? '' : 'dead'} ${a.isPlayer ? 'me' : ''}`.trim();
      const nameSpan = document.createElement('span');
      nameSpan.textContent = a.name;
      const hpSpan = document.createElement('span');
      hpSpan.className = 'hp-mini';
      hpSpan.textContent = a.alive ? String(a.health) : '—';
      li.append(nameSpan, hpSpan);
      frag.appendChild(li);
    }
    listEl.replaceChildren(frag);
  }

  return {
    el,
    show(visible) {
      el.hud.classList.toggle('hidden', !visible);
      el.hud.setAttribute('aria-hidden', String(!visible));
    },
    update(state) {
      const p = state;

      // scores / pips
      setText(el.scoreA, String(p.scores.A));
      setText(el.scoreB, String(p.scores.B));
      setText(el.roundLabel, `RAUND ${p.round} / ${p.maxRounds}`);
      for (let i = 0; i < pips.A.length; i++) {
        pips.A[i].classList.toggle('on', i < p.scores.A);
        pips.B[i].classList.toggle('on', i < p.scores.B);
      }
      const remaining = Math.max(0, Math.ceil(p.roundTimeLimit - (p.roundElapsed || 0)));
      setText(el.roundTimer, p.phase === 'live' ? formatTime(remaining) : '--:--');

      let statusText = 'HAZIR';
      if (p.phase === 'freeze') statusText = `GERİ SAYIM ${Math.ceil(p.phaseTime)}`;
      else if (p.phase === 'live') statusText = p.playerAlive ? 'ÇATIŞMA' : 'ELENDİN';
      else if (p.phase === 'round_end') {
        statusText = p.roundWinner ? `${MATCH.teamNames[p.roundWinner]} RAUNDU ALDI` : 'RAUND BERABERE';
      } else if (p.phase === 'match_end') {
        statusText = p.matchWinner === 'draw' ? 'MAÇ BERABERE' : `${MATCH.teamNames[p.matchWinner]} MAÇI KAZANDI`;
      }
      setText(el.roundStatus, statusText);

      // team rosters: own team fully, enemies as an anonymous alive count
      if (p.playerTeam === 'A') {
        renderTeamList(el.teamAList, p.teamMates, 'A');
        renderTeamList(el.teamBList, placeholderEnemies(p), 'B');
      } else {
        renderTeamList(el.teamAList, placeholderEnemies(p), 'A');
        renderTeamList(el.teamBList, p.teamMates, 'B');
      }

      // vitals
      setText(el.healthValue, String(p.health));
      setText(el.armorValue, String(p.armor));
      setStyle(el.healthBar, 'width', `${(p.health / p.maxHealth) * 100}%`);
      setStyle(el.armorBar, 'width', `${(p.armor / p.maxArmor) * 100}%`);
      toggleClass(el.healthVital, 'low', p.health <= 30);

      // weapon / ammo
      setText(el.weaponName, p.weaponName);
      setText(el.ammoMag, String(p.ammo.mag));
      setText(el.ammoReserve, String(p.ammo.reserve));
      toggleClass(el.ammoMag, 'empty', p.ammo.mag === 0);
      for (const slot of el.slots) {
        slot.classList.toggle('active', slot.dataset.slot === p.weaponId);
      }

      // reload ring
      const reloading = p.reloading;
      toggleClass(el.reloadRing, 'hidden', !reloading);
      if (reloading) {
        const len = 2 * Math.PI * 17;
        el.reloadFg.style.strokeDasharray = String(len);
        el.reloadFg.style.strokeDashoffset = String(len * (1 - p.reloadProgress));
      }

      // crosshair spread (px)
      const gap = 4 + p.spreadDeg * 2.6 + (p.ads ? -1.5 : 0);
      el.crosshair.style.setProperty('--gap', `${Math.max(2, gap)}px`);
      el.crosshair.style.opacity = p.ads ? '0.55' : '1';

      // hitmarker
      toggleClass(el.hitmarker, 'on', p.hitmarker > 0);
      toggleClass(el.hitmarker, 'kill', Boolean(p.hitmarkerKill));

      // damage feedback
      el.damageVignette.style.opacity = String(Math.min(0.9, p.damageFlash * 0.85));
      if (p.damageFlash > 0.02) {
        el.damageDir.style.opacity = String(Math.min(1, p.damageFlash * 1.4));
        el.damageDir.style.transform = `rotate(${(p.damageDir * 180) / Math.PI}deg)`;
      } else {
        el.damageDir.style.opacity = '0';
      }

      // death overlay
      const dead = !p.playerAlive && (p.phase === 'live' || p.phase === 'round_end');
      toggleClass(el.deathOverlay, 'hidden', !dead);
      if (dead) setText(el.deathSub, p.phase === 'round_end' ? 'Raund bitti' : 'Takımın için izliyorsun');

      // killfeed
      const key = p.killfeed.map((k) => k.text + k.team).join('|');
      if (key !== lastKillfeedKey) {
        lastKillfeedKey = key;
        el.killfeed.innerHTML = '';
        for (const k of p.killfeed) {
          const d = document.createElement('li');
          d.className = k.team === 'A' ? 'a' : 'b';
          d.textContent = k.text;
          el.killfeed.appendChild(d);
        }
      }

      // banner (round / match transitions)
      let banner = p.roundBanner;
      if (!banner && p.phase === 'freeze') banner = 'HAZIR OL';
      if (!banner && p.phase === 'match_end') {
        banner = p.matchWinner === 'draw' ? 'BERABERE' : `${MATCH.teamNames[p.matchWinner]} KAZANDI`;
      }
      if (banner !== bannerText) {
        bannerText = banner;
        el.banner.textContent = banner || '';
        el.banner.classList.toggle('hidden', !banner);
      }

      setText(el.diffTag, p.difficulty.toUpperCase());

      // tactical map + compass
      drawMinimap(p);
      drawCompass(p);
      if (p.playerPos) {
        setText(el.minimapLane, locationLabel(p.playerPos.x, p.playerPos.z));
      }
      return this;
    },
    setFps(fps) {
      setText(el.fps, `${Math.round(fps)} FPS`);
    },
    resetTeamLists() {
      teamKeys.A = '';
      teamKeys.B = '';
    },
  };
}

function placeholderEnemies(p) {
  // Enemies are shown only as an alive count; no live positions are leaked.
  const list = [];
  for (let i = 0; i < p.enemiesAlive; i++) {
    list.push({ id: `e${i}`, name: 'HEDEF', alive: true, health: '?', isPlayer: false });
  }
  return list;
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
