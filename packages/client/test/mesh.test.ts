/**
 * Relay discovery (src/mesh.ts) against a fake litVM and fake relays — no network. The module keeps state
 * between calls the way the page does, so these tests run in order as one page's life: boot, a node restart
 * onto a new tunnel hostname, the chain going away, the publisher probe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── the browser globals mesh.ts reads ──
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  },
  location: { protocol: 'https:', hostname: 'agentfighter.wtf' },
});

// ── a fake litVM: NodeDirectory.entryOf / NodeStake.standingOf, ABI-encoded as mesh.ts decodes them ──
const DESKTOP = '5b703f1288765c0ca3734ab0625df161121ef45a9eabafaaae539be1add95151'; // PREFERRED_RELAYS[0]
const DIRECTORY = `0x${'d'.repeat(40)}`, STAKE = `0x${'5'.repeat(40)}`;
const word = (n: number): string => n.toString(16).padStart(64, '0');
const abiString = (s: string): string => {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  return word(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
};
const entry = (url: string, wsAddr: string, updatedAt: number): string => {
  const a = abiString(url), b = abiString(wsAddr);
  return `0x${word(96)}${word(96 + a.length / 2)}${word(updatedAt)}${a}${b}`;
};

const chain = { up: true, calls: 0, announced: '' };
const live = new Set<string>(); // relay hosts whose /health answers agent-fighter
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === 'https://arcade.litvm.games/contracts.json') {
    return json({ generation: 4, chainId: 4441, rpc: 'https://rpc.test/', contracts: { NodeDirectory: { address: DIRECTORY }, NodeStake: { address: STAKE } } });
  }
  if (init?.method === 'POST') {
    chain.calls++;
    if (!chain.up) throw new TypeError('fetch failed');
    const { id, params } = JSON.parse(String(init.body)) as { id: number; params: [{ to: string; data: string }] };
    const { to, data } = params[0];
    const key = data.slice(10);
    const result = to === STAKE ? `0x${word(0)}${word(0)}${word(1)}` // bonded, active
      : key === DESKTOP ? entry('https://node.trycloudflare.com', chain.announced, Math.floor(Date.now() / 1000))
      : entry('', '', 0); // m16 announces no relay
    return json({ jsonrpc: '2.0', id, result });
  }
  if (url.endsWith('/health')) {
    if (live.has(new URL(url).host)) return json({ game: 'agent-fighter' });
    throw new TypeError('fetch failed'); // a dead quick tunnel
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const { cachedRelay, isPublisherRelay, publisherOnline, refreshRelay, relayReady } = await import('../src/mesh.js');

/** The node restarted: a new tunnel hostname is announced and only it answers. */
const restartOnto = (host: string): void => { chain.announced = `wss://${host}`; live.clear(); live.add(host); };
/** Make the last read CACHE_MS (2 min) old, as a page that has been open a while has it. */
const ageCache = (): void => {
  const c = JSON.parse(store.get('af.mesh-relay')!) as { at: number };
  store.set('af.mesh-relay', JSON.stringify({ ...c, at: Date.now() - 3 * 60_000 }));
};

test('boot: the relay the publisher announced, once its /health answers', async () => {
  restartOnto('relay-a.trycloudflare.com');
  refreshRelay();
  await relayReady();
  assert.equal(cachedRelay(), 'wss://relay-a.trycloudflare.com');
  assert.ok(isPublisherRelay('wss://relay-a.trycloudflare.com'));
});

test('a read 2 minutes old keeps its address (never no relay) and is re-read in the background', async () => {
  restartOnto('relay-b.trycloudflare.com');
  ageCache();
  // The 23 Oct bug: this answered null, so every call went to wss://no-relay.invalid and the account fetch failed.
  assert.equal(cachedRelay(), 'wss://relay-a.trycloudflare.com', 'the last address stands in while the re-read runs');
  await relayReady();
  assert.equal(cachedRelay(), 'wss://relay-b.trycloudflare.com');
  assert.ok(isPublisherRelay('wss://relay-b.trycloudflare.com'));
  assert.ok(!isPublisherRelay('wss://relay-a.trycloudflare.com'), 'the token no longer goes to the dead hostname');
});

test('relayReady waits for the re-read, so a token goes only to the relay announced now', async () => {
  restartOnto('relay-c.trycloudflare.com');
  ageCache();
  await relayReady(); // what relayAuthToken() awaits before deciding where the AIR token may go
  assert.ok(isPublisherRelay('wss://relay-c.trycloudflare.com'));
  assert.equal(cachedRelay(), 'wss://relay-c.trycloudflare.com');
});

test('a read that finds nothing is not repeated on every frame (chain unreachable)', async () => {
  chain.up = false;
  ageCache();
  cachedRelay();
  await relayReady();
  const afterOneRead = chain.calls;
  for (let i = 0; i < 100; i++) cachedRelay(); // the MY AGENT screen reads the address every frame
  await relayReady();
  assert.equal(chain.calls, afterOneRead, 'no second read within RETRY_MS');
  assert.equal(cachedRelay(), 'wss://relay-c.trycloudflare.com', 'the last address still stands in');
  chain.up = true;
});

test('publisherOnline re-reads the directory when no known relay answers', async () => {
  restartOnto('relay-d.trycloudflare.com'); // relay-c is dead now; the failed read above holds off the background re-read
  assert.equal(await publisherOnline(true), true);
  assert.equal(cachedRelay(), 'wss://relay-d.trycloudflare.com');
});
