// Central tuning data. Nothing gameplay-related should hardcode these values
// elsewhere — everything reads from here (or from a profile derived from here).

export const GAME_TITLE = 'SIFIR NOKTA';
export const GAME_VERSION = '0.9.0';

export const PLAYER = {
  maxHealth: 100,
  maxArmor: 50,
  radius: 0.42,
  height: 1.8,
  eyeHeight: 1.62,
  crouchEyeHeight: 1.05,
  // Aim reference points on the body, in metres above the floor, measured while
  // standing. They live here because the AI's aim point and the hit volumes are
  // both derived from them: when these were separate literals, changing the
  // hitbox silently moved where bots aimed.
  chestHeight: 1.12,
  crouchChestHeight: 0.78,
  // How fast the sight settles onto the camera axis. The viewmodel uses the same
  // rate, so the accuracy bonus and the visible sight arrive together (~200 ms
  // to 95%). Raising one without the other re-introduces the mismatch where the
  // cone was fully aimed while the sight was still off-axis.
  adsLerpSpeed: 14,
  walkSpeed: 4.9,
  sprintSpeed: 6.6,
  crouchSpeed: 2.5,
  adsSpeedFactor: 0.6,
  accel: 55,
  friction: 12,
  crouchLerpSpeed: 9,
  pitchLimit: 88,
};

export const COMBAT = {
  headMultiplier: 2.5,
  // Fraction of incoming damage the armour eats while it lasts. Never 1.0:
  // armour is mitigation, not immunity.
  armorAbsorb: 0.5,
  friendlyFire: false,
  // How long a downed actor's hitbox stays inert.
  corpseLinger: 0,
};

export const MATCH = {
  teamSize: 5,
  roundsToWin: 3,
  maxRounds: 5,
  freezeTime: 3,
  roundEndTime: 3.0,
  // Stall breaker: an unresolved round is decided by survivors, then by
  // remaining health, so a camping matchup can never hang a match.
  roundTimeLimit: 80,
  matchEndDelay: 1.4,
  teamNames: { A: 'ALFA', B: 'BRAVO' },
  teamColors: { A: 0x2f7fbf, B: 0xc2662f },
};

// Weapon data is original (no real-world model stats copied).
// Angles are degrees, times in seconds, distances in metres.
export const WEAPONS = {
  pistol: {
    id: 'pistol',
    name: 'K-7 TABANCA',
    shortName: 'K-7',
    slot: 1,
    damage: 24,
    headMultiplier: COMBAT.headMultiplier,
    rpm: 330,
    auto: false,
    magSize: 12,
    reserveAmmo: 48,
    reloadTime: 1.45,
    switchTime: 0.3,
    // Recoil: degrees kicked on camera, recovered at `recovery` deg/s.
    recoil: { pitch: 1.05, yaw: 0.45, recovery: 9 },
    // Spread: half-angle of the shot cone, degrees.
    spread: { base: 0.4, perShot: 0.5, max: 3.0, recovery: 6.5, adsFactor: 0.55, moveFactor: 1.6 },
    range: 70,
    falloffStart: 0.55,
    falloffFactor: 0.6,
    adsFov: 62,
    fireSound: 'pistol',
  },
  rifle: {
    id: 'rifle',
    name: 'AR-14 TÜFEK',
    shortName: 'AR-14',
    slot: 2,
    damage: 26,
    headMultiplier: COMBAT.headMultiplier,
    rpm: 600,
    auto: true,
    magSize: 30,
    reserveAmmo: 90,
    reloadTime: 2.1,
    switchTime: 0.45,
    recoil: { pitch: 0.62, yaw: 0.3, recovery: 6.2 },
    spread: { base: 0.55, perShot: 0.42, max: 4.2, recovery: 5.0, adsFactor: 0.5, moveFactor: 2.0 },
    range: 110,
    falloffStart: 0.5,
    falloffFactor: 0.6,
    adsFov: 48,
    fireSound: 'rifle',
  },
};



// Difficulty only ever changes reaction, aim quality, decision speed and
// coordination. Vision is always LOS-limited and aim error is never zero.
export const DIFFICULTY = {
  easy: {
    id: 'easy',
    label: 'KOLAY',
    // Weak in aim and reaction, but they still hunt: a passive bot that never
    // finds anyone just stalls the round until the time limit.
    reactionTime: 0.55,
    reacquireTime: 1.4,
    aimSpeed: 2.8, // rad/s turn rate toward target
    aimError: 3.4, // degrees of persistent aim offset
    aimRamp: 1.9, // seconds to reach full accuracy after acquiring
    fireAngleTolerance: 4.5, // degrees
    burstShots: 3,
    burstPause: 0.5,
    recoilAimKick: 0.3, // degrees of climb added per shot inside a burst
    headBias: 0.22, // 0 = chest, 1 = head centre
    fov: 112,
    viewDistance: 38,
    hearingRadius: 16,
    coordination: 0.15,
    strafeChance: 0.25,
    coverUse: 0.15,
    retreatHealth: 0,
    investigateTime: 2.4,
    decisionInterval: 0.34,
    // How long a bot camps its lane before pushing deeper / hunting.
    pushAfter: 3.0,
  },
  normal: {
    id: 'normal',
    label: 'NORMAL',
    reactionTime: 0.36,
    reacquireTime: 0.85,
    aimSpeed: 4.6,
    aimError: 1.9,
    aimRamp: 1.0,
    fireAngleTolerance: 2.6,
    burstShots: 4,
    burstPause: 0.38,
    recoilAimKick: 0.2,
    headBias: 0.7,
    fov: 118,
    viewDistance: 44,
    hearingRadius: 18,
    coordination: 0.5,
    strafeChance: 0.5,
    coverUse: 0.5,
    retreatHealth: 0.25,
    investigateTime: 5,
    decisionInterval: 0.3,
    pushAfter: 3.5,
  },
  hard: {
    id: 'hard',
    label: 'ZOR',
    reactionTime: 0.2,
    reacquireTime: 0.5,
    aimSpeed: 7.0,
    aimError: 0.95,
    aimRamp: 0.55,
    fireAngleTolerance: 1.6,
    burstShots: 7,
    burstPause: 0.24,
    recoilAimKick: 0.05,
    headBias: 0.8,
    fov: 135,
    viewDistance: 60,
    hearingRadius: 24,
    coordination: 0.8,
    strafeChance: 0.7,
    coverUse: 0.8,
    retreatHealth: 0.35,
    investigateTime: 6.5,
    decisionInterval: 0.18,
    pushAfter: 3.0,
  },
};

export const DEFAULT_SETTINGS = {
  sensitivity: 1.0,
  volume: 0.55,
  quality: 'medium',
  shake: true,
  difficulty: 'normal',
  fov: 78,
};

export const SETTINGS_LIMITS = {
  sensitivity: { min: 0.2, max: 3.0 },
  volume: { min: 0, max: 1 },
  fov: { min: 65, max: 100 },
  qualities: ['low', 'medium', 'high'],
};
