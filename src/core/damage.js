import { COMBAT } from './config.js';

/**
 * Range falloff: full damage up to `falloffStart` fraction of weapon range,
 * then linearly down to `falloffFactor` at max range. Never below the factor.
 */
export function damageAtDistance(weapon, distance) {
  const startDist = weapon.range * weapon.falloffStart;
  if (distance <= startDist) return weapon.damage;
  if (distance >= weapon.range) return weapon.damage * weapon.falloffFactor;
  const t = (distance - startDist) / (weapon.range - startDist);
  return weapon.damage * (1 - t * (1 - weapon.falloffFactor));
}

/**
 * Pure damage calculation, identical for player and bots.
 * Armour absorbs `armorAbsorb` of the incoming damage until it is depleted;
 * the remainder (and everything after depletion) hits health.
 * Returns the new values plus a breakdown, so HUD/AI can reason about it.
 */
export function resolveDamage({ health, armor, damage, headshot = false, headMultiplier = COMBAT.headMultiplier }) {
  const raw = Math.max(0, damage) * (headshot ? headMultiplier : 1);
  const armorBefore = Math.max(0, armor);
  const absorbed = Math.min(armorBefore, raw * COMBAT.armorAbsorb);
  const healthLoss = raw - absorbed;
  const newHealth = Math.max(0, health - healthLoss);
  const newArmor = Math.max(0, armorBefore - absorbed);
  return {
    raw,
    armorAbsorbed: absorbed,
    healthLost: Math.min(health, healthLoss),
    health: newHealth,
    armor: newArmor,
    killed: newHealth <= 0 && health > 0,
    headshot,
  };
}

/** Is a shot from `attackerTeam` allowed to hurt `victimTeam`? */
function isFriendly(attackerTeam, victimTeam) {
  return attackerTeam === victimTeam;
}

export function damageAllowed(attackerTeam, victimTeam) {
  if (!isFriendly(attackerTeam, victimTeam)) return true;
  return COMBAT.friendlyFire === true;
}
