/**
 * RTT probes + adaptive input delay (2026-07-18, additive to protocol 6).
 *
 * The lag story this guards: the relay computes each PvP match's input
 * delay from both clients' measured RTT (half hidden by delay, half by
 * rollback) instead of a fixed constant. Unknown RTT — old client, agent,
 * instant pair — falls back to INPUT_DELAY exactly as before, so nothing
 * about the legacy path may change.
 *
 * RTT arrives via pong echoes of the server's lobby pings. These tests
 * seed it by sending pongs directly (the server treats any pong's `ts` as
 * its own clock at send time) — which also documents that RTT is
 * client-influencable ON PURPOSE: it only ever picks a delay inside
 * [INPUT_DELAY_MIN, INPUT_DELAY_MAX], symmetric for both players.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { ENGINE_VERSION } from '@af/core';
import { createMatchServer } from '../src/server.js';
import type { MatchServer } from '../src/server.js';
import { INPUT_DELAY, INPUT_DELAY_MAX, INPUT_DELAY_MIN, PROTOCOL_VERSION } from '../src/protocol.js';

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

  async open(): Promise<void> {
    await new Promise<void>((res) => this.ws.on('open', () => res()));
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
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

describe('RTT probes + adaptive input delay', () => {
  let server: MatchServer;
  const clients: RawClient[] = [];
  const hello = (name: string): Record<string, unknown> =>
    ({ t: 'hello', v: PROTOCOL_VERSION, engine: ENGINE_VERSION, name });

  const connect = async (name: string): Promise<RawClient> => {
    const c = new RawClient(`ws://localhost:${server.port}`);
    clients.push(c);
    await c.open();
    c.send(hello(name));
    await c.waitFor((m) => m.t === 'welcome');
    return c;
  };

  after(() => {
    for (const c of clients) c.close();
    server?.close();
  });

  it('echoes a client ping back as a pong with the same ts', async () => {
    server = await createMatchServer({ port: 0, persistence: null, noPaceCheck: true });
    const c = await connect('Pinger');
    c.send({ t: 'ping', ts: 123456 });
    const pong = await c.waitFor((m) => m.t === 'pong');
    assert.equal(pong.ts, 123456);
  });

  it('slow reported RTT on both sides → delay clamps to INPUT_DELAY_MAX; resume keeps it pinned', async () => {
    const a = await connect('SlowA');
    const b = await connect('SlowB');
    // Pretend the server's lobby ping left 200 ms ago on both sockets:
    // oneWay = (200+200)/2 = 200 ms ≈ 12 ticks → /2 = 6 → clamped MAX.
    a.send({ t: 'pong', ts: Date.now() - 200 });
    b.send({ t: 'pong', ts: Date.now() - 200 });
    await new Promise((res) => setTimeout(res, 100)); // pongs are fire-and-forget
    a.send({ t: 'queue', character: 'analog' });
    b.send({ t: 'queue', character: 'vector' });
    const setupA = await a.waitFor((m) => m.t === 'match');
    const setupB = await b.waitFor((m) => m.t === 'match');
    assert.equal(setupA.delay, INPUT_DELAY_MAX);
    assert.equal(setupB.delay, INPUT_DELAY_MAX, 'delay must be symmetric');

    // Resume must resend the SAME pinned delay — the input ledger was
    // scheduled with it; a resumed client on a different delay desyncs.
    a.close();
    const a2 = new RawClient(`ws://localhost:${server.port}`);
    clients.push(a2);
    await a2.open();
    a2.send(hello('SlowA'));
    a2.send({ t: 'resume', matchId: setupA.matchId, token: setupA.resume });
    const resumed = await a2.waitFor((m) => m.t === 'resumed');
    assert.equal(resumed.delay, INPUT_DELAY_MAX, 'resume must pin the pair-time delay');
  });

  it('fast reported RTT on both sides → delay clamps to INPUT_DELAY_MIN', async () => {
    const a = await connect('FastA');
    const b = await connect('FastB');
    // oneWay = 30 ms ≈ 1.8 ticks → /2 = 0.9 → round 1 → clamped MIN.
    a.send({ t: 'pong', ts: Date.now() - 30 });
    b.send({ t: 'pong', ts: Date.now() - 30 });
    await new Promise((res) => setTimeout(res, 100));
    a.send({ t: 'queue', character: 'analog' });
    b.send({ t: 'queue', character: 'vector' });
    const setup = await a.waitFor((m) => m.t === 'match');
    assert.equal(setup.delay, INPUT_DELAY_MIN);
  });

  it('no RTT on either side → the INPUT_DELAY fallback (legacy behavior)', async () => {
    const a = await connect('LegacyA');
    const b = await connect('LegacyB');
    a.send({ t: 'queue', character: 'analog' });
    b.send({ t: 'queue', character: 'vector' });
    const setup = await a.waitFor((m) => m.t === 'match');
    assert.equal(setup.delay, INPUT_DELAY);
  });

  it('a garbage pong ts never poisons the delay computation', async () => {
    const a = await connect('GarbageA');
    const b = await connect('GarbageB');
    a.send({ t: 'pong', ts: 'not-a-number' });
    a.send({ t: 'pong', ts: Date.now() + 999999 }); // negative sample
    a.send({ t: 'pong', ts: 0 }); // absurdly old → rejected by the 60s bound
    await new Promise((res) => setTimeout(res, 100));
    a.send({ t: 'queue', character: 'analog' });
    b.send({ t: 'queue', character: 'vector' });
    const setup = await a.waitFor((m) => m.t === 'match');
    assert.equal(setup.delay, INPUT_DELAY, 'bad samples must leave RTT unknown');
  });
});
