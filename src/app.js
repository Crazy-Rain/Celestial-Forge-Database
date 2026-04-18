const express = require('express');
const { randomUUID } = require('crypto');
const { db } = require('./db');
const {
  nowIso,
  defaultResources,
  parseJson,
  applyXp,
  applyResourceModification,
} = require('./engine');

const app = express();
app.use(express.json());

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function getSelectedSessionId() {
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get('selected_session_id');
  return row?.value || null;
}

function setSelectedSessionId(sessionId) {
  db.prepare(
    `INSERT INTO app_state(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run('selected_session_id', sessionId);
}

function getSheet(sessionId) {
  const row = db.prepare('SELECT * FROM character_sheets WHERE session_id = ?').get(sessionId);
  if (!row) return null;

  const perks = db
    .prepare('SELECT perk_id, level, xp, cooldowns_json, acquired_at FROM perk_instances WHERE session_id = ?')
    .all(sessionId)
    .map((r) => ({
      perkId: r.perk_id,
      level: r.level,
      xp: r.xp,
      cooldowns: parseJson(r.cooldowns_json, {}),
      acquiredAt: r.acquired_at,
    }));

  return {
    sessionId: row.session_id,
    name: row.character_name,
    resources: parseJson(row.resources_json, defaultResources()),
    statusEffects: parseJson(row.status_effects_json, []),
    perks,
    turn: row.turn,
  };
}

function getSessionById(sessionId) {
  return db.prepare('SELECT session_id, name, created_at, roll_counter FROM sessions WHERE session_id = ?').get(sessionId);
}

function requireSelectedSession(req, res, { allowImplicit = false } = {}) {
  const explicitId = req.body?.sessionId || req.query?.sessionId;
  const sessionId = typeof explicitId === 'string' && explicitId.trim().length > 0 ? explicitId.trim() : null;

  if (!sessionId && !allowImplicit) {
    res.status(400).json({ error: 'sessionId is required.' });
    return null;
  }

  const finalSessionId = sessionId || getSelectedSessionId();
  if (!finalSessionId) {
    res.status(404).json({ error: 'No selected session. Call POST /session/select first.' });
    return null;
  }

  const existing = getSessionById(finalSessionId);
  if (!existing) {
    res.status(404).json({ error: 'Session not found.' });
    return null;
  }

  return finalSessionId;
}

function appendLog(sessionId, type, payload) {
  db.prepare('INSERT INTO logs(session_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)').run(
    sessionId,
    type,
    JSON.stringify(payload),
    nowIso()
  );
}

function deterministicHash(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seedPerksIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) as c FROM perks').get().c;
  if (count > 0) return;

  const insert = db.prepare(`
    INSERT INTO perks(
      id, name, tier, cost, summary, description, tags_json, scaling_json, engine_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = nowIso();
  const defaults = [
    {
      id: 'fire_magic',
      name: 'Fire Magic',
      tier: 2,
      cost: 150,
      summary: 'Control and generate fire.',
      description: 'Manipulate flame with active and passive applications.',
      tags: ['magic', 'offense'],
      scaling: { type: 'bounded', maxLevel: 10, xpCurve: 'medium' },
      engine: { type: 'active', triggers: ['manual'], effects: [] },
    },
    {
      id: 'mana_flow',
      name: 'Mana Flow',
      tier: 1,
      cost: 100,
      summary: 'Improved mana regeneration each turn.',
      description: 'A passive field that restores mana over time.',
      tags: ['magic', 'resource'],
      scaling: { type: 'bounded', maxLevel: 5, xpCurve: 'fast' },
      engine: {
        type: 'passive',
        triggers: ['end_of_turn'],
        effects: [{ type: 'modify_resource', target: 'mana', amount: 5 }],
      },
    },
  ];

  for (const perk of defaults) {
    insert.run(
      perk.id,
      perk.name,
      perk.tier,
      perk.cost,
      perk.summary,
      perk.description,
      JSON.stringify(perk.tags),
      JSON.stringify(perk.scaling),
      JSON.stringify(perk.engine),
      now
    );
  }
}

seedPerksIfEmpty();

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/session/create', (req, res) => {
  const sessionId = req.body?.sessionId || randomUUID();
  const name = req.body?.name || `Session ${sessionId.slice(0, 8)}`;
  const characterName = req.body?.characterName || 'Character Name';

  if (typeof sessionId !== 'string' || typeof name !== 'string' || typeof characterName !== 'string') {
    return badRequest(res, 'sessionId, name, and characterName must be strings.');
  }

  const createdAt = nowIso();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO sessions(session_id, name, created_at) VALUES (?, ?, ?)').run(sessionId, name, createdAt);
    db.prepare(
      'INSERT INTO character_sheets(session_id, character_name, resources_json, status_effects_json, turn) VALUES (?, ?, ?, ?, 0)'
    ).run(sessionId, characterName, JSON.stringify(defaultResources()), JSON.stringify([]));
    setSelectedSessionId(sessionId);
    appendLog(sessionId, 'session_created', { sessionId, name, characterName, createdAt });
  });

  try {
    tx();
  } catch (err) {
    return badRequest(res, `Unable to create session: ${err.message}`);
  }

  return res.status(201).json({ sessionId, name, selected: true });
});

app.get('/session/list', (_req, res) => {
  const selected = getSelectedSessionId();
  const sessions = db
    .prepare('SELECT session_id, name, created_at FROM sessions ORDER BY created_at DESC')
    .all()
    .map((s) => ({ sessionId: s.session_id, name: s.name, createdAt: s.created_at, selected: selected === s.session_id }));
  res.json({ sessions });
});

app.post('/session/select', (req, res) => {
  const { sessionId } = req.body || {};
  if (typeof sessionId !== 'string') return badRequest(res, 'sessionId is required.');

  const existing = db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(sessionId);
  if (!existing) return res.status(404).json({ error: 'Session not found.' });

  setSelectedSessionId(sessionId);
  res.json({ selectedSessionId: sessionId });
});

app.post('/session/duplicate', (req, res) => {
  const sourceId = req.body?.sessionId || getSelectedSessionId();
  if (!sourceId) return badRequest(res, 'sessionId is required or must have a selected session.');

  const sourceSession = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sourceId);
  const sourceSheet = db.prepare('SELECT * FROM character_sheets WHERE session_id = ?').get(sourceId);
  if (!sourceSession || !sourceSheet) return res.status(404).json({ error: 'Source session not found.' });

  const copyId = randomUUID();
  const copyName = req.body?.name || `${sourceSession.name} (Copy)`;
  const copyCreatedAt = nowIso();

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO sessions(session_id, name, created_at) VALUES (?, ?, ?)').run(copyId, copyName, copyCreatedAt);
    db.prepare(
      'INSERT INTO character_sheets(session_id, character_name, resources_json, status_effects_json, turn) VALUES (?, ?, ?, ?, ?)'
    ).run(copyId, sourceSheet.character_name, sourceSheet.resources_json, sourceSheet.status_effects_json, sourceSheet.turn);

    const sourcePerks = db.prepare('SELECT * FROM perk_instances WHERE session_id = ?').all(sourceId);
    const insertPerk = db.prepare(
      'INSERT INTO perk_instances(session_id, perk_id, level, xp, cooldowns_json, acquired_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const perk of sourcePerks) {
      insertPerk.run(copyId, perk.perk_id, perk.level, perk.xp, perk.cooldowns_json, perk.acquired_at);
    }

    appendLog(copyId, 'session_duplicated', { from: sourceId, to: copyId, createdAt: copyCreatedAt });
  });

  tx();
  res.status(201).json({ sessionId: copyId, name: copyName, copiedFrom: sourceId });
});

app.get('/sheet/full', (_req, res) => {
  const sessionId = requireSelectedSession(_req, res, { allowImplicit: true });
  if (!sessionId) return;
  const sheet = getSheet(sessionId);
  if (!sheet) return res.status(404).json({ error: 'Character sheet not found.' });
  res.json(sheet);
});

app.get('/sheet/summary', (_req, res) => {
  const sessionId = requireSelectedSession(_req, res, { allowImplicit: true });
  if (!sessionId) return;
  const sheet = getSheet(sessionId);
  if (!sheet) return res.status(404).json({ error: 'Character sheet not found.' });

  const perkSummaries = db
    .prepare(
      `SELECT p.id, p.name, p.summary
       FROM perk_instances pi JOIN perks p ON p.id = pi.perk_id
       WHERE pi.session_id = ?`
    )
    .all(sessionId);

  res.json({
    sessionId,
    turn: sheet.turn,
    resources: sheet.resources,
    perks: perkSummaries,
  });
});

app.post('/perk/roll', (req, res) => {
  const sessionId = requireSelectedSession(req, res);
  if (!sessionId) return;
  const tierRaw = req.body?.tier;
  const tier = tierRaw === undefined ? null : Number(tierRaw);
  if (tier !== null && (!Number.isInteger(tier) || tier < 1)) {
    return badRequest(res, 'tier must be a positive integer when provided.');
  }

  const owned = db.prepare('SELECT perk_id FROM perk_instances WHERE session_id = ?').all(sessionId).map((r) => r.perk_id);
  const all = db.prepare('SELECT * FROM perks ORDER BY id ASC').all();

  const filtered = all.filter((p) => (tier ? p.tier === tier : true) && !owned.includes(p.id));
  if (filtered.length === 0) return res.status(404).json({ error: 'No available perks to roll.' });

  const session = getSessionById(sessionId);
  const currentCounter = Number.isInteger(session?.roll_counter) ? session.roll_counter : 0;
  const index = deterministicHash(`${sessionId}:${currentCounter}:${tier ?? 'any'}`) % filtered.length;
  const pick = filtered[index];
  db.prepare('UPDATE sessions SET roll_counter = ? WHERE session_id = ?').run(currentCounter + 1, sessionId);

  res.json({
    perk: {
      id: pick.id,
      name: pick.name,
      tier: pick.tier,
      cost: pick.cost,
      summary: pick.summary,
      tags: parseJson(pick.tags_json, []),
      scaling: parseJson(pick.scaling_json, {}),
      engine: parseJson(pick.engine_json, {}),
    },
  });
});

app.post('/perk/buy', (req, res) => {
  const sessionId = requireSelectedSession(req, res);
  if (!sessionId) return;
  const { perkId } = req.body || {};
  if (typeof perkId !== 'string') return badRequest(res, 'perkId is required.');

  const perk = db.prepare('SELECT * FROM perks WHERE id = ?').get(perkId);
  if (!perk) return res.status(404).json({ error: 'Perk not found.' });

  const sheet = getSheet(sessionId);
  if (sheet.perks.some((p) => p.perkId === perkId)) return badRequest(res, 'Perk already owned.');
  if ((sheet.resources.cp.current || 0) < perk.cost) return badRequest(res, 'Insufficient CP.');

  const tx = db.transaction(() => {
    const resources = applyResourceModification(sheet.resources, 'cp', -perk.cost, 'modify');
    db.prepare('UPDATE character_sheets SET resources_json = ? WHERE session_id = ?').run(JSON.stringify(resources), sessionId);
    db.prepare(
      'INSERT INTO perk_instances(session_id, perk_id, level, xp, cooldowns_json, acquired_at) VALUES (?, ?, 1, 0, ?, ?)'
    ).run(sessionId, perkId, JSON.stringify({}), nowIso());
    appendLog(sessionId, 'perk_bought', { perkId, cost: perk.cost });
  });
  tx();

  res.status(201).json({ purchased: perkId, cost: perk.cost });
});

app.get('/perk/:id', (req, res) => {
  const perk = db.prepare('SELECT * FROM perks WHERE id = ?').get(req.params.id);
  if (!perk) return res.status(404).json({ error: 'Perk not found.' });

  res.json({
    id: perk.id,
    name: perk.name,
    tier: perk.tier,
    cost: perk.cost,
    summary: perk.summary,
    description: perk.description,
    tags: parseJson(perk.tags_json, []),
    scaling: parseJson(perk.scaling_json, {}),
    engine: parseJson(perk.engine_json, {}),
  });
});

app.post('/xp/add', (req, res) => {
  const sessionId = requireSelectedSession(req, res);
  if (!sessionId) return;
  const { perkId, amount } = req.body || {};
  if (typeof perkId !== 'string' || !Number.isFinite(amount) || amount < 0) {
    return badRequest(res, 'perkId and non-negative finite amount are required.');
  }

  const owned = db.prepare('SELECT * FROM perk_instances WHERE session_id = ? AND perk_id = ?').get(sessionId, perkId);
  if (!owned) return res.status(404).json({ error: 'Perk instance not found.' });

  const def = db.prepare('SELECT * FROM perks WHERE id = ?').get(perkId);
  const perkDef = { scaling: parseJson(def.scaling_json, { type: 'none' }) };
  const result = applyXp(perkDef, { level: owned.level, xp: owned.xp }, amount);

  db.prepare('UPDATE perk_instances SET level = ?, xp = ? WHERE id = ?').run(result.level, result.xp, owned.id);
  appendLog(sessionId, 'xp_add', { perkId, amount, level: result.level, xp: result.xp });

  res.json({ perkId, amount, level: result.level, xp: result.xp, leveledTo: result.leveledTo });
});

app.post('/resource/modify', (req, res) => {
  const sessionId = requireSelectedSession(req, res);
  if (!sessionId) return;
  const { resource, amount, reason } = req.body || {};
  if (typeof resource !== 'string' || !Number.isFinite(amount) || amount < 0 || !Number.isInteger(amount)) {
    return badRequest(res, 'resource and non-negative integer amount are required.');
  }

  const sheet = getSheet(sessionId);
  const oldValue = sheet.resources?.[resource]?.current || 0;
  const resources = applyResourceModification(sheet.resources, resource, amount, 'modify');

  db.prepare('UPDATE character_sheets SET resources_json = ? WHERE session_id = ?').run(JSON.stringify(resources), sessionId);
  appendLog(sessionId, 'resource_modify', {
    resource,
    oldValue,
    newValue: resources[resource].current,
    amount,
    reason: reason || null,
  });

  res.json({ resource, oldValue, newValue: resources[resource].current });
});

app.post('/resource/set', (req, res) => {
  const sessionId = requireSelectedSession(req, res);
  if (!sessionId) return;
  const { resource, value, reason } = req.body || {};
  if (typeof resource !== 'string' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    return badRequest(res, 'resource and non-negative integer value are required.');
  }

  const sheet = getSheet(sessionId);
  const oldValue = sheet.resources?.[resource]?.current || 0;
  const resources = applyResourceModification(sheet.resources, resource, value, 'set');

  db.prepare('UPDATE character_sheets SET resources_json = ? WHERE session_id = ?').run(JSON.stringify(resources), sessionId);
  appendLog(sessionId, 'override', {
    type: 'override',
    resource,
    oldValue,
    newValue: resources[resource].current,
    reason: reason || 'manual_set',
    timestamp: nowIso(),
  });

  res.json({ resource, oldValue, newValue: resources[resource].current });
});

app.post('/perk/generate', (req, res) => {
  const { theme, tier, constellation } = req.body || {};
  if (typeof theme !== 'string' || !Number.isFinite(tier) || !Number.isInteger(tier) || tier < 1 || typeof constellation !== 'string') {
    return badRequest(res, 'theme, positive integer tier, and constellation are required.');
  }

  const normalizedRaw = theme.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const normalized = normalizedRaw || 'perk';
  const id = `${normalized}_${randomUUID()}`;
  const perk = {
    id,
    name: `${theme} Attunement`,
    tier,
    cost: tier * 100,
    summary: `Harness ${theme} through constellation ${constellation}.`,
    description: `AI-generated style perk for ${theme}.`,
    tags: [constellation.toLowerCase(), 'generated'],
    scaling: { type: 'bounded', maxLevel: 10, xpCurve: 'medium' },
    engine: { type: 'narrative', triggers: ['manual'], effects: [{ type: 'custom', detail: 'narrative_only' }] },
  };

  db.prepare(
    `INSERT INTO perks(id, name, tier, cost, summary, description, tags_json, scaling_json, engine_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    perk.id,
    perk.name,
    perk.tier,
    perk.cost,
    perk.summary,
    perk.description,
    JSON.stringify(perk.tags),
    JSON.stringify(perk.scaling),
    JSON.stringify(perk.engine),
    nowIso()
  );

  res.status(201).json({ perk });
});

app.post('/turn/finalize', (req, res) => {
  const sessionId = requireSelectedSession(req, res);
  if (!sessionId) return;

  const sheet = getSheet(sessionId);
  const updates = [];
  const resources = structuredClone(sheet.resources);

  if (resources.mana && typeof resources.mana.regen === 'number') {
    const before = resources.mana.current;
    resources.mana.current = Math.min(resources.mana.max || Number.MAX_SAFE_INTEGER, before + resources.mana.regen);
    if (resources.mana.current !== before) {
      updates.push(`+${resources.mana.current - before} Mana regenerated`);
    }
  }

  const owned = db.prepare('SELECT * FROM perk_instances WHERE session_id = ?').all(sessionId);
  for (const instance of owned) {
    const def = db.prepare('SELECT * FROM perks WHERE id = ?').get(instance.perk_id);
    const engine = parseJson(def.engine_json, {});
    const effects = engine.triggers?.includes('end_of_turn') ? engine.effects || [] : [];

    for (const effect of effects) {
      if (effect.type === 'modify_resource' && typeof effect.target === 'string' && typeof effect.amount === 'number') {
        const prev = resources[effect.target]?.current || 0;
        const changed = applyResourceModification(resources, effect.target, effect.amount, 'modify');
        Object.assign(resources, changed);
        const nextVal = resources[effect.target]?.current || 0;
        if (nextVal !== prev) updates.push(`${effect.amount >= 0 ? '+' : ''}${effect.amount} ${effect.target.toUpperCase()} (${def.name})`);
      }
    }
  }

  const xpGains = Array.isArray(req.body?.xpGains) ? req.body.xpGains : [];
  const perkUpdates = [];
  for (const gain of xpGains) {
    if (
      !gain ||
      typeof gain.perkId !== 'string' ||
      !Number.isFinite(gain.amount) ||
      gain.amount < 0 ||
      !Number.isInteger(gain.amount)
    ) {
      return badRequest(res, 'Each xpGain must include perkId and a non-negative integer amount.');
    }
    const ownedPerk = db
      .prepare('SELECT * FROM perk_instances WHERE session_id = ? AND perk_id = ?')
      .get(sessionId, gain.perkId);
    const def = db.prepare('SELECT * FROM perks WHERE id = ?').get(gain.perkId);
    if (!ownedPerk || !def) continue;

    const result = applyXp({ scaling: parseJson(def.scaling_json, { type: 'none' }) }, { level: ownedPerk.level, xp: ownedPerk.xp }, gain.amount);
    perkUpdates.push({ id: ownedPerk.id, level: result.level, xp: result.xp });

    updates.push(`+${gain.amount} XP (${def.name})`);
    for (const lvl of result.leveledTo) {
      updates.push(`${def.name} leveled up to ${lvl}`);
    }
  }

  const newTurn = sheet.turn + 1;
  const tx = db.transaction(() => {
    const updatePerk = db.prepare('UPDATE perk_instances SET level = ?, xp = ? WHERE id = ?');
    for (const perkUpdate of perkUpdates) {
      updatePerk.run(perkUpdate.level, perkUpdate.xp, perkUpdate.id);
    }
    db.prepare('UPDATE character_sheets SET resources_json = ?, turn = ? WHERE session_id = ?').run(
      JSON.stringify(resources),
      newTurn,
      sessionId
    );

    appendLog(sessionId, 'turn_finalize', { turn: newTurn, updates });
  });

  try {
    tx();
  } catch (err) {
    return res.status(500).json({ error: `Failed to finalize turn: ${err.message}` });
  }

  res.json({ turn: newTurn, updates });
});

module.exports = { app };
