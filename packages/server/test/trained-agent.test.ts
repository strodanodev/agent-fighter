/**
 * TRAIN MY AGENT (ADR 0006): durable agent keys + coached personality.
 *
 *  · /agent/key mints once, owner-auth only; the key authenticates /agent
 *    and the ws hello, always as a DECLARED agent under the owner's profile.
 *  · PUT /agent clamps style knobs to core AI_PERSONALITY_RANGES and
 *    validates the character — stats/skill are untouchable by construction.
 *  · createAi(personality) is deterministic and clamp-equal to the server.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_PERSONALITY_RANGES, createAi } from '@af/core';
import { createMatchServer } from '../src/server.js';
import type { MatchServer } from '../src/server.js';
import { memoryPersistence } from '../src/persist.js';
import type { Persistence } from '../src/persist.js';
import { playOneMatch } from '../src/agent-session.js';

const here = dirname(fileURLToPath(import.meta.url));
const charactersDir = join(here, '..', '..', '..', 'characters');

describe('core: coached personality override', () => {
  it('clamps to AI_PERSONALITY_RANGES and leaves unspecified knobs sampled', () => {
    const base = createAi(0, 60, 12345);
    const coached = createAi(0, 60, 12345, { aggression: 9999, patience: -5 });
    assert.equal(coached.p.aggression, AI_PERSONALITY_RANGES.aggression[1], 'over-max clamps to max');
    assert.equal(coached.p.patience, AI_PERSONALITY_RANGES.patience[0], 'under-min clamps to min');
    // Untouched knobs keep the seed-sampled values — the rng stream is
    // identical with and without an override.
    assert.equal(coached.p.zoner, base.p.zoner);
    assert.equal(coached.p.jumpiness, base.p.jumpiness);
    assert.equal(coached.rng, base.rng, 'override must not consume rng');
  });

  it('ignores unknown and non-numeric knobs', () => {
    const base = createAi(1, 40, 777);
    const coached = createAi(1, 40, 777, {
      skill: 100, damage: 100, aggression: Number.NaN,
    } as Record<string, number>);
    assert.deepEqual(coached.p, base.p, 'nothing legitimate was overridden');
    assert.equal(coached.skill, 40, 'skill is not a personality knob');
  });
});

describe('agent key + config API', () => {
  let server: MatchServer;
  let mem: Persistence;
  let http = '';
  const OWNER = { 'X-Dev-Name': 'Coach' };

  before(async () => {
    mem = memoryPersistence();
    server = await createMatchServer({ port: 0, persistence: mem, noPaceCheck: true });
    http = `http://localhost:${server.port}`;
    // First authed contact creates the profile (and claims the daily 10).
    const me = await fetch(`${http}/me`, { headers: OWNER });
    assert.equal(me.status, 200);
  });
  after(() => server.close());

  it('mints a key (owner-auth only), and the key reads the profile', async () => {
    // A random key nobody minted is rejected.
    const nope = await fetch(`${http}/agent`, { headers: { 'X-Agent-Key': 'afk_not_real' } });
    assert.equal(nope.status, 401);

    const mint = await fetch(`${http}/agent/key`, { method: 'POST', headers: OWNER });
    assert.equal(mint.status, 200);
    const { key } = await mint.json() as { key: string };
    assert.match(key, /^afk_[0-9a-f]{48}$/);

    // The key must NOT be able to mint (rotate) keys — owner sessions only.
    const rotate = await fetch(`${http}/agent/key`, { method: 'POST', headers: { 'X-Agent-Key': key } });
    assert.equal(rotate.status, 403);

    const info = await fetch(`${http}/agent`, { headers: { 'X-Agent-Key': key } });
    assert.equal(info.status, 200);
    const body = await info.json() as { name: string; config: unknown; ranges: unknown };
    assert.equal(body.name, 'Coach');
    assert.equal(body.config, null, 'no coaching yet');
    assert.ok(body.ranges, 'ranges ride along for the coach UI/skill');

    (globalThis as Record<string, unknown>).__key = key; // later cases
  });

  it('PUT /agent clamps personality, validates character, merges partials', async () => {
    const key = (globalThis as Record<string, unknown>).__key as string;
    const bad = await fetch(`${http}/agent`, {
      method: 'PUT', headers: { 'X-Agent-Key': key },
      body: JSON.stringify({ character: 'notachar' }),
    });
    assert.equal(bad.status, 400, 'unknown character rejected');

    const put = await fetch(`${http}/agent`, {
      method: 'PUT', headers: { 'X-Agent-Key': key },
      body: JSON.stringify({
        character: 'vector',
        personality: { aggression: 100000, zoner: 60, hitpoints: 9999 },
        motto: 'fear the grid',
      }),
    });
    assert.equal(put.status, 200);
    const { config } = await put.json() as { config: { character: string; personality: Record<string, number>; motto: string } };
    assert.equal(config.character, 'vector');
    assert.equal(config.personality.aggression, AI_PERSONALITY_RANGES.aggression[1], 'clamped');
    assert.equal(config.personality.zoner, 60);
    assert.equal(config.personality.hitpoints, undefined, 'unknown knobs dropped');

    // Partial update: nudge one knob, keep the rest.
    const nudge = await fetch(`${http}/agent`, {
      method: 'PUT', headers: { 'X-Agent-Key': key },
      body: JSON.stringify({ personality: { patience: 200 } }),
    });
    const merged = (await nudge.json() as { config: { character: string; personality: Record<string, number> } }).config;
    assert.equal(merged.character, 'vector', 'character survives a knob-only PUT');
    assert.equal(merged.personality.zoner, 60, 'previous coaching survives');
    assert.equal(merged.personality.patience, 200);
  });

  it('the key authenticates a ws match as the OWNER, declared as an agent', async () => {
    const key = (globalThis as Record<string, unknown>).__key as string;
    const { result } = await playOneMatch({
      url: `ws://localhost:${server.port}`,
      name: 'CoachBot', character: 'vector', skill: 55,
      charactersDir, aiSeed: 42, paceMs: 1, mode: 'solo',
      agentKey: key,
      personality: { aggression: 220, zoner: 60 },
    });
    assert.equal(result.reason, 'verified');
    // The match settled on the OWNER's profile (dev:Coach), not an anon one.
    const info = await fetch(`${http}/agent`, { headers: { 'X-Agent-Key': key } });
    const body = await info.json() as { wins: number; losses: number };
    assert.equal(body.wins + body.losses, 1, 'owner profile carries the W-L');
  });
});
