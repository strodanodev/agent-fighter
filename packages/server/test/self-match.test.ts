/**
 * Self-match regression (audit 2026-07-18, server finding 1 — CRITICAL).
 *
 * The exploit: one identity on two sockets queues for wager twice; tryPair
 * pairs them against each other. Production escrow_match's per-profile
 * idempotency guard then collects only ONE fee while settlement pays the
 * winner fee*2 — a net credit mint. The player controls both sides, so
 * they always "win".
 *
 * Guards under test:
 *  1. tryPair refuses to pair two clients sharing an identity sub — the
 *     later joiner is bounced back to the lobby with an error, the earlier
 *     one keeps waiting, and NO match starts.
 *  2. memoryPersistence.escrowMatch rejects _p0 = _p1 outright (mirroring
 *     supabase/migrations/0012_no_self_match.sql) so no future pairing bug
 *     can reopen the mint. The old mirror charged a self-pair TWICE, which
 *     is precisely why tests could never see the production bug.
 *
 * persistence: memoryPersistence() — tests must NEVER touch real Supabase.
 */
import { describe, it, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { ENGINE_VERSION } from '@af/core';
import { createMatchServer } from '../src/server.js';
import type { MatchServer } from '../src/server.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import { DAILY_CREDITS, WAGER_FEE, memoryPersistence } from '../src/persist.js';

test('memory escrow rejects a self-pair instead of charging twice', async () => {
  const p = memoryPersistence();
  await p.getAccount({ sub: 'x' }, 'X', false); // daily grant
  const before = (await p.getAccount({ sub: 'x' }, 'X', false)).credits;
  await assert.rejects(p.escrowMatch('m-self', ['x', 'x'], WAGER_FEE), /SELF_MATCH/);
  assert.equal((await p.getAccount({ sub: 'x' }, 'X', false)).credits, before);
});

/** Minimal raw-protocol client: collects every server message. */
class RawClient {
  ws: WebSocket;
  msgs: Array<Record<string, unknown>> = [];
  private waiters: Array<() => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => {
      this.msgs.push(JSON.parse(String(d)) as Record<string, unknown>);
      for (const w of this.waiters.splice(0)) w();
    });
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Resolve on socket open; reject fast on error/timeout. A bare
   *  `ws.on('open')` wait hangs the whole run forever if the connect errors
   *  instead of opening — turn that into a prompt, reported failure. */
  opened(ms = 3000): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise<void>((res, rej) => {
      const to = setTimeout(() => rej(new Error('ws open timed out')), ms);
      this.ws.on('open', () => { clearTimeout(to); res(); });
      this.ws.on('error', (e) => { clearTimeout(to); rej(e instanceof Error ? e : new Error(String(e))); });
    });
  }

  async waitFor(pred: (m: Record<string, unknown>) => boolean, ms = 3000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.msgs.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting; got ${JSON.stringify(this.msgs)}`);
      await new Promise<void>((res) => {
        this.waiters.push(res);
        setTimeout(res, 50);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

describe('wager queue: one identity on two sockets never self-pairs', () => {
  let server: MatchServer;
  const clients: RawClient[] = [];
  after(() => {
    for (const c of clients) c.close();
    server?.close();
  });

  it('bounces the later joiner, starts no match, moves no credits', async () => {
    const p = memoryPersistence();
    server = await createMatchServer({ port: 0, persistence: p });
    const url = `ws://localhost:${server.port}`;

    // Same name → same dev-economy sub (dev:Selfy) on both sockets.
    const a = new RawClient(url);
    const b = new RawClient(url);
    clients.push(a, b);
    await a.opened();
    await b.opened();
    const hello = { t: 'hello', v: PROTOCOL_VERSION, engine: ENGINE_VERSION, name: 'Selfy' };
    a.send(hello);
    b.send(hello);
    await a.waitFor((m) => m.t === 'account');
    await b.waitFor((m) => m.t === 'account');
    const startCredits = (await p.getAccount({ sub: 'dev:Selfy' }, 'Selfy', false)).credits;
    assert.equal(startCredits, DAILY_CREDITS); // enough to cover one WAGER_FEE

    a.send({ t: 'queue', character: 'analog' });
    await a.waitFor((m) => m.t === 'queued');
    b.send({ t: 'queue', character: 'analog' });

    // The pair attempt must bounce one socket back with an error…
    const err = await b.waitFor((m) => m.t === 'error');
    assert.match(String(err.msg), /already queued/);

    // …and NO match may start on either socket (grace window for tryPair).
    await new Promise((res) => setTimeout(res, 400));
    assert.ok(!a.msgs.some((m) => m.t === 'match'), `A got a match: ${JSON.stringify(a.msgs)}`);
    assert.ok(!b.msgs.some((m) => m.t === 'match'), `B got a match: ${JSON.stringify(b.msgs)}`);

    // Net credit change: zero. Nothing escrowed, nothing minted.
    assert.equal((await p.getAccount({ sub: 'dev:Selfy' }, 'Selfy', false)).credits, startCredits);
  });

  it('a different identity still pairs normally against the waiter', async () => {
    const url = `ws://localhost:${server.port}`;
    // Socket A from the previous test is still queued. A NEW identity joins…
    const c = new RawClient(url);
    clients.push(c);
    await c.opened();
    c.send({ t: 'hello', v: PROTOCOL_VERSION, engine: ENGINE_VERSION, name: 'Other' });
    await c.waitFor((m) => m.t === 'account');
    c.send({ t: 'queue', character: 'vector' });

    // …and the guard must not block legitimate cross-identity pairing.
    const m0 = await clients[0]!.waitFor((m) => m.t === 'match');
    const m1 = await c.waitFor((m) => m.t === 'match');
    assert.equal(m0.matchId, m1.matchId);
  });
});
