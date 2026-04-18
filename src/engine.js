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
  const safeAddedXp = Number.isFinite(addedXp) ? Math.max(0, addedXp) : 0;
  let xpBase = Number.isFinite(perkInstance?.xp) ? perkInstance.xp : 0;
  let level = Number.isFinite(perkInstance?.level) ? Math.trunc(perkInstance.level) : 0;
  xpBase = Math.max(0, xpBase);
  level = Math.max(0, level);

  let xp = xpBase + safeAddedXp;
  let leveledTo = [];
  let iterations = 0;
  const maxIterations = 10000;

  while (canLevel(perkDef, { ...perkInstance, level }) && iterations < maxIterations) {
    const threshold = curveThreshold(level, perkDef.scaling?.xpCurve);
    if (!Number.isFinite(threshold) || threshold <= 0 || xp < threshold) break;
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
