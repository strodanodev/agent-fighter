/**
 * VENDING MACHINE (ADR 0007 Phase 1): gacha energy drinks for credits.
 *
 *  · POST /items/buy debits ITEM_COST atomically and grants a server-rolled
 *    item from the @af/core registry; GET /items lists catalog + inventory.
 *  · Purchases are IDEMPOTENT by client nonce — a retry replays the stored
 *    grant (no double charge, no re-roll).
 *  · Insufficient balance is a clean 402 {code:'credits'}; auth is owner
 *    only (agent keys are refused by construction — the route never accepts
 *    X-Agent-Key, so a leaked coach key cannot spend credits on cans).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION, ITEMS, ITEM_COST } from '@af/core';
import { WebSocket } from 'ws';
import { createMatchServer } from '../src/server.js';
import type { MatchServer } from '../src/server.js';
import { memoryPersistence, DAILY_CREDITS } from '../src/persist.js';
import type { Persistence } from '../src/persist.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { ServerMsg } from '../src/protocol.js';
import { playOneMatch } from '../src/agent-session.js';

const here = dirname(fileURLToPath(import.meta.url));
const charactersDir = join(here, '..', '..', '..', 'characters');

describe('vending machine (ADR 0007 Phase 1)', () => {
  let server: MatchServer;
  let mem: Persistence;
  let http = '';
  const BUYER = { 'X-Dev-Name': 'Thirsty', 'Content-Type': 'application/json' };

  before(async () => {
    mem = memoryPersistence();
    server = await createMatchServer({ port: 0, persistence: mem, noPaceCheck: true });
    http = `http://localhost:${server.port}`;
    // First authed contact creates the profile + claims the daily grant.
    const me = await fetch(`${http}/me`, { headers: BUYER });
    assert.equal(me.status, 200);
    const acct = await me.json() as { credits: number };
    assert.equal(acct.credits, DAILY_CREDITS, 'daily grant = the shop budget');
  });
  after(() => server.close());

  it('requires sign-in', async () => {
    const bare = await fetch(`${http}/items`);
    assert.equal(bare.status, 401);
    // Agent keys are NOT accepted on the shop — owner sessions only.
    const keyed = await fetch(`${http}/items`, { headers: { 'X-Agent-Key': 'afk_whatever' } });
    assert.equal(keyed.status, 401);
  });

  it('GET /items: catalog + empty inventory + price', async () => {
    const res = await fetch(`${http}/items`, { headers: BUYER });
    assert.equal(res.status, 200);
    const body = await res.json() as { cost: number; catalog: unknown[]; items: unknown[] };
    assert.equal(body.cost, ITEM_COST);
    assert.equal(body.catalog.length, ITEMS.length, 'full drink registry rides along');
    assert.deepEqual(body.items, [], 'nothing owned yet');
  });

  it('rejects a missing/short nonce', async () => {
    const res = await fetch(`${http}/items/buy`, {
      method: 'POST', headers: BUYER, body: JSON.stringify({ nonce: 'x' }),
    });
    assert.equal(res.status, 400);
  });

  it('a pull debits the cost and grants a registry item', async () => {
    const res = await fetch(`${http}/items/buy`, {
      method: 'POST', headers: BUYER, body: JSON.stringify({ nonce: 'pull-0001' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      item: { id: string; tier: number }; rowId: number; credits: number; duplicate: boolean;
    };
    assert.equal(body.duplicate, false);
    assert.equal(body.credits, DAILY_CREDITS - ITEM_COST, 'exactly one pull charged');
    assert.ok(ITEMS.some((i) => i.id === body.item.id), 'granted item is in the registry');
    assert.ok(body.item.tier >= 1 && body.item.tier <= 3, 'tier in range');

    const inv = await fetch(`${http}/items`, { headers: BUYER });
    const list = (await inv.json() as { items: Array<{ rowId: number; itemId: string }> }).items;
    assert.equal(list.length, 1, 'inventory grew');
    assert.equal(list[0]!.itemId, body.item.id);

    (globalThis as Record<string, unknown>).__pull1 = body;
  });

  it('replaying the same nonce charges nothing and never re-rolls', async () => {
    const first = (globalThis as Record<string, unknown>).__pull1 as {
      item: { id: string }; rowId: number; credits: number;
    };
    const res = await fetch(`${http}/items/buy`, {
      method: 'POST', headers: BUYER, body: JSON.stringify({ nonce: 'pull-0001' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      item: { id: string }; rowId: number; credits: number; duplicate: boolean; cost: number;
    };
    assert.equal(body.duplicate, true);
    assert.equal(body.cost, 0, 'replay is free');
    assert.equal(body.credits, first.credits, 'balance untouched');
    assert.equal(body.item.id, first.item.id, 'the STORED grant wins — a retry cannot fish for a better can');
    assert.equal(body.rowId, first.rowId);

    const inv = await fetch(`${http}/items`, { headers: BUYER });
    const list = (await inv.json() as { items: unknown[] }).items;
    assert.equal(list.length, 1, 'no duplicate row');
  });

  it('an empty wallet gets a clean 402, nothing granted', async () => {
    // Daily 10 − pull 5 = 5 left: exactly one more pull, then broke.
    const second = await fetch(`${http}/items/buy`, {
      method: 'POST', headers: BUYER, body: JSON.stringify({ nonce: 'pull-0002' }),
    });
    assert.equal(second.status, 200);
    assert.equal((await second.json() as { credits: number }).credits, 0);

    const broke = await fetch(`${http}/items/buy`, {
      method: 'POST', headers: BUYER, body: JSON.stringify({ nonce: 'pull-0003' }),
    });
    assert.equal(broke.status, 402);
    assert.equal((await broke.json() as { code: string }).code, 'credits');

    const inv = await fetch(`${http}/items`, { headers: BUYER });
    const list = (await inv.json() as { items: unknown[] }).items;
    assert.equal(list.length, 2, 'the failed pull granted nothing');
  });
});

/**
 * PHASE 2 — drinks in matches: consume at pair time, pin into the setup,
 * verify the buffed sim end-to-end, release on a no-contest.
 */
describe('consumables in matches (ADR 0007 Phase 2)', () => {
  let server: MatchServer;
  let mem: Persistence;
  let http = '';
  // Each case plays a FRESH dev identity: the daily 10 buys one 5 CR drink
  // plus fees with room to spare, so no case can bankrupt the next.
  const hdr = (who: string): Record<string, string> =>
    ({ 'X-Dev-Name': who, 'Content-Type': 'application/json' });

  const buy = async (who: string, nonce: string): Promise<{ rowId: number; itemId: string }> => {
    await fetch(`${http}/me`, { headers: hdr(who) }); // profile + daily 10
    const res = await fetch(`${http}/items/buy`, {
      method: 'POST', headers: hdr(who), body: JSON.stringify({ nonce }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { rowId: number; item: { id: string } };
    return { rowId: body.rowId, itemId: body.item.id };
  };

  const inventory = async (who: string): Promise<number[]> => {
    const res = await fetch(`${http}/items`, { headers: hdr(who) });
    return (await res.json() as { items: Array<{ rowId: number }> }).items.map((i) => i.rowId);
  };

  before(async () => {
    mem = memoryPersistence();
    // Short idle window: the no-contest release test goes silent on purpose.
    server = await createMatchServer({ port: 0, persistence: mem, noPaceCheck: true, idleForfeitMs: 700 });
    http = `http://localhost:${server.port}`;
  });
  after(() => {
    for (const ws of wagerSockets) { try { ws.close(); } catch { /* already closed */ } }
    server.close();
  });

  it('a solo match with a drink pins it, verifies end-to-end, and consumes it', async () => {
    const drink = await buy('Drinker', 'phase2-pull-1');
    assert.deepEqual(await inventory('Drinker'), [drink.rowId]);

    // The reference client sims the match itself — it applies the pinned
    // items from the setup echo, so a VERIFIED result here proves both ends
    // (client sim + server re-sim) agreed on the BUFFED simulation. If the
    // verifier forgot installItems, the hashes/outcome would diverge.
    const r = await playOneMatch({
      url: `ws://localhost:${server.port}`,
      name: 'Drinker', character: 'analog', skill: 60,
      charactersDir, aiSeed: 41, paceMs: 1, mode: 'solo',
      item: drink.rowId,
    });
    assert.equal(r.result.reason, 'verified');
    assert.equal(r.result.deviator, undefined, 'no side flagged — both simmed the same buffed match');
    assert.equal(r.result.hash, r.localHash, 'client and verifier agree bit-for-bit');

    assert.deepEqual(await inventory('Drinker'), [], 'the drink was consumed by playing');
  });

  it('the setup echoes the pinned drink (and a bogus rowId yields an item-less match)', async () => {
    const drink = await buy('Echoer', 'phase2-pull-2');
    const setupWith = await rawSolo(server.port, 'Echoer', drink.rowId);
    const items = setupWith.items as Array<{ id: string } | null> | undefined;
    assert.ok(items?.[0], 'side 0 carries the drink');
    assert.equal(items[0]!.id, drink.itemId);
    assert.equal(items[1], null, 'the house drinks nothing');

    // The abandoned socket settles as forfeit/incomplete eventually; either
    // way the NEXT queue with a bogus row must be clean and item-less.
    const setupBogus = await rawSolo(server.port, 'Echoer', 999999);
    assert.equal(setupBogus.items, undefined, 'bogus rowId → no pin, match still starts');
  });

  it('a silent no-contest hands the drink back', async () => {
    const drink = await buy('Ghost', 'phase2-pull-3');
    const ws = new WebSocket(`ws://localhost:${server.port}`);
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('no result before timeout')); }, 15_000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'Ghost', engine: ENGINE_VERSION }));
        ws.send(JSON.stringify({ t: 'queue', character: 'analog', mode: 'solo', item: drink.rowId }));
      });
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as ServerMsg & Record<string, unknown>;
        if (m.t === 'match') {
          // A few honest ticks, then total silence WITHOUT closing — the
          // idle sweep must settle this as a no-contest (nobody to blame in
          // PvE) and the drink must come home.
          for (let k = 0; k < 20; k++) ws.send(JSON.stringify({ t: 'i', k, v: 0 }));
        }
        if (m.t === 'result') { clearTimeout(timer); ws.close(); resolve(m); }
        if (m.t === 'error') { clearTimeout(timer); ws.close(); reject(new Error(String(m.msg))); }
      });
    });
    assert.equal(result.reason, 'incomplete', 'silence in PvE is a no-contest');
    await new Promise((r) => setTimeout(r, 300)); // releaseItems is fire-and-forget
    assert.ok((await inventory('Ghost')).includes(drink.rowId), 'the un-drunk drink is back in the stash');
  });

  // Bank +20 credits via a fabricated settled wager win (the memory impl pays
  // fee*2 to the winner with no prior escrow) — a fresh account's daily 10
  // can't cover both a 5-CR drink AND the 10-CR wager fee in one day.
  const fund = async (who: string, matchId: string): Promise<void> => {
    await mem.recordMatch({
      matchId, mode: 'wager', fee: 10,
      identities: [{ sub: `dev:${who}` } as never, { sub: 'dev:Loser' } as never],
      names: [who, 'Loser'], agents: [false, false], chars: ['analog', 'analog'],
      winner: 0, reason: 'verified', rounds: [2, 0], endTick: 1000, hash: 1,
      engine: ENGINE_VERSION,
    });
  };

  it('WAGER open carry: each side pins its OWN drink into the setup (Phase 4)', async () => {
    await fund('WagerA', 'fund-a');
    await fund('WagerB', 'fund-b');
    const a = await buy('WagerA', 'phase4-a');
    const b = await buy('WagerB', 'phase4-b');
    // Two humans queue wager, each carrying their own can → paired, and each
    // setup echoes items[thisSide] = my drink, items[otherSide] = theirs.
    const setups = await Promise.all([
      rawWager(server.port, 'WagerA', a.rowId),
      rawWager(server.port, 'WagerB', b.rowId),
    ]);
    for (const setup of setups) {
      const side = setup.side as number;
      const items = setup.items as Array<{ id: string } | null> | undefined;
      assert.ok(items, 'wager setup carries items');
      assert.ok(items[side], 'this side has a drink');
      assert.ok(items[1 - side], 'the opponent has a drink too (open carry)');
    }
    // Both drinks were consumed at pair time.
    assert.deepEqual(await inventory('WagerA'), []);
    assert.deepEqual(await inventory('WagerB'), []);
  });
});

/**
 * Wager sockets must stay OPEN until both sides pair (the setup arrives only
 * after pairing), so they can't self-close on 'match' like the solo helper.
 * They're parked here and closed in the describe's `after` hook — leaving a
 * ws open keeps node's event loop alive and the whole test process never
 * exits (the bug that made the suite look "hung"). Closing later triggers a
 * harmless no-contest; the test's assertions already ran while they were open.
 */
const wagerSockets: WebSocket[] = [];

/** Raw WAGER queue → resolve the SMatch setup (socket parked for cleanup). */
const rawWager = (port: number, name: string, item: number): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    wagerSockets.push(ws);
    const timer = setTimeout(() => { ws.close(); reject(new Error('no wager setup before timeout')); }, 8_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name, engine: ENGINE_VERSION }));
      ws.send(JSON.stringify({ t: 'queue', character: 'analog', mode: 'wager', item }));
    });
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Record<string, unknown>;
      if (m.t === 'match') { clearTimeout(timer); resolve(m); } // keep socket for pairing
      if (m.t === 'error') { clearTimeout(timer); ws.close(); reject(new Error(String(m.msg))); }
    });
  });

/** Raw solo queue → resolve the SMatch setup (then abandon the socket). */
const rawSolo = (port: number, name: string, item: number): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('no setup before timeout')); }, 8_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name, engine: ENGINE_VERSION }));
      ws.send(JSON.stringify({ t: 'queue', character: 'analog', mode: 'solo', item }));
    });
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Record<string, unknown>;
      if (m.t === 'match') { clearTimeout(timer); ws.close(); resolve(m); }
      if (m.t === 'error') { clearTimeout(timer); ws.close(); reject(new Error(String(m.msg))); }
    });
  });
