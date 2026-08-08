/**
 * PETS (ADR 0011): account-bound companions with rolled auras.
 *
 *  · POST /pets/adopt debits PET_COST atomically and grants a server-rolled
 *    pet from the `pets/` catalog with a server-rolled aura; GET /pets lists
 *    the catalog + what you own.
 *  · Adoptions are IDEMPOTENT by client nonce — a retry replays the stored
 *    grant, so a dropped response can never re-roll a better aura.
 *  · Auth is owner-only: agent keys are refused by construction (the route
 *    never accepts X-Agent-Key) and agent-class subs are refused outright.
 *  · The equipped pet's aura is PINNED into the match setup and installed by
 *    every simulating peer — which is what makes it survive verification.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AURA_MAX, AURA_MIN, ENGINE_VERSION, PET_COST, clampAura,
} from '@af/core';
import type { PetAura } from '@af/core';
import { WebSocket } from 'ws';
import { createMatchServer } from '../src/server.js';
import type { MatchServer } from '../src/server.js';
import { memoryPersistence, DAILY_CREDITS } from '../src/persist.js';
import type { Persistence } from '../src/persist.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { ServerMsg } from '../src/protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const charactersDir = join(here, '..', '..', '..', 'characters');

interface OwnedPetBody {
  rowId: number; petId: string; rarity: number; aura: PetAura; equipped: boolean;
}

/** GET /pets → what this identity owns. */
const listPets = async (
  http: string, headers: Record<string, string>,
): Promise<OwnedPetBody[]> => {
  const res = await fetch(`${http}/pets`, { headers });
  const body = await res.json() as { pets: OwnedPetBody[] };
  return body.pets;
};

describe('pets: adoption (ADR 0011)', () => {
  let server: MatchServer;
  let mem: Persistence;
  let http = '';
  const OWNER = { 'X-Dev-Name': 'PetLover', 'Content-Type': 'application/json' };

  before(async () => {
    mem = memoryPersistence();
    server = await createMatchServer({ port: 0, persistence: mem, noPaceCheck: true });
    http = `http://localhost:${server.port}`;
    const me = await fetch(`${http}/me`, { headers: OWNER });
    assert.equal((await me.json() as { credits: number }).credits, DAILY_CREDITS);
  });
  after(() => server.close());

  it('requires sign-in, and refuses an agent key', async () => {
    assert.equal((await fetch(`${http}/pets`)).status, 401);
    const keyed = await fetch(`${http}/pets`, { headers: { 'X-Agent-Key': 'afk_whatever' } });
    assert.equal(keyed.status, 401, 'a leaked coach key cannot spend credits');
  });

  it('GET /pets: the catalog is the pets/ directory, inventory starts empty', async () => {
    const res = await fetch(`${http}/pets`, { headers: OWNER });
    assert.equal(res.status, 200);
    const body = await res.json() as { cost: number; catalog: { id: string }[]; pets: unknown[] };
    assert.equal(body.cost, PET_COST);
    assert.ok(body.catalog.length > 0, 'starter pets are published');
    assert.ok(body.catalog.every((p) => typeof p.id === 'string' && p.id.length > 0));
    assert.deepEqual(body.pets, [], 'nothing adopted yet');
  });

  it('rejects a missing/short nonce', async () => {
    const res = await fetch(`${http}/pets/adopt`, {
      method: 'POST', headers: OWNER, body: JSON.stringify({ nonce: 'x' }),
    });
    assert.equal(res.status, 400);
  });

  it('402 when the balance cannot cover an adoption', async () => {
    // DAILY_CREDITS (10) < PET_COST (25) on a fresh account.
    const res = await fetch(`${http}/pets/adopt`, {
      method: 'POST', headers: OWNER, body: JSON.stringify({ nonce: 'too-poor-0001' }),
    });
    assert.equal(res.status, 402);
    assert.equal((await res.json() as { code: string }).code, 'credits');
  });

  it('an adoption debits the cost and rolls a bounded aura', async () => {
    await mem.buyItem('dev:PetLover', -100, 'topup', 1, 'grant-credits-for-pets');
    const res = await fetch(`${http}/pets/adopt`, {
      method: 'POST', headers: OWNER, body: JSON.stringify({ nonce: 'adopt-0001' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { pet: OwnedPetBody; credits: number; cost: number };
    assert.equal(body.cost, PET_COST);
    assert.ok(body.pet.rowId > 0);
    assert.ok(body.pet.rarity >= 1 && body.pet.rarity <= 3);
    const lines = Object.values(body.pet.aura).filter((v) => v > 0);
    assert.equal(lines.length, body.pet.rarity, 'rarity decides HOW MANY lines roll');
    for (const v of lines) {
      assert.ok(v >= AURA_MIN && v <= AURA_MAX, `line ${v} inside the subtle band`);
    }
  });

  it('a replayed nonce charges once and NEVER re-rolls', async () => {
    const first = await (await fetch(`${http}/pets/adopt`, {
      method: 'POST', headers: OWNER, body: JSON.stringify({ nonce: 'adopt-retry-01' }),
    })).json() as { pet: OwnedPetBody; credits: number };
    const again = await (await fetch(`${http}/pets/adopt`, {
      method: 'POST', headers: OWNER, body: JSON.stringify({ nonce: 'adopt-retry-01' }),
    })).json() as { pet: OwnedPetBody; credits: number; duplicate: boolean; cost: number };
    assert.equal(again.duplicate, true);
    assert.equal(again.cost, 0, 'a retry is free');
    assert.equal(again.credits, first.credits, 'balance did not move');
    assert.equal(again.pet.rowId, first.pet.rowId);
    assert.deepEqual(again.pet.aura, first.pet.aura, 'the same aura came back');
  });

  it('equipping is exclusive — one pet, or none', async () => {
    const owned = await listPets(http, OWNER);
    assert.ok(owned.length >= 2, 'two pets adopted by now');

    const equip = async (rowId: number | null): Promise<OwnedPetBody | null> => {
      const res = await fetch(`${http}/pets/equip`, {
        method: 'POST', headers: OWNER, body: JSON.stringify({ rowId }),
      });
      assert.equal(res.status, 200);
      return (await res.json() as { equipped: OwnedPetBody | null }).equipped;
    };

    assert.equal((await equip(owned[0]!.rowId))?.rowId, owned[0]!.rowId);
    assert.equal((await equip(owned[1]!.rowId))?.rowId, owned[1]!.rowId);
    const list = await listPets(http, OWNER);
    assert.equal(list.filter((p) => p.equipped).length, 1, 'the first one unequipped itself');
    assert.equal(await equip(null), null, 'null takes the pet off');
  });

  it('a pet belongs to its account — another player cannot equip it', async () => {
    const owned = await listPets(http, OWNER);
    const THIEF = { 'X-Dev-Name': 'Thief', 'Content-Type': 'application/json' };
    await fetch(`${http}/me`, { headers: THIEF });
    const res = await fetch(`${http}/pets/equip`, {
      method: 'POST', headers: THIEF, body: JSON.stringify({ rowId: owned[0]!.rowId }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { equipped: unknown }).equipped, null,
      'someone else\'s row is a no-op, never an equip');
    const mine = await listPets(http, THIEF);
    assert.deepEqual(mine, [], 'and it did not appear in the thief\'s inventory');
  });
});

describe('pets: the aura reaches the match', () => {
  let server: MatchServer;
  let mem: Persistence;
  let http = '';
  const sockets: WebSocket[] = [];
  const PLAYER = { 'X-Dev-Name': 'Trainer', 'Content-Type': 'application/json' };

  before(async () => {
    mem = memoryPersistence();
    server = await createMatchServer({ port: 0, persistence: mem, noPaceCheck: true });
    http = `http://localhost:${server.port}`;
    await fetch(`${http}/me`, { headers: PLAYER });
    await mem.buyItem('dev:Trainer', -100, 'topup', 1, 'trainer-credits');
  });
  // Leaked sockets keep node --test alive forever (the 2026-07-19 lesson).
  after(() => { for (const ws of sockets) { try { ws.close(); } catch { /* closed */ } } server.close(); });

  /** Queue a ranked solo match and return the setup the server pinned. */
  const setupFor = (name: string): Promise<Extract<ServerMsg, { t: 'match' }>> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${server.port}`);
      sockets.push(ws);
      const timer = setTimeout(() => reject(new Error('no setup')), 8000);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          t: 'hello', v: PROTOCOL_VERSION, engine: ENGINE_VERSION,
          name, character: 'analog', devName: name,
        }));
        ws.send(JSON.stringify({ t: 'queue', mode: 'solo', character: 'analog' }));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as ServerMsg;
        if (msg.t === 'match') { clearTimeout(timer); resolve(msg); }
        if (msg.t === 'error') { clearTimeout(timer); reject(new Error(msg.msg)); }
      });
      ws.on('error', reject);
    });

  it('no pet equipped → no pin at all (a pet-less match is untouched)', async () => {
    const setup = await setupFor('Trainer');
    assert.equal(setup.pets, undefined);
  });

  it('the EQUIPPED pet\'s rolled aura is pinned into the setup', async () => {
    const adopted = await (await fetch(`${http}/pets/adopt`, {
      method: 'POST', headers: PLAYER, body: JSON.stringify({ nonce: 'trainer-adopt-1' }),
    })).json() as { pet: OwnedPetBody };
    await fetch(`${http}/pets/equip`, {
      method: 'POST', headers: PLAYER, body: JSON.stringify({ rowId: adopted.pet.rowId }),
    });

    const setup = await setupFor('Trainer');
    assert.ok(setup.pets, 'the setup carries the pin');
    const mine = setup.pets![0];
    assert.ok(mine, 'side 0 is the player');
    assert.equal(mine!.id, adopted.pet.petId);
    assert.deepEqual(mine!.aura, clampAura(adopted.pet.aura), 'exactly what was rolled');
    assert.equal(setup.pets![1], null, 'the house AI never carries one');
  });

  it('the pinned aura is bounded — the sim can never receive an out-of-band line', async () => {
    const setup = await setupFor('Trainer');
    for (const v of Object.values(setup.pets![0]!.aura)) {
      assert.ok(v >= 0 && v <= AURA_MAX);
    }
  });
});

describe('pet gacha: rolling with tickets (ADR 0009 phase B)', () => {
  let server: MatchServer;
  let mem: Persistence;
  let http = '';
  const OWNER = { 'X-Dev-Name': 'Roller', 'Content-Type': 'application/json' };

  /** Mint one wager ticket the legitimate way: a decided human wager win. */
  const mintTicket = async (i: number): Promise<void> => {
    await mem.recordMatch({
      matchId: `tkt-${i}`, mode: 'wager', fee: 10,
      identities: [{ sub: 'dev:Roller' }, { sub: 'dev:Victim' }] as never,
      names: ['Roller', 'Victim'], agents: [false, false],
      chars: ['analog', 'vector'], winner: 0, reason: 'verified',
      rounds: [2, 0], endTick: 1000, hash: 1, engine: ENGINE_VERSION,
    });
  };

  before(async () => {
    mem = memoryPersistence();
    server = await createMatchServer({ port: 0, persistence: mem, noPaceCheck: true });
    http = `http://localhost:${server.port}`;
    await fetch(`${http}/me`, { headers: OWNER });
    await fetch(`${http}/me`, { headers: { 'X-Dev-Name': 'Victim' } });
  });
  after(() => server.close());

  it('GET /pets reports BOTH prices and the ticket balance', async () => {
    for (let i = 0; i < 5; i++) await mintTicket(i);
    const body = await (await fetch(`${http}/pets`, { headers: OWNER })).json() as {
      cost: number; costTickets: number; tickets: number;
    };
    assert.equal(body.cost, PET_COST);
    assert.equal(body.costTickets, 5);
    assert.equal(body.tickets, 5, 'five wager wins = five unredeemed tickets');
  });

  it('a bogus pay method is a 400, and charges nothing', async () => {
    const res = await fetch(`${http}/pets/adopt`, {
      method: 'POST', headers: OWNER,
      body: JSON.stringify({ nonce: 'roll-bogus-01', pay: 'iou' }),
    });
    assert.equal(res.status, 400);
  });

  it('pay:tickets redeems exactly 5 and grants a pet — credits untouched', async () => {
    const beforeCr = await mem.getCredits('dev:Roller');
    const res = await fetch(`${http}/pets/adopt`, {
      method: 'POST', headers: OWNER,
      body: JSON.stringify({ nonce: 'roll-tickets-01', pay: 'tickets' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      pet: OwnedPetBody; tickets: number; credits: number | null;
      cost: number; costTickets: number;
    };
    assert.ok(body.pet.rowId > 0);
    assert.equal(body.tickets, 0, 'all five tickets redeemed');
    assert.equal(body.cost, 0, 'no credits price on a ticket roll');
    assert.equal(body.costTickets, 5);
    assert.equal(await mem.getCredits('dev:Roller'), beforeCr, 'credits never moved');
    const aura = clampAura(body.pet.aura);
    for (const v of Object.values(aura)) assert.ok(v >= 0 && v <= AURA_MAX);
  });

  it('a replayed ticket nonce redeems NOTHING and returns the same pet', async () => {
    const res = await fetch(`${http}/pets/adopt`, {
      method: 'POST', headers: OWNER,
      body: JSON.stringify({ nonce: 'roll-tickets-01', pay: 'tickets' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      pet: OwnedPetBody; tickets: number; duplicate: boolean; costTickets: number;
    };
    assert.equal(body.duplicate, true);
    assert.equal(body.costTickets, 0, 'a replay is free');
    assert.equal(body.tickets, 0, 'balance did not move again');
  });

  it('rolling on an empty ticket wallet is a clean 402 {code:tickets}', async () => {
    const res = await fetch(`${http}/pets/adopt`, {
      method: 'POST', headers: OWNER,
      body: JSON.stringify({ nonce: 'roll-tickets-02', pay: 'tickets' }),
    });
    assert.equal(res.status, 402);
    assert.equal((await res.json() as { code: string }).code, 'tickets');
  });

  it('4 tickets is not 5: partial balances redeem nothing at all', async () => {
    for (let i = 10; i < 14; i++) await mintTicket(i);
    const res = await fetch(`${http}/pets/adopt`, {
      method: 'POST', headers: OWNER,
      body: JSON.stringify({ nonce: 'roll-tickets-03', pay: 'tickets' }),
    });
    assert.equal(res.status, 402);
    const body = await (await fetch(`${http}/pets`, { headers: OWNER })).json() as { tickets: number };
    assert.equal(body.tickets, 4, 'the failed roll redeemed none of the four');
  });
});
