// Settings persistence (localStorage) with validation, so a corrupt or old
// payload can never wedge the game.

import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from '../core/config.js';

const KEY = 'sifirnokta.settings.v1';

export function loadSettings() {
  const settings = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return settings;
    const parsed = JSON.parse(raw);
    return sanitize({ ...settings, ...parsed });
  } catch {
    return settings;
  }
}

export function sanitize(input) {
  const out = { ...DEFAULT_SETTINGS };
  if (typeof input !== 'object' || !input) return out;
  const clamp = (v, { min, max }, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };
  out.sensitivity = clamp(input.sensitivity, SETTINGS_LIMITS.sensitivity, DEFAULT_SETTINGS.sensitivity);
  out.volume = clamp(input.volume, SETTINGS_LIMITS.volume, DEFAULT_SETTINGS.volume);
  out.fov = clamp(input.fov, SETTINGS_LIMITS.fov, DEFAULT_SETTINGS.fov);
  out.quality = SETTINGS_LIMITS.qualities.includes(input.quality) ? input.quality : DEFAULT_SETTINGS.quality;
  out.shake = Boolean(input.shake);
  out.difficulty = ['easy', 'normal', 'hard'].includes(input.difficulty) ? input.difficulty : DEFAULT_SETTINGS.difficulty;
  return out;
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(sanitize(settings)));
    return true;
  } catch {
    return false;
  }
}

export function clearSettings() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
