/**
 * Relay discovery from the litnode mesh.
 *
 * The match server no longer has a fixed address: it runs on an operator's
 * machine behind an outbound tunnel whose hostname can change, and the
 * operator's node publishes the current one on litVM (NodeDirectory —
 * github.com/strodanodev/litnode, docs/WALLET-IDENTITY.md and the
 * "decentralized bootstrap" notes). This module reads it straight from the
 * chain for the publisher's own nodes only (PREFERRED_RELAYS): each one's
 * entry (url, wsAddr, updatedAt) and whether NodeStake still shows it bonded.
 * Of those that advertise a relay, the first whose /health answers
 * `game: agent-fighter` is the match server.
 *
 * Read-only, no wallet, no library: two eth_call shapes and their ABI
 * decoding are inlined below (the selectors are keccak-derived in litnode's
 * protocol/keccak.js; hard-coded here so the game bundle stays dependency-free).
 *
 * Cached in localStorage so `matchWsUrl()` — which is synchronous and used
 * everywhere — can read it: read at boot, and re-read in the background once
 * the read is CACHE_MS old. `?ws=` still overrides everything.
 */
// The contract set is READ, never baked: litnode publishes the current one as contracts.json
// (https://arcade.litvm.games/contracts.json, and /cabinet/contracts.json on every node — generated from its
// contracts/deployed.testnet.json on every deploy), and the cabinet hands it to a launched title in
// cabinet:init.chain. There is no fallback pair. A hand-copied set is what took the client down: a baked
// generation-2 pair resolved the desktop's dead quick-tunnel hostname and showed SERVER OFFLINE on every
// launch the cabinet did not hand a ?ws= to (22 Sep 2026), and the CI check meant to catch a lagging copy was
// never wired in. tools/check-contracts.mjs (part of `npm run verify`) now fails on ANY address literal in
// source. With no set read yet, discovery has nothing to ask and says so; a launch the cabinet hands a ?ws=
// to still plays.
const CONTRACTS_URL = 'https://arcade.litvm.games/contracts.json';
const CONTRACTS_KEY = 'af.mesh-contracts';
/** A set read this recently is used as is; an older one is re-read, and kept only while the arcade cannot answer. */
const CONTRACTS_MS = 10 * 60_000;
/** A set older than this is not trusted even as a stand-in: a generation may have moved since. */
const CONTRACTS_MAX_MS = 7 * 24 * 3600_000;
/**
 * RPC endpoints for the same chain, tried after the set's own (`rpc`, then `rpcFallback` when it names one). The
 * same list, in the same order, as litnode's sdk/court DEFAULT_RPCS. Not addresses.
 *
 * One endpoint is not enough: on 23 Oct 2026 Caldera's public `/http` answered every call with "Bandwidth limit
 * exceeded", relay discovery read nothing, and the game showed SERVER OFFLINE to everyone who did not arrive
 * through the arcade with a `?ws=`.
 */
const DEFAULT_RPCS = ['https://liteforge.rpc.caldera.xyz/http', 'https://liteforge.rpc.caldera.xyz/infra-partner-http'];
const DEFAULT_RPC = DEFAULT_RPCS[0]!;
export interface ContractSet {
  NODE_DIRECTORY: string;
  NODE_STAKE: string;
  generation: number | null;
  chainId: number | null;
  rpc: string;
  /** Further endpoints for the same chain the set names (litnode `rpcFallback`), tried in order after `rpc`. */
  rpcFallback?: string[];
  /** Every contract the set names, by its litnode name (MatchBook, EpochAnchor, TitleRegistry, …). */
  addresses: Record<string, string>;
  /** Block explorer base URL the set names (litnode 0.12.0 contracts.json `explorer`): EpochAnchor links; null = none. */
  explorer: string | null;
  /** The arcade origin the set came from — its receipt pages (#/match/<id>) explain a result. */
  arcade: string | null;
  at: number;
}
let contracts: ContractSet | null = null;
const isAddr = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHttps = (v: unknown): v is string => typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/.test(v);
/** litnode's contracts.json shape: { generation, chainId, rpc, explorer?, contracts: { NodeDirectory: { address }, … } }. */
function takeContractSet(doc: unknown, source: string, arcade: string | null): boolean {
  const d = doc as { generation?: unknown; chainId?: unknown; rpc?: unknown; rpcFallback?: unknown; explorer?: unknown; contracts?: Record<string, { address?: string }> } | null;
  const dir = d?.contracts?.NodeDirectory?.address, stake = d?.contracts?.NodeStake?.address;
  if (!isAddr(dir) || !isAddr(stake)) { console.warn(`[mesh] ${source} is not a contract set (no NodeDirectory / NodeStake)`); return false; }
  const addresses: Record<string, string> = {};
  for (const [name, c] of Object.entries(d?.contracts ?? {})) if (isAddr(c?.address)) addresses[name] = c.address;
  contracts = {
    NODE_DIRECTORY: dir, NODE_STAKE: stake,
    generation: typeof d?.generation === 'number' ? d.generation : null,
    chainId: typeof d?.chainId === 'number' ? d.chainId : null,
    rpc: isHttps(d?.rpc) ? d.rpc : DEFAULT_RPC,
    rpcFallback: Array.isArray(d?.rpcFallback) ? d.rpcFallback.filter(isHttps) : [],
    addresses,
    explorer: isHttps(d?.explorer) ? d.explorer.replace(/\/+$/, '') : null,
    arcade, at: Date.now(),
  };
  try { localStorage.setItem(CONTRACTS_KEY, JSON.stringify(contracts)); } catch { /* private mode */ }
  return true;
}
/** The cabinet's cabinet:init.chain — the CURRENT set, straight from the arcade that launched us (its origin). */
export function useCabinetContracts(chain: unknown, arcadeOrigin: string): void { takeContractSet(chain, 'cabinet:init', arcadeOrigin); }
/** The contract set last read from the arcade, or null when none could be read. Synchronous. */
export const contractSet = (): ContractSet | null => contracts;
const cachedSet = (): ContractSet | null => {
  try {
    const c = JSON.parse(localStorage.getItem(CONTRACTS_KEY) ?? 'null') as ContractSet | null;
    return c && isAddr(c.NODE_DIRECTORY) && isAddr(c.NODE_STAKE) && typeof c.at === 'number' && c.addresses && typeof c.rpc === 'string' ? c : null;
  } catch { return null; }
};
/** contracts.json from the arcade (cached CONTRACTS_MS). With no answer, a set read within CONTRACTS_MAX_MS
 *  stands in; with none of those, there is no set and discovery fails closed. */
async function loadContracts(): Promise<ContractSet> {
  const cached = cachedSet();
  if (contracts && Date.now() - contracts.at < CONTRACTS_MS) return contracts;
  if (cached && Date.now() - cached.at < CONTRACTS_MS) return (contracts = cached);
  try {
    const r = await fetch(CONTRACTS_URL, { signal: AbortSignal.timeout(6000), cache: 'no-store' });
    if (r.ok && takeContractSet(await r.json(), CONTRACTS_URL, new URL(CONTRACTS_URL).origin)) return contracts!;
  } catch { /* the arcade did not answer */ }
  const stale = contracts ?? cached;
  if (stale && Date.now() - stale.at < CONTRACTS_MAX_MS) return (contracts = stale);
  throw new Error("no litVM contract set: the arcade's contracts.json did not answer and none was read before");
}
/** Read the contract set if none is held (for proof links on a page that never ran relay discovery). Never throws. */
export async function ensureContractSet(): Promise<ContractSet | null> {
  try { return await loadContracts(); } catch { return null; }
}
const SEL = { entryOf: '0x82fb8643', standingOf: '0x43aa9ad3' } as const;
const CACHE_KEY = 'af.mesh-relay';
// A read this old is re-read. Short: a node behind a quick tunnel gets a new
// hostname on every restart, and a client holding the old one for ten minutes
// saw 'server offline'.
const CACHE_MS = 2 * 60_000;
/** A read that found no relay (chain unreachable, none announced) is not repeated sooner: cachedRelay() runs every frame on some screens. */
const RETRY_MS = 30_000;
/** An entry older than this is a node that stopped announcing (litnode FRESH_S). */
const FRESH_S = 7 * 24 * 3600;
/**
 * The publisher's nodes, in the order every client tries them. Only these are asked: the relay is also the
 * account API and the economy, so a relay the publisher does not run is never used. The relay is the
 * matchmaker, so two players only meet when they pick the SAME one; a fixed order (not "newest announcement
 * wins", which kept naming a machine that died without withdrawing its entry, 27 Sep 2026) makes them agree,
 * and a relay counts only while its /health says agent-fighter.
 */
const PREFERRED_RELAYS = [
  '5b703f1288765c0ca3734ab0625df161121ef45a9eabafaaae539be1add95151', // desktop
  '50bb1da9d3dbd72f10c27bfbb709643e7fe6055ddc09879d7d2a8146055c2e05', // m16 standby
];
const HEALTH_MS = 6000;

let id = 0;
/** An endpoint that just failed in transit sits out a minute, then is preferred again in list order. */
const benchedUntil = new Map<string, number>();
const BENCH_MS = 60_000;
/**
 * One JSON-RPC call, across every endpoint for the chain: the set's `rpc`, its `rpcFallback`, then DEFAULT_RPCS.
 * A transport failure, a non-2xx answer or an endpoint-side error (rate or bandwidth limit, overload) moves on to
 * the next endpoint; a revert is the chain's answer and is returned as an error at once, from any endpoint.
 */
async function rpc(method: string, params: unknown[]): Promise<string> {
  const all = [...new Set([contracts?.rpc ?? DEFAULT_RPC, ...(contracts?.rpcFallback ?? []), ...DEFAULT_RPCS])];
  const now = Date.now();
  const order = [...all.filter((u) => (benchedUntil.get(u) ?? 0) <= now), ...all.filter((u) => (benchedUntil.get(u) ?? 0) > now)];
  let last: unknown = null;
  for (const url of order) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`${url} answered ${r.status}`);
      const j = (await r.json()) as { result?: string; error?: { message?: string; code?: number } };
      if (j.error) {
        if (/revert/i.test(j.error.message ?? '') || j.error.code === 3) throw Object.assign(new Error(j.error.message ?? 'reverted'), { revert: true });
        throw new Error(`${url}: ${j.error.message ?? `error ${j.error.code}`}`);
      }
      benchedUntil.delete(url);
      return j.result ?? '0x';
    } catch (e) {
      if ((e as { revert?: boolean }).revert) throw e;
      last = e;
      benchedUntil.set(url, Date.now() + BENCH_MS);
    }
  }
  throw last instanceof Error ? last : new Error('no RPC endpoint answered');
}
const call = (to: string, data: string): Promise<string> => rpc('eth_call', [{ to, data }, 'latest']);
const word = (d: string, i: number): string => d.slice(i * 64, i * 64 + 64);
const utf8 = (hex: string): string => new TextDecoder().decode(Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)));

function decodeEntry(ret: string): { url: string; wsAddr: string; updatedAt: number } {
  const d = ret.replace(/^0x/, '');
  const str = (offWord: string): string => { const o = Number(BigInt('0x' + offWord)) * 2; const l = Number(BigInt('0x' + d.slice(o, o + 64))); return utf8(d.slice(o + 64, o + 64 + l * 2)); };
  return { url: str(word(d, 0)), wsAddr: str(word(d, 1)), updatedAt: Number(BigInt('0x' + word(d, 2))) };
}
const decodeActive = (ret: string): boolean => BigInt('0x' + word(ret.replace(/^0x/, ''), 2)) === 1n;

/** The chosen relay, and every relay the publisher's nodes announced at that read (for isPublisherRelay). */
type Cached = { wsAddr: string; relays?: string[]; at: number };
function readCache(): Cached | null {
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as Cached | null; return c && typeof c.wsAddr === 'string' ? c : null; } catch { return null; }
}

/**
 * The relay the mesh announced at the last read, however old; null before any read. Synchronous. A read CACHE_MS
 * old is re-read in the background, and the last address stands in meanwhile: a node that moved costs that one
 * connection (the lobby re-reads on a refusal). Answering null instead sent every call made two minutes after
 * load to no relay at all, the account fetch among them, and the game showed SERVER OFFLINE (23 Oct 2026).
 */
export function cachedRelay(): string | null {
  const c = readCache();
  if (c && Date.now() - c.at >= CACHE_MS) refreshRelay();
  return c?.wsAddr ?? null;
}

/**
 * The relays the PUBLISHER runs: the wsAddr each PREFERRED_RELAYS node announced at the last directory read.
 * A NodeDirectory entry is written by that node's own announcer, so the address is the node's. Only these may
 * receive the player's AIR token (a bearer credential for the whole account API: /me, /items/buy, /agent/key):
 * a `?ws=` override names some other host, and is played without it.
 */
let publisherList: string[] = [];
function publisherRelays(): string[] {
  if (!publisherList.length) publisherList = (readCache()?.relays ?? []).filter((r): r is string => typeof r === 'string');
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

/** Read the publisher's NodeDirectory entries + NodeStake standing and cache the first live relay, in PREFERRED_RELAYS order. */
export async function discoverRelay(): Promise<string | null> {
  const { NODE_DIRECTORY, NODE_STAKE } = await loadContracts();
  const nowS = Math.floor(Date.now() / 1000);
  // One node that left the directory (its entry reverts or decodes empty) is skipped, not fatal.
  const entries = await Promise.all(PREFERRED_RELAYS.map(async (k) => {
    try {
      const [entry, standing] = await Promise.all([call(NODE_DIRECTORY, SEL.entryOf + k), call(NODE_STAKE, SEL.standingOf + k)]);
      const e = decodeEntry(entry);
      return e.wsAddr && /^wss:\/\//.test(e.wsAddr) && nowS - e.updatedAt <= FRESH_S && decodeActive(standing) ? e.wsAddr : null;
    } catch { return null; }
  }));
  const found = entries.filter((w): w is string => !!w);
  // Probe them all at once, then take the first that answers in that order. When none answers
  // (every relay down, or this network blocks the probe) fall back to the first that is not
  // another title's — the lobby's connect-failure path re-reads from here.
  const probes = await Promise.all(found.map(probeRelay));
  const wsAddr = found[probes.indexOf('ok')] ?? found[probes.indexOf('down')] ?? null;
  publisherList = found;
  try { if (wsAddr) localStorage.setItem(CACHE_KEY, JSON.stringify({ wsAddr, relays: found, at: Date.now() } satisfies Cached)); } catch { /* private mode */ }
  return wsAddr;
}

/** The cached relay refused a connection: forget it and read the directory
 *  again, now. Returns the relay the mesh names now (may be the same one:
 *  then the relay itself is down, not merely moved). */
export async function relayFailed(): Promise<string | null> {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* private mode */ }
  try { return await discoverRelay(); } catch { return null; }
}

/**
 * Is any publisher relay answering? Wagers escrow credits in the publisher's database, so they run only on the
 * publisher's relays and pause while none answers (MVP decision, 5 Oct 2026: wagers stay off-chain). Ranked and
 * casual play in the arcade do not depend on this. Probed at most every PUBLISHER_MS; a failed probe counts as
 * down, since the wager would connect to the same host.
 */
const PUBLISHER_MS = 30_000;
let publisherCheck: { at: number; up: boolean } | null = null;
export async function publisherOnline(force = false): Promise<boolean> {
  if (!force && publisherCheck && Date.now() - publisherCheck.at < PUBLISHER_MS) return publisherCheck.up;
  await relayReady();
  const anyUp = async (): Promise<boolean> => (await Promise.all(publisherRelays().map(probeRelay))).includes('ok');
  let up = publisherRelays().length > 0 && await anyUp();
  // None answered: the node may have restarted onto a new tunnel hostname. Read the directory now and probe what
  // it names, rather than probing the dead address every minute (23 Oct 2026: wagers paused until a reload).
  if (!up) {
    try { await discoverRelay(); } catch { /* chain unreachable */ }
    up = await anyUp();
  }
  publisherCheck = { at: Date.now(), up };
  return up;
}
/** The last answer of publisherOnline(): true/false, or null before the first probe. Synchronous. */
export const publisherUp = (): boolean | null => publisherCheck?.up ?? null;

let inflight: Promise<unknown> | null = null;
let readAgainAt = 0;
/** Re-read the directory in the background when no read is current (none yet, or CACHE_MS old); returns immediately. */
export function refreshRelay(): void {
  if (inflight || Date.now() < readAgainAt) return;
  const c = readCache();
  if (c && Date.now() - c.at < CACHE_MS && publisherRelays().length) return;
  inflight = discoverRelay()
    .then((addr) => { if (!addr) readAgainAt = Date.now() + RETRY_MS; })
    .catch(() => { readAgainAt = Date.now() + RETRY_MS; /* chain unreachable: keep whatever we had */ })
    .finally(() => { inflight = null; });
}
/** Resolves once the relay read is current (a stale one is re-read first), so a caller deciding where a token may go reads a current answer. */
export const relayReady = (): Promise<unknown> => { refreshRelay(); return inflight ?? Promise.resolve(); };
