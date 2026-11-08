// Career statistics: what you have done across every match you have ever
// played, persisted between sessions.
//
// Before this module a match ended, the summary screen showed seven numbers,
// and everything was forgotten. There was no answer to "am I getting better",
// no history to look back at, and no reason for the difficulty setting to
// matter beyond the match you were in.
//
// Design rules, and why:
//
//   * Pure functions plus one storage adapter. The interesting logic is the
//     merge, and a merge you cannot unit test is a merge that will silently
//     corrupt a player's history on the one input you did not think of.
//   * Everything is validated on read. This data lives in localStorage, which
//     means it can be edited by hand, truncated by a quota error, or left over
//     from an older version of the game. None of those may wedge the game or
//     throw — a corrupt career file should degrade to "no career yet", not to a
//     white screen.
//   * Bounded. The history keeps the last N matches and nothing else. An
//     unbounded log is how a localStorage payload grows until it fails.

export const HISTORY_LIMIT = 10;
const STORAGE_KEY = 'sifirnokta.career.v1';
const DIFFICULTIES = ['easy', 'normal', 'hard'];

/** A career with nothing in it. Returned instead of throwing, always. */
export function emptyCareer() {
  return {
    version: 1,
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    kills: 0,
    deaths: 0,
    headshots: 0,
    shots: 0,
    hits: 0,
    damageDealt: 0,
    rounds: 0,
    roundsWon: 0,
    playtimeSeconds: 0,
    bestKd: 0,
    bestAccuracy: 0,
    byDifficulty: {
      easy: { matches: 0, wins: 0, kills: 0, deaths: 0, shots: 0, hits: 0 },
      normal: { matches: 0, wins: 0, kills: 0, deaths: 0, shots: 0, hits: 0 },
      hard: { matches: 0, wins: 0, kills: 0, deaths: 0, shots: 0, hits: 0 },
    },
    history: [],
  };
}

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Coerce anything into a valid career.
 *
 * This is the only place that trusts nothing. Every field is clamped to a
 * non-negative finite number, the difficulty buckets are rebuilt rather than
 * trusted, and the history is filtered down to well-formed entries.
 */
export function sanitizeCareer(input) {
  const out = emptyCareer();
  if (!input || typeof input !== 'object') return out;

  for (const key of ['matches', 'wins', 'losses', 'draws', 'kills', 'deaths', 'headshots', 'shots', 'hits', 'damageDealt', 'rounds', 'roundsWon', 'playtimeSeconds', 'bestKd', 'bestAccuracy']) {
    out[key] = num(input[key]);
  }
  // A career cannot have won more matches than it played. If the numbers
  // disagree the file was tampered with or partially written, and the invariant
  // is worth repairing rather than displaying.
  out.wins = Math.min(out.wins, out.matches);
  out.losses = Math.min(out.losses, out.matches);
  out.draws = Math.min(out.draws, out.matches);
  out.hits = Math.min(out.hits, out.shots);
  out.roundsWon = Math.min(out.roundsWon, out.rounds);

  const src = (input.byDifficulty && typeof input.byDifficulty === 'object') ? input.byDifficulty : {};
  for (const d of DIFFICULTIES) {
    const s = src[d];
    if (!s || typeof s !== 'object') continue;
    for (const key of ['matches', 'wins', 'kills', 'deaths', 'shots', 'hits']) {
      out.byDifficulty[d][key] = num(s[key]);
    }
    out.byDifficulty[d].wins = Math.min(out.byDifficulty[d].wins, out.byDifficulty[d].matches);
    out.byDifficulty[d].hits = Math.min(out.byDifficulty[d].hits, out.byDifficulty[d].shots);
  }

  const hist = Array.isArray(input.history) ? input.history : [];
  out.history = hist
    .filter((h) => h && typeof h === 'object')
    .slice(0, HISTORY_LIMIT)
    .map((h) => ({
      at: typeof h.at === 'string' ? h.at : '',
      difficulty: DIFFICULTIES.includes(h.difficulty) ? h.difficulty : 'normal',
      wins: Boolean(h.wins),
      win: Boolean(h.win),
      draw: Boolean(h.draw),
      scoreA: num(h.scoreA),
      scoreB: num(h.scoreB),
      kills: num(h.kills),
      deaths: num(h.deaths),
      headshots: num(h.headshots),
      shots: num(h.shots),
      hits: num(h.hits),
      rounds: num(h.rounds),
      // Derived, so a tampered file cannot claim a K/D it did not earn.
      kd: num(h.deaths) > 0 ? num(h.kills) / num(h.deaths) : num(h.kills),
    }));
  return out;
}

/**
 * Fold one finished match into a career.
 *
 * `result` is the plain object `matchResult()` produces; this function never
 * reads game state, which keeps it usable from the match-end screen, a test,
 * or a future replay import without dragging the whole game along.
 */
export function addMatch(career, result, { now = new Date() } = {}) {
  const base = sanitizeCareer(career);
  const difficulty = DIFFICULTIES.includes(result?.difficulty) ? result.difficulty : 'normal';
  const kills = num(result?.kills);
  const deaths = num(result?.deaths);
  const shots = num(result?.shots);
  const hits = Math.min(num(result?.hits), shots);
  const headshots = Math.min(num(result?.headshots), hits);
  const rounds = num(result?.rounds);
  const roundsWon = Math.min(num(result?.roundsWon), rounds);

  const next = sanitizeCareer(base);

  next.matches += 1;
  if (result?.draw) next.draws += 1;
  else if (result?.win) next.wins += 1;
  else next.losses += 1;

  next.kills += kills;
  next.deaths += deaths;
  next.headshots += headshots;
  next.shots += shots;
  next.hits += hits;
  next.damageDealt += Math.round(num(result?.damageDealt));
  next.rounds += rounds;
  next.roundsWon += roundsWon;
  next.playtimeSeconds += Math.round(num(result?.durationSeconds));

  const d = next.byDifficulty[difficulty];
  d.matches += 1;
  if (result?.win) d.wins += 1;
  d.kills += kills;
  d.deaths += deaths;
  d.shots += shots;
  d.hits += hits;

  // Personal bests, only for matches that had enough volume to mean something.
  // A 1-kill, 0-death match technically has an infinite K/D; recording that as
  // a career best would make every later match look like a regression.
  const matchKd = deaths > 0 ? kills / deaths : (kills >= 5 ? kills : 0);
  if (deaths > 0 && matchKd > next.bestKd) next.bestKd = matchKd;
  const matchAcc = shots >= 20 ? hits / shots : 0;
  if (matchAcc > next.bestAccuracy) next.bestAccuracy = matchAcc;

  next.history.unshift({
    at: now instanceof Date ? now.toISOString() : String(now),
    difficulty,
    win: Boolean(result?.win),
    draw: Boolean(result?.draw),
    scoreA: num(result?.scoreA),
    scoreB: num(result?.scoreB),
    kills,
    deaths,
    headshots,
    shots,
    hits,
    rounds,
    kd: deaths > 0 ? kills / deaths : kills,
  });
  next.history = next.history.slice(0, HISTORY_LIMIT);
  return next;
}

/** Derived summary numbers. Kept here so the UI does no arithmetic. */
export function careerSummary(career) {
  const c = sanitizeCareer(career);
  const rounds = c.matches ? c.rounds : 0;
  return {
    // Raw counters, not just ratios. The UI needs to distinguish "no matches
    // yet" from "zero deaths", and it cannot do that from a derived ratio
    // alone — which is exactly the bug that made K/D, accuracy and headshot
    // rate all render as "—" on a career with thousands of shots in it.
    matches: c.matches,
    wins: c.wins,
    losses: c.losses,
    draws: c.draws,
    kills: c.kills,
    deaths: c.deaths,
    shots: c.shots,
    hits: c.hits,
    headshots: c.headshots,
    rounds: c.rounds,
    roundsWon: c.roundsWon,
    damageDealt: c.damageDealt,
    winRate: c.matches ? c.wins / c.matches : 0,
    kd: c.deaths ? c.kills / c.deaths : c.kills,
    accuracy: c.shots ? c.hits / c.shots : 0,
    headshotRate: c.hits ? c.headshots / c.hits : 0,
    avgKills: c.matches ? c.kills / c.matches : 0,
    avgDeaths: c.matches ? c.deaths / c.matches : 0,
    roundWinRate: rounds ? c.roundsWon / rounds : 0,
    playtimeSeconds: c.playtimeSeconds,
    bestKd: c.bestKd,
    bestAccuracy: c.bestAccuracy,
    byDifficulty: c.byDifficulty,
    history: c.history,
  };
}

/**
 * Accuracy trend over the recent history, oldest first, for a sparkline.
 *
 * Matches with too few shots are skipped rather than plotted as zero: one
 * sprayed magazine from the hip is not a data point about aim.
 */
export function accuracyTrend(career, minShots = 20) {
  const c = sanitizeCareer(career);
  return c.history
    .slice()
    .reverse()
    .filter((h) => h.shots >= minShots)
    .map((h) => ({ at: h.at, accuracy: h.shots ? h.hits / h.shots : 0, difficulty: h.difficulty }));
}

/** `12.3 s`, `4 dk 12 s`, `2 sa 05 dk` — short and readable in a stats row. */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(num(seconds)));
  if (s < 60) return `${s} sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk ${String(s % 60).padStart(2, '0')} sn`;
  const h = Math.floor(m / 60);
  return `${h} sa ${String(m % 60).padStart(2, '0')} dk`;
}

// ── storage ────────────────────────────────────────────────────────────────

/**
 * Read the career from storage. Never throws.
 *
 * The try/catch is not defensive padding: `localStorage` throws outright in
 * private-mode Safari and when the origin is opaque, and a game that refuses to
 * start because it could not read a stats file would be absurd.
 */
export function loadCareer(storage = safeStorage()) {
  if (!storage) return emptyCareer();
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return emptyCareer();
    return sanitizeCareer(JSON.parse(raw));
  } catch {
    return emptyCareer();
  }
}

export function saveCareer(career, storage = safeStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(sanitizeCareer(career)));
    return true;
  } catch {
    // Quota exceeded or storage disabled. The career still works for this
    // session; it just will not survive a reload. Failing silently is right
    // here — interrupting a match to report a stats write would be worse.
    return false;
  }
}

export function clearCareer(storage = safeStorage()) {
  if (!storage) return false;
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function safeStorage() {
  try {
    // Accessing the property is itself what throws in some browsers.
    if (typeof localStorage === 'undefined') return null;
    localStorage.getItem(STORAGE_KEY);
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * Record a finished match: read, merge, write, return the updated career.
 *
 * One function so the three call sites cannot each forget to persist, and so a
 * test can pass a fake storage and assert on the round trip.
 */
export function recordMatch(result, { now = new Date(), storage = safeStorage() } = {}) {
  const updated = addMatch(loadCareer(storage), result, { now });
  saveCareer(updated, storage);
  return updated;
}
