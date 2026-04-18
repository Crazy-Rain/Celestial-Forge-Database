const CURVE_MULTIPLIERS = {
  fast: 75,
  medium: 100,
  slow: 150,
};

function nowIso() {
  return new Date().toISOString();
}

function defaultResources() {
  return {
    hp: { current: 100, max: 100 },
    mana: { current: 50, max: 50, regen: 5 },
    cp: { current: 0 },
    money: { current: 0, label: 'Gold', symbol: 'G' },
  };
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function curveThreshold(level, curve = 'medium') {
  const mult = CURVE_MULTIPLIERS[curve] ?? CURVE_MULTIPLIERS.medium;
  return level * mult;
}

function canLevel(perkDef, perkInstance) {
  const scaling = perkDef.scaling || { type: 'none' };
  if (scaling.type === 'none') return false;
  if (scaling.type === 'bounded' && typeof scaling.maxLevel === 'number') {
    return perkInstance.level < scaling.maxLevel;
  }
  return true;
}

function applyXp(perkDef, perkInstance, addedXp) {
  // Sanitize inputs: coerce to finite numbers
  const sanitizedAddedXp = Number.isFinite(addedXp) && addedXp >= 0 ? addedXp : 0;
  const sanitizedXp = Number.isFinite(perkInstance.xp) && perkInstance.xp >= 0 ? perkInstance.xp : 0;
  const sanitizedLevel = Number.isInteger(perkInstance.level) && perkInstance.level >= 0 ? perkInstance.level : 0;

  let xp = sanitizedXp + sanitizedAddedXp;
  let level = sanitizedLevel;
  let leveledTo = [];

  const maxIterations = 1000;
  let iterations = 0;

  while (canLevel(perkDef, { ...perkInstance, level }) && iterations < maxIterations) {
    const threshold = curveThreshold(level, perkDef.scaling?.xpCurve);

    // Safety check: ensure threshold is valid
    if (!Number.isFinite(threshold) || threshold <= 0) {
      break;
    }

    if (xp < threshold) {
      break;
    }

    xp -= threshold;
    level += 1;
    leveledTo.push(level);
    iterations += 1;
  }

  return { xp, level, leveledTo };
}

function applyResourceModification(resources, resource, amount, mode = 'modify') {
  const next = structuredClone(resources);
  if (!next[resource]) {
    next[resource] = { current: 0 };
  }

  if (mode === 'set') {
    next[resource].current = amount;
  } else {
    next[resource].current = (next[resource].current || 0) + amount;
  }

  if (typeof next[resource].max === 'number') {
    next[resource].current = Math.max(0, Math.min(next[resource].current, next[resource].max));
  }

  return next;
}

module.exports = {
  nowIso,
  defaultResources,
  parseJson,
  applyXp,
  applyResourceModification,
};
