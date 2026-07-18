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
import { ITEMS, ITEM_COST } from '@af/core';
import { createMatchServer } from '../src/server.js';
import type { MatchServer } from '../src/server.js';
import { memoryPersistence, DAILY_CREDITS } from '../src/persist.js';
import type { Persistence } from '../src/persist.js';

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
