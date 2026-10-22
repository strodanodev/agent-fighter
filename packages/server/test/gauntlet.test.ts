import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createMatchServer, type MatchServer } from '../src/server.js';
import { playOneMatch } from '../src/agent-session.js';
import { gauntletFromEnv, seedIntOf, verifyTicket, type GauntletConfig, type GauntletOutcome } from '../src/gauntlet.js';
import { descriptorProblem, meshLedger } from '../src/mesh-ledger.js';
import { ENGINE_VERSION } from '@af/core';
import { PROTOCOL_VERSION } from '../src/protocol.js';

/**
 * Gauntlet mode: ONE mesh-placed match, run by a litnode node. The node mints a seat ticket per placed
 * key (HMAC with a per-match secret), hands this process the placement's seed, and receives the result
 * on its /ledger. A fake node here stands in for it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const charactersDir = join(here, '..', '..', '..', 'characters');
const hex = (n: number): string => randomBytes(n).toString('hex');

/** litnode node/gauntlet.js mintTicket, byte for byte. */
const mintTicket = (claims: object, secret: string): string => {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
};

/** litnode protocol/canonical.js + keys.js: an envelope { body, signer, sig } signed `tag NUL canonical(body)`. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
  : x));
const placer = generateKeyPairSync('ed25519');
const placerKey = (placer.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
const seal = (body: Record<string, unknown>, key = placer.privateKey): { body: Record<string, unknown>; signer: string; sig: string } =>
  ({ body, signer: placerKey, sig: sign(null, Buffer.from(`match\0${canonical(body)}`, 'utf8'), key).toString('hex') });

const matchId = hex(32);
const room = `LIT-${matchId.slice(0, 32).toUpperCase()}`;
const seed = hex(32);
const secret = hex(32);
const keys = [hex(32), hex(32)] as const;
const ticketFor = (i: 0 | 1, over: object = {}): string => mintTicket({ sub: keys[i], matchId, team: i, slot: 0, mode: 'singles', exp: Date.now() + 60_000, ...over }, secret);

let node: Server;
let server: MatchServer;
const posted: unknown[] = [];
let outcome: GauntletOutcome | null = null;

after(async () => { await server?.close(); node?.close(); });

const startAll = async (): Promise<void> => {
  node = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { posted.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ attestation: 'players' })); });
  });
  await new Promise<void>((r) => node.listen(0, '127.0.0.1', r));
  const g: GauntletConfig = gauntletFromEnv({
    GAUNTLET_MATCH_ID: matchId, GAUNTLET_ROOM: room, GAUNTLET_SEED: seed, GAUNTLET_SECRET: secret,
    GAUNTLET_SEATS: JSON.stringify([{ sub: keys[0], team: 0, slot: 0 }, { sub: keys[1], team: 1, slot: 0 }]),
    GAUNTLET_NODE_URL: `http://127.0.0.1:${(node.address() as { port: number }).port}`,
    GAUNTLET_PLACED_MODE: 'ranked', GAUNTLET_BUILD: 'b'.repeat(64), GAUNTLET_RULESET: 'agent-fighter.v1',
  });
  server = await createMatchServer({ port: 0, noPaceCheck: true, gauntlet: { ...g, signWaitMs: 5000, onDone: (o) => { outcome = o; } } });
};

/** One hello, and the first answer to it. */
const helloWith = (ticket: string | undefined): Promise<{ t: string; code?: string }> => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://localhost:${server.port}`);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'x', engine: ENGINE_VERSION, ticket })));
  ws.on('message', (d) => { ws.close(); resolve(JSON.parse(String(d)) as { t: string; code?: string }); });
  ws.on('error', reject);
});

describe('gauntlet mode: one placed match for a litnode node', () => {
  it('reads the node\'s environment and verifies its tickets', () => {
    const t = ticketFor(0);
    assert.equal(verifyTicket(t, secret)?.sub, keys[0]);
    assert.equal(verifyTicket(t, 'other-secret'), null);
    assert.equal(verifyTicket(`${t.slice(0, -2)}xx`, secret), null);
    assert.equal(verifyTicket('nonsense', secret), null);
    assert.throws(() => gauntletFromEnv({}), /GAUNTLET_MATCH_ID is not set/);
    assert.equal(seedIntOf('ffffffff' + '0'.repeat(56)), 0x7fffffff, 'kept positive');
  });

  it('refuses a socket without a valid seat ticket', async () => {
    await startAll();
    assert.deepEqual(await helloWith(undefined).then((m) => [m.t, m.code]), ['error', 'seat']);
    assert.deepEqual(await helloWith('forged.ticket').then((m) => [m.t, m.code]), ['error', 'seat']);
    assert.deepEqual(await helloWith(ticketFor(0, { matchId: hex(32) })).then((m) => [m.t, m.code]), ['error', 'seat'], 'a ticket for another match');
    assert.deepEqual(await helloWith(ticketFor(0, { exp: Date.now() - 1 })).then((m) => [m.t, m.code]), ['error', 'seat'], 'an expired ticket');
    assert.deepEqual(await helloWith(mintTicket({ sub: hex(32), matchId, team: 0, slot: 0, mode: 'singles', exp: Date.now() + 60_000 }, secret)).then((m) => [m.t, m.code]), ['error', 'seat'], 'a key the node did not place');
  });

  it('seats the two placed keys by team, plays the placement\'s seed, and hands the signed log to the node', async () => {
    const heads: string[] = [];
    const signer = (ledger: { head: string; ticks: number }, entries: { k: number; inputs: [number, number] }[]): string => {
      // What the arcade does before it signs: the head of THIS player's own record of the log.
      const own = meshLedger([entries.map((e) => e.inputs[0]), entries.map((e) => e.inputs[1])]);
      heads.push(own.head);
      assert.equal(own.head, ledger.head, 'the client\'s own log gives the head the server names');
      return 'ab'.repeat(64);
    };
    // The placement both were served (litnode GET /match `envelope`). B sends a forgery, A the real one: only a
    // descriptor naming this match with its placer's signature reaches the node.
    const placement = { matchId, rulesetId: 'agent-fighter.v1', mode: 'ranked', participants: [keys[0], keys[1]], host: hex(32), computedBy: placerKey, protocol: 4, beacon: hex(32) };
    const real = seal(placement);
    const forged = { ...seal(placement, generateKeyPairSync('ed25519').privateKey) };
    // Team 1 arrives first: seats follow the tickets, not arrival order.
    const [b, a] = await Promise.all([
      playOneMatch({ url: `ws://localhost:${server.port}`, name: 'B', character: 'vector', skill: 55, charactersDir, aiSeed: 2, paceMs: 1, mode: 'friendly', room, ticket: ticketFor(1), playerKey: hex(32), signLedger: signer, descriptor: forged }),
      new Promise((r) => setTimeout(r, 300)).then(() => playOneMatch({ url: `ws://localhost:${server.port}`, name: 'A', character: 'analog', skill: 70, charactersDir, aiSeed: 1, paceMs: 1, mode: 'friendly', room, ticket: ticketFor(0), signLedger: signer, descriptor: real })),
    ]);
    assert.equal(a.result.reason, 'verified'); assert.equal(b.result.reason, 'verified');
    assert.deepEqual(a.placed, { intake: 'gauntlet', mode: 'ranked' }, 'the client is told who serves it, at which level');
    assert.equal(a.result.ledger?.ticks, a.result.endTick, 'the log ends at the final KO');
    assert.equal(heads.length, 2);

    for (let i = 0; i < 100 && !outcome; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(outcome, { posted: true, status: 200, error: undefined, signatures: 2 });
    const sub = posted[0] as { matchId: string; mode: string; buildHash: string; participants: string[]; entries: { k: number }[]; signatures: Record<string, string>; hydration: { pin: { seed: number; chars: string[]; room: string }; bundles: Record<string, unknown> } };
    assert.equal(sub.matchId, matchId);
    assert.equal(sub.mode, 'ranked');
    assert.equal(sub.buildHash, 'b'.repeat(64));
    assert.deepEqual(sub.participants, [keys[0], keys[1]], 'side 0 is team 0, whoever connected first; the key is the ticket\'s, not hello\'s');
    assert.equal(sub.entries.length, a.result.ledger?.ticks);
    assert.deepEqual(Object.keys(sub.signatures).sort(), [...keys].sort());
    assert.equal(sub.hydration.pin.seed, seedIntOf(seed), 'the placement\'s seed, not one the server rolled');
    assert.deepEqual(sub.hydration.pin.chars, ['analog', 'vector']);
    assert.equal((sub.hydration.pin as { intake?: string }).intake, 'gauntlet');
    assert.deepEqual((sub as { descriptor?: unknown }).descriptor, real, 'the placement the players were served travels with the ledger (litnode 0.11.31)');
    assert.ok(sub.hydration.bundles.analog && sub.hydration.bundles.vector, 'the character bundles travel with the pin');
  });

  it('plays the one match only', async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}`);
    const answers: { t: string; msg?: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'A', engine: ENGINE_VERSION, ticket: ticketFor(0) }));
        ws.send(JSON.stringify({ t: 'queue', character: 'analog', mode: 'friendly', room }));
      });
      ws.on('message', (d) => { const m = JSON.parse(String(d)) as { t: string; msg?: string }; answers.push(m); if (m.t === 'error') { ws.close(); resolve(); } });
      ws.on('error', reject);
      setTimeout(() => { ws.close(); resolve(); }, 5000);
    });
    assert.match(answers.find((m) => m.t === 'error')?.msg ?? '', /has been played/);
  });
});

describe('gauntlet mode: the only ranked intake (ADR 0014)', () => {
  it('a ranked placement without both players\' signatures is reported, never posted', async () => {
    const mid = hex(32);
    const rm = `LIT-${mid.slice(0, 32).toUpperCase()}`;
    const sec = hex(32);
    const ks = [hex(32), hex(32)] as const;
    const got: unknown[] = [];
    const fake = createServer((req, res) => { req.resume(); req.on('end', () => { got.push(1); res.writeHead(200); res.end('{}'); }); });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    let done: GauntletOutcome | null = null;
    const g = gauntletFromEnv({
      GAUNTLET_MATCH_ID: mid, GAUNTLET_ROOM: rm, GAUNTLET_SEED: hex(32), GAUNTLET_SECRET: sec,
      GAUNTLET_SEATS: JSON.stringify([{ sub: ks[0], team: 0, slot: 0 }, { sub: ks[1], team: 1, slot: 0 }]),
      GAUNTLET_NODE_URL: `http://127.0.0.1:${(fake.address() as { port: number }).port}`,
      GAUNTLET_PLACED_MODE: 'ranked',
    });
    const srv = await createMatchServer({ port: 0, noPaceCheck: true, gauntlet: { ...g, signWaitMs: 300, onDone: (o) => { done = o; } } });
    try {
      const tk = (i: 0 | 1): string => mintTicket({ sub: ks[i], matchId: mid, team: i, slot: 0, mode: 'singles', exp: Date.now() + 60_000 }, sec);
      // Only side 0 signs: one signature is not enough for ranked.
      await Promise.all([
        playOneMatch({ url: `ws://localhost:${srv.port}`, name: 'A', character: 'analog', skill: 70, charactersDir, aiSeed: 1, paceMs: 1, mode: 'friendly', room: rm, ticket: tk(0), signLedger: () => 'cd'.repeat(64) }),
        playOneMatch({ url: `ws://localhost:${srv.port}`, name: 'B', character: 'vector', skill: 55, charactersDir, aiSeed: 2, paceMs: 1, mode: 'friendly', room: rm, ticket: tk(1) }),
      ]);
      for (let i = 0; i < 50 && !done; i++) await new Promise((r) => setTimeout(r, 100));
      const o = done as GauntletOutcome | null;
      assert.equal(o?.posted, false);
      assert.equal(o?.signatures, 1);
      assert.match(o?.error ?? '', /ranked needs both players' ledger signatures/);
      assert.equal(got.length, 0, 'nothing was posted to the node');
    } finally {
      await srv.close();
      fake.close();
    }
  });
});

describe('gauntlet mode: the placement descriptor (litnode 0.11.31 binding)', () => {
  const want = { matchId: 'aa'.repeat(32), rulesetId: 'agent-fighter.v1', mode: 'ranked' as const, participants: ['11'.repeat(32), '22'.repeat(32)] };
  const body = { matchId: want.matchId, rulesetId: want.rulesetId, mode: 'ranked', participants: [...want.participants].reverse(), host: 'h', computedBy: placerKey, protocol: 4 };
  it('accepts the placer-signed envelope of this match, seats in any order', () => {
    assert.equal(descriptorProblem(seal(body), want), null);
  });
  it('refuses another match, another mode, other seats, a forged or misattributed signature', () => {
    assert.match(descriptorProblem(seal({ ...body, matchId: 'bb'.repeat(32) }), want) ?? '', /another match/);
    assert.match(descriptorProblem(seal({ ...body, mode: 'casual' }), want) ?? '', /mode casual/);
    assert.match(descriptorProblem(seal({ ...body, participants: [want.participants[0], '33'.repeat(32)] }), want) ?? '', /participants/);
    assert.match(descriptorProblem({ ...seal(body), sig: 'ab'.repeat(64) }, want) ?? '', /signature/);
    assert.match(descriptorProblem(seal({ ...body, computedBy: '44'.repeat(32) }), want) ?? '', /not signed by the node/);
    assert.match(descriptorProblem('nonsense', want) ?? '', /not an envelope/);
  });
});
