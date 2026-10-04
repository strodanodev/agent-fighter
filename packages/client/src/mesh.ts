/**
 * Relay discovery from the litnode mesh.
 *
 * The match server no longer has a fixed address: it runs on an operator's
 * machine behind an outbound tunnel whose hostname can change, and the
 * operator's node publishes the current one on litVM (NodeDirectory —
 * github.com/strodanodev/litnode, docs/WALLET-IDENTITY.md and the
 * "decentralized bootstrap" notes). This module reads that list straight
 * from the chain: every announced node key, its entry (url, wsAddr,
 * updatedAt), and whether NodeStake still shows it bonded. Of the bonded
 * seeds that advertise a relay, the first in PREFERRED_RELAYS order whose
 * /health answers `game: agent-fighter` is the match server.
 *
 * Read-only, no wallet, no library: three eth_call shapes and their ABI
 * decoding are inlined below (the selectors are keccak-derived in litnode's
 * protocol/keccak.js; hard-coded here so the game bundle stays dependency-free).
 *
 * Cached in localStorage for CACHE_MS so `matchWsUrl()` — which is
 * synchronous and used everywhere — can read it; refreshed in the background
 * at boot. `?ws=` still overrides everything.
 */
const RPC = 'https://liteforge.rpc.caldera.xyz/http';
// The contract set is READ, not baked: litnode publishes the current one as
// contracts.json (https://arcade.litvm.games/contracts.json and /cabinet/contracts.json
// on every node — generated from its contracts/deployed.testnet.json), and the
// cabinet hands it to a launched title in cabinet:init.chain. Nodes announce
// only on the CURRENT generation's directory: v1 (0xf63AA459…) and v2
// (0x278e4550…) are retired, and a client that still read the baked v2 pair
// resolved the desktop's relay hostname from 20 Sep — a quick tunnel dead for
// two days — and showed SERVER OFFLINE on every launch the cabinet did not
// hand a ?ws= to (22 Sep 2026). The pair below is the generation-3 set, the
// LAST RESORT when neither source answers; tools/check-contracts.mjs (CI)
// fails when it lags litnode's deployed set.
const CONTRACTS_URL = 'https://arcade.litvm.games/contracts.json';
const CONTRACTS_KEY = 'af.mesh-contracts';
const CONTRACTS_MS = 10 * 60_000;
const BAKED = { NODE_DIRECTORY: '0xac0C73008028E3eAA05Bc5C72f0C233F94b4E3df', NODE_STAKE: '0x3CFe2D006d946A1E0E5Cf6B3E0958aFc3fF73717', generation: 3 };
type ContractSet = { NODE_DIRECTORY: string; NODE_STAKE: string; generation: number | null; at?: number };
let contracts: ContractSet = BAKED;
const isAddr = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
/** litnode's contracts.json shape: { generation, chainId, rpc, contracts: { NodeDirectory: { address }, NodeStake: { address }, … } }. */
function takeContractSet(doc: unknown, source: string): boolean {
  const d = doc as { generation?: number; contracts?: Record<string, { address?: string }> } | null;
  const dir = d?.contracts?.NodeDirectory?.address, stake = d?.contracts?.NodeStake?.address;
  if (!isAddr(dir) || !isAddr(stake)) return false;
  contracts = { NODE_DIRECTORY: dir, NODE_STAKE: stake, generation: typeof d?.generation === 'number' ? d.generation : null, at: Date.now() };
  try { localStorage.setItem(CONTRACTS_KEY, JSON.stringify(contracts)); } catch { /* private mode */ }
  if (contracts.generation != null && BAKED.generation != null && contracts.generation !== BAKED.generation) console.warn(`[mesh] contract set from ${source} is generation ${contracts.generation}; this build was cut for ${BAKED.generation} — update the baked pair`);
  return true;
}
/** The cabinet's cabinet:init.chain — the CURRENT set, straight from the node that launched us. */
export function useCabinetContracts(chain: unknown): void { takeContractSet(chain, 'cabinet:init'); }
/** contracts.json from the arcade (cached CONTRACTS_MS); the baked pair only when it cannot be read. */
async function loadContracts(): Promise<void> {
  try { const c = JSON.parse(localStorage.getItem(CONTRACTS_KEY) ?? 'null') as ContractSet | null; if (c && isAddr(c.NODE_DIRECTORY) && isAddr(c.NODE_STAKE) && typeof c.at === 'number' && Date.now() - c.at < CONTRACTS_MS) { contracts = c; return; } } catch { /* fall through */ }
  try { const r = await fetch(CONTRACTS_URL, { signal: AbortSignal.timeout(6000), cache: 'no-store' }); if (r.ok) takeContractSet(await r.json(), CONTRACTS_URL); } catch { /* keep what we have */ }
}
const SEL = { keys: '0x307540f6', entryOf: '0x82fb8643', standingOf: '0x43aa9ad3' } as const;
const CACHE_KEY = 'af.mesh-relay';
// Short: a node behind a quick tunnel gets a new hostname on every restart,
// and a client holding the old one for ten minutes saw 'server offline'.
const CACHE_MS = 2 * 60_000;
/** An entry older than this is a node that stopped announcing (litnode FRESH_S). */
const FRESH_S = 7 * 24 * 3600;
/**
 * The order every client tries relays in. The relay is the matchmaker, so two
 * players only meet when they pick the SAME one. "Newest announcement wins"
 * followed whichever node last rotated its quick tunnel, and kept naming a
 * machine that died without withdrawing its entry (the desktop, 27 Sep 2026).
 * So: the desktop, then the m16 standby, then any other bonded relay (newest
 * first) — and a relay counts only while its /health says agent-fighter.
 */
const PREFERRED_RELAYS = [
  '5b703f1288765c0ca3734ab0625df161121ef45a9eabafaaae539be1add95151', // desktop
  '50bb1da9d3dbd72f10c27bfbb709643e7fe6055ddc09879d7d2a8146055c2e05', // m16 standby
];
const HEALTH_MS = 6000;

let id = 0;
async function rpc(method: string, params: unknown[]): Promise<string> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(8000) });
  const j = (await r.json()) as { result?: string; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result ?? '0x';
}
const call = (to: string, data: string): Promise<string> => rpc('eth_call', [{ to, data }, 'latest']);
const word = (d: string, i: number): string => d.slice(i * 64, i * 64 + 64);
const utf8 = (hex: string): string => new TextDecoder().decode(Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)));

function decodeKeys(ret: string): string[] {
  const d = ret.replace(/^0x/, '');
  if (d.length < 128) return [];
  const off = Number(BigInt('0x' + word(d, 0))) * 2;
  const n = Number(BigInt('0x' + d.slice(off, off + 64)));
  return Array.from({ length: n }, (_, i) => d.slice(off + 64 + i * 64, off + 128 + i * 64));
}
function decodeEntry(ret: string): { url: string; wsAddr: string; updatedAt: number } {
  const d = ret.replace(/^0x/, '');
  const str = (offWord: string): string => { const o = Number(BigInt('0x' + offWord)) * 2; const l = Number(BigInt('0x' + d.slice(o, o + 64))); return utf8(d.slice(o + 64, o + 64 + l * 2)); };
  return { url: str(word(d, 0)), wsAddr: str(word(d, 1)), updatedAt: Number(BigInt('0x' + word(d, 2))) };
}
const decodeActive = (ret: string): boolean => BigInt('0x' + word(ret.replace(/^0x/, ''), 2)) === 1n;

type Cached = { wsAddr: string; at: number };
function readCache(): Cached | null {
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as Cached | null; return c && typeof c.wsAddr === 'string' ? c : null; } catch { return null; }
}

/** The relay the mesh announced, if we have read it recently. Synchronous. */
export function cachedRelay(): string | null {
  const c = readCache();
  return c && Date.now() - c.at < CACHE_MS ? c.wsAddr : null;
}

/**
 * The relays the PUBLISHER runs: the wsAddr each PREFERRED_RELAYS node announced at the last directory read.
 * A NodeDirectory entry is written by that node's own announcer, so the address is the node's. Agent Fighter's
 * account API is the relay itself and any bonded node may run one, so only these may receive the player's AIR
 * token (a bearer credential for the whole API: /me, /items/buy, /agent/key). Anything else is played without it.
 */
const PUBLISHER_KEY = 'af.mesh-publisher-relays';
let publisherList: string[] = [];
function publisherRelays(): string[] {
  if (publisherList.length) return publisherList;
  try { const c = JSON.parse(localStorage.getItem(PUBLISHER_KEY) ?? 'null') as { relays?: unknown } | null; if (Array.isArray(c?.relays)) publisherList = c.relays.filter((r): r is string => typeof r === 'string'); } catch { /* private mode */ }
  return publisherList;
}
const originOf = (u: string): string | null => { try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch { return null; } };
/** May this relay see the player's AIR token? The publisher's relays, and a dev box serving the page itself. */
export function isPublisherRelay(wsUrl: string): boolean {
  const o = originOf(wsUrl);
  if (!o) return false;
  if (location.protocol !== 'https:' && o === `ws://${location.hostname}:8477`) return true; // npm run play: the server beside the page
  return publisherRelays().some((r) => originOf(r) === o);
}

/** 'ok' = an Agent Fighter relay answered; 'other' = some other title's server (never ours); 'down' = no answer. */
async function probeRelay(wsAddr: string): Promise<'ok' | 'other' | 'down'> {
  try {
    const r = await fetch(new URL('/health', wsAddr.replace(/^wss:/, 'https:')), { signal: AbortSignal.timeout(HEALTH_MS), cache: 'no-store' });
    if (!r.ok) return 'down';
    const j = (await r.json()) as { game?: unknown };
    return j.game === 'agent-fighter' ? 'ok' : 'other';
  } catch { return 'down'; }
}

/** Read NodeDirectory + NodeStake and cache the first live relay in PREFERRED_RELAYS order. */
export async function discoverRelay(): Promise<string | null> {
  await loadContracts();
  const { NODE_DIRECTORY, NODE_STAKE } = contracts;
  const keys = decodeKeys(await call(NODE_DIRECTORY, SEL.keys));
  const nowS = Math.floor(Date.now() / 1000);
  const found: { nodeId: string; wsAddr: string; updatedAt: number }[] = [];
  await Promise.all(keys.map(async (k) => {
    const [entry, standing] = await Promise.all([call(NODE_DIRECTORY, SEL.entryOf + k), call(NODE_STAKE, SEL.standingOf + k)]);
    const e = decodeEntry(entry);
    if (e.wsAddr && /^wss:\/\//.test(e.wsAddr) && nowS - e.updatedAt <= FRESH_S && decodeActive(standing)) found.push({ nodeId: k.toLowerCase(), wsAddr: e.wsAddr, updatedAt: e.updatedAt });
  }));
  const rank = (nodeId: string): number => { const i = PREFERRED_RELAYS.indexOf(nodeId); return i < 0 ? PREFERRED_RELAYS.length : i; };
  found.sort((a, b) => rank(a.nodeId) - rank(b.nodeId) || b.updatedAt - a.updatedAt);
  // Probe them all at once, then take the first that answers in that order. When none answers
  // (every relay down, or this network blocks the probe) fall back to the first that is not
  // another title's, as before — the lobby's connect-failure path re-reads from here.
  const probes = await Promise.all(found.map((f) => probeRelay(f.wsAddr)));
  const pick = found[probes.indexOf('ok')] ?? found[probes.indexOf('down')];
  const wsAddr = pick?.wsAddr ?? null;
  publisherList = found.filter((f) => PREFERRED_RELAYS.includes(f.nodeId)).map((f) => f.wsAddr);
  try { localStorage.setItem(PUBLISHER_KEY, JSON.stringify({ relays: publisherList, at: Date.now() })); } catch { /* private mode */ }
  try { if (wsAddr) localStorage.setItem(CACHE_KEY, JSON.stringify({ wsAddr, at: Date.now() } satisfies Cached)); } catch { /* private mode */ }
  return wsAddr;
}

/** The cached relay refused a connection: forget it and read the directory
 *  again, now. Returns the relay the mesh names now (may be the same one:
 *  then the relay itself is down, not merely moved). */
export async function relayFailed(): Promise<string | null> {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* private mode */ }
  try { return await discoverRelay(); } catch { return null; }
}

let inflight: Promise<unknown> | null = null;
/** Refresh in the background; returns immediately. Call once at boot. */
export function refreshRelay(): void {
  const c = readCache();
  if (c && Date.now() - c.at < CACHE_MS && publisherRelays().length) return;
  inflight = discoverRelay().catch(() => { /* chain unreachable: keep whatever we had */ }).finally(() => { inflight = null; });
}
/** Resolves once the boot discovery (if any) is done, so a caller deciding where a token may go reads its answer. */
export const relayReady = (): Promise<unknown> => inflight ?? Promise.resolve();
