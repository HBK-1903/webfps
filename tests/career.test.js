// Career statistics.
//
// The interesting tests here are not "does a kill add to the kill count" — they
// are "what happens when the stored file is wrong". Career data lives in
// localStorage, which can be edited by hand, truncated by a quota error, left
// over from an older version of the game, or written by a browser that throws
// on access. None of those may produce a crash, a NaN on screen, or a history
// that claims a win rate above 100%.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HISTORY_LIMIT,
  emptyCareer,
  sanitizeCareer,
  addMatch,
  careerSummary,
  accuracyTrend,
  formatDuration,
  loadCareer,
  saveCareer,
  clearCareer,
  recordMatch,
} from '../src/core/career.js';

/** In-memory stand-in for localStorage, with optional failure modes. */
function fakeStorage({ throwOnGet = false, throwOnSet = false } = {}) {
  const map = new Map();
  return {
    getItem(k) {
      if (throwOnGet) throw new Error('erisim engellendi');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (throwOnSet) throw new Error('kota dolu');
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
    get size() {
      return map.size;
    },
  };
}

const MATCH = {
  difficulty: 'normal',
  win: true,
  draw: false,
  kills: 12,
  deaths: 5,
  shots: 120,
  hits: 48,
  headshots: 12,
  rounds: 5,
  roundsWon: 5,
  scoreA: 5,
  scoreB: 2,
  damageDealt: 1180,
  durationSeconds: 400,
};

test('an empty career reports zeros rather than undefined', () => {
  const c = emptyCareer();
  assert.equal(c.matches, 0);
  const s = careerSummary(c);
  assert.equal(s.winRate, 0);
  assert.equal(s.kd, 0);
  assert.equal(s.accuracy, 0);
  assert.deepEqual(s.history, []);
});

test('no division by zero anywhere in the summary', () => {
  const s = careerSummary(emptyCareer());
  for (const [key, value] of Object.entries(s)) {
    if (typeof value === 'number') {
      assert.ok(Number.isFinite(value), `${key} sonlu değil: ${value}`);
    }
  }
});

test('one match folds every counter in', () => {
  const c = addMatch(emptyCareer(), MATCH);
  assert.equal(c.matches, 1);
  assert.equal(c.wins, 1);
  assert.equal(c.kills, 12);
  assert.equal(c.deaths, 5);
  assert.equal(c.shots, 120);
  assert.equal(c.hits, 48);
  assert.equal(c.headshots, 12);
  assert.equal(c.rounds, 5);
  assert.equal(c.roundsWon, 5);
  assert.equal(c.damageDealt, 1180);
  assert.equal(c.playtimeSeconds, 400);
  assert.equal(c.history.length, 1);
});

test('summary maths are right, and a win rate is a fraction not a percent', () => {
  let c = addMatch(emptyCareer(), MATCH);
  c = addMatch(c, { ...MATCH, win: false, kills: 3, deaths: 9, shots: 60, hits: 15, roundsWon: 1, scoreA: 1, scoreB: 5 });
  const s = careerSummary(c);
  assert.equal(s.matches, 2);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.kd, 15 / 14);
  assert.equal(s.accuracy, 63 / 180);
  assert.equal(s.avgKills, 7.5);
  assert.equal(s.roundWinRate, 6 / 10);
});

test('difficulty buckets are tracked separately', () => {
  let c = addMatch(emptyCareer(), MATCH);
  c = addMatch(c, { ...MATCH, difficulty: 'hard', win: false, kills: 2, deaths: 8, shots: 40, hits: 8 });
  assert.equal(c.byDifficulty.normal.matches, 1);
  assert.equal(c.byDifficulty.hard.matches, 1);
  assert.equal(c.byDifficulty.hard.kills, 2);
  assert.equal(c.byDifficulty.easy.matches, 0);
  // Totals still include everything.
  assert.equal(c.kills, 14);
});

test('an unknown difficulty is recorded as normal, not dropped', () => {
  const c = addMatch(emptyCareer(), { ...MATCH, difficulty: 'imkansiz' });
  assert.equal(c.matches, 1);
  assert.equal(c.byDifficulty.normal.matches, 1);
  assert.equal(c.history[0].difficulty, 'normal');
});

test('history is newest first and capped', () => {
  let c = emptyCareer();
  for (let i = 0; i < HISTORY_LIMIT + 6; i++) {
    c = addMatch(c, { ...MATCH, kills: i }, { now: new Date(2026, 0, 1 + i) });
  }
  assert.equal(c.matches, HISTORY_LIMIT + 6, 'toplam maç sayısı sınırsız kalmalı');
  assert.equal(c.history.length, HISTORY_LIMIT, 'geçmiş listesi sınırlı olmalı');
  assert.equal(c.history[0].kills, HISTORY_LIMIT + 5, 'en yeni maç başta olmalı');
});

test('a match with more hits than shots cannot exist', () => {
  const c = addMatch(emptyCareer(), { ...MATCH, shots: 10, hits: 40 });
  assert.equal(c.hits, 10, 'isabet, atıştan fazla olamaz');
  assert.ok(careerSummary(c).accuracy <= 1);
});

test('headshots cannot exceed hits', () => {
  const c = addMatch(emptyCareer(), { ...MATCH, shots: 50, hits: 10, headshots: 30 });
  assert.equal(c.headshots, 10);
});

test('a match total cannot claim more wins than matches played', () => {
  // The exact shape of a hand-edited or half-written file.
  const c = sanitizeCareer({ matches: 3, wins: 99, losses: 40, draws: 7 });
  assert.equal(c.wins, 3);
  assert.equal(c.losses, 3);
  assert.equal(c.draws, 3);
});

test('garbage in the file degrades to an empty career, never a throw', () => {
  for (const bad of [null, undefined, 'metin', 42, [], { matches: 'çok' }, { matches: NaN }, { matches: -5 }]) {
    const c = sanitizeCareer(bad);
    assert.equal(c.matches, 0, `girdi: ${JSON.stringify(bad)}`);
    assert.ok(Number.isFinite(c.kills));
  }
});

test('NaN and Infinity in individual fields do not poison the totals', () => {
  const c = sanitizeCareer({ matches: 4, kills: NaN, deaths: Infinity, shots: -1, hits: Number.POSITIVE_INFINITY });
  assert.ok(Number.isFinite(c.kills));
  assert.ok(Number.isFinite(c.deaths));
  assert.ok(Number.isFinite(c.shots));
  assert.ok(Number.isFinite(c.hits));
  assert.ok(c.hits <= c.shots);
});

test('a corrupt history entry is discarded, good ones survive', () => {
  const c = sanitizeCareer({
    matches: 2,
    history: [null, 'çöp', 7, { kills: 5, deaths: 2, shots: 30, hits: 12 }],
  });
  assert.equal(c.history.length, 1);
  assert.equal(c.history[0].kills, 5);
  assert.ok(c.history[0].kd > 0);
});

test('K/D in a history entry is derived, not trusted', () => {
  const c = sanitizeCareer({ history: [{ kills: 4, deaths: 2, kd: 99 }] });
  assert.equal(c.history[0].kd, 2);
});

test('the best K/D ignores matches with no deaths', () => {
  // 8 kills and 0 deaths is a great round, but it is not a K/D, and letting it
  // become the career best would make every honest match look like a decline.
  const c = addMatch(emptyCareer(), { ...MATCH, kills: 8, deaths: 0 });
  assert.equal(c.bestKd, 0);
  assert.equal(c.kills, 8, 'öldürme yine de sayılmalı');
});

test('best accuracy ignores matches with almost no shots', () => {
  const c = addMatch(emptyCareer(), { ...MATCH, shots: 3, hits: 3 });
  assert.equal(c.bestAccuracy, 0);
});

test('best K/D and accuracy only ever go up', () => {
  let c = addMatch(emptyCareer(), { ...MATCH, kills: 20, deaths: 4, shots: 200, hits: 120 });
  const kd = c.bestKd;
  const acc = c.bestAccuracy;
  c = addMatch(c, { ...MATCH, kills: 1, deaths: 10, shots: 200, hits: 10 });
  assert.equal(c.bestKd, kd);
  assert.equal(c.bestAccuracy, acc);
});

test('a draw is neither a win nor a loss', () => {
  const c = addMatch(emptyCareer(), { ...MATCH, win: false, draw: true });
  assert.equal(c.draws, 1);
  assert.equal(c.wins, 0);
  assert.equal(c.losses, 0);
  assert.equal(careerSummary(c).winRate, 0);
});

test('accuracy trend is oldest first and skips thin matches', () => {
  let c = emptyCareer();
  c = addMatch(c, { ...MATCH, shots: 100, hits: 20 }); // %20
  c = addMatch(c, { ...MATCH, shots: 5, hits: 5 });     // atlanmalı
  c = addMatch(c, { ...MATCH, shots: 100, hits: 60 }); // %60
  const trend = accuracyTrend(c);
  assert.equal(trend.length, 2);
  assert.ok(Math.abs(trend[0].accuracy - 0.2) < 1e-9);
  assert.ok(Math.abs(trend[1].accuracy - 0.6) < 1e-9);
});

test('formatDuration reads like a person wrote it', () => {
  assert.equal(formatDuration(0), '0 sn');
  assert.equal(formatDuration(45), '45 sn');
  assert.equal(formatDuration(60), '1 dk 00 sn');
  assert.equal(formatDuration(700), '11 dk 40 sn');
  assert.equal(formatDuration(3600), '1 sa 00 dk');
  assert.equal(formatDuration(7500), '2 sa 05 dk');
  assert.equal(formatDuration(-3), '0 sn');
  assert.equal(formatDuration(NaN), '0 sn');
});

test('storage round trip preserves the career', () => {
  const storage = fakeStorage();
  const c = addMatch(emptyCareer(), MATCH);
  assert.equal(saveCareer(c, storage), true);
  const back = loadCareer(storage);
  assert.deepEqual(back, sanitizeCareer(c));
});

test('recordMatch reads, merges and writes in one step', () => {
  const storage = fakeStorage();
  recordMatch(MATCH, { storage, now: new Date(2026, 4, 1) });
  const c = recordMatch({ ...MATCH, win: false }, { storage });
  assert.equal(c.matches, 2);
  assert.equal(loadCareer(storage).matches, 2, 'ikinci maç diske de yazılmalı');
});

test('a storage that throws on read yields an empty career, not a crash', () => {
  const storage = fakeStorage({ throwOnGet: true });
  const c = loadCareer(storage);
  assert.equal(c.matches, 0);
});

test('a storage that throws on write fails quietly and is reported as false', () => {
  const storage = fakeStorage({ throwOnSet: true });
  const c = addMatch(emptyCareer(), MATCH);
  assert.equal(saveCareer(c, storage), false);
  // The match is still counted for this session.
  assert.equal(recordMatch(MATCH, { storage }).matches, 1);
});

test('a truncated JSON payload is treated as no career', () => {
  const storage = fakeStorage();
  storage.setItem('sifirnokta.career.v1', '{"matches":3,"kill');
  assert.equal(loadCareer(storage).matches, 0);
});

test('a payload from an older version without new fields still loads', () => {
  const storage = fakeStorage();
  storage.setItem('sifirnokta.career.v1', JSON.stringify({ matches: 7, wins: 4, kills: 40 }));
  const c = loadCareer(storage);
  assert.equal(c.matches, 7);
  assert.equal(c.wins, 4);
  assert.equal(c.byDifficulty.normal.matches, 0, 'eksik alan sıfırdan başlamalı');
  assert.deepEqual(c.history, []);
});

test('clearCareer removes the record', () => {
  const storage = fakeStorage();
  recordMatch(MATCH, { storage });
  assert.equal(loadCareer(storage).matches, 1);
  assert.equal(clearCareer(storage), true);
  assert.equal(loadCareer(storage).matches, 0);
});

test('addMatch never mutates the career it is given', () => {
  const before = addMatch(emptyCareer(), MATCH);
  const snapshot = JSON.stringify(before);
  addMatch(before, MATCH);
  assert.equal(JSON.stringify(before), snapshot, 'girdi değişmemeli');
});
