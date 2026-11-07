// HUD binding. Reads a plain state object and writes only what changed, so the
// DOM is untouched on frames where nothing moved.

import { MATCH } from '../core/config.js';

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
