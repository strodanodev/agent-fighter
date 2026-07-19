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

  it('GET /agent/matches maps rows sub-centric after a settled match', async () => {
    const key = (globalThis as Record<string, unknown>).__key as string;
    const res = await fetch(`${http}/agent/matches`, { headers: { 'X-Agent-Key': key } });
    assert.equal(res.status, 200);
    const { matches } = await res.json() as { matches: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(matches), 'matches array present (empty until the owner plays)');
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
    // …and the coach can now read it back sub-centric.
    const hist = await fetch(`${http}/agent/matches`, { headers: { 'X-Agent-Key': key } });
    const { matches } = await hist.json() as { matches: Array<{ won: boolean | null; mode: string; opponent: string }> };
    assert.equal(matches.length, 1);
    assert.equal(typeof matches[0]!.won, 'boolean', 'decided match maps to won:true/false');
  });
});

describe('match ids survive server restarts (settlement-drop regression)', () => {
  it('two server lifetimes over ONE durable persistence never collide ids', async () => {
    // The DB settles idempotently BY MATCH ID. A per-process counter reused
    // `m1, m2, …` after every restart, so post-restart settlements silently
    // no-opped against the old rows (found live on prod). The shared memory
    // persistence here plays the role of the durable DB.
    const shared = memoryPersistence();
    const play = async (): Promise<void> => {
      const s = await createMatchServer({ port: 0, persistence: shared, noPaceCheck: true });
      try {
        const r = await playOneMatch({
          url: `ws://localhost:${s.port}`,
          name: 'Restarter', character: 'analog', skill: 60,
          charactersDir, aiSeed: 3, paceMs: 1, mode: 'solo',
        });
        assert.equal(r.result.reason, 'verified');
      } finally { s.close(); }
    };
    await play(); // lifetime 1 → its m…-1 settles
    await play(); // lifetime 2 → would have been m1 again pre-fix
    const acc = await shared.getAccount({ sub: 'dev:Restarter' }, 'Restarter', false);
    assert.equal(acc.wins + acc.losses, 2,
      'BOTH lifetimes settled — a colliding id would have silently dropped the second');
  });
});

describe('agent-class signup (operator-owned, inert)', () => {
  let server: MatchServer;
  let mem: Persistence;
  let http = '';

  before(async () => {
    mem = memoryPersistence();
    server = await createMatchServer({ port: 0, persistence: mem, noPaceCheck: true });
    http = `http://localhost:${server.port}`;
  });
  after(() => server.close());

  it('POST /agent/signup requires a signed-in operator', async () => {
    const res = await fetch(`${http}/agent/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NoAuthBot' }),
    });
    assert.equal(res.status, 401);
  });

  it('POST /agent/signup (owner auth) creates a rank-only account and the key plays arcade FREE', async () => {
    // Operator profile must exist first (same prerequisite as /agent/key).
    await fetch(`${http}/me`, { headers: { 'X-Dev-Name': 'OpCrusher' } });
    const res = await fetch(`${http}/agent/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-Name': 'OpCrusher' },
      body: JSON.stringify({ name: 'CrusherBot' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { sub: string; name: string; key: string; owner: string };
    assert.match(body.sub, /^agent:/);
    assert.match(body.key, /^afk_/);
    assert.equal(body.owner, 'dev:OpCrusher');

    // The key reads the fresh profile.
    const info = await fetch(`${http}/agent`, { headers: { 'X-Agent-Key': body.key } });
    assert.equal(info.status, 200);
    const agent = await info.json() as { name: string; level: number };
    assert.equal(agent.name, 'CrusherBot');

    // Arcade battle 1 runs with ZERO credits (fee waived for the class) and
    // settles XP on the agent account.
    const r = await playOneMatch({
      url: `ws://localhost:${server.port}`,
      name: 'CrusherBot', character: 'vector', skill: 80,
      charactersDir, aiSeed: 7, paceMs: 1, mode: 'arcade',
      agentKey: body.key,
    });
    assert.equal(r.result.reason, 'verified');
    assert.ok(r.arcade, 'arcade run info surfaced');
    assert.equal(r.arcade!.battle, 0, 'battle 1 of the run');

    const after = await (await fetch(`${http}/agent`, { headers: { 'X-Agent-Key': body.key } })).json() as { wins: number; losses: number; xp: number };
    assert.equal(after.wins + after.losses, 1, 'battle settled on the agent account');
  });

  it('signup with empty name auto-derives from the operator profile', async () => {
    await fetch(`${http}/me`, { headers: { 'X-Dev-Name': 'OpAuto' } });
    const res = await fetch(`${http}/agent/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-Name': 'OpAuto' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { name: string; key: string; owner: string };
    assert.match(body.key, /^afk_/);
    assert.equal(body.owner, 'dev:OpAuto');
    assert.ok(body.name.length >= 3);
  });

  it('wager stays unreachable for the inert class (0 credits, no daily)', async () => {
    await fetch(`${http}/me`, { headers: { 'X-Dev-Name': 'OpBroke' } });
    const res = await fetch(`${http}/agent/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-Name': 'OpBroke' },
      body: JSON.stringify({ name: 'BrokeBot' }),
    });
    assert.equal(res.status, 200);
    const { key } = await res.json() as { key: string };
    await assert.rejects(
      playOneMatch({
        url: `ws://localhost:${server.port}`,
        name: 'BrokeBot', character: 'analog', skill: 50,
        charactersDir, aiSeed: 9, paceMs: 1, mode: 'wager',
        agentKey: key,
      }),
      /credit/i,
      'wager needs credits the agent class can never hold',
    );
  });
});

describe('dare-vs-agent / sparring (solo agentOf, ADR 0006)', () => {
  let server: MatchServer;
  let mem: Persistence;
  let http = '';
  let rivalCode = ''; // RIVAL's public dare code — what rides the share link
  const RIVAL = { 'X-Dev-Name': 'Rival' };

  before(async () => {
    mem = memoryPersistence();
    server = await createMatchServer({ port: 0, persistence: mem, noPaceCheck: true });
    http = `http://localhost:${server.port}`;
    // RIVAL: profile + coached config (over-max aggression must clamp).
    const me = await (await fetch(`${http}/me`, { headers: RIVAL })).json() as { refCode: string };
    rivalCode = me.refCode;
    assert.ok(rivalCode, 'dev economy issues a dare code');
    const put = await fetch(`${http}/agent`, {
      method: 'PUT', headers: RIVAL,
      body: JSON.stringify({
        character: 'vector',
        personality: { aggression: 100000, zoner: 60 },
        motto: 'fear the grid',
      }),
    });
    assert.equal(put.status, 200);
  });
  after(() => server.close());

  it('pins the coached character + CLAMPED personality into the solo setup', async () => {
    // Raw ws client: assert the actual wire setup (playOneMatch hides it).
    const { WebSocket } = await import('ws');
    const { PROTOCOL_VERSION } = await import('../src/protocol.js');
    const { ENGINE_VERSION } = await import('@af/core');
    const setup = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${server.port}`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'Hero', engine: ENGINE_VERSION }));
        ws.send(JSON.stringify({ t: 'queue', character: 'analog', mode: 'solo', agentOf: rivalCode }));
      });
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as Record<string, unknown>;
        if (m.t === 'match') { ws.close(); resolve(m); }
        if (m.t === 'error') { ws.close(); reject(new Error(String(m.msg))); }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('no setup within 5s')), 5000).unref();
    });
    const solo = setup.solo as { skill: number; personality?: Record<string, number> };
    assert.ok(solo, 'still a local-sim solo match');
    assert.equal((setup.chars as Array<{ id: string }>)[1]!.id, 'vector', "opponent is the RIVAL's coached character");
    assert.ok(solo.personality, 'personality pinned in the setup');
    assert.equal(solo.personality!.aggression, AI_PERSONALITY_RANGES.aggression[1],
      'over-max coaching arrives CLAMPED — a DB row can never smuggle range-breaking knobs');
    assert.equal(solo.personality!.zoner, 60);
    assert.match((setup.names as string[])[1]!, /RIVAL'S AGENT/, 'billed as the owner\'s agent, not HOUSE');
  });

  it('the full loop verifies and settles on the CHALLENGER only', async () => {
    const before = await mem.getAccount({ sub: 'dev:Rival' }, 'Rival', false);
    const r = await playOneMatch({
      url: `ws://localhost:${server.port}`,
      name: 'Hero', character: 'analog', skill: 55,
      charactersDir, aiSeed: 11, paceMs: 1, mode: 'solo',
      agentOf: rivalCode,
    });
    assert.equal(r.result.reason, 'verified',
      'the local sim honored the pinned personality — re-sim agrees');
    assert.equal(r.localHash, r.result.hash >>> 0, 'no desync');
    const hero = await mem.getAccount({ sub: 'dev:Hero' }, 'Hero', false);
    assert.equal(hero.wins + hero.losses, 1, 'challenger settled');
    const rival = await mem.getAccount({ sub: 'dev:Rival' }, 'Rival', false);
    assert.equal(rival.wins + rival.losses, before.wins + before.losses,
      "the agent's OWNER is not a party — no W-L, no payout (economy v1)");
  });

  it('sparring = your own code (the coach → spar → adjust loop)', async () => {
    const r = await playOneMatch({
      url: `ws://localhost:${server.port}`,
      name: 'Rival', character: 'analog', skill: 55,
      charactersDir, aiSeed: 13, paceMs: 1, mode: 'solo',
      agentOf: rivalCode,
    });
    assert.equal(r.result.reason, 'verified');
  });

  it('bad codes fail clean BEFORE any fee moves', async () => {
    const heroBefore = await mem.getAccount({ sub: 'dev:Hero' }, 'Hero', false);
    await assert.rejects(
      playOneMatch({
        url: `ws://localhost:${server.port}`,
        name: 'Hero', character: 'analog', skill: 55,
        charactersDir, aiSeed: 17, paceMs: 1, mode: 'solo',
        agentOf: 'NOBODY-9999',
      }),
      /no fighter behind that code/,
    );
    // An existing profile with NO coached config is also a clean error.
    await fetch(`${http}/me`, { headers: { 'X-Dev-Name': 'Untrained' } });
    const untrained = await (await fetch(`${http}/me`, { headers: { 'X-Dev-Name': 'Untrained' } })).json() as { refCode: string };
    await assert.rejects(
      playOneMatch({
        url: `ws://localhost:${server.port}`,
        name: 'Hero', character: 'analog', skill: 55,
        charactersDir, aiSeed: 19, paceMs: 1, mode: 'solo',
        agentOf: untrained.refCode,
      }),
      /has not trained an agent yet/,
    );
    const heroAfter = await mem.getAccount({ sub: 'dev:Hero' }, 'Hero', false);
    assert.equal(heroAfter.credits, heroBefore.credits, 'no fee was escrowed for either failure');
  });
});
