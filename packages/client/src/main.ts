/**
 * Agent Fighter — game client.
 * Fixed-timestep 60Hz loop; the renderer is a pure function of GameState plus
 * cosmetic juice that lives OUTSIDE the sim (safe under future rollback).
 * Characters are loaded from `characters/<id>/` bundles + packed atlases —
 * the client interprets no frame data, it only asks the engine which sprite
 * to draw (`spriteForFighter`) and blits it.
 */
import {
  Action, Btn, EXIT_BONUS, EXIT_FIGHT_FLOOR, Phase, REGION_NAME, STAGE,
  TICKS_PER_SEC, TUNING, aiPoll, createAi, createGameState, debugBoxes,
  generateBoard, isLegalMove, itemById, nodeById, setCharacters, step, successors,
} from '@af/core';
import type { AiState, Board, BoardNode, GameState, InputFrame } from '@af/core';
import {
  awardXp, cpuLevelFor, loadLever, loadProfile, saveLever, skillForCpuLevel, xpForNext,
} from './progress.js';
import type { Profile } from './progress.js';
import { listCharacters, loadRoster, drawFighter, resetFighterTrails } from './atlas.js';
import type { Roster } from './atlas.js';
import {
  CONTENT_BOT, CONTENT_TOP, P_COLORS, RANK_TABS, VH, VW, ZOOM_MAX, ZOOM_MIN,
  currentStageBounds, currentStageCamLimits, drawAgent, drawExtract, drawGameOver, drawHud, drawInvite, drawLoading, drawMap, drawNetError, drawOpponentGone,
  drawRanks, drawReconnecting, drawResults, drawSelect, drawShop, drawStage, drawStageSelect, drawTitle,
  drawVsCard, drawWallet, resetTaps, SHOP_SPIN_TICKS, setBgVideo, setGameLogo, setLogo,
  setStageAsset, setUiKit, setVendingArt, tapHit, tapZone, worldTransform,
} from './ui.js';
import type { AgentOpponent, Cam, ExtractView, HudFx, HudId, Mode, RankRow, ShopInventoryEntry, ShopReveal, XpInfo } from './ui.js';
import { listStages, loadBgVideo, loadDisplayFont, loadGameLogo, loadLogo, loadStage, loadUiKit, loadVendingArt } from './chrome.js';
import type { BgVideo, StageAsset } from './chrome.js';
import { audio, hitSfxFor, swingSfx } from './audio.js';
import type { AudioChannel, SfxId } from './audio.js';
import { auth, authLogin, authLogout, authName, authRehydrate, authToken } from './auth.js';
import { NetSession, SoloSession } from './net.js';
import type { NetAccount, Session } from './net.js';
import {
  auraGlow, drawFx, emitAura, emitBurst, emitRing, fxPulse, updateFx,
} from './fx.js';
import { initTouchControls, setTouchCharged, setTouchScreen } from './touch.js';
import {
  autoSpecialActive, autoSpecialCharged, cancelAutoSpecial, pollAutoSpecial, startAutoSpecial,
} from './autospecial.js';
import { initPwa } from './pwa.js';

const TICK_MS = 1000 / TICKS_PER_SEC;

// ---------------------------------------------------------------- crash safety
// A single uncaught exception inside the frame loop used to skip the trailing
// requestAnimationFrame and freeze the canvas permanently and silently (audit
// 2026-07-20 CT-1). These report-and-continue hooks + the try/catch in loop()
// downgrade a stray throw to a logged blip. Purely additive: on a clean frame
// nothing here runs, so existing behaviour is unchanged.
let lastErrLog = 0;
const reportClientError = (where: string, err: unknown): void => {
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  if (now - lastErrLog < 1000) return; // throttle to at most one report/sec
  lastErrLog = now;
  try {
    console.error(`[af] ${where}:`, err);
  } catch { /* console unavailable — nothing safe left to do */ }
};
try {
  addEventListener('error', (e) => reportClientError('window.error', (e as ErrorEvent).error ?? (e as ErrorEvent).message));
  addEventListener('unhandledrejection', (e) => reportClientError('unhandledrejection', (e as PromiseRejectionEvent).reason));
} catch { /* addEventListener unavailable in this context — non-fatal */ }

// Storage that never throws (audit 2026-07-18 client #1). localStorage access
// raises SecurityError in sandboxed iframes / hardened-privacy contexts — and
// this module reads it at TOP LEVEL (the remembered fighter, below). An
// unguarded throw there aborts the whole bundle at eval time, before any error
// UI exists → a permanent white screen, in exactly the embed contexts the game
// is shared into (dare / share links). These wrappers degrade storage to a
// no-op instead of crashing the app.
const safeGetItem = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};
const safeSetItem = (k: string, v: string): void => {
  try { localStorage.setItem(k, v); } catch { /* storage unavailable — non-fatal */ }
};
const safeRemoveItem = (k: string): void => {
  try { localStorage.removeItem(k); } catch { /* storage unavailable — non-fatal */ }
};

// fetch with a hard timeout (audit 2026-07-18 client #4). Browser fetch has no
// default timeout — minutes on a stalled mobile connection — and a hung request
// SOFT-LOCKS UI flows that gate on it (the shop reel spins until its buy
// settles, with ESC disabled while it does). On timeout the request aborts and
// rejects, so the caller's existing catch resets the flow instead of hanging.
const FETCH_TIMEOUT_MS = 12_000;
const fetchT = (url: string, opts: RequestInit = {}, ms = FETCH_TIMEOUT_MS): Promise<Response> => {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(to));
};

// ---------------------------------------------------------------- input
const keys = new Set<string>();
const pressedThisFrame = new Set<string>();
addEventListener('keydown', (e) => {
  audio.unlock(); // first user gesture — browsers block AudioContext until one fires
  if (!keys.has(e.code)) pressedThisFrame.add(e.code);
  keys.add(e.code);
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));

const P0_MAP: [string, number][] = [
  ['KeyA', Btn.Left], ['KeyD', Btn.Right], ['KeyW', Btn.Up], ['KeyS', Btn.Down],
  ['KeyT', Btn.LP], ['KeyY', Btn.MP], ['KeyU', Btn.HP],
  ['KeyG', Btn.LK], ['KeyH', Btn.MK], ['KeyJ', Btn.HK],
];
const P1_MAP: [string, number][] = [
  ['ArrowLeft', Btn.Left], ['ArrowRight', Btn.Right], ['ArrowUp', Btn.Up], ['ArrowDown', Btn.Down],
  ['KeyI', Btn.LP], ['KeyO', Btn.MP], ['KeyP', Btn.HP],
  ['KeyK', Btn.LK], ['KeyL', Btn.MK], ['Semicolon', Btn.HK],
  ['Numpad4', Btn.LP], ['Numpad5', Btn.MP], ['Numpad6', Btn.HP],
  ['Numpad1', Btn.LK], ['Numpad2', Btn.MK], ['Numpad3', Btn.HK],
];
const CONFIRM = [['KeyT', 'KeyY', 'KeyU', 'KeyG', 'KeyH', 'KeyJ'], ['KeyI', 'KeyO', 'KeyP', 'KeyK', 'KeyL', 'Semicolon']];

const pollPad = (map: [string, number][]): InputFrame => {
  let f = 0;
  for (const [code, bit] of map) if (keys.has(code)) f |= bit;
  return f;
};

/** Which fighter the human at this keyboard/screen controls (online may be P2). */
const localSide = (): 0 | 1 => (net ? net.side : 0);

/**
 * Player-0 pad poll, with Auto Special taking the wheel while its macro runs.
 * The two must NEVER merge — the player's own stick would corrupt the motion
 * halfway through and turn a fireball into a random normal.
 */
/** Per-slot arm mask for one fight-frame, set by taps on the HUD cans
 *  ('item:use:N'). The keyboard R drinks the FIRST still-carried slot. */
let itemUseMask = 0;

/** Slot kinds of the local fighter (0 = empty/drunk), HUD-order. */
const localSlotKinds = (g: GameState): [number, number, number] => {
  const f = g.fighters[localSide()];
  return [f.itemKind0, f.itemKind1, f.itemKind2];
};

const pollLocal = (g: GameState, edges = true): InputFrame => {
  let f = autoSpecialActive() ? pollAutoSpecial(g.fighters[localSide()]) : pollPad(P0_MAP);
  // `edges` is false on catch-up sub-steps (CT-2): the one-shot item/drink bits
  // fire only on the first sim step of the rAF so a multi-tick burst can't
  // re-trigger them every tick. Held movement/attack input still applies each
  // step via pollPad/pollAutoSpecial above.
  let mask = edges ? itemUseMask : 0;
  // Press edge, NOT held (`keys.has`): while held, the "first carried" slot
  // re-targets the frame after a can empties, minting a fresh rising edge
  // per slot — one held R chugged the whole rack at a can per frame.
  if (edges && pressedThisFrame.has('KeyR')) {
    // R = drink the next un-drunk can (slot order).
    const kinds = localSlotKinds(g);
    const s = kinds.findIndex((k) => k !== 0);
    if (s >= 0) mask |= 1 << s;
  }
  if (mask & 1) f |= Btn.Item;
  if (mask & 2) f |= Btn.Item2;
  if (mask & 4) f |= Btn.Item3;
  return f;
};

/**
 * Menu taps. The draw functions register their tappable rects every frame
 * (ui.ts tapZone), so a pointer press just hit-tests the CURRENT layout and
 * queues a semantic action ('mode:cpu', 'pick:3'). Screen handlers drain this
 * exactly like `pressedThisFrame`, and it's cleared at the end of each frame.
 *
 * Mouse and touch both land here, so clicking menus works on desktop too.
 */
const taps = new Set<string>();
const tapAt = (clientX: number, clientY: number): void => {
  const r = canvas.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  // CSS-scaled + letterboxed canvas → virtual 960×540 space.
  const vx = ((clientX - r.left) / r.width) * VW;
  const vy = ((clientY - r.top) / r.height) * VH;
  if (vx < 0 || vy < 0 || vx > VW || vy > VH) return;
  const action = tapHit(vx, vy);
  if (action) {
    audio.blip(); // UI feedback: a tap that lands on a real menu zone clicks
    taps.add(action);
  }
};

// ---------------------------------------------------------------- state
type Screen = 'loading' | 'title' | 'select' | 'stageSelect' | 'online' | 'fight' | 'results' | 'gameover' | 'ranks' | 'invite' | 'agent' | 'shop' | 'map' | 'extract';

let screen: Screen = 'loading';
let mode: Mode = 'cpu';
let net: Session | null = null;
let netInstalled = false;

// ---- M5 credits: the AIR sign-in gate + the server-side account.
// ?dev=NAME bypasses the gate against a DEV-economy match server (in-memory
// persistence, name-keyed identities) — for development only; a production
// server (real Supabase) ignores dev names and demands a verified AIR token.
const DEV_GUEST = new URLSearchParams(location.search).get('dev');
/**
 * Signed-in = a real AIR session (or a ?dev= economy identity). Guests may play
 * AGENT ARCADE locally, reward-free (no fee / XP / records); signing in is only
 * required for RANKED (wager), the shop, MY AGENT, and dares — the account IS
 * the wallet those settle into. This is a module-level probe so the in-gesture
 * pointerdown handler (which fires the OAuth dialog on iOS) can read it too.
 */
const isSignedIn = (): boolean => auth.status === 'in' || !!DEV_GUEST;
let account: NetAccount | null = null;
let accountFetch: 'idle' | 'busy' | 'done' | 'fail' = 'idle';
/** Coached agent config (ADR 0006) — non-null unlocks AUTO in solo/arcade. */
interface AgentCoachConfig { character?: string; personality?: Record<string, number>; motto?: string }
let agentCfg: AgentCoachConfig | null = null;
let autoHintAge = -1; // ≥0 → "coach your agent to unlock AUTO" toast animating
let accountToastAge = -1; // ≥0 → the "+10 DAILY CREDITS" toast is animating
let queuedMode: 'solo' | 'wager' | 'arcade' | 'friendly' = 'wager';
let practiceFree = false; // offline-fallback match: no fee, no XP, no records

// ---- P0 loop redesign: quick play, VS card, wallet strip.
// The remembered fighter makes the title's ENTER a one-input path to a match.
const LAST_FIGHTER_KEY = 'af-last-fighter';
let lastFighter = safeGetItem(LAST_FIGHTER_KEY) ?? '';
/** Title-screen Music/SFX/Hits dropdown (speaker chip always visible). */
let audioMenuOpen = false;
/** Ambient menu video — paused during fights to free its decoder (iOS memory). */
let bgVideoRef: BgVideo | null = null;
let bgVideoPlaying = true;

/**
 * AIR sign-in / sign-out toggle. This MUST be reachable straight from a pointer
 * event's own call stack: AIR's `login()` opens an OAuth surface (popup /
 * redirect) that iOS Safari only permits while a user-activation is still live.
 * Every other menu tap is drained a frame later inside the rAF loop, which on
 * iPhone drops that activation and the dialog silently never opens — the
 * sign-in headline looked completely dead. Same failure class the invite share
 * buttons already work around by firing in-gesture. Desktop `L` still routes
 * here from the frame loop (keyboard has no activation constraint).
 */
const toggleSignIn = (): void => {
  if (auth.status === 'in') {
    void authLogout();
    account = null;
    accountFetch = 'idle';
  } else {
    void authLogin();
  }
};

// ---- Referral dares ("I dare you to fight"). A shared landing link
// (agent-fighter-web.vercel.app/dare/<code>) deep-links here with ?ref=;
// the code waits in localStorage until the first authenticated contact
// redeems it server-side (+25 credits each, once ever, new accounts only).
const REF_CODE_KEY = 'af-ref-code';
const DARE_LINK_BASE = 'https://agent-fighter-web.vercel.app/dare';
const storedRef = (): string | undefined => safeGetItem(REF_CODE_KEY) ?? undefined;
let referralToastAge = -1; // ≥0 → the "+25 DARE ACCEPTED" toast is animating

// ---- Invite screen ("PUT A BOUNTY ON YOUR OWN HEAD") — the sender side of
// the dare loop. The chosen taunt rides the link as ?t= so the landing page
// and its OG thumbnail shout it at the invitee; free text is by design.
/** Mirrors release_referral's rolling-week payout cap (0005_referrals.sql). */
const REFERRAL_WEEKLY_CAP = 10;
// Curated taunts only — the ◀ ▶ picker cycles these (no free-text input, so
// nothing forgeable ever rides the shared ?t= link). Keep each ≤ ~64 chars so
// the OG card and the in-game line never overflow.
const TAUNTS = [
  "MY GRANDMA'S AI HITS HARDER THAN YOU.",
  "YOU'D BE MY EASIEST WIN YET.",
  'SAY YOU WERE LAGGING. I DARE YOU.',
  "I'LL PLAY ONE-HANDED. STILL TAKING YOUR ROUNDS.",
  "BRING A FRIEND. YOU'LL NEED THE EMOTIONAL SUPPORT.",
  "I'VE SEEN YOU PLAY. THIS WON'T TAKE LONG.",
  'ONE ROUND. THAT’S ALL I’M ASKING. YOU CAN’T EVEN GIVE ME ONE.',
  'YOUR MAIN? CUTE. BRING IT ANYWAY.',
  'BLOCK BUTTON’S RIGHT THERE. YOU’LL FIND OUT WHY.',
  'AFRAID? YOU SHOULD BE.',
  'I ALREADY KNOW HOW THIS ENDS. DO YOU?',
  'FREE CREDITS FOR LOSING TO ME. GENEROUS, RIGHT?',
  'TAP ACCEPT. GET FLATTENED. COLLECT YOUR PARTICIPATION TROPHY.',
  'NO JOHNS. NO LAG. JUST YOU LOSING.',
  'PROVE ME WRONG. YOU WON’T, BUT PROVE ME WRONG.',
];
let tauntIdx = 0;
let inviteCopiedAge = -1; // ≥0 → the button reads "DARE ARMED"
let inviteFrom: 'title' | 'results' = 'title'; // where ESC returns to
// ---- Friendly challenge rooms (protocol v5): FREE, UNRANKED, paired by a
// shared room code (the inviter's ref code). ?room= deep links a challenged
// friend straight into the inviter's room — after the AIR sign-in gate.
let friendlyRoom = ''; // the room the current/last friendly queued into
let pendingRoom = ''; // ?room= from a challenge link, waiting on sign-in
// The select screen is shared by wager and friendly (both PvP, one fighter to
// pick). This flag tells its lock handler which to queue — set true only for
// the friendly path, reset false on every normal (wager/cpu) select entry.
let selectingFriendly = false;
// ---- Dare-vs-agent (ADR 0006): the dare can target the sender's TRAINED
// AGENT instead of the sender live. Sender side: the invite toggle flips the
// link to &agent=1. Accepter side: ?agent=1 + ?ref= deep-links into a solo
// match vs the sender's coached config (server-pinned, verified — the sender
// stays offline). Same in-memory-only stance as pendingRoom: it's a "fight
// them NOW" intent, not a durable coupon.
let dareVsAgent = false; // invite screen toggle state
let pendingAgentOf = ''; // ?agent=1 dare code waiting on the sign-in gate
let selectingAgentOf = ''; // select screen: lock queues solo vs this agent
let queuedAgentOf = ''; // what the live/last online queue used (rematch)
const currentTaunt = (): string => TAUNTS[tauntIdx]!;
const dareLink = (): string =>
  `${DARE_LINK_BASE}/${account?.refCode ?? ''}?t=${encodeURIComponent(currentTaunt())}${dareVsAgent ? '&agent=1' : ''}`;
/** Coarse pointer ≈ phone/tablet → prefer the OS share sheet over clipboard. */
const shareViaSheet = (): boolean =>
  typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches;
const enterInvite = (from: 'title' | 'results'): void => {
  inviteFrom = from;
  inviteCopiedAge = -1;
  screen = 'invite';
};
const shareDare = (): void => {
  if (!account?.refCode) return;
  const link = dareLink();
  // Level flex: the account level is the bragging-rights stat, so it rides the
  // share text (the one place progression can actually spread).
  const lv = account?.level;
  const text = dareVsAgent
    ? `${currentTaunt()} — MY LV ${lv ?? '??'} AGENT FIGHTS FOR ME. Beat it and prove something. +25 credits when you sign in.`
    : `${currentTaunt()}${lv ? ` I'M LV ${lv}.` : ''} I DARE YOU TO FIGHT. +25 credits if you can take one round.`;
  const done = (): void => { inviteCopiedAge = 0; };
  const copyFallback = (): void => {
    void navigator.clipboard?.writeText(`${text}\n${link}`).then(done)
      .catch(() => { window.prompt('COPY YOUR DARE LINK:', link); done(); });
  };
  if (shareViaSheet()) {
    // Must be called synchronously from a tap/key gesture on iOS — a deferred
    // rAF call loses user activation and fails with NotAllowedError.
    void navigator.share({ title: 'AGENT FIGHTER', text, url: link }).then(done)
      .catch((err: unknown) => {
        // User dismissed the sheet — leave the button armed for another try.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        copyFallback();
      });
  } else {
    copyFallback();
  }
};
/** Ticks the pre-fight stakes card has been showing (-1 = off). */
let vsCardAge = -1;
const VS_CARD_TICKS = 150; // ~2.5s; any key skips
let vsStakes: string[] = [];
// Wallet strip delta: animate credits the moment the balance visibly moves.
let walletShown: number | null = null;
let walletDelta: { amt: number; age: number } | null = null;

const drawWalletStrip = (): void => {
  if (!account) return;
  walletShown ??= account.credits;
  if (account.credits !== walletShown) {
    walletDelta = { amt: account.credits - walletShown, age: 0 };
    walletShown = account.credits;
  }
  if (walletDelta && ++walletDelta.age > 130) walletDelta = null;
  drawWallet(ctx, account, walletDelta);
};

/**
 * The deployed match server (Railway). MUST be wss:// — the game is served
 * over https and browsers block ws:// from an https origin as mixed content,
 * so a ws:// default here means online play dies before a packet moves.
 * Railway terminates TLS; the server itself still speaks plain ws.
 */
const PROD_MATCH_WS = 'wss://match-server-production.up.railway.app';

/**
 * Match-server endpoints. `?ws=` overrides everything (dev/staging/testing);
 * an https page uses the deployed server; anything else is a local dev box
 * running the server beside the page (`npm run play`).
 */
const matchWsUrl = (): string => {
  const override = new URLSearchParams(location.search).get('ws');
  if (override) return override;
  if (location.protocol === 'https:') return PROD_MATCH_WS;
  return `ws://${location.hostname}:8477`;
};
const matchHttpUrl = (): string => matchWsUrl().replace(/^ws/, 'http');

// Public standings (drawRanks) — fetched from the match server on entry.
let ranksRows: RankRow[] | null = null;
let ranksTab = 0;
let ranksErr = '';
let ranksBusy = false;

const fetchRanks = (): void => {
  if (ranksBusy) return;
  ranksBusy = true;
  ranksRows = null;
  ranksErr = '';
  void fetchT(`${matchHttpUrl()}/leaderboard?limit=100`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`server said ${res.status}`);
      ranksRows = (await res.json()) as RankRow[];
    })
    .catch((e) => { ranksErr = (e as Error).message || 'unreachable'; })
    .finally(() => { ranksBusy = false; });
};

// ---- AGENT OPPONENT identity (select-screen badge) ------------------------
// The match server's /agents/roster returns real LIVE agents (fleet/headless
// accounts with W-L) plus the house aggregate record. Ranked solo pins that
// same nearest-level agent server-side (name + optional personality), so the
// badge, queue copy, nameplate, and match history share one identity.
interface RosterAgent {
  id: string; name: string; address: string | null;
  level: number; xp: number; wins: number; losses: number; streak: number;
}
interface RosterResp {
  agents: RosterAgent[];
  house: { wins: number; losses: number; streak: number; battles: number };
}
let agentRoster: RosterResp | null = null;
let agentRosterFetched = false;
/** Stable branded house smart-account handle (the house has no AIR wallet). */
const HOUSE_WALLET = '0xA6E7…13C9';

const shortAddr = (a?: string | null): string =>
  a && a.length >= 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a ?? '');

const fetchAgentRoster = (): void => {
  agentRosterFetched = true;
  void fetchT(`${matchHttpUrl()}/agents/roster`)
    .then(async (r) => { if (r.ok) agentRoster = (await r.json()) as RosterResp; })
    .catch(() => { /* offline — the house agent is synthesized in resolveAgentOpp */ });
};

/** Nearest-level live agent — mirrors server `soloOpts` pick order. */
const pickLiveAgentOpp = (target: number): RosterAgent | null => {
  const agents = (agentRoster?.agents ?? []).filter((a) => a.name);
  if (agents.length === 0) return null;
  return [...agents].sort((p, q) =>
    Math.abs(p.level - target) - Math.abs(q.level - target)
    || q.wins - p.wins
    || p.name.localeCompare(q.name),
  )[0] ?? null;
};

/**
 * The two HUD identity strips (wallet + on-chain stats) drawn under each
 * fighter's portrait/health/meter. The signed-in player's row shows credits;
 * the opponent's shows its record — the agent opponent for solo/arcade, the
 * live peer for online, a guest for local 2P.
 */
const hudIds = (): [HudId | null, HudId | null] => {
  const ls = localSide();
  const me: HudId = {
    wallet: shortAddr(auth.address),
    credits: account?.credits,
    level: account?.level ?? profile.level,
    wins: account?.wins ?? profile.wins,
    losses: account?.losses ?? profile.losses,
  };
  let opp: HudId | null;
  if (cpuAi) {
    const o = resolveAgentOpp();
    opp = { wallet: o.wallet, level: o.level, wins: o.wins, losses: o.losses, streak: o.streak, minds: o.minds };
  } else if (net?.setup) {
    const os = (1 - net.side) as 0 | 1;
    opp = { wallet: '', minds: net.setup.agents[os] }; // live peer: name is on the nameplate; record unknown here
  } else {
    opp = { wallet: '' }; // local 2P guest
  }
  const out: [HudId | null, HudId | null] = [null, null];
  out[ls] = me;
  out[(1 - ls) as 0 | 1] = opp;
  return out;
};

/** Resolve the current AI-agent opponent for the select-screen badge. */
const resolveAgentOpp = (): AgentOpponent => {
  // Online solo pins by account level; offline CPU still uses the local lever.
  const target = account?.level ?? cpuLevelFor(profile, lever);
  const a = pickLiveAgentOpp(target);
  if (a) {
    return {
      kind: 'live', name: a.name, level: a.level, wins: a.wins, losses: a.losses,
      streak: a.streak, wallet: shortAddr(a.address), minds: false,
    };
  }
  // House agent: calibrated level; the REAL aggregate record once it has match
  // history (it visibly grows as players fight it — the "learning" signal),
  // else a seeded "connected account" so a fresh deployment still reads as an
  // established rival.
  const h = agentRoster?.house;
  const live = h && h.battles > 0;
  return {
    kind: 'house', name: 'HOUSE AGENT', level: target,
    wins: live ? h!.wins : (12 + (profile.wins % 40)),
    losses: live ? h!.losses : (2 + (profile.losses % 6)),
    streak: live ? h!.streak : Math.max(0, (profile.wins % 5)),
    wallet: HOUSE_WALLET, minds: true,
  };
};

/**
 * Pull the account snapshot from the match server (also claims the daily
 * +10 login bonus — first authenticated contact of the day wins it).
 */
const fetchAccount = async (): Promise<void> => {
  accountFetch = 'busy';
  try {
    const headers: Record<string, string> = {};
    const token = await authToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (DEV_GUEST) headers['X-Dev-Name'] = DEV_GUEST;
    else { accountFetch = 'idle'; return; }
    // A stashed dare code rides along and redeems exactly once server-side.
    const ref = storedRef();
    const q = new URLSearchParams();
    // Same display name as the ws hello — without it get_account upserts a
    // UUID-prefix fallback over the real fighter name (leaderboard bug).
    const name = authName();
    if (name) q.set('name', name.toUpperCase());
    if (ref) q.set('ref', ref);
    const qs = q.toString();
    const res = await fetchT(`${matchHttpUrl()}/me${qs ? `?${qs}` : ''}`, { headers });
    if (!res.ok) { accountFetch = 'fail'; return; }
    account = (await res.json()) as NetAccount;
    if (account.dailyGranted) accountToastAge = 0;
    if ((account.referralGranted ?? 0) > 0) referralToastAge = 0;
    // The server has now decided the referral (granted or ineligible) —
    // either way the code is spent for this account. Stop resending it.
    if (ref) safeRemoveItem(REF_CODE_KEY);
    accountFetch = 'done';
    // TRAIN MY AGENT (ADR 0006): the coached config gates + drives AUTO
    // (hands-free) mode. Best-effort — no config just leaves AUTO locked.
    void fetchT(`${matchHttpUrl()}/agent`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((info: { config?: AgentCoachConfig | null } | null) => {
        agentCfg = info?.config ?? null;
      })
      .catch(() => { /* coach config is optional */ });
  } catch {
    accountFetch = 'fail'; // server offline — title shows it, local play still fine
  }
};

// ---- MY AGENT screen (ADR 0006): the in-game face of the coaching loop.
// Read-only view of GET /agent + the two actions the game owns: minting the
// coach key (POST /agent/key) and sparring vs your own agent (ranked solo
// with agentOf = your ref code). Coaching itself stays in Minds by design.
interface AgentScreenInfo {
  name?: string; level?: number; xp?: number; wins?: number; losses?: number;
  config?: AgentCoachConfig | null;
  keyCreatedAt?: string | null;
}
let agentScreenFetch: 'idle' | 'busy' | 'done' | 'fail' = 'idle';
let agentScreenInfo: AgentScreenInfo | null = null;
let mintedKey = ''; // plaintext from mint — shown once, never stored
/** Which mint produced `mintedKey` (copy/reveal copy differs). */
let mintedKeyKind: 'coach' | 'fighter' = 'coach';
let mintBusy = false;
let keyCopiedAge = -1; // ≥0 → the "copied" flash is animating

const agentAuthHeaders = async (): Promise<Record<string, string> | null> => {
  const headers: Record<string, string> = {};
  const token = await authToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (DEV_GUEST) headers['X-Dev-Name'] = DEV_GUEST;
  else return null;
  return headers;
};

const fetchAgentScreen = async (): Promise<void> => {
  agentScreenFetch = 'busy';
  try {
    const headers = await agentAuthHeaders();
    if (!headers) { agentScreenFetch = 'fail'; return; }
    const res = await fetchT(`${matchHttpUrl()}/agent`, { headers });
    if (!res.ok) { agentScreenFetch = 'fail'; return; }
    agentScreenInfo = (await res.json()) as AgentScreenInfo;
    agentCfg = agentScreenInfo.config ?? null; // keep the AUTO gate in sync
    agentScreenFetch = 'done';
  } catch {
    agentScreenFetch = 'fail';
  }
};

const mintAgentKey = async (): Promise<void> => {
  if (mintBusy) return;
  mintBusy = true;
  keyCopiedAge = -1;
  try {
    const headers = await agentAuthHeaders();
    if (!headers) return;
    const res = await fetchT(`${matchHttpUrl()}/agent/key`, { method: 'POST', headers });
    if (!res.ok) return;
    const body = (await res.json()) as { key?: string };
    if (body.key) {
      mintedKey = body.key;
      mintedKeyKind = 'coach';
      void fetchAgentScreen();
    }
  } catch { /* the screen keeps its MINT button — just tap again */
  } finally {
    mintBusy = false;
  }
};

/** Create an operator-owned agent-class fighter (POST /agent/signup + AIR). */
const createAgentFighter = async (): Promise<void> => {
  if (mintBusy) return;
  mintBusy = true;
  keyCopiedAge = -1;
  try {
    const headers = await agentAuthHeaders();
    if (!headers) return;
    headers['Content-Type'] = 'application/json';
    // Name omitted — server derives from the owner profile + tag.
    const res = await fetchT(`${matchHttpUrl()}/agent/signup`, {
      method: 'POST', headers, body: '{}',
    });
    if (!res.ok) return;
    const body = (await res.json()) as { key?: string };
    if (body.key) {
      mintedKey = body.key;
      mintedKeyKind = 'fighter';
    }
  } catch { /* retry via tap */
  } finally {
    mintBusy = false;
  }
};

const enterAgentScreen = (): void => {
  screen = 'agent';
  mintedKey = '';
  mintedKeyKind = 'coach';
  mintBusy = false;
  keyCopiedAge = -1;
  void fetchAgentScreen();
};

// ---- VENDING MACHINE (ADR 0007 Phase 1): gacha energy drinks for credits.
// The roll is SERVER-side at purchase time; the client only renders what the
// machine dispensed. Purchases are idempotent by a client nonce, so a flaky
// network retry can never double-charge or re-roll.
interface ShopCatalogDef { id: string; name: string; tier: number; desc: string; flavor: string }
let shopFetch: 'idle' | 'busy' | 'done' | 'fail' = 'idle';
let shopInv: ShopInventoryEntry[] = [];
let shopCatalog: ShopCatalogDef[] = [];
let shopCost = 5; // server-confirmed on fetch (core ITEM_COST)
let shopPullBusy = false;
let shopReveal: ShopReveal | null = null;
let shopRevealAge = -1;
let shopErr = '';
let shopErrAge = -1;
// Purchase-flow state: PULL → confirm modal → slot-machine spin → reveal.
let shopConfirm = false;
let shopSpinAge = -1; // ticks into the reel spin; -1 = not spinning
// The buy response, held back until the reel finishes its 3s spin — the
// item is decided server-side instantly; the suspense is pure theater.
let shopPending: { reveal: ShopReveal; entry: ShopInventoryEntry } | null = null;
// The shop's OWN identity + balance. Headers are resolved once per shop visit
// and reused for the pull; the balance comes from GET /items. Both exist so
// the number on screen is always the wallet that a pull will charge — the
// /me account can be a DIFFERENT identity while the AIR session rehydrates
// (found live twice; the enterShop re-fetch alone didn't close the race).
let shopHeaders: Record<string, string> | null = null;
let shopCredits: number | null = null;
/** The EQUIPPED loadout (slot order, from GET /items) — the server carries
 *  these into every ranked match automatically; select just displays them. */
let equippedInv: ShopInventoryEntry[] = [];

const mapOwned = (
  it: { rowId?: number; tier?: number; equippedSlot?: number | null; def?: ShopCatalogDef | null },
): ShopInventoryEntry => ({
  rowId: Number(it.rowId ?? 0),
  name: it.def?.name ?? 'UNKNOWN CAN',
  tier: Number(it.def?.tier ?? it.tier ?? 1),
  desc: it.def?.desc ?? '',
  equippedSlot: it.equippedSlot === null || it.equippedSlot === undefined ? null : Number(it.equippedSlot),
});

/** Rebuild the equipped view (slot order) from the full inventory. */
const refreshEquipped = (): void => {
  equippedInv = shopInv
    .filter((i) => i.equippedSlot !== null && i.equippedSlot !== undefined)
    .sort((a, b) => (a.equippedSlot ?? 0) - (b.equippedSlot ?? 0))
    .slice(0, 3);
};

const fetchShop = async (): Promise<void> => {
  shopFetch = 'busy';
  try {
    // Resolve auth ONCE for this shop visit; the pull reuses these exact
    // headers so the balance shown and the wallet charged cannot diverge.
    shopHeaders = await agentAuthHeaders();
    if (!shopHeaders) { shopFetch = 'fail'; return; }
    const res = await fetchT(`${matchHttpUrl()}/items`, { headers: shopHeaders });
    if (!res.ok) { shopFetch = 'fail'; return; }
    const body = (await res.json()) as {
      cost?: number;
      credits?: number | null;
      catalog?: ShopCatalogDef[];
      items?: Array<{ rowId?: number; tier?: number; equippedSlot?: number | null; def?: ShopCatalogDef | null }>;
    };
    shopCost = Number(body.cost ?? 5);
    // null/undefined = profile unseen or old server — fall back to the /me
    // wallet (pre-credits servers never reach prod, this is dev leniency).
    shopCredits = typeof body.credits === 'number' ? body.credits : null;
    shopCatalog = body.catalog ?? [];
    shopInv = (body.items ?? []).map(mapOwned);
    refreshEquipped();
    shopFetch = 'done';
  } catch {
    shopFetch = 'fail';
  }
};

/** The balance the SHOP trusts: its own identity's read, else the /me wallet. */
const shopBalance = (): number | null =>
  shopCredits !== null ? shopCredits : (account ? account.credits : null);

const pullShop = async (): Promise<void> => {
  if (shopPullBusy) return;
  shopPullBusy = true;
  shopErr = '';
  shopErrAge = -1;
  try {
    const headers = shopHeaders ?? await agentAuthHeaders();
    if (!headers) return;
    // Client purchase id — the server's idempotency key for THIS pull.
    const nonce = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    const res = await fetchT(`${matchHttpUrl()}/items/buy`, {
      method: 'POST', headers, body: JSON.stringify({ nonce }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      item?: ShopCatalogDef; rowId?: number; credits?: number; error?: string;
    };
    if (!res.ok) {
      shopErr = res.status === 402
        ? `NOT ENOUGH CREDITS — A PULL COSTS ${shopCost}`
        : (body.error ?? 'THE MACHINE ATE YOUR COIN — TRY AGAIN').toUpperCase().slice(0, 64);
      shopErrAge = 0;
      shopSpinAge = -1; // stop the reel dead — no result is coming
      return;
    }
    if (body.item) {
      // Hold the result until the reel lands (the frame loop swaps it in);
      // if the spin somehow isn't running, reveal immediately.
      shopPending = {
        reveal: {
          name: body.item.name, tier: body.item.tier,
          desc: body.item.desc, flavor: body.item.flavor,
        },
        entry: mapOwned({ rowId: body.rowId, def: body.item }),
      };
      if (shopSpinAge < 0) landShopSpin();
    }
    // The purchase changed the balance — keep both wallets honest.
    if (typeof body.credits === 'number') {
      shopCredits = body.credits;
      if (account) account.credits = body.credits;
    }
  } catch {
    shopErr = 'SERVER UNREACHABLE — NOTHING WAS CHARGED';
    shopErrAge = 0;
    shopSpinAge = -1;
  } finally {
    shopPullBusy = false;
  }
};

/** Reel finished (or was never running): swap the held result into the reveal. */
const landShopSpin = (): void => {
  shopSpinAge = -1;
  if (!shopPending) return;
  shopReveal = shopPending.reveal;
  shopRevealAge = 0;
  shopInv.unshift(shopPending.entry);
  shopPending = null;
  audio.blip({ freq: 1560, volume: 0.5 }); // the "clunk" of the can landing
};

/**
 * Toggle a can in/out of the equipped loadout (≤3) and sync the server.
 * Optimistic: the local slots update immediately; the response re-syncs.
 */
let equipBusy = false;
const toggleEquip = async (rowId: number): Promise<void> => {
  if (equipBusy) return;
  const target = shopInv.find((i) => i.rowId === rowId);
  if (!target) return;
  const current = equippedInv.map((i) => i.rowId);
  let next: number[];
  if (current.includes(rowId)) {
    next = current.filter((r) => r !== rowId); // unequip
  } else {
    if (current.length >= 3) { audio.blip({ freq: 220, volume: 0.3 }); return; } // rack full
    next = [...current, rowId];
  }
  equipBusy = true;
  // Optimistic local flip so the rack answers the tap instantly.
  for (const it of shopInv) {
    it.equippedSlot = next.includes(it.rowId) ? next.indexOf(it.rowId) : null;
  }
  refreshEquipped();
  audio.blip({ freq: 990, volume: 0.4 });
  try {
    const headers = shopHeaders ?? await agentAuthHeaders();
    if (!headers) return;
    const res = await fetchT(`${matchHttpUrl()}/items/equip`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowIds: next }),
    });
    if (!res.ok) void fetchShop(); // server disagreed — re-sync the truth
  } catch {
    void fetchShop();
  } finally {
    equipBusy = false;
  }
};

const enterShop = (): void => {
  audioMenuOpen = false;
  screen = 'shop';
  shopReveal = null;
  shopRevealAge = -1;
  shopErr = '';
  shopErrAge = -1;
  shopConfirm = false;
  shopSpinAge = -1;
  shopPending = null;
  shopHeaders = null;
  shopCredits = null;
  // Re-sync the account alongside the shop fetch: both resolve auth NOW, so
  // the wallet shown is the wallet charged. (Without this, a boot-time /me
  // that raced AIR-session rehydration can display one profile while the
  // pull debits another — found live: wallet said 10 CR, buy 402'd at 0.)
  void fetchAccount();
  void fetchShop();
};
let uiTick = 0;
let allRosters: Roster[] = [];
let picks: [number, number] = [0, 0];
let locked: [boolean, boolean] = [false, false];

// ---- AGENT ARCADE: the RANKED gauntlet. Enter from the title, pick a
// fighter (inside the mode — never before it), then battle every enabled
// agent back-to-back with the AI ramping up each stage. One loss = GAME OVER
// → title. The fighter is locked for the whole run by design.
//
// RANKED (default): every battle is a server-verified solo-style match — the
// server owns the opponent order, the skill ramp, and the run token; 1 credit
// buys the run, XP/W-L settle per battle, credits pay at milestones + clear.
// PRACTICE (server-unreachable fallback): the same gauntlet fully local —
// no fee, no XP, no records.
interface ArcadeRun {
  practice: boolean;
  /** The generated board. Fully revealed — this is a puzzle, not a gamble. */
  board: Board;
  /** Node the run is STANDING on. Ranked: mirrors the server, never leads it. */
  at: number;
  /** Node currently being fought, or -1. */
  pending: number;
  /** Fights WON this run. */
  fights: number;
  /** Fights on the cheapest line to the deep exit (the 7 in 2/4/7). */
  total: number;
  /** UNBANKED pickups — what a loss takes away. */
  bag: { credits: number; drinks: { itemId: string; tier: number }[] };
  /**
   * The fighter SEALED into this run. Ranked runs take it from the server
   * (it is the server that locked it), so a resume draws the right fighter on
   * the board even when the local pick has since moved.
   */
  charId: string;
  /** RANKED only: bearer token that continues the run after a win. */
  runToken?: string;
}
let arcade: ArcadeRun | null = null;
let gameOverAge = 0; // ticks on the GAME OVER screen — drives its countdown
// ---- QUIT CONFIRM: leaving a LIVE match (desktop ESC, or the phone MATCH-MENU
// QUIT which fires Escape) raises an "are you sure?" modal instead of dumping
// straight to character select. Confirming returns to the HOME screen — never
// select — and forfeits any online match. Reset on every match start.
let quitConfirm = false;

// ---- ARCADE ENTRY (ADR 0007 credits rework): pay-before-select + resume.
// The 1-credit entry is a consented, NON-refundable debit taken by
// POST /arcade/enter BEFORE character select; the returned run token queues
// battle 1 with fee 0. The token is ALSO persisted (af-arcade-run) so a
// crashed PWA can relaunch and RESUME the run inside the server's 5-minute
// grace instead of silently eating the credit (observed live in prod logs).
let arcadeEntryConfirm = false; // the ENTER ARCADE? modal is up on the title
let arcadeEntryBusy = false; // POST /arcade/enter in flight
let pendingArcadeToken = ''; // paid-but-unstarted run (consumed by select lock)

const ARCADE_RUN_KEY = 'af-arcade-run';
interface StoredArcadeRun { token: string; charId: string; battle: number; total: number; ts: number }
const storeArcadeRun = (r: StoredArcadeRun | null): void => {
  try {
    if (r) safeSetItem(ARCADE_RUN_KEY, JSON.stringify(r));
    else safeRemoveItem(ARCADE_RUN_KEY);
  } catch { /* private mode — resume is best-effort */ }
};
/** The stored run, if it's fresh enough for the server to still hold it. */
const storedArcadeRun = (): StoredArcadeRun | null => {
  try {
    const raw = safeGetItem(ARCADE_RUN_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as StoredArcadeRun;
    // Kept just inside the server's ARCADE_NEXT_GRACE_MS (30min, ADR 0008) so
    // the RESUME pill never offers a run the server has already swept.
    if (!r.token || !r.charId || Date.now() - r.ts > 25 * 60_000) return null;
    return r;
  } catch {
    return null;
  }
};

/** Small title-screen toast for arcade-entry outcomes (drawn inline). */
let titleToast = '';
let titleToastAge = -1;
const showToast = (msg: string): void => { titleToast = msg; titleToastAge = 0; };

/**
 * Module-scope twin of the title branch's local enterSelect() — needed
 * because payArcadeEntry resolves async, after that frame's closure is gone.
 * mode is already 'cpu' (the arcade row) when this runs.
 */
const enterSelectForArcade = (): void => {
  audioMenuOpen = false;
  screen = 'select';
  locked = [false, false];
  selectingFriendly = false;
  selectingAgentOf = '';
  let fe = allRosters.findIndex((r) => r.id === lastFighter && !r.disabled);
  if (fe < 0) fe = Math.max(0, allRosters.findIndex((r) => !r.disabled));
  picks = [fe, fe];
  if (auth.status === 'in' || DEV_GUEST) void fetchShop();
  void audio.playBgm('player_select', { fadeInSec: 0.5 });
};

/** Pay the arcade entry (idempotent by nonce) and move on to fighter select. */
const payArcadeEntry = async (): Promise<void> => {
  if (arcadeEntryBusy) return;
  arcadeEntryBusy = true;
  try {
    const headers = await agentAuthHeaders();
    if (!headers) return;
    const nonce = `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const res = await fetchT(`${matchHttpUrl()}/arcade/enter`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      token?: string; credits?: number | null; error?: string;
    };
    if (!res.ok || !body.token) {
      showToast(res.status === 402
        ? 'NOT ENOUGH CREDITS — AGENT ARCADE COSTS 1'
        : (body.error ?? 'ARCADE ENTRY FAILED — TRY AGAIN').toUpperCase().slice(0, 56));
      arcadeEntryConfirm = false;
      return;
    }
    pendingArcadeToken = body.token;
    // The credit left the wallet NOW — show it now (this is the whole point
    // of the rework: no more surprise −1 after the first battle).
    if (typeof body.credits === 'number' && account) {
      account = { ...account, credits: body.credits };
    }
    arcadeEntryConfirm = false;
    enterSelectForArcade();
  } catch {
    showToast('SERVER UNREACHABLE — NOTHING WAS CHARGED');
    arcadeEntryConfirm = false;
  } finally {
    arcadeEntryBusy = false;
  }
};

// Progression + the CPU difficulty lever.
const profile: Profile = loadProfile();
let lever = loadLever();
let cpuAi: AiState | null = null;
let statDmg = 0; // damage the human dealt this match
let statBestCombo = 0;
let xpBanner: XpInfo | null = null;
let resultsAge = 0; // ticks since the results screen appeared — drives its pop-in
let stageIds: string[] = [];
let stageAssets: (StageAsset | null)[] = [];
let stageCursor = 0;
let fighters: [Roster, Roster] | null = null;
let game: GameState | null = null;
let showBoxes = false;
let seed = 1;
let loadError = '';
/** Boot load fraction 0..1 — drives the loading-screen charge bar. */
let loadProgress = 0;
/** Smoothed bar fill so step jumps don't look like a stuck meter. */
let loadDisplay = 0;
let hurryPlayed = false; // per-round: has the "Hurry Up!" stinger fired yet
const HURRY_UP_TICKS = 10 * TICKS_PER_SEC; // MvC fires it at 10s left on the clock
const setLoadProgress = (p: number): void => {
  loadProgress = Math.max(loadProgress, Math.min(1, p));
};

// Cosmetic juice — never simulated.
const DANGER_RED = '#ff2d4a'; // critical-health aura / warning tint
interface Spark {
  x: number; y: number; age: number; big: boolean;
  /** Floating text (drink-consumed FX) — rendered instead of the hit ring. */
  tag?: string; color?: string;
}
let sparks: Spark[] = [];
let shake = 0;
let cam: Cam = { x: 0, y: 0, zoom: 1.5 };
let hitStopFlash = 0;
const fx: HudFx = { flash: [1, 1], comboOwner: -1, comboHits: 0, comboAge: 0, announce: '', announceAge: 0 };
let prevHealth: [number, number] = [0, 0];
let prevConnected: [number, number] = [0, 0]; // fighters[i].attackConnected last frame — edge-detects new hits/blocks
let prevPhase: Phase = Phase.PreRound;
let prevSuperFlash = 0; // rising-edge detect for the super-activation shockwave
let prevMeter: [number, number] = [0, 0]; // to spot which fighter spent meter

// ---------------------------------------------------------------- canvas
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const px = (v: number): number => Math.trunc(v / 256);

// Menus are tappable/clickable: hit-test the layout the last frame drew.
// The in-match arcade overlay (touch.ts) sits above this and swallows its own
// presses, so a fight's controls never leak through as menu taps.
canvas.addEventListener('pointerdown', (e) => {
  audio.unlock(); // same first-gesture unlock the keydown path does
  tapAt(e.clientX, e.clientY);
});

// ---------------------------------------------------------------- boot
const boot = async (): Promise<void> => {
  try {
    // Kick the badge logo first so the loading screen can show it while the
    // rest of boot runs — not awaited (same reason as the title logo below).
    void loadGameLogo().then((img) => { setGameLogo(img); setLoadProgress(0.12); });
    await loadDisplayFont(); // awaited so the title screen never flashes the Impact fallback
    setLoadProgress(0.08);
    setUiKit(await loadUiKit());
    setLoadProgress(0.18);
    // Title logo (11MB SVG) and background video (~10MB) are NOT awaited: both
    // have graceful fallbacks (text wordmark, static stage art), so the title
    // screen should be interactive immediately and swap in as they arrive —
    // important on mobile, where blocking boot on ~20MB of art would stall
    // first paint for seconds on a slow connection.
    void loadLogo().then(setLogo);
    void loadVendingArt().then(setVendingArt); // shop art — procedural fallback until it lands
    bgVideoRef = loadBgVideo('/assets/video/bg_video_main_af.mp4');
    setBgVideo(bgVideoRef);
    stageIds = await listStages();
    setLoadProgress(0.28);
    stageAssets = [];
    for (let i = 0; i < stageIds.length; i++) {
      stageAssets.push(await loadStage(stageIds[i]!));
      setLoadProgress(0.28 + 0.12 * ((i + 1) / Math.max(1, stageIds.length)));
    }
    if (stageAssets.length > 0) setStageAsset(stageAssets[0]!);
    const ids = await listCharacters();
    if (ids.length === 0) throw new Error('no characters found in characters/');
    setLoadProgress(0.42);
    allRosters = [];
    for (let i = 0; i < ids.length; i++) {
      allRosters.push(await loadRoster(ids[i]!));
      setLoadProgress(0.42 + 0.56 * ((i + 1) / ids.length));
    }
    setLoadProgress(1);
    picks = [0, Math.min(1, allRosters.length - 1)];
    screen = 'title';
    audio.preload();
    // Landing / share deep-links: ?screen=title|select|ranks|play &mode=cpu|online &char=<id>
    applyBootDeepLink();
    if (screen === 'title') {
      void audio.playBgm(audio.nextHomeTrack(), { fadeInSec: 1.5 });
    }
    // Restore a previous AIR session silently (30-day sessions) — never blocks
    // boot, and offline play works identically if it fails or is skipped.
    void authRehydrate();
  } catch (e) {
    loadError = (e as Error).message;
  }
};

/**
 * Apply one-shot entry from the URL so the marketing site can open the real
 * in-game screens (select / play / leaderboards) without a path router.
 */
const applyBootDeepLink = (): void => {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(location.search);
  } catch {
    return;
  }
  const screenQ = (q.get('screen') ?? '').toLowerCase();
  const modeQ = (q.get('mode') ?? '').toLowerCase();
  const charQ = q.get('char');

  // Dare referral code — stash it before any auth happens so it survives
  // the AIR dialog round-trip and redeems on the first signed-in contact.
  const refQ = q.get('ref');
  if (refQ && /^[A-Za-z0-9-]{3,40}$/.test(refQ)) {
    safeSetItem(REF_CODE_KEY, refQ.toUpperCase());
  }

  // Live challenge (?room=): remember it in-memory only — it's a "fight me
  // RIGHT NOW" invitation, not a durable coupon. The title branch auto-joins
  // the room once the player is signed in (AIR login is an in-page dialog,
  // so no reload loses this).
  const roomQ = q.get('room');
  if (roomQ && /^[A-Za-z0-9-]{3,40}$/.test(roomQ)) {
    pendingRoom = roomQ.toUpperCase();
  }

  // Dare-vs-agent (?agent=1 riding a ?ref= dare link): after the sign-in
  // gate, the title auto-routes into a solo match vs the SENDER's trained
  // agent. In-memory only — same "fight them now" stance as ?room=.
  if (q.get('agent') === '1' && refQ && /^[A-Za-z0-9-]{3,40}$/.test(refQ)) {
    pendingAgentOf = refQ.toUpperCase();
  }

  if (modeQ === 'cpu' || modeQ === 'online' || modeQ === '2p') {
    mode = modeQ;
  }

  const pickChar = (): void => {
    if (!charQ) return;
    const idx = allRosters.findIndex((r) => r.id === charQ && !r.disabled);
    if (idx >= 0) picks = [idx, idx];
  };

  const enterSelectFromLink = (): void => {
    screen = 'select';
    locked = [false, false];
    const fe = Math.max(0, allRosters.findIndex((r) => !r.disabled));
    picks = [fe, fe];
    pickChar();
    void audio.playBgm('player_select', { fadeInSec: 0.5 });
  };

  if (screenQ === 'ranks' || screenQ === 'leaderboard' || screenQ === 'leaderboards') {
    screen = 'ranks';
    fetchRanks();
    return;
  }
  if (screenQ === 'select' || screenQ === 'character' || screenQ === 'characters') {
    enterSelectFromLink();
    return;
  }
  if (screenQ === 'play') {
    // "Play now" → fighter select with VS AGENT (cpu) unless mode= was set.
    if (modeQ !== 'online' && modeQ !== '2p') mode = 'cpu';
    enterSelectFromLink();
    return;
  }
  // Title (default): still honor ?char= so a shared fighter opens ready to pick.
  pickChar();
};

/** Reset per-match juice/announce state (shared by local + online starts). */
const resetMatchFx = (g: GameState): void => {
  cancelAutoSpecial(); // never carry a half-finished motion into a new round/match
  cam = { x: STAGE.widthPx / 2 - VW / 2 / 1.5, y: STAGE.floorYPx - (VH / 1.5) * 0.86, zoom: 1.5 };
  updateCamera(g);
  prevHealth = [g.fighters[0].health, g.fighters[1].health];
  prevConnected = [0, 0];
  prevPhase = g.phase;
  fx.flash = [1, 1];
  fx.comboOwner = -1;
  fx.comboHits = 0;
  fx.comboAge = 0;
  fx.announce = `ROUND ${g.roundNum + 1}`;
  fx.announceAge = 0;
  sparks = [];
  shake = 0;
  hurryPlayed = false;
  resetFighterTrails();
};

/**
 * Queue for a server match (ADR 0003 + M5 credits).
 * 'wager'    = PvP, 10-credit entrance each, winner takes the pot.
 * 'solo'     = a single match vs the HOUSE agent at your level, 1 credit.
 * 'arcade'   = AGENT ARCADE, the ranked gauntlet — 1 credit per RUN.
 *   `runToken` continues an existing run (the next battle); omitted = new run.
 * 'friendly' = private challenge (v5): PvP paired by `friendlyRoom` instead
 *   of the public queue. FREE and UNRANKED — verified winner, nothing else.
 */
const startOnline = (
  m: 'solo' | 'wager' | 'arcade' | 'friendly', runToken?: string, agentOf?: string,
  /** ARCADE v2: the board node being moved to — the move IS the queue. */
  arcadeNode?: number,
): void => {
  const roster = allRosters[picks[0]]!;
  lastFighter = roster.id;
  safeSetItem(LAST_FIGHTER_KEY, lastFighter); // powers title quick play
  queuedMode = m;
  queuedAgentOf = m === 'solo' ? agentOf ?? '' : ''; // rematch re-queues the same agent
  // CONSUMABLES (ADR 0007 final shape): nothing to send — the server reads
  // this profile's EQUIPPED loadout itself at queue time and pins it.
  practiceFree = false;
  netInstalled = false;
  screen = 'online';
  // Play under the AIR identity (fresh token; the server verifies it against
  // the JWKS and settles credits/XP). ?dev=NAME plays a dev-economy account.
  const name = authName() ?? DEV_GUEST ?? `PLAYER-${(profile.wins + profile.losses) % 1000}`;
  void authToken().then((token) => {
    if (screen !== 'online' || net) return; // player backed out while fetching
    const email = auth.email || undefined; // AIR write-back target (ADR 0004)
    // Solo/arcade (v3/v4): pure LOCAL simulation of the pinned house AI —
    // zero added latency; the server re-derives the AI to verify. Wager and
    // friendly: rollback PvP over the relay. `agentOf` (ADR 0006) swaps the
    // solo house AI for the trained agent behind a dare code.
    net = m === 'wager' || m === 'friendly'
      ? new NetSession(matchWsUrl(), name, roster.id, roster.bundle.versionHash, token, m, email, storedRef(),
        m === 'friendly' ? friendlyRoom : undefined)
      : new SoloSession(matchWsUrl(), name, roster.id, roster.bundle.versionHash, token, email, storedRef(),
        m === 'arcade' ? { runToken, node: arcadeNode } : undefined,
        m === 'solo' ? agentOf : undefined);
  });
};

/**
 * Enter a friendly challenge → the CHARACTER SELECT screen first (both the
 * inviter hitting CHALLENGE LIVE and a ?room= friend pick their fighter
 * before queuing). Locking on select queues 'friendly' into `friendlyRoom`.
 */
const startFriendly = (room: string): void => {
  friendlyRoom = room.toUpperCase();
  selectingFriendly = true;
  mode = 'online'; // render the one-fighter online select (not cpu/2p)
  screen = 'select';
  locked = [false, false];
  // Cursor starts on the remembered fighter — one confirm away, but they CAN
  // move it now (the whole point of this screen).
  let fe = allRosters.findIndex((r) => r.id === lastFighter && !r.disabled);
  if (fe < 0) fe = Math.max(0, allRosters.findIndex((r) => !r.disabled));
  picks = [fe, fe];
  void audio.playBgm('player_select', { fadeInSec: 0.5 });
};

/**
 * Dare-vs-agent (ADR 0006): a ?agent=1 dare link → the CHARACTER SELECT
 * screen, then locking queues a ranked-solo match whose opponent is the
 * SENDER's trained agent (the server resolves the code and pins their
 * coached config — the sender stays offline, the match still verifies).
 */
const startAgentDare = (code: string): void => {
  selectingAgentOf = code.toUpperCase();
  selectingFriendly = false;
  mode = 'online';
  screen = 'select';
  locked = [false, false];
  let fe = allRosters.findIndex((r) => r.id === lastFighter && !r.disabled);
  if (fe < 0) fe = Math.max(0, allRosters.findIndex((r) => !r.disabled));
  picks = [fe, fe];
  void audio.playBgm('player_select', { fadeInSec: 0.5 });
};

/** Match setup arrived — install the pinned characters/stage and begin. */
const installOnlineMatch = (): void => {
  const s = net!.setup!;
  const r0 = allRosters.find((r) => r.id === s.chars[0].id);
  const r1 = allRosters.find((r) => r.id === s.chars[1].id);
  if (!r0 || !r1) {
    net!.error = `missing character "${!r0 ? s.chars[0].id : s.chars[1].id}" locally`;
    net!.close();
    return;
  }
  fighters = [r0, r1];
  setCharacters(r0.ch, r1.ch);
  const si = stageIds.indexOf(s.stage);
  if (si >= 0) setStageAsset(stageAssets[si] ?? null);
  net!.begin();
  game = net!.game;
  cpuAi = null;
  xpBanner = null;
  statDmg = 0;
  statBestCombo = 0;
  resetMatchFx(game!);
  netInstalled = true;
  quitConfirm = false; // fresh match — clear any stale quit prompt
  screen = 'fight';
  // AGENT ARCADE v2: the SERVER owns the run position — adopt, never assert.
  // The BOARD is not in this message (it never changes mid-run and is far too
  // big to repeat); it was fetched once from POST /arcade/run.
  if (s.mode === 'arcade' && s.arcade) {
    if (arcade && !arcade.practice) {
      arcade.pending = s.arcade.node;
      arcade.fights = s.arcade.fights;
      arcade.total = s.arcade.total;
      arcade.runToken = s.arcade.token;
    }
    // Crash insurance (ADR 0007): entries are non-refundable, so the run token
    // must survive a killed PWA — the title offers RESUME within the server's
    // grace window instead of silently eating the credit.
    storeArcadeRun({
      token: s.arcade.token,
      charId: s.chars[0].id,
      battle: s.arcade.fights,
      total: s.arcade.total,
      ts: Date.now(),
    });
  } else {
    storeArcadeRun(null); // any non-arcade match invalidates a stashed run
  }
  // Stakes card (P0): what this match costs and pays, up front.
  vsCardAge = 0;
  vsStakes = s.mode === 'arcade'
    ? [
      `${arcade ? REGION_NAME[nodeById(arcade.board, s.arcade?.node ?? -1)?.region ?? 1] : 'GAUNTLET'}`
      + `      ${s.arcade?.fights ?? 0} FIGHT${(s.arcade?.fights ?? 0) === 1 ? '' : 'S'} DEEP`
      + (arcade && arcade.bag.credits > 0 ? `      CARRYING ${arcade.bag.credits} CR` : ''),
      arcade && arcade.bag.credits + arcade.bag.drinks.length > 0
        ? 'LOSE AND THE BAG IS GONE · SERVER-VERIFIED'
        : "RANKED GAUNTLET · SERVER-VERIFIED · LOSE ONCE AND IT'S GAME OVER",
    ]
    : s.mode === 'solo'
      ? ['ENTRY −1 CR      WIN +2 CR · +60 XP      LOSE −15 XP',
        // Dare-vs-agent (ADR 0006): the pinned personality is the tell.
        s.solo?.personality ? 'VS A COACHED AGENT · RANKED · SERVER-VERIFIED' : 'RANKED · SERVER-VERIFIED']
      : s.mode === 'friendly'
        ? ['FRIENDLY CHALLENGE      NO FEE · NO POT · NO RECORDS', 'BRAGGING RIGHTS ONLY · SERVER-VERIFIED']
        : [`ENTRY −${s.fee ?? 10} CR      WINNER TAKES THE ${(s.fee ?? 10) * 2} CR POT`, 'WAGER · SERVER-VERIFIED'];
  // CONSUMABLES: the pinned loadout is part of the stakes — show what's
  // carried (server echo = the truth, not what the player asked for).
  const myDrinks = s.items?.[s.side] ?? [];
  if (myDrinks.length > 0) {
    vsStakes.push(`🥤 ${myDrinks.map((d) => d.name).join(' · ')} — TAP A CAN OR PRESS R TO DRINK`);
  }
  const newChallenger = s.mode === 'arcade' && (s.arcade?.fights ?? 0) > 0;
  void audio.playStinger(newChallenger ? 'here_comes_a_new_challenger' : 'vs',
    { onEnded: () => void audio.playBgm(audio.nextRotationTrack(), { fadeInSec: 1 }) });
};

const startFight = (): void => {
  fighters = [allRosters[picks[0]]!, allRosters[picks[1]]!];
  setCharacters(fighters[0].ch, fighters[1].ch);
  // Local play: walls follow the selected stage's view-lock region (matches
  // the online feel, where the server pins the same bounds).
  game = createGameState(seed++, currentStageBounds());
  cpuAi = mode === 'cpu'
    ? createAi(1, skillForCpuLevel(cpuLevelFor(profile, lever)), seed * 31 + 7)
    : null;
  statDmg = 0;
  statBestCombo = 0;
  xpBanner = null;
  net = null;
  resetMatchFx(game);
  quitConfirm = false; // fresh match — clear any stale quit prompt
  screen = 'fight';
  vsCardAge = 0;
  vsStakes = mode === '2p'
    ? ['LOCAL VERSUS', '']
    : ['FREE PRACTICE      NO FEE · NO XP · NO RECORDS', ''];
  void audio.playStinger('vs', { onEnded: () => void audio.playBgm(audio.nextRotationTrack(), { fadeInSec: 1 }) });
};

// ---------------------------------------------------------------- arcade
// AGENT ARCADE v2 (ADR 0008): a RUN is a walk across a generated 32x32 board.
// Wins pay XP; credits come ONLY from board pickups banked by reaching an exit
// alive. RANKED runs are server-authoritative — this module draws the board and
// asks; the server owns where you stand and what you carry. PRACTICE runs
// (guest / server-offline) use the identical generator locally, reward-free.
let mapBusy = false; // an /arcade/* request is in flight
let mapToast = '';
/** Escape was pressed once with a loaded bag — the next one really quits. */
let mapAbandonArmed = false;
/**
 * The HIGHLIGHTED route (-1 = none). Choosing and committing are separate on
 * the map: a route costs a fight or ends the run, so it must never be one
 * stray tap away. The action button is the only thing that spends it.
 */
let mapSel = -1;
let extractView: ExtractView | null = null;

/** The roster ids a board may be populated from (never the player's own). */
const arcadeRoster = (): string[] => allRosters
  .filter((r, i) => !r.disabled && i !== picks[0])
  .map((r) => r.id);

const rosterName = (charId: string): string =>
  allRosters.find((r) => r.id === charId)?.bundle.name ?? charId;

/**
 * PRACTICE gauntlet — guests, and the fallback when the match server is
 * unreachable. Same board generator, same rules, fully local: no entry, no
 * XP, no records, and an extraction that banks nothing.
 */
const startArcadePractice = (): void => {
  const roster = allRosters[picks[0]]!;
  lastFighter = roster.id;
  safeSetItem(LAST_FIGHTER_KEY, lastFighter);
  const pool = arcadeRoster();
  const board = generateBoard({
    roster: pool.length > 0 ? pool : [roster.id],
    seed: (Math.random() * 0x7fffffff) | 0,
  });
  arcade = {
    practice: true, board, at: board.start, pending: -1, charId: roster.id,
    fights: 0, total: EXIT_FIGHT_FLOOR[3], bag: { credits: 0, drinks: [] },
  };
  enterMap();
};

/** Show the board. Every route decision in the mode is made on this screen. */
const enterMap = (): void => {
  mapToast = '';
  mapBusy = false;
  mapAbandonArmed = false;
  mapSel = -1; // re-armed against the CURRENT node's routes on the next frame
  net = null;
  cpuAi = null;
  screen = 'map';
  void audio.playBgm('player_select', { fadeInSec: 0.5 });
};

/**
 * Walk a PRACTICE run onto `to` and sweep up what it lands on — the exact
 * mirror of the server's advanceRun (server.ts). Auto-collect exists because
 * a guarded pickup's fighter has the pickup as its ONLY successor: once the
 * guard is beaten there is no decision left to make, so a manual step there
 * could only ever go wrong.
 */
const practiceAdvance = (run: ArcadeRun, to: number): void => {
  run.at = to;
  for (;;) {
    const outs = successors(run.board, run.at);
    if (outs.length !== 1) break;
    const next = nodeById(run.board, outs[0]!);
    if (!next || next.kind !== 'loot' || !next.loot) break;
    if (next.loot.kind === 'credits') run.bag.credits += next.loot.amount;
    else run.bag.drinks.push({ itemId: next.loot.itemId, tier: next.loot.tier });
    run.at = next.id;
  }
};

/** POST /arcade/run — locks the fighter on the first call, resumes after. */
const fetchArcadeRun = async (token: string, character?: string): Promise<boolean> => {
  const headers = await agentAuthHeaders();
  if (!headers) return false;
  const res = await fetchT(`${matchHttpUrl()}/arcade/run`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, character }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    board?: Board; at?: number; pending?: number; fights?: number; total?: number;
    bag?: { credits: number; drinks: { itemId: string; tier: number }[] };
    character?: string; error?: string;
  };
  if (!res.ok || !body.board) {
    mapToast = (body.error ?? 'RUN NOT FOUND').toUpperCase().slice(0, 46);
    return false;
  }
  arcade = {
    practice: false,
    board: body.board,
    at: body.at ?? body.board.start,
    pending: body.pending ?? -1,
    charId: body.character ?? allRosters[picks[0]]!.id,
    fights: body.fights ?? 0,
    total: body.total ?? EXIT_FIGHT_FLOOR[3],
    bag: body.bag ?? { credits: 0, drinks: [] },
    runToken: token,
  };
  // Crash insurance: entries are non-refundable, so the token must survive a
  // killed PWA — the title offers RESUME inside the server's grace window.
  storeArcadeRun({
    token,
    charId: arcade.charId,
    battle: arcade.fights,
    total: arcade.total,
    ts: Date.now(),
  });
  return true;
};

/** Start a RANKED run: lock the fighter, mint the board, show the map. */
const startArcadeRanked = (token: string): void => {
  mapBusy = true;
  mapToast = '';
  screen = 'map';
  void (async () => {
    let ok = false;
    try {
      ok = await fetchArcadeRun(token, allRosters[picks[0]]!.id);
    } catch {
      mapToast = 'SERVER UNREACHABLE';
    }
    mapBusy = false;
    if (ok) { enterMap(); return; }
    storeArcadeRun(null);
    screen = 'title';
    showToast(mapToast || 'ARCADE RUN FAILED');
  })();
};

/** Refresh the run from the server after a battle — it owns the position. */
const refreshArcadeRun = (): void => {
  const run = arcade;
  if (!run || run.practice || !run.runToken) return;
  mapBusy = true;
  const token = run.runToken;
  void (async () => {
    let ok = false;
    try {
      ok = await fetchArcadeRun(token);
    } catch {
      mapToast = 'SERVER UNREACHABLE';
    }
    mapBusy = false;
    if (!ok) endArcade();
  })();
};

/** Take a route: fight the chosen node, or extract through the chosen exit. */
const arcadeGo = (nodeId: number): void => {
  const run = arcade;
  if (!run || mapBusy) return;
  if (!isLegalMove(run.board, run.at, nodeId)) return;
  const node = nodeById(run.board, nodeId);
  if (!node) return;
  if (node.kind === 'exit') { arcadeExtract(node); return; }
  run.pending = nodeId;
  if (run.practice) { startPracticeFight(node); return; }
  startOnline('arcade', run.runToken, undefined, nodeId);
};

/** Bank the bag and end the run — the only way credits leave the board. */
const arcadeExtract = (node: BoardNode): void => {
  const run = arcade;
  if (!run || mapBusy) return;
  const tier = (node.exitTier ?? 1) as 1 | 2 | 3;
  if (run.practice) {
    extractView = {
      exitTier: tier, bonus: EXIT_BONUS[tier], bag: run.bag.credits,
      granted: 0, multiplierPct: 0, drinks: run.bag.drinks.length,
      drinksLeftBehind: 0, fights: run.fights, practice: true,
    };
    screen = 'extract';
    return;
  }
  mapBusy = true;
  void (async () => {
    try {
      const headers = await agentAuthHeaders();
      if (!headers) return;
      const res = await fetchT(`${matchHttpUrl()}/arcade/extract`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: run.runToken, node: node.id }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        exitTier?: number; bonus?: number; bag?: number; granted?: number;
        multiplierPct?: number; credits?: number | null;
        drinks?: unknown[]; drinksLeftBehind?: number; fights?: number; error?: string;
      };
      if (!res.ok) {
        mapToast = (body.error ?? 'EXTRACTION FAILED').toUpperCase().slice(0, 46);
        return;
      }
      if (typeof body.credits === 'number' && account) {
        account = { ...account, credits: body.credits };
      }
      extractView = {
        exitTier: body.exitTier ?? tier,
        bonus: body.bonus ?? EXIT_BONUS[tier],
        bag: body.bag ?? run.bag.credits,
        granted: body.granted ?? 0,
        multiplierPct: body.multiplierPct ?? 100,
        drinks: body.drinks?.length ?? 0,
        drinksLeftBehind: body.drinksLeftBehind ?? 0,
        fights: body.fights ?? run.fights,
        practice: false,
      };
      storeArcadeRun(null); // banked — nothing left to resume
      screen = 'extract';
    } catch {
      mapToast = 'SERVER UNREACHABLE — THE RUN IS STILL YOURS';
    } finally {
      mapBusy = false;
    }
  })();
};

/** Begin a PRACTICE fight against the fighter standing on `node`. */
const startPracticeFight = (node: BoardNode): void => {
  const run = arcade!;
  const opp = allRosters.findIndex((r) => r.id === node.charId);
  picks[1] = opp >= 0 ? opp : picks[0];
  fighters = [allRosters[picks[0]]!, allRosters[picks[1]]!];
  setCharacters(fighters[0].ch, fighters[1].ch);
  // Rotate the stage art each battle so a run tours the whole game.
  if (stageAssets.length > 0) {
    stageCursor = (seed + run.fights) % stageAssets.length;
    setStageAsset(stageAssets[stageCursor] ?? null);
  }
  game = createGameState(seed++, currentStageBounds());
  // The BOARD sets the difficulty (region band), not the fight count — a long
  // safe detour must never be free money.
  cpuAi = createAi(1, node.skill ?? 50, seed * 31 + 7);
  statDmg = 0;
  statBestCombo = 0;
  xpBanner = null;
  net = null;
  resetMatchFx(game);
  quitConfirm = false; // fresh match — clear any stale quit prompt
  screen = 'fight';
  vsCardAge = 0;
  vsStakes = [
    `${REGION_NAME[node.region]} · ${run.fights} FIGHT${run.fights === 1 ? '' : 'S'} DEEP`
    + (run.bag.credits > 0 ? `      CARRYING ${run.bag.credits} CR` : ''),
    'PRACTICE GAUNTLET · NO FEE · NO XP · NO RECORDS',
  ];
  void audio.playStinger(run.fights === 0 ? 'vs' : 'here_comes_a_new_challenger',
    { onEnded: () => void audio.playBgm(audio.nextRotationTrack(), { fadeInSec: 1 }) });
};

/** Leave the gauntlet (quit, GAME OVER, or full clear) → back to the title. */
const endArcade = (): void => {
  net?.close(); // ranked: leaving mid-battle is a forfeit; post-result no-op
  net = null;
  arcade = null;
  cpuAi = null;
  storeArcadeRun(null); // the run is over — nothing to resume
  screen = 'title';
  void audio.playBgm(audio.nextHomeTrack(), { fadeInSec: 1 });
};

/**
 * Abandon a LIVE match from the quit-confirm modal → HOME screen (never
 * character select). Online play forfeits (ADR 0003: leaving = a loss); an
 * arcade run is dropped via endArcade (which also clears the resume token).
 */
const quitMatch = (): void => {
  quitConfirm = false;
  if (arcade) { endArcade(); return; }
  net?.close(); // online: leaving is a forfeit
  net = null;
  cpuAi = null;
  screen = 'title';
  locked = [false, false];
  void audio.playBgm(audio.nextHomeTrack(), { fadeInSec: 1 });
};

/**
 * World px a fighter's body occupies. Sprites are authored supersampled (2x)
 * for anime detail and scaled back down at blit time via atlas.json `scale`,
 * so this stays the WORLD height — keep it equal to the Studio's WORLD_BODY_H.
 */
const FIGHTER_H = 112;

/**
 * Dynamic camera: frame BOTH fighters. Zooms in tight when they're close and
 * grounded (big, readable characters) and pulls back on super jumps / air
 * combos so nobody leaves the frame (spec §4: MvC-style vertical follow).
 * Solves for the zoom that fits the action box, then places the camera so the
 * box lands between the HUD and the bottom edge.
 */
const updateCamera = (g: GameState): void => {
  const x0 = px(g.fighters[0].x), x1 = px(g.fighters[1].x);
  const PAD_X = 150; // breathing room either side
  const boxL = Math.min(x0, x1) - PAD_X;
  const boxR = Math.max(x0, x1) + PAD_X;

  const highestFeet = Math.min(px(g.fighters[0].y), px(g.fighters[1].y));
  const boxT = highestFeet - FIGHTER_H - 50; // head + headroom
  const boxB = STAGE.floorYPx + 24; // a little deck below the feet

  // Stage art bounds the camera: it may not zoom out past the point where the
  // viewport would exceed the art (`limits.minZoom`), and cam.y is clamped so
  // the art always covers top and bottom — no flat sky/deck fill ever shows.
  const limits = currentStageCamLimits();
  const zoomFloor = limits ? Math.max(ZOOM_MIN, limits.minZoom) : ZOOM_MIN;

  const zoomX = VW / Math.max(1, boxR - boxL);
  const zoomY = (CONTENT_BOT - CONTENT_TOP) / Math.max(1, boxB - boxT);
  const targetZoom = Math.max(zoomFloor, Math.min(ZOOM_MAX, Math.min(zoomX, zoomY)));

  cam.zoom += (targetZoom - cam.zoom) * 0.08;

  // Place the camera so the action box sits inside the content band.
  const viewW = VW / cam.zoom;
  const viewH = VH / cam.zoom;
  const midX = (x0 + x1) / 2;
  // VIEW LOCK: pan only within the stage's playable region. When the region is
  // narrower than the viewport, `Math.max(b.left, …)` collapses the window to
  // its left edge (the min-zoom floor keeps this from cropping the action).
  const b = currentStageBounds();
  const targetX = Math.max(b.left, Math.min(Math.max(b.left, b.right - viewW), midX - viewW / 2));
  let targetY = boxT - CONTENT_TOP / cam.zoom;

  if (limits) {
    // Keep the art covering: its top must be at/above the screen top and its
    // bottom at/below the screen bottom. minZoom guarantees viewH ≤ art height,
    // so the [top, bottom-viewH] window is non-empty and this pins the image's
    // bottom edge to the screen bottom once fully zoomed out.
    const maxY = limits.botY - viewH;
    targetY = Math.max(limits.topY, Math.min(maxY, targetY));
  }

  cam.x += (targetX - cam.x) * 0.16;
  cam.y += (targetY - cam.y) * 0.12;
};

// Victim pain-grunt pools (voice/*.mp3) — light taps get a plain "Hit", the
// heavy ones ("big" damage, matching the spark/shake threshold) get an "Ouch".
const HIT_BARK: SfxId[] = ['hit_1', 'hit_2', 'hit_3', 'hit_4'];
const OUCH: SfxId[] = ['ouch_1', 'ouch_2', 'ouch_3'];

// ---------------------------------------------------------------- juice
/** Per-fighter carried-slot kinds last frame — drives the drink-consumed FX. */
const prevSlotKinds: [number[], number[]] = [[0, 0, 0], [0, 0, 0]];
const ITEM_FX: Record<number, { color: string; tag: string }> = {
  1: { color: '#7ddf8a', tag: 'HEAL!' },
  2: { color: '#ff9d6b', tag: 'POWER UP!' },
  3: { color: '#6fd3ff', tag: 'GUARD UP!' },
  4: { color: '#ffd166', tag: 'METER!' },
};

const updateJuice = (g: GameState): void => {
  for (const i of [0, 1] as const) {
    const f = g.fighters[i];
    // DRINK CONSUMED (ADR 0007): a carried slot going kind→0 mid-round is a
    // can being drunk — ring + burst in the effect's color, a floating tag,
    // and a synthesized gulp-fizz (no asset needed). Round resets restock
    // prevSlotKinds via the phase-change branch below, so a reset never
    // false-fires (kinds only ever DROP inside a round).
    const kinds = [f.itemKind0, f.itemKind1, f.itemKind2];
    if (g.phase === Phase.Fighting) {
      for (let s = 0; s < 3; s++) {
        const was = prevSlotKinds[i][s]!;
        if (was !== 0 && kinds[s] === 0) {
          const fxDef = ITEM_FX[was] ?? { color: '#cfd8e3', tag: 'DRINK!' };
          const dx = px(f.x), dy = px(f.y) - 70;
          emitRing(dx, dy, 64, fxDef.color, { width: 4 });
          emitBurst(dx, dy - 10, fxDef.color, 1.4);
          emitAura(dx, dy, 30, 50, fxDef.color, 3);
          sparks.push({ x: dx, y: dy - 40, age: 0, big: false, tag: fxDef.tag, color: fxDef.color });
          audio.blip({ freq: 340, volume: 0.5 }); // gulp…
          setTimeout(() => audio.blip({ freq: 990, volume: 0.35 }), 90); // …fizz
        }
      }
    }
    prevSlotKinds[i] = kinds;
    if (f.health < prevHealth[i]) {
      const dmg = prevHealth[i] - f.health;
      const big = dmg > 600;
      const hx = px(f.x) + f.facing * -22, hy = px(f.y) - 78;
      sparks.push({ x: hx, y: hy, age: 0, big });
      // Ember burst in the ATTACKER's color (the victim is fighter i).
      emitBurst(hx, hy, P_COLORS[(1 - i) as 0 | 1], big ? 1.8 : 0.9);
      shake = big ? 11 : 6;
      hitStopFlash = big ? 3 : 0;
      // Victim's pain grunt — a bigger "Ouch" bark for the heavier hits.
      audio.playSfx(big ? OUCH[Math.floor(Math.random() * OUCH.length)]! : HIT_BARK[Math.floor(Math.random() * HIT_BARK.length)]!, { volume: 0.55 });
    }
    // Hit SFX: a swoosh on every swing (attack's very first tick), plus a
    // punch/kick impact or block clip on the tick the attack actually makes
    // contact (attackConnected's rising edge: 0→1 hit, 0→2 block).
    if (f.action === Action.Attack && f.actionFrame === 0 && f.moveIdx >= 0) {
      const move = fighters![i].ch.b.moves[f.moveIdx];
      // The fireball/uppercut motion specials get their classic voice
      // callout instead of a generic whoosh — everything else keeps the
      // plain swing, with a normal occasionally getting a kiai bark too.
      if (move?.motion === 623) audio.playSfx('shoryuken', { volume: 0.7 });
      else if (move?.motion === 236) audio.playSfx('hadouken', { volume: 0.7 });
      else {
        audio.playSfx(swingSfx(), { volume: 0.45 });
        if (move?.type === 'normal' && Math.random() < 0.3) {
          audio.playSfx(Math.random() < 0.5 ? 'hiya_1' : 'hiya_2', { volume: 0.5 });
        }
      }
    }
    if (f.attackConnected !== 0 && f.attackConnected !== prevConnected[i]) {
      if (f.attackConnected === 1) {
        const move = fighters![i].ch.b.moves[f.moveIdx];
        audio.playSfx(move?.type === 'special' || move?.type === 'super' ? 'special_hit' : hitSfxFor(move?.button));
        if (g.fighters[(1 - i) as 0 | 1].comboHits >= 2) audio.playSfx('combo_accent', { volume: 0.6 });
      } else if (f.attackConnected === 2) {
        audio.playSfx('block_hit');
      }
    }
    prevConnected[i] = f.attackConnected;
    // Aura motes: a fighter that is CHARGED (≥1 super bar) or on CRITICAL
    // health smoulders — a steady trickle of embers rising off the body.
    const meterN = f.meter / TUNING.meterMax;
    const critical = f.health / fighters![i].ch.b.maxHealth < 0.25;
    const auraRate = (f.meter >= TUNING.meterBar ? 0.35 + meterN * 0.5 : 0) + (critical ? 0.4 : 0);
    if (auraRate > 0) {
      emitAura(px(f.x), px(f.y) - 56, 20, 52, critical ? DANGER_RED : P_COLORS[i], auraRate);
    }
    // ACTIVE BUFF (ADR 0007): a separate, denser mote stream in the buff's
    // color — layered over (not replacing) the charged/critical aura, so a
    // critical fighter still reads red underneath.
    if (f.itemDmgLeft > 0 || f.itemDefLeft > 0) {
      emitAura(px(f.x), px(f.y) - 56, 26, 58,
        f.itemDmgLeft > 0 ? '#ff9d6b' : '#6fd3ff', 0.9);
    }
    // Progression stats: what the human (P1) dished out.
    if (i === 1 && f.health < prevHealth[1]) statDmg += prevHealth[1] - f.health;
    prevHealth[i] = f.health;
    // Health bar lag (white flash draining behind the real bar).
    const max = fighters![i].ch.b.maxHealth;
    const target = Math.max(0, f.health) / max;
    fx.flash[i] = fx.flash[i] > target ? Math.max(target, fx.flash[i] - 0.006) : target;
  }
  statBestCombo = Math.max(statBestCombo, g.fighters[1].comboHits);

  // Combo counter tracks whoever is being hit.
  const v0 = g.fighters[0], v1 = g.fighters[1];
  const inCombo = (a: Action): boolean => a === Action.Hitstun || a === Action.AirHitstun;
  const bumpCombo = (owner: 0 | 1, hits: number): void => {
    // Re-pop on the OWNER changing or the hit count climbing (each new hit
    // in the string gets its own little punch), not on every frame the
    // counter merely stays on screen.
    if (fx.comboOwner !== owner || hits > fx.comboHits) fx.comboAge = 0; else fx.comboAge++;
    fx.comboOwner = owner;
    fx.comboHits = hits;
  };
  if (inCombo(v1.action) && v1.comboHits >= 2) bumpCombo(0, v1.comboHits);
  else if (inCombo(v0.action) && v0.comboHits >= 2) bumpCombo(1, v0.comboHits);
  else if (!inCombo(v0.action) && !inCombo(v1.action)) fx.comboOwner = -1;

  // Announcements on phase changes — each punctuated by a screen shockwave.
  if (g.phase !== prevPhase) {
    if (g.phase === Phase.Fighting) {
      fx.announce = 'FIGHT!'; fx.announceAge = 0;
      emitRing(VW / 2, VH / 2 - 40, 240, '#ffd166', { life: 30, width: 5 });
      audio.playSfx(Math.random() < 0.5 ? 'fight_call_a' : 'fight_call_b', { volume: 0.7 });
    } else if (g.phase === Phase.RoundOver) {
      fx.announce = g.roundWinner === 2 ? 'DOUBLE KO' : 'K.O.';
      fx.announceAge = 0;
      emitRing(VW / 2, VH / 2 - 40, 340, DANGER_RED, { life: 40, width: 7 });
      audio.playSfx('ouch_long', { volume: 0.75 });
    } else if (g.phase === Phase.PreRound) { fx.announce = `ROUND ${g.roundNum + 1}`; fx.announceAge = 0; }
    prevPhase = g.phase;
  }
  fx.announceAge++;

  // Super activation: on the rising edge of the freeze flash, blow a ring off
  // the fighter who supered (whichever one is spending meter / attacking).
  if (g.superFlashLeft > 0 && prevSuperFlash === 0) {
    // The super's owner is whoever just spent meter this frame.
    const d0 = prevMeter[0] - g.fighters[0].meter;
    const d1 = prevMeter[1] - g.fighters[1].meter;
    const su: 0 | 1 = d0 >= d1 ? 0 : 1;
    const sx = px(g.fighters[su].x), sy = px(g.fighters[su].y) - 56;
    emitRing(sx, sy, 160, P_COLORS[su], { life: 28, width: 6, layer: 'world' });
    emitBurst(sx, sy, P_COLORS[su], 2.2);
  }
  prevSuperFlash = g.superFlashLeft;
  prevMeter = [g.fighters[0].meter, g.fighters[1].meter];

  sparks = sparks.filter((s) => ++s.age < 9);
  shake = Math.max(0, shake - 0.7);
  if (hitStopFlash > 0) hitStopFlash--;
};

// ---------------------------------------------------------------- render
const renderFight = (g: GameState): void => {
  // World pass: everything below is in world coordinates.
  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  worldTransform(ctx, cam);

  drawStage(ctx, cam);

  // Character aura (UNDER the sprite): an energy glow that intensifies when a
  // fighter is charged (super meter) or in critical health — the "this
  // fighter is dangerous / desperate" read, tinted to the player color.
  for (const i of [0, 1] as const) {
    const f = g.fighters[i];
    const meterN = f.meter / TUNING.meterMax;
    const critical = f.health / fighters![i].ch.b.maxHealth < 0.25;
    const intensity = 0.12 + meterN * 0.4 + (critical ? 0.3 : 0);
    const breathe = fxPulse(g.tick, 0.12, 0.8, 1); // subtle living pulse
    auraGlow(ctx, px(f.x), px(f.y) - 52, 70,
      critical ? DANGER_RED : P_COLORS[i], intensity * breathe);
    // ACTIVE BUFF (ADR 0007): an AGGRESSIVE second halo in the buff color —
    // larger radius, hard intensity, fast pulse. Layered with 'lighter'
    // compositing inside auraGlow, so it stacks over the base aura.
    if (f.itemDmgLeft > 0 || f.itemDefLeft > 0) {
      const throb = fxPulse(g.tick, 0.35, 0.6, 1); // fast, wide swing
      auraGlow(ctx, px(f.x), px(f.y) - 52, 88,
        f.itemDmgLeft > 0 ? '#ff9d6b' : '#6fd3ff', 0.75 * throb);
    }
  }

  // Fighters (draw the one in hitstun last so it reads on top).
  const order: (0 | 1)[] = g.fighters[0].action === Action.Hitstun ? [1, 0] : [0, 1];
  for (const i of order) {
    const f = g.fighters[i];
    // Ground shadow (shrinks with height — sells the jump arc).
    const height = STAGE.floorYPx - px(f.y);
    const sc = Math.max(0.35, 1 - height / 320);
    ctx.fillStyle = `rgba(0,0,0,${0.42 * sc})`;
    ctx.beginPath();
    ctx.ellipse(px(f.x), STAGE.floorYPx + 2, 26 * sc, 6 * sc, 0, 0, Math.PI * 2);
    ctx.fill();
    // Motion afterimage intensity from speed (fixed-point → px/tick): off while
    // standing/walking (~4px), ramping in over dashes/jumps/knockback (~10px+).
    const spd = (Math.abs(f.velX) + Math.abs(f.velY)) / 256;
    const motion = Math.max(0, Math.min(1, (spd - 3) / 7));
    drawFighter(ctx, fighters![i], f, g.tick, px(f.x), px(f.y), P_COLORS[i], { slot: i, motion });
  }

  // Projectiles.
  for (const p of g.projectiles) {
    if (!p.active) continue;
    const x = px(p.x);
    const y = px(p.y);
    const grd = ctx.createRadialGradient(x, y, 2, x, y, 20);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.5, P_COLORS[p.owner as 0 | 1]);
    grd.addColorStop(1, '#ffffff00');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.fill();
  }

  // Hit sparks (+ floating drink-consumed tags).
  for (const s of sparks) {
    if (s.tag) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - s.age / 9);
      ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = s.color ?? '#ffffff';
      ctx.strokeStyle = '#10131b';
      ctx.lineWidth = 3;
      const ty = s.y - s.age * 4; // rises as it fades
      ctx.strokeText(s.tag, s.x, ty);
      ctx.fillText(s.tag, s.x, ty);
      ctx.restore();
      continue;
    }
    const r = (s.big ? 10 : 5) + s.age * (s.big ? 6 : 3.5);
    ctx.strokeStyle = `rgba(255, 224, 130, ${1 - s.age / 9})`;
    ctx.lineWidth = s.big ? 4 : 2.5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.lineWidth = 1;

  // Particle FX in world space (embers, auras, super rings) — on top of the
  // fighters so debris reads over the bodies.
  drawFx(ctx, 'world');

  // Debug boxes (world space — they come from the sim in world px).
  if (showBoxes) {
    for (const b of debugBoxes(g)) {
      ctx.strokeStyle = '#4ade80';
      for (const r of b.hurtboxes) ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
      ctx.strokeStyle = '#f87171';
      for (const r of b.hitboxes) ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
    }
  }
  ctx.restore();

  // Screen pass: full-frame flashes + HUD.
  if (g.superFlashLeft > 0) {
    ctx.fillStyle = g.superFlashLeft % 4 < 2 ? '#ffffff22' : '#000018aa';
    ctx.fillRect(0, 0, VW, VH);
  }
  if (hitStopFlash > 0) {
    ctx.fillStyle = '#ffffff33';
    ctx.fillRect(0, 0, VW, VH);
  }
  drawHud(ctx, g, fighters!, fx,
    net?.setup
      ? [
        `${net.setup.names[0]}${net.setup.agents[0] ? ' · AGENT' : ''}${net.side === 0 ? ' (YOU)' : ''}`,
        // Arcade: the HUD prefixes the character name itself, so the server
        // name ("ELON · 1/8") would double it — show just the run position.
        `${arcade && !arcade.practice
          ? `${arcade.fights + 1}/${arcade.total} DEEP`
          : net.setup.names[1]}${net.setup.agents[1] ? ' · AGENT' : ''}${net.side === 1 ? ' (YOU)' : ''}`,
      ]
      : cpuAi
        ? ['', arcade
          ? `${arcade.fights + 1}/${arcade.total} DEEP`
          : `AGENT LV ${cpuLevelFor(profile, lever)}`]
        : undefined,
    autoSpecialCharged(g.fighters[localSide()]),
    hudIds(),
    // CONSUMABLES: which side is the human's, so drawHud makes only YOUR can
    // tappable ('item:use') and prompts it. -1 for local 2P (both are human,
    // no online item flow — practice mode carries nothing).
    net ? localSide() : (mode === 'cpu' ? 0 : -1));

  // Screen-space FX (announcement shockwaves) — over the HUD so a KO ring
  // sweeps across the whole frame.
  drawFx(ctx, 'screen');
};

// ---------------------------------------------------------------- screens
const tickSelect = (): void => {
  const n = allRosters.length;
  const enabled = (i: number): boolean => !allRosters[i]?.disabled;
  const anyEnabled = allRosters.some((_r, i) => enabled(i));
  // ESC / the ‹ TITLE button: unlock a locked pick first; otherwise leave.
  if (pressedThisFrame.has('Escape') || taps.has('back')) {
    if (locked[0] || locked[1]) {
      locked = [false, false];
    } else if (selectingFriendly) {
      // Backing out of a challenge pick → the invite screen it came from
      // (no one is waiting yet — the room isn't queued until lock).
      selectingFriendly = false;
      screen = 'invite';
      return;
    } else if (selectingAgentOf) {
      // Backing out of a dare-vs-agent pick → title (the accepter arrived by
      // link; there is no invite screen behind them). The dare stays declined
      // until they follow the link again.
      selectingAgentOf = '';
      screen = 'title';
      void audio.playBgm(audio.nextHomeTrack(), { fadeInSec: 1 });
      return;
    } else {
      screen = 'title';
      void audio.playBgm(audio.nextHomeTrack(), { fadeInSec: 1 });
      return;
    }
  }
  const move = (i: 0 | 1, d: number): void => {
    if (locked[i] || !anyEnabled) return;
    // Step over disabled fighters so the cursor lands only on selectable ones.
    let p = picks[i];
    for (let s = 0; s < n; s++) {
      p = (p + d + n) % n;
      if (enabled(p)) { picks[i] = p; return; }
    }
  };
  if (pressedThisFrame.has('KeyA')) move(0, -1);
  if (pressedThisFrame.has('KeyD')) move(0, 1);

  // Touch: tapping a portrait moves the cursor onto it so its stats can be
  // read; tapping the one already under the cursor commits. Two light taps
  // beat one blind commit — you get to look before you lock.
  let tapConfirm = false;
  for (let k = 0; k < n; k++) {
    if (!taps.has(`pick:${k}`)) continue;
    if (!enabled(k) || locked[0]) break;
    if (picks[0] === k) tapConfirm = true; // second tap on the same fighter
    else picks[0] = k;
    break;
  }

  // The CPU difficulty lever: [ and ] on the select screen (CPU mode).
  if (mode === 'cpu') {
    if (pressedThisFrame.has('BracketLeft')) { lever = Math.max(-10, lever - 1); saveLever(lever); }
    if (pressedThisFrame.has('BracketRight')) { lever = Math.min(10, lever + 1); saveLever(lever); }
  } else {
    if (pressedThisFrame.has('ArrowLeft')) move(1, -1);
    if (pressedThisFrame.has('ArrowRight')) move(1, 1);
  }


  // A disabled fighter under the cursor cannot be confirmed.
  if (!locked[0] && enabled(picks[0]) && (tapConfirm || CONFIRM[0]!.some((k) => pressedThisFrame.has(k)))) {
    locked[0] = true;
    audio.playSfx('select_confirm');
  }
  if (mode === 'online' || mode === 'cpu') {
    // Locking IS the launch. FRIENDLY: queue the private challenge room.
    // ONLINE: the pick is the wager-queue ticket (server matchmakes + charges
    // the fee). ARCADE: the pick is sealed for the whole gauntlet — no
    // switching until the run ends — and queues the RANKED run (1 credit).
    if (locked[0]) {
      if (selectingAgentOf) startOnline('solo', undefined, selectingAgentOf);
      else if (selectingFriendly) startOnline('friendly');
      else if (mode === 'cpu') {
        // GUEST: the same gauntlet, run fully LOCAL and reward-free — no fee,
        // no account, no server. The GAME OVER card invites them to sign in.
        if (!isSignedIn()) { startArcadePractice(); return; }
        // SIGNED-IN (ADR 0008): the pre-paid token now LOCKS the fighter and
        // mints the board, then the map screen takes over. No token means the
        // entry never landed — bounce to the title rather than play unpaid.
        const token = pendingArcadeToken;
        pendingArcadeToken = '';
        if (!token) { screen = 'title'; showToast('ENTER AGENT ARCADE FROM THE TITLE'); return; }
        startArcadeRanked(token);
      } else if (!isSignedIn()) {
        // WAGER needs the account for escrow — a guest who reached select via
        // "change fighter" is bounced to sign-in rather than queued unpaid.
        locked = [false, false];
        void authLogin();
      } else startOnline('wager');
    }
    return;
  }
  if (mode === '2p') {
    if (!locked[1] && enabled(picks[1]) && CONFIRM[1]!.some((k) => pressedThisFrame.has(k))) {
      locked[1] = true;
      audio.playSfx('select_confirm');
    }
  } else if (locked[0] && !locked[1]) {
    // CPU picks its fighter — visibly, like an arcade opponent reveal — but
    // never a disabled one.
    let p = (seed * 17 + profile.wins * 5 + uiTick) % n;
    for (let s = 0; s < n && !enabled(p); s++) p = (p + 1) % n;
    picks[1] = p;
    locked[1] = true;
    void audio.playStinger('here_comes_a_new_challenger');
  }

  if (locked[0] && locked[1] && (pressedThisFrame.has('Enter') || pressedThisFrame.has('Space'))) {
    if (stageIds.length > 0) screen = 'stageSelect';
    else startFight(); // no stages installed — fall back to the procedural stage
  }
};

const tickStageSelect = (): void => {
  const n = stageIds.length;
  const move = (d: number): void => {
    stageCursor = (stageCursor + d + n) % n;
    setStageAsset(stageAssets[stageCursor] ?? null);
  };
  if (pressedThisFrame.has('KeyA') || pressedThisFrame.has('ArrowLeft')) move(-1);
  if (pressedThisFrame.has('KeyD') || pressedThisFrame.has('ArrowRight')) move(1);
  // Same look-then-commit rule as the fighter grid: tap to preview the stage
  // (the backdrop swaps), tap the highlighted one again to fight.
  let tapStart = false;
  for (let k = 0; k < n; k++) {
    if (!taps.has(`stage:${k}`)) continue;
    if (stageCursor === k) tapStart = true;
    else { stageCursor = k; setStageAsset(stageAssets[k] ?? null); }
    break;
  }
  if (pressedThisFrame.has('Escape') || taps.has('back')) { screen = 'select'; locked = [false, false]; return; }
  if (tapStart || pressedThisFrame.has('Enter') || pressedThisFrame.has('Space')) startFight();
};

const frame = (steps = 1): void => {
  // `steps` = fixed-timestep ticks owed this rAF (>1 only when catching up after
  // a stall). The SIM loops `steps` times in the fight branch, but the whole
  // frame RENDERS ONCE — that is the fix for the CT-2 catch-up render spiral
  // (audit 2026-07-20), where a slow frame made the old loop re-render up to 12
  // times per rAF. At a steady 60fps steps===1, so normal play is unchanged.
  uiTick += steps;
  for (let s = 0; s < steps; s++) updateFx(); // advance cosmetic particles/rings per tick (fight AND results)
  // Tap targets are rebuilt by this frame's draw calls. Clearing here (rather
  // than after) means a press landing between frames still hit-tests the
  // layout the player can actually see.
  resetTaps();

  if (screen === 'loading') {
    // Ease the bar toward the real fraction so milestone jumps don't stutter.
    loadDisplay += (loadProgress - loadDisplay) * 0.14;
    if (loadProgress - loadDisplay < 0.002) loadDisplay = loadProgress;
    drawLoading(ctx, loadDisplay, uiTick, loadError);
  } else if (screen === 'title') {
    // M5: the AIR account IS the wallet the credits settle into — signing in
    // is required to proceed (?dev=NAME bypasses against a dev server).
    const signedIn = auth.status === 'in' || !!DEV_GUEST;
    if (signedIn && accountFetch === 'idle') void fetchAccount();
    if (!signedIn && account) { account = null; accountFetch = 'idle'; } // signed out
    if (accountToastAge >= 0 && ++accountToastAge > 300) accountToastAge = -1;
    if (referralToastAge >= 0 && ++referralToastAge > 300) referralToastAge = -1;
    // A challenge link (?room=) auto-joins the friend's room the moment the
    // sign-in gate clears — clicking the link WAS the consent. One last
    // title frame draws beneath; the lobby takes over next frame.
    if (signedIn && accountFetch === 'done' && pendingRoom) {
      const room = pendingRoom;
      pendingRoom = '';
      startFriendly(room);
    }
    // A dare-vs-agent link (?agent=1&ref=) routes the same way: clicking the
    // link WAS the consent; the fighter pick is still theirs to make.
    if (signedIn && accountFetch === 'done' && pendingAgentOf && !pendingRoom) {
      const code = pendingAgentOf;
      pendingAgentOf = '';
      startAgentDare(code);
    }
    drawTitle(ctx, allRosters, uiTick, {
      mode, cpuLevel: cpuLevelFor(profile, lever),
      authLabel: authName() ?? (DEV_GUEST ? `DEV·${DEV_GUEST.toUpperCase()}` : null),
      authBusy: auth.status === 'busy',
      authError: auth.status === 'error' ? auth.error : undefined,
      signedIn,
      address: auth.address || undefined,
      account: accountFetch === 'done' && account
        ? { credits: account.credits, level: account.level, wins: account.wins, losses: account.losses }
        : null,
      dailyToast: accountToastAge >= 0,
      referralToast: referralToastAge >= 0,
      refCode: accountFetch === 'done' ? account?.refCode : undefined,
      challenge: !!pendingRoom,
      fighter: (allRosters.find((r) => r.id === lastFighter && !r.disabled)
        ?? allRosters.find((r) => !r.disabled))?.bundle.name,
      audio: {
        masterMuted: audio.isMasterMuted(),
        musicMuted: audio.isChannelMuted('music'),
        sfxMuted: audio.isChannelMuted('sfx'),
        hitsMuted: audio.isChannelMuted('hits'),
        open: audioMenuOpen,
      },
    });
    // 2-player local is disabled on all platforms (single-controller / mobile
    // focus). The '2p' Mode value + its handling stay in the codebase, just no
    // longer offered on the menu.
    const MODES: Mode[] = ['cpu', 'online'];
    /** Leave the title for the fighter select. */
    const enterSelect = (): void => {
      audioMenuOpen = false;
      screen = 'select';
      locked = [false, false];
      selectingFriendly = false; // a title select is always wager (online) or arcade (cpu)
      selectingAgentOf = ''; // …never a dare-vs-agent leftover
      // Cursor starts on the REMEMBERED fighter so select is one confirm away.
      let fe = allRosters.findIndex((r) => r.id === lastFighter && !r.disabled);
      if (fe < 0) fe = Math.max(0, allRosters.findIndex((r) => !r.disabled));
      picks = [fe, fe];
      // CONSUMABLES: refresh the stash so the equipped indicator is honest.
      if (signedIn) void fetchShop();
      void audio.playBgm('player_select', { fadeInSec: 0.5 });
    };
    /**
     * Both modes now route through the select screen first — you pick your
     * fighter before entering the match (ONLINE WAGER stakes credits, so a
     * blind quick-queue was a footgun; AGENT ARCADE locks the pick for the
     * whole run). Select's lock handler does the actual queue.
     */
    const launchMode = (): void => {
      // RANKED WAGER stakes real credits → needs the AIR account for escrow.
      // A guest here opens sign-in instead of queuing. (On touch the dialog is
      // fired in-gesture from the pointerdown handler; this covers desktop
      // Enter and any keyboard fall-through — authLogin() no-ops if already busy.)
      if (mode === 'online' && !isSignedIn()) { void authLogin(); return; }
      // AGENT ARCADE (ADR 0007 credits rework): a SIGNED-IN player pays the
      // 1-credit entry BEFORE character select (when the live economy is
      // reachable). GUESTS skip straight to select → the run starts locally,
      // reward-free (handled at the select lock). Server-down / dev-no-persist
      // signed-in players also fall through to the legacy select→queue path.
      if (mode === 'cpu' && isSignedIn() && accountFetch === 'done' && account) {
        if (pendingArcadeToken) { enterSelectForArcade(); return; } // already paid
        arcadeEntryConfirm = true;
        return;
      }
      enterSelect();
    };
    // A tapped mode row picks the mode AND launches — one tap to a match.
    const tappedMode = MODES.find((m) => taps.has(`mode:${m}`));

    // ---- ARCADE ENTRY modal + crash-resume pill (drawn over drawTitle) ----
    if (titleToastAge >= 0 && ++titleToastAge > 240) { titleToastAge = -1; titleToast = ''; }
    if (titleToast && titleToastAge >= 0 && titleToastAge % 30 < 22) {
      ctx.save();
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.fillStyle = '#ff5d7e';
      ctx.textAlign = 'center';
      ctx.fillText(`⚠ ${titleToast}`, VW / 2, VH - 40);
      ctx.restore();
    }
    const resumable = signedIn && !arcadeEntryConfirm ? storedArcadeRun() : null;
    if (resumable) {
      const w = 320, h = 34, x = VW / 2 - w / 2, y = VH - 254;
      tapZone(x, y, w, h, 'arcade:resume');
      ctx.save();
      ctx.fillStyle = 'rgba(58,38,10,0.92)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillStyle = uiTick % 44 < 34 ? '#ffe9a3' : '#ffd166';
      ctx.textAlign = 'center';
      ctx.fillText(`▶ RESUME ARCADE RUN · BATTLE ${resumable.battle + 1}/${resumable.total}`, x + w / 2, y + 22);
      ctx.restore();
    }
    if (arcadeEntryConfirm) {
      // Modal owns the input (like the shop's purchase confirm).
      ctx.save();
      ctx.fillStyle = 'rgba(4,2,10,0.72)';
      ctx.fillRect(0, 0, VW, VH);
      const pw = 430, ph = 180, px = VW / 2 - pw / 2, py = VH / 2 - ph / 2 - 10;
      ctx.fillStyle = 'rgba(16,12,28,0.97)';
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
      ctx.textAlign = 'center';
      ctx.font = 'bold 24px system-ui, sans-serif';
      ctx.fillStyle = '#ffd166';
      ctx.fillText('ENTER AGENT ARCADE — 1 CREDIT?', px + pw / 2, py + 44);
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillStyle = '#ffffffcc';
      ctx.fillText('ONE CREDIT BUYS THE WHOLE GAUNTLET · NON-REFUNDABLE', px + pw / 2, py + 72);
      ctx.fillText(`BALANCE AFTER: ${Math.max(0, (account?.credits ?? 0) - 1)} CR · EVERY WIN PAYS +1`, px + pw / 2, py + 92);
      const btnW = 180, btnH = 44, gap = 26, btnY = py + ph - 62;
      const yesX = px + pw / 2 - btnW - gap / 2, noX = px + pw / 2 + gap / 2;
      tapZone(yesX, btnY, btnW, btnH, 'arcadeentry:yes');
      ctx.fillStyle = 'rgba(28,66,30,0.95)';
      ctx.fillRect(yesX, btnY, btnW, btnH);
      ctx.strokeStyle = '#7ddf8a';
      ctx.strokeRect(yesX + 0.5, btnY + 0.5, btnW - 1, btnH - 1);
      ctx.font = 'bold 17px system-ui, sans-serif';
      ctx.fillStyle = '#c8ffd0';
      ctx.fillText(arcadeEntryBusy ? 'PAYING…' : 'YES · ENTER', yesX + btnW / 2, btnY + 28);
      tapZone(noX, btnY, btnW, btnH, 'arcadeentry:no');
      ctx.fillStyle = 'rgba(66,24,28,0.95)';
      ctx.fillRect(noX, btnY, btnW, btnH);
      ctx.strokeStyle = '#ff8d9d';
      ctx.strokeRect(noX + 0.5, btnY + 0.5, btnW - 1, btnH - 1);
      ctx.fillStyle = '#ffd6dd';
      ctx.fillText('NO · BACK', noX + btnW / 2, btnY + 28);
      ctx.restore();
      if (!arcadeEntryBusy
        && (pressedThisFrame.has('Enter') || pressedThisFrame.has('KeyY') || taps.has('arcadeentry:yes'))) {
        void payArcadeEntry();
      } else if (pressedThisFrame.has('Escape') || pressedThisFrame.has('KeyN') || taps.has('arcadeentry:no')) {
        arcadeEntryConfirm = false;
      }
      pressedThisFrame.clear();
      taps.clear();
      return;
    }
    if (resumable && taps.has('arcade:resume')) {
      // Crash/relaunch recovery: rejoin the paid run inside the server's
      // grace window. The fighter is locked server-side — restore the pick.
      const idx = allRosters.findIndex((r) => r.id === resumable.charId && !r.disabled);
      if (idx >= 0) {
        picks = [idx, idx];
        mode = 'cpu';
        // The board lives server-side, so resuming is a plain read: the run
        // comes back standing exactly where it fell.
        startArcadeRanked(resumable.token);
      } else {
        storeArcadeRun(null);
      }
      pressedThisFrame.clear();
      taps.clear();
      return;
    }

    // Audio chip — works on the sign-in gate too (music is already playing).
    const audioTap = (['music', 'sfx', 'hits'] as const)
      .find((ch) => taps.has(`audio:${ch}`)) as AudioChannel | undefined;
    if (taps.has('audio:mute')) {
      audio.toggleMaster();
    } else if (taps.has('audio:menu')) {
      audioMenuOpen = !audioMenuOpen;
    } else if (audioTap) {
      audio.toggleChannel(audioTap);
    } else if (audioMenuOpen && taps.size > 0) {
      // Any other tap dismisses the dropdown without launching a mode.
      audioMenuOpen = false;
    } else if (pressedThisFrame.has('KeyL') || taps.has('signin')) {
      // AIR sign-in/out toggle — must not fall through to "any key starts".
      // On touch the gesture-time pointerdown handler below already fired this
      // and deleted the tap, so iOS keeps the user-activation the OAuth dialog
      // needs; reaching here means the desktop `L` key (no activation gate).
      toggleSignIn();
    } else if (pressedThisFrame.has('KeyR') || taps.has('ranks')) {
      // Standings are public — viewable even from the sign-in gate.
      audioMenuOpen = false;
      screen = 'ranks';
      fetchRanks();
    } else if (pressedThisFrame.has('KeyD') || taps.has('dare')) {
      // "I DARE YOU TO FIGHT" — the full invite screen (poster, taunt,
      // shareable link). Both sides earn +25 credits when a friend accepts.
      // Account-only → a guest tap opens sign-in instead (the touch dialog is
      // fired in-gesture from the pointerdown handler; this is the desktop path).
      if (signedIn && account?.refCode) enterInvite('title'); else void authLogin();
    } else if (pressedThisFrame.has('KeyA') || taps.has('myagent')) {
      // MY AGENT (ADR 0006): view the coached config, mint the coach key,
      // spar your own agent. Sign-in required — the agent IS the account.
      if (signedIn) enterAgentScreen(); else void authLogin();
    } else if (pressedThisFrame.has('KeyB') || taps.has('shop')) {
      // VENDING MACHINE (ADR 0007): gacha energy drinks for credits.
      if (signedIn) enterShop(); else void authLogin();
    } else if (tappedMode) {
      mode = tappedMode;
      launchMode();
    } else if (pressedThisFrame.has('ArrowUp') || pressedThisFrame.has('KeyW')) {
      mode = MODES[(MODES.indexOf(mode) + MODES.length - 1) % MODES.length]!;
    } else if (pressedThisFrame.has('ArrowDown') || pressedThisFrame.has('KeyS')) {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length]!;
    } else if (pressedThisFrame.has('KeyC') || taps.has('changefighter')) {
      enterSelect();
    } else if (pressedThisFrame.has('Enter') || pressedThisFrame.has('Space') || taps.has('start')) {
      launchMode();
    }
  } else if (screen === 'agent') {
    if (keyCopiedAge >= 0 && ++keyCopiedAge > 300) keyCopiedAge = -1;
    drawAgent(ctx, uiTick, {
      status: agentScreenFetch,
      name: agentScreenInfo?.name ?? authName() ?? undefined,
      level: agentScreenInfo?.level,
      wins: agentScreenInfo?.wins,
      losses: agentScreenInfo?.losses,
      config: agentScreenInfo?.config ?? null,
      keyCreatedAt: agentScreenInfo?.keyCreatedAt ?? null,
      roster: allRosters.find((r) => r.id === agentScreenInfo?.config?.character),
      mintedKey: mintedKey || undefined,
      mintedKeyKind,
      mintBusy,
      keyCopiedAge,
      connectLabel: `${matchHttpUrl().replace(/^https?:\/\//, '')}/connect`,
    });
    const sparCode = agentScreenFetch === 'done' && agentScreenInfo?.config ? account?.refCode : undefined;
    if (sparCode && (pressedThisFrame.has('KeyS') || taps.has('agent:spar'))) {
      // Sparring IS dare-vs-agent aimed at yourself: ranked solo, your own
      // ref code — the coach → spar → adjust feedback loop (ADR 0006).
      startAgentDare(sparCode);
    } else if (!mintBusy && (pressedThisFrame.has('KeyK') || taps.has('agent:mint'))) {
      void mintAgentKey();
    } else if (!mintBusy && (pressedThisFrame.has('KeyF') || taps.has('agent:fighter'))) {
      void createAgentFighter();
    } else if (pressedThisFrame.has('Escape') || taps.has('back')) {
      screen = 'title';
    }
  } else if (screen === 'map' && arcade) {
    // AGENT ARCADE v2 (ADR 0008): the board is the whole between-fights loop.
    // Every credit in this mode is decided here — take the short line to an
    // exit, or spend another fight on a guarded pile.
    const options = successors(arcade.board, arcade.at);
    // The highlight always points at a LEGAL route: the server owns where we
    // stand, so a refresh can move us and strand a stale selection.
    if (!options.includes(mapSel)) mapSel = options[0] ?? -1;
    drawMap(ctx, uiTick, {
      board: arcade.board,
      at: arcade.at,
      fights: arcade.fights,
      total: arcade.total,
      bag: { credits: arcade.bag.credits, drinks: arcade.bag.drinks.length },
      practice: arcade.practice,
      nameOf: rosterName,
      rosterOf: (charId) => allRosters.find((r) => r.id === charId),
      player: allRosters.find((r) => r.id === arcade!.charId),
      sel: mapSel,
      busy: mapBusy,
      toast: mapToast || undefined,
    });
    drawWalletStrip();
    if (!mapBusy) {
      // Taps carry the node id, so a mis-drawn row can never highlight
      // something illegal — arcadeGo re-checks the edge either way.
      let chosen = -1;
      for (const t of taps) {
        if (t.startsWith('map:sel:')) {
          const id = Number(t.slice(8));
          // Tap-to-choose, tap-again-to-commit — the same two-step the
          // character select uses, so one touch never spends a fight.
          if (Number.isFinite(id) && options.includes(id)) {
            if (id === mapSel) chosen = id;
            else { mapSel = id; audio.blip({ freq: 720, volume: 0.28 }); }
          }
        }
      }
      // Keyboard 1-4 mirror the panel rows, in the same order they are drawn.
      for (let i = 0; i < Math.min(options.length, 4); i++) {
        if (pressedThisFrame.has(`Digit${i + 1}`)) {
          mapSel = options[i]!;
          audio.blip({ freq: 720, volume: 0.28 });
        }
      }
      const step = (d: number): void => {
        if (options.length === 0) return;
        const at = Math.max(0, options.indexOf(mapSel));
        mapSel = options[(at + d + options.length) % options.length]!;
        audio.blip({ freq: 720, volume: 0.28 });
      };
      if (pressedThisFrame.has('ArrowDown') || pressedThisFrame.has('KeyS')) step(1);
      if (pressedThisFrame.has('ArrowUp') || pressedThisFrame.has('KeyW')) step(-1);
      if (taps.has('map:act') || pressedThisFrame.has('Enter') || pressedThisFrame.has('Space')) {
        if (mapSel >= 0) chosen = mapSel;
      }
      if (chosen >= 0) {
        audio.playSfx('select_confirm');
        arcadeGo(chosen);
      } else if (pressedThisFrame.has('Escape') || taps.has('back')) {
        // Abandoning forfeits the bag exactly like dying does. When there IS
        // a bag, say what it costs and make them mean it — one stray Escape
        // must not be able to throw away credits they fought for.
        const carrying = arcade.bag.credits + arcade.bag.drinks.length;
        if (carrying > 0 && !mapAbandonArmed) {
          mapAbandonArmed = true;
          mapToast = `ESC AGAIN TO ABANDON — YOU LOSE ${arcade.bag.credits} CR`
            + (arcade.bag.drinks.length > 0 ? ` + ${arcade.bag.drinks.length} DRINK` : '');
        } else {
          endArcade();
        }
      } else if (mapAbandonArmed && (pressedThisFrame.size > 0 || taps.size > 0)) {
        mapAbandonArmed = false; // any other input stands the prompt down
        mapToast = '';
      }
    }
  } else if (screen === 'extract' && extractView) {
    drawExtract(ctx, uiTick, extractView);
    drawWalletStrip();
    if (pressedThisFrame.has('Enter') || pressedThisFrame.has('Escape') || taps.has('start')) {
      extractView = null;
      endArcade();
    }
  } else if (screen === 'shop') {
    if (shopRevealAge >= 0) shopRevealAge++;
    if (shopErrAge >= 0 && ++shopErrAge > 240) { shopErrAge = -1; shopErr = ''; }
    // Slot reel: advance; land the held result once the 3s spin completes.
    // (Spin overruns SHOP_SPIN_TICKS only if the server response is late.)
    if (shopSpinAge >= 0) {
      shopSpinAge++;
      // Reel tick-tick-tick that slows with the reel (pure theater).
      const spinT = Math.min(1, shopSpinAge / SHOP_SPIN_TICKS);
      const tickEvery = 3 + Math.round(spinT * spinT * 21); // 3f → 24f apart
      if (shopSpinAge % tickEvery === 0) {
        audio.blip({ freq: 620 + 240 * (1 - spinT), volume: 0.18 });
      }
      if (shopSpinAge >= SHOP_SPIN_TICKS && shopPending) landShopSpin();
    }
    drawShop(ctx, uiTick, {
      status: shopFetch,
      credits: shopBalance(),
      cost: shopCost,
      items: shopInv,
      pullBusy: shopPullBusy,
      reveal: shopReveal,
      revealAge: shopRevealAge,
      err: shopErr,
      errAge: shopErrAge,
      confirm: shopConfirm,
      spinAge: shopSpinAge,
      catalog: shopCatalog.map((d) => ({ name: d.name, tier: d.tier })),
      equipped: equippedInv,
    });
    // EQUIP rack + stash taps ('equip:<rowId>') — toggle in/out of the loadout.
    for (const t of taps) {
      if (t.startsWith('equip:')) {
        const rowId = Number(t.slice(6));
        if (Number.isFinite(rowId) && rowId > 0) void toggleEquip(rowId);
      }
    }
    if (shopConfirm) {
      // Modal owns the input: YES pulls, NO/ESC backs out. Nothing else.
      if (pressedThisFrame.has('Enter') || pressedThisFrame.has('KeyY') || taps.has('shop:yes')) {
        shopConfirm = false;
        shopReveal = null;
        shopRevealAge = -1;
        shopSpinAge = 0; // reel starts NOW; the buy races it and always wins
        void pullShop();
      } else if (pressedThisFrame.has('Escape') || pressedThisFrame.has('KeyN') || taps.has('shop:no')) {
        shopConfirm = false;
      }
    } else if (!shopPullBusy && shopSpinAge < 0 && shopFetch !== 'fail'
      && (shopBalance() === null || shopBalance()! >= shopCost)
      && (pressedThisFrame.has('Enter') || pressedThisFrame.has('Space') || taps.has('shop:pull'))) {
      shopConfirm = true; // ask before taking the money
    } else if (shopSpinAge < 0 && (pressedThisFrame.has('Escape') || taps.has('back'))) {
      screen = 'title';
    }
  } else if (screen === 'ranks') {
    drawRanks(ctx, ranksRows, ranksTab, ranksErr, uiTick,
      authName() ?? (DEV_GUEST ?? undefined));
    if (pressedThisFrame.has('ArrowLeft') || pressedThisFrame.has('KeyA')) {
      ranksTab = (ranksTab + RANK_TABS.length - 1) % RANK_TABS.length;
    }
    if (pressedThisFrame.has('ArrowRight') || pressedThisFrame.has('KeyD')) {
      ranksTab = (ranksTab + 1) % RANK_TABS.length;
    }
    for (let i = 0; i < RANK_TABS.length; i++) if (taps.has(`ranktab:${i}`)) ranksTab = i;
    if (pressedThisFrame.has('KeyR')) fetchRanks();
    if (pressedThisFrame.has('Escape') || taps.has('back')) screen = 'title';
  } else if (screen === 'invite') {
    if (inviteCopiedAge >= 0 && ++inviteCopiedAge > 240) inviteCopiedAge = -1;
    drawInvite(ctx, uiTick, {
      name: (authName() ?? (DEV_GUEST ? `DEV·${DEV_GUEST.toUpperCase()}` : 'FIGHTER')).toUpperCase(),
      account: account
        ? { credits: account.credits, level: account.level, wins: account.wins, losses: account.losses }
        : null,
      refCode: account?.refCode,
      roster: allRosters.find((r) => r.id === lastFighter && !r.disabled)
        ?? allRosters.find((r) => !r.disabled),
      rosters: allRosters,
      taunt: currentTaunt(),
      tauntIdx,
      tauntCount: TAUNTS.length,
      linkLabel: `${DARE_LINK_BASE.replace(/^https?:\/\//, '')}/${account?.refCode ?? ''}`,
      copiedAge: inviteCopiedAge,
      canShare: shareViaSheet(),
      daresAccepted: account?.daresAccepted,
      bountiesLeft: account
        ? Math.max(0, REFERRAL_WEEKLY_CAP - (account.daresPaidWeek ?? 0))
        : undefined,
      agentReady: !!agentCfg,
      vsAgent: dareVsAgent,
    });
    if (agentCfg && (pressedThisFrame.has('KeyT') || taps.has('daretype:me') || taps.has('daretype:agent'))) {
      // Dare target toggle (ADR 0006): T cycles; taps set directly.
      dareVsAgent = taps.has('daretype:agent') ? true
        : taps.has('daretype:me') ? false
        : !dareVsAgent;
      inviteCopiedAge = -1; // the link changed — re-arm the button
    } else if (pressedThisFrame.has('ArrowLeft') || pressedThisFrame.has('KeyA') || taps.has('taunt:prev')) {
      tauntIdx = (tauntIdx + TAUNTS.length - 1) % TAUNTS.length;
      inviteCopiedAge = -1; // new taunt = new link — re-arm the button
    } else if (pressedThisFrame.has('ArrowRight') || pressedThisFrame.has('KeyD') || taps.has('taunt:next')) {
      tauntIdx = (tauntIdx + 1) % TAUNTS.length;
      inviteCopiedAge = -1;
    } else if (account?.refCode && (pressedThisFrame.has('KeyC') || taps.has('challenge'))) {
      // CHALLENGE LIVE: park in a room keyed by MY code and copy the live
      // link (?room= + ?ref= — a brand-new friend still redeems the dare
      // bonus by signing up). The lobby explains the waiting state.
      const code = account.refCode;
      void navigator.clipboard
        ?.writeText(`${location.origin}/?room=${encodeURIComponent(code)}&ref=${encodeURIComponent(code)}`)
        .catch(() => { /* lobby shows the room code as fallback */ });
      startFriendly(code);
    } else if (pressedThisFrame.has('Enter') || pressedThisFrame.has('Space') || taps.has('copydare')) {
      shareDare();
    } else if (pressedThisFrame.has('Escape') || taps.has('back')) {
      screen = inviteFrom;
    }
  } else if (screen === 'select') {
    tickSelect();
    if (!agentRosterFetched) fetchAgentRoster();
    // The upper-right AGENT OPPONENT card: who you're about to fight (level,
    // W-L, streak, wallet) — a live roster agent when one exists (same pick
    // ranked solo pins server-side), else the house agent. PvP-friendly
    // select has no CPU. AGENT ARCADE has no single opponent either: the
    // board (minted at lock-in) decides who guards each node and pins the
    // skill by region, so it draws the ramp instead of a named agent.
    const badge = !selectingFriendly && mode !== 'cpu'
      ? { cpuLevel: cpuLevelFor(profile, lever), lever, opp: resolveAgentOpp() }
      : undefined;
    // A guest's gauntlet runs locally, reward-free — the rules panel must say
    // so rather than quoting the 1-credit entry it will never charge them.
    // CHARACTER LEVEL / XP / W-L on the player's own card: the signed-in
    // account when there is one (server-authoritative), else the local
    // profile — the same pair the results screen animates.
    drawSelect(ctx, allRosters, picks, locked, uiTick, badge,
      mode === 'cpu' ? { practice: !isSignedIn() } : undefined,
      selectingFriendly,
      account
        ? {
          level: account.level, xp: account.xp, xpNeed: xpForNext(account.level),
          wins: account.wins, losses: account.losses,
        }
        : {
          level: profile.level, xp: profile.xp, xpNeed: xpForNext(profile.level),
          wins: profile.wins, losses: profile.losses,
        });
    drawWalletStrip();
  } else if (screen === 'stageSelect') {
    tickStageSelect();
    drawStageSelect(ctx, stageIds, stageCursor, uiTick);
  } else if (screen === 'online') {
    // Matchmaking lobby: connect → queue → match setup → install → fight.
    ctx.fillStyle = '#0a0616';
    ctx.fillRect(0, 0, VW, VH);
    const dots = '.'.repeat(1 + (Math.trunc(uiTick / 20) % 3));
    const solo = queuedMode === 'solo';
    const arcadeQ = queuedMode === 'arcade';
    const friendlyQ = queuedMode === 'friendly';
    const failed = net?.status === 'error';
    const soloOpp = solo ? resolveAgentOpp() : null;
    const soloCall = soloOpp
      ? `CALLING ${soloOpp.name.toUpperCase()}${dots}`
      : `CALLING THE HOUSE AGENT${dots}`;
    const msg = !net ? `CONNECTING${dots}` // token fetch in flight
      : failed ? `OFFLINE: ${net.error}`
      : net.setup ? 'OPPONENT FOUND — STARTING'
      : net.status === 'queued'
        ? (arcadeQ ? `ENTERING AGENT ARCADE${dots}`
          : friendlyQ ? `WAITING FOR YOUR CHALLENGER${dots}`
          : solo ? soloCall : `SEARCHING FOR OPPONENT${dots}`)
      : `CONNECTING${dots}`;
    ctx.font = 'bold 22px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = failed ? '#e94560' : '#f7e0a3';
    ctx.fillText(msg, VW / 2, VH / 2 - 34);
    ctx.font = 'bold 14px "Courier New", monospace';
    ctx.fillStyle = '#ffd166';
    ctx.fillText(arcadeQ
      ? 'RANKED GAUNTLET · 1 CREDIT PER RUN · BEAT EVERY AGENT'
      : friendlyQ
        ? `FRIENDLY · FREE · NO POT · ROOM ${friendlyRoom}`
        : solo
          ? 'RANKED VS AGENT · 1 CREDIT · WIN +1 · LOSE −15 XP'
          : 'WAGER · 10 CREDITS ENTRY EACH · WINNER TAKES THE 20 POT', VW / 2, VH / 2 - 4);
    ctx.font = '13px "Courier New", monospace';
    ctx.fillStyle = '#ffffff88';
    ctx.fillText(failed
      ? (arcadeQ ? 'TAP / ENTER: PRACTICE GAUNTLET (no fee · no XP · no records)'
        : solo ? 'TAP / ENTER: FREE PRACTICE (no fee · no XP · no records)'
        : 'is the match server running?  npm run server')
      : friendlyQ
        ? 'challenge link copied — paste it to your friend, they must join while you wait  ·  ESC: cancel'
        : 'humans and agents share this queue  ·  ESC: cancel', VW / 2, VH / 2 + 24);
    if (failed) {
      ctx.fillText('TAP BACK / ESC: leave', VW / 2, VH / 2 + 46);
      // Phones have no Enter/Esc — without these zones iOS is stuck on OFFLINE.
      if (solo || arcadeQ) tapZone(VW / 2 - 280, VH / 2 - 70, 560, 100, 'practice');
      tapZone(24, VH - 52, 200, 40, 'back');
      ctx.font = 'bold 14px "Courier New", monospace';
      ctx.fillStyle = '#ffd166';
      ctx.fillText('← BACK', 40, VH - 28);
    }
    drawWalletStrip();
    if (net?.setup && !netInstalled) installOnlineMatch();
    if (failed && arcadeQ && (pressedThisFrame.has('Enter') || taps.has('practice') || taps.has('start'))) {
      // Server unreachable → the same gauntlet fully local, reward-free.
      practiceFree = true;
      net?.close();
      net = null;
      startArcadePractice();
    } else if (failed && solo && (pressedThisFrame.has('Enter') || taps.has('practice') || taps.has('start'))) {
      // Server unreachable → the old local match, explicitly reward-free.
      practiceFree = true;
      net?.close();
      net = null;
      const en = allRosters.map((r, i) => (r.disabled ? -1 : i)).filter((i) => i >= 0);
      picks[1] = en[(seed * 13 + uiTick) % en.length] ?? picks[0];
      startFight();
    } else if (pressedThisFrame.has('Escape') || taps.has('back')) {
      net?.close();
      net = null;
      if (arcadeQ && arcade) {
        // Backing out MID-RUN (between battles): the run is abandoned — the
        // title, never the select screen (no fighter switching mid-run).
        endArcade();
      } else if (friendlyQ) {
        // Canceling a challenge → the invite screen (both the inviter who
        // came from it and a deep-linked friend, who lands on their own).
        screen = 'invite';
      } else {
        screen = 'select';
        locked = [false, false];
      }
    }
  } else if (screen === 'fight' && game) {
    if (pressedThisFrame.has('KeyB')) showBoxes = !showBoxes;
    // AUTO (hands-free, ADR 0006 obj. 2): V hands the sticks to the COACHED
    // agent — solo/arcade only (never against a staked human), and gated on
    // a coached config existing (the observable effect of the Minds skill's
    // first PUT). The agent is exactly house-strength for your level; only
    // its coached STYLE is yours.
    if (pressedThisFrame.has('KeyV') && net instanceof SoloSession) {
      if (!agentCfg) {
        autoHintAge = 0;
      } else {
        const lvl = account?.level ?? profile.level;
        const skill = Math.max(40, Math.min(100, Math.round((lvl * 100) / 40)));
        net.setAuto(!net.auto, skill, agentCfg.personality);
      }
    }
    // Stakes card: shown for the first ~2.5s; any key skips. Solo and local
    // matches HOLD the sim under it (nothing is waiting on us); wager keeps
    // stepping — the peer's card runs on the same clock and rollback absorbs
    // the difference if one side skips early.
    const cardUp = vsCardAge >= 0 && vsCardAge < VS_CARD_TICKS;
    // Keyboard OR a menu tap skips the stakes card (phones never populate pressedThisFrame).
    if (cardUp && (pressedThisFrame.size > 0 || taps.size > 0) && vsCardAge > 20) {
      vsCardAge = VS_CARD_TICKS;
    }
    // The socket died mid-match: the sim CANNOT continue (its opponent inputs
    // are gone, and the server owns the verdict anyway). Freeze, explain, and
    // offer the exit — never silently stall on a live-looking frame.
    const netDead = !!net && net.status === 'error' && !net.result;
    // QUIT CONFIRM (ADR 0003 leave = forfeit): ESC — or the phone MATCH-MENU's
    // QUIT, which fires ESC — no longer bails straight to character select. It
    // raises an "are you sure?" modal; confirming returns HOME. A dead match
    // has its own exit overlay (below), so cancel any pending prompt and let
    // that own the exit. `quitWasOpen` lets a SECOND ESC cancel the prompt
    // without the same ESC that opened it also closing it.
    if (netDead) quitConfirm = false;
    const quitWasOpen = quitConfirm;
    if (!netDead && pressedThisFrame.has('Escape')) quitConfirm = true;
    // The quit prompt does NOT freeze the fight — same rule as the phone
    // MATCH-MENU: a local pause of a live (solo-ledger / wager) match would
    // strand its input stream and trip the server's idle-forfeit if the player
    // dwells on the prompt. It's a quick decision, and leaving is a forfeit
    // anyway, so there is no "safe pause" to protect. Only the fixed-length VS
    // card holds the sim (nothing waits on us, and it can't outlast the idle
    // window).
    const holdSim = cardUp && net?.setup?.mode !== 'wager';
    // A resume rebuilds the session's GameState object — re-adopt it, or the
    // renderer keeps drawing the pre-drop snapshot forever.
    const netReconnecting = !!net && net.status === 'reconnecting';
    if (net?.game && net.game !== game) game = net.game;
    // Auto Special: tapping the logo badge queues a real motion + button
    // script, which then drives the pad for the next few ticks (see
    // autospecial.ts — inputs only, so the server's re-sim still agrees).
    if (taps.has('special') && fighters && !holdSim && !netDead) {
      startAutoSpecial(game, localSide(), fighters[localSide()].ch);
    }
    // CONSUMABLES (ADR 0007): a tap on a HUD can arms that slot's bit for
    // this frame's step(s); R (handled in pollLocal) drinks the next can.
    // The sim acts on rising edges only, in free ground states only.
    itemUseMask = (!holdSim && !netDead)
      ? ((taps.has('item:use:0') ? 1 : 0) | (taps.has('item:use:1') ? 2 : 0) | (taps.has('item:use:2') ? 4 : 0))
      : 0;
    // Advance the sim the `steps` fixed ticks owed this rAF (CT-2: render is
    // ONCE, below — only the simulation catches up here). Edge inputs fire on
    // the first sub-step only (pollLocal's `edges` flag); held input applies
    // every step. holdSim/netDead gate the whole loop, exactly as before.
    for (let s = 0; s < steps; s++) {
      const edges = s === 0;
      if (net && !holdSim && !netDead) {
        net.frame(pollLocal(game, edges)); // session owns stepping (rollback or local-sim)
      } else if (!net && !holdSim) {
        // Offline the human is always P1 (localSide() === 0).
        const p2: InputFrame = cpuAi ? aiPoll(cpuAi, game) : pollPad(P1_MAP);
        step(game, [pollLocal(game, edges), p2]);
      }
    }
    itemUseMask = 0;
    updateJuice(game);
    updateCamera(game);
    renderFight(game);
    if (cardUp && fighters && !netDead) {
      // LV chips (match-side order, matching names[]): my account/training
      // level always; the opponent's when we know it — offline CPU scales to
      // `cpuLevelFor`, online solo pins the house/agent to my account level.
      const myLv = account?.level ?? profile.level;
      const vsLevels: [number | null, number | null] = [null, null];
      if (net?.setup) {
        vsLevels[net.setup.side] = myLv;
        if (net.setup.mode === 'solo') vsLevels[1 - net.setup.side] = myLv;
      } else {
        vsLevels[0] = myLv;
        if (cpuAi && !arcade) vsLevels[1] = cpuLevelFor(profile, lever);
      }
      drawVsCard(ctx, fighters,
        net?.setup
          ? net.setup.names
          : [fighters[0].bundle.name,
            cpuAi && !arcade ? `AGENT LV ${cpuLevelFor(profile, lever)}` : fighters[1].bundle.name],
        vsStakes.filter((s) => s), vsCardAge, vsLevels);
      vsCardAge++;
    } else if (vsCardAge >= 0 && !netDead) {
      vsCardAge = -1;
    }
    // AUTO chip / unlock hint (drawn inline, perf-overlay style — ui.ts is
    // untouched on purpose). Chip = hands-free is ON; toast = gated.
    if (net instanceof SoloSession && !netDead && !cardUp) {
      if (net.auto) {
        const t = '▶ AUTO · agent has the controls · V to take over';
        ctx.save();
        ctx.font = 'bold 13px system-ui, sans-serif';
        const w = ctx.measureText(t).width + 24;
        ctx.fillStyle = uiTick % 60 < 45 ? '#101018cc' : '#10101888';
        ctx.fillRect((VW - w) / 2, 86, w, 24);
        ctx.strokeStyle = '#f5c542';
        ctx.strokeRect((VW - w) / 2, 86, w, 24);
        ctx.fillStyle = '#f5c542';
        ctx.textAlign = 'center';
        ctx.fillText(t, VW / 2, 103);
        ctx.restore();
      } else if (autoHintAge >= 0 && autoHintAge < 240) {
        const t = 'AUTO locked — coach your agent on Minds to unlock (see /connect)';
        ctx.save();
        ctx.font = '13px system-ui, sans-serif';
        ctx.globalAlpha = autoHintAge > 180 ? 1 - (autoHintAge - 180) / 60 : 1;
        ctx.fillStyle = '#ff9d9d';
        ctx.textAlign = 'center';
        ctx.fillText(t, VW / 2, 100);
        ctx.restore();
        autoHintAge++;
      }
    }
    if (netReconnecting) {
      drawReconnecting(ctx, uiTick); // ESC falls through to the branch's exit
    }
    // OUR link is fine but the OPPONENT's dropped (v6): the rollback sim has
    // frozen waiting on their inputs. Explain it + count down the server's
    // grace, so the freeze reads as "they bailed" not "it crashed". Yields to
    // our own reconnect/dead overlays (those are the more urgent story).
    const oppGoneUntil = net?.oppGoneUntil ?? null;
    if (oppGoneUntil !== null && !netReconnecting && !netDead && !net?.result) {
      drawOpponentGone(ctx, (oppGoneUntil - Date.now()) / 1000,
        net?.setup?.mode === 'friendly', uiTick);
    }
    // Rollback throttle stall: the sim halted waiting on opponent inputs but
    // their socket is still up (throttled tab, wifi hiccup, cross-region
    // jitter). Without this chip the freeze reads as a crash. Yields to the
    // reconnect/oppgone/dead overlays — those are the more urgent story.
    // (Audit 2026-07-18 client finding 3.)
    if (net instanceof NetSession && net.status === 'playing' && net.stalled > 20
      && oppGoneUntil === null && !netReconnecting && !netDead && !net.result) {
      const t = `⚠ CONNECTION — waiting for opponent… ${Math.floor(net.stalled / 60)}s`;
      ctx.save();
      ctx.font = 'bold 13px system-ui, sans-serif';
      const w = ctx.measureText(t).width + 24;
      ctx.fillStyle = uiTick % 60 < 45 ? '#101018cc' : '#10101888';
      ctx.fillRect((VW - w) / 2, 86, w, 24);
      ctx.strokeStyle = '#ffd166';
      ctx.strokeRect((VW - w) / 2, 86, w, 24);
      ctx.fillStyle = '#ffd166';
      ctx.textAlign = 'center';
      ctx.fillText(t, VW / 2, 103);
      ctx.restore();
    }
    if (netDead) {
      drawNetError(ctx, net!.error, queuedMode, uiTick);
      // The match is already dead and its own overlay reads "BACK TO MENU" —
      // no second confirmation; ENTER/ESC returns HOME (never select).
      if (pressedThisFrame.has('Enter') || pressedThisFrame.has('Escape') || taps.has('back')) {
        vsCardAge = -1;
        if (arcade) {
          endArcade(); // ranked run dies with the connection → title
        } else {
          net!.close();
          net = null;
          screen = 'title';
          locked = [false, false];
          void audio.playBgm(audio.nextHomeTrack(), { fadeInSec: 1 });
        }
      }
    }
    // QUIT CONFIRM modal — topmost, over the fight (which is frozen for
    // non-wager via holdSim). Centered so its buttons stay clear of the phone
    // touch pad / attack cluster anchored to the screen edges. Deliberately
    // requires Y or a tap to confirm (never Enter) so a mash can't bail a match.
    if (quitConfirm) {
      ctx.save();
      ctx.fillStyle = 'rgba(4,2,10,0.72)';
      ctx.fillRect(0, 0, VW, VH);
      const pw = 440, ph = 172, pxm = VW / 2 - pw / 2, pym = VH / 2 - ph / 2;
      ctx.fillStyle = 'rgba(16,12,28,0.97)';
      ctx.fillRect(pxm, pym, pw, ph);
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(pxm + 0.5, pym + 0.5, pw - 1, ph - 1);
      ctx.textAlign = 'center';
      ctx.font = 'bold 24px system-ui, sans-serif';
      ctx.fillStyle = '#ffd166';
      ctx.fillText('QUIT THIS MATCH?', pxm + pw / 2, pym + 46);
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillStyle = '#ffffffcc';
      ctx.fillText(net && queuedMode !== 'friendly'
        ? 'LEAVING COUNTS AS A LOSS · YOU RETURN TO THE HOME SCREEN'
        : 'YOU RETURN TO THE HOME SCREEN', pxm + pw / 2, pym + 76);
      const btnW = 186, btnH = 44, gap = 24, btnY = pym + ph - 60;
      const yesX = pxm + pw / 2 - btnW - gap / 2, noX = pxm + pw / 2 + gap / 2;
      tapZone(yesX, btnY, btnW, btnH, 'quit:yes');
      ctx.fillStyle = 'rgba(66,24,28,0.95)';
      ctx.fillRect(yesX, btnY, btnW, btnH);
      ctx.strokeStyle = '#ff8d9d';
      ctx.strokeRect(yesX + 0.5, btnY + 0.5, btnW - 1, btnH - 1);
      ctx.font = 'bold 17px system-ui, sans-serif';
      ctx.fillStyle = '#ffd6dd';
      ctx.fillText('Y · QUIT', yesX + btnW / 2, btnY + 28);
      tapZone(noX, btnY, btnW, btnH, 'quit:no');
      ctx.fillStyle = 'rgba(28,66,30,0.95)';
      ctx.fillRect(noX, btnY, btnW, btnH);
      ctx.strokeStyle = '#7ddf8a';
      ctx.strokeRect(noX + 0.5, btnY + 0.5, btnW - 1, btnH - 1);
      ctx.fillStyle = '#c8ffd0';
      ctx.fillText('N · RESUME', noX + btnW / 2, btnY + 28);
      ctx.restore();
      if (pressedThisFrame.has('KeyY') || taps.has('quit:yes')) {
        quitMatch();
      } else if (pressedThisFrame.has('KeyN') || taps.has('quit:no')
        || (quitWasOpen && pressedThisFrame.has('Escape'))) {
        quitConfirm = false;
      }
    }
    if (game.phase === Phase.Fighting && !hurryPlayed && game.timerTicks <= HURRY_UP_TICKS) {
      hurryPlayed = true;
      void audio.playStinger('hurry_up', { duck: false }); // layers over the stage loop, like the arcade original
    }
    // The server settled this match UNDER a live fight (idle forfeit while
    // the tab was throttled/locked, or a mid-match verdict): the local sim
    // can no longer decide anything — surface the verdict instead of
    // freezing on a dead session forever.
    if (net?.result && net.status === 'done' && game.phase !== Phase.MatchOver) {
      fx.announce = '';
      fx.comboOwner = -1;
      resultsAge = 0;
      const lostIt = net.result.winner === 1 - localSide() || net.result.winner === -1;
      if (arcade) {
        if (net.result.reason === 'incomplete' && !arcade.practice) {
          // NO-CONTEST (network blip / pace flag): the server kept the run,
          // the position AND the bag. Showing GAME OVER here would tell a
          // player they lost a loaded run that is in fact still theirs —
          // send them back to the map and re-read the truth from the server.
          net.close();
          net = null;
          enterMap(); // clears the toast, so set it after
          mapToast = 'NO CONTEST — THE RUN AND YOUR BAG ARE INTACT';
          refreshArcadeRun();
        } else {
          // A real loss: the run is over server-side and the bag is gone.
          gameOverAge = 0;
          screen = 'gameover';
          audio.playSfx('you_lose', { volume: 0.8 });
          void audio.playStinger('game_over');
        }
      } else {
        screen = 'results';
        if (lostIt) audio.playSfx('you_lose', { volume: 0.8 });
        void audio.playStinger(lostIt ? 'game_over' : 'win', {
          onEnded: () => void audio.playBgm('ranking', { fadeInSec: 1 }),
        });
      }
    }
    if (game.phase === Phase.MatchOver) {
      // Stale fight-screen state (a lingering "K.O." banner, a frozen combo
      // counter) must not bleed into the next screen's own layout.
      fx.announce = '';
      fx.comboOwner = -1;
      resultsAge = 0;
      if (arcade) {
        // AGENT ARCADE: only a clean win advances the run. A loss OR a draw
        // ends it — the gauntlet demands the win. Progression is SERVER-
        // AWARDED for ranked runs (the post-result xp message → banner);
        // practice runs pay nothing by design.
        if (game.winner === 0) {
          screen = 'results';
          // PRACTICE runs advance locally the way the server advances a ranked
          // one (practiceAdvance mirrors advanceRun, auto-collect included).
          // Ranked runs wait for the verdict and then re-read the server.
          if (arcade.practice && arcade.pending >= 0) {
            arcade.fights++;
            practiceAdvance(arcade, arcade.pending);
            arcade.pending = -1;
          }
          void audio.playStinger('win', {
            onEnded: () => void audio.playBgm('ranking', { fadeInSec: 1 }),
          });
        } else {
          gameOverAge = 0;
          screen = 'gameover';
          audio.playSfx('you_lose', { volume: 0.8 });
          void audio.playStinger('game_over');
        }
      } else {
        // Progression is SERVER-AWARDED (M5): ranked/wager XP + credits
        // arrive in the post-result xp message. Free practice pays nothing.
        screen = 'results';
        // OFFLINE TRAINING LV: a purely LOCAL progression track for vs-CPU
        // play (no server, no credits, no free pulls — localStorage is
        // editable, so it can never feed the trustworthy account economy).
        // It moves the same `profile` that scales CPU difficulty and shows a
        // "sign in for the real thing" nudge. Online matches never hit this —
        // `net` is set — so the server award stays authoritative.
        if (!net && cpuAi && !practiceFree) {
          const s = awardXp(profile, {
            won: game.winner === 0, damageDealt: statDmg, bestCombo: statBestCombo,
          });
          xpBanner = {
            gained: s.gained, levelsUp: s.levelsUp,
            level: profile.level, xp: profile.xp, xpNeed: xpForNext(profile.level),
            wins: profile.wins, losses: profile.losses, training: true,
          };
        }
        // CPU beat the human → arcade "Game Over" stinger; anything else
        // (human win, 2P vs 2P, a draw) gets the victory jingle.
        const lostToCpu = Boolean(cpuAi) && game.winner === 1;
        if (lostToCpu) audio.playSfx('you_lose', { volume: 0.8 });
        void audio.playStinger(lostToCpu ? 'game_over' : 'win', {
          onEnded: () => void audio.playBgm('ranking', { fadeInSec: 1 }),
        });
      }
    }
  } else if (screen === 'results' && game) {
    resultsAge++;
    // The 25s verification stall-guard must keep ticking here (audit 2026-07-18
    // client #5): net.frame() — its only other caller — is NOT invoked on this
    // screen, so without this a server that never sends 'result' leaves the card
    // on "VERIFYING WITH SERVER…" forever. checkVerifyWatchdog is side-effect
    // free (it only flips status→error after the deadline; no stepping, no send).
    net?.checkVerifyWatchdog();
    // Online progression is SERVER-AWARDED (Phase B): the xp message lands
    // after the verified result, only for signed-in players.
    if (net?.xp && !xpBanner) {
      // Resolve each server-granted free pull id → its full item def so the
      // results banner can name the drink (server already added it to inventory).
      const freePulls = (net.xp.freePulls ?? [])
        .map((p) => itemById(p.itemId))
        .filter((d): d is NonNullable<typeof d> => !!d)
        .map((d) => ({ name: d.name, tier: d.tier, desc: d.desc, flavor: d.flavor }));
      xpBanner = {
        gained: net.xp.gained, levelsUp: net.xp.levelsUp,
        level: net.xp.level, xp: net.xp.xp, xpNeed: xpForNext(net.xp.level),
        wins: net.xp.wins, losses: net.xp.losses,
        creditsDelta: net.xp.creditsDelta, credits: net.xp.credits,
        freePulls,
      };
      // A fresh pull is now in inventory — refresh the shop list lazily so the
      // vending screen shows it without a manual re-fetch.
      if (freePulls.length) void fetchShop();
      // Keep the title-screen chip in sync without a refetch.
      if (account) {
        account = {
          ...account, credits: net.xp.credits, level: net.xp.level,
          xp: net.xp.xp, wins: net.xp.wins, losses: net.xp.losses,
        };
      }
    }
    renderFight(game);
    // The effective winner: the local sim's, or the SERVER's verdict when the
    // sim never finished (opponent forfeit / mid-match settlement) — without
    // it this screen indexed rosters[-1] and crashed on every ragequit win.
    const effWinner = game.winner >= 0 ? game.winner : net?.result?.winner ?? -1;
    // Peak-ego entry point: a signed-in winner gets offered the dare screen.
    const canDare = effWinner === localSide() && !!account?.refCode;
    // Arcade: this screen is the between-battles interstitial. The run only
    // moves FORWARD (next challenger) or ENDS (quit to title) — there is no
    // path back to the select screen mid-run.
    drawResults(ctx, game, fighters!, uiTick, resultsAge, xpBanner,
      arcade
        ? (`${arcade.bag.credits > 0 ? `CARRYING ${arcade.bag.credits} CR — UNBANKED` : 'ROUTE CLEARED'}`
          + '        TAP / ENTER: BACK TO THE MAP        ESC: QUIT')
        : net
          ? `TAP / ENTER: REMATCH · ${queuedMode === 'solo' ? '1 CR' : queuedMode === 'friendly' ? 'FREE' : '10 CR'}        ESC: CHANGE FIGHTER`
          : undefined,
      canDare, net?.result?.winner);
    // Online: the server's verdict is the real result (ADR 0003).
    if (net) {
      ctx.font = 'bold 15px "Courier New", monospace';
      ctx.textAlign = 'center';
      if (net.result) {
        const ok = net.result.reason === 'verified';
        const pot = net.setup?.mode === 'wager' && (net.setup.fee ?? 0) > 0
          ? ` · POT ${(net.setup.fee ?? 0) * 2} CR` : '';
        ctx.fillStyle = ok ? '#7ee85a' : '#ffd166';
        ctx.fillText(
          ok ? `✓ SERVER-VERIFIED RESULT · ${net.result.rounds[0]}-${net.result.rounds[1]}${pot}`
            : `RESULT: ${net.result.reason.toUpperCase()}`,
          VW / 2, VH - 44);
      } else if (net.status === 'error') {
        // The watchdog fired (server stranded the verification). Say so instead
        // of an eternal "VERIFYING…"; ESC/Enter below still leaves the screen.
        ctx.fillStyle = '#ffd166';
        ctx.fillText('SERVER STOPPED ANSWERING — STRANDED FEES REFUND AUTOMATICALLY', VW / 2, VH - 44);
      } else {
        ctx.fillStyle = '#ffffff88';
        ctx.fillText('VERIFYING WITH SERVER…', VW / 2, VH - 44);
      }
    }
    drawWalletStrip();
    // 'back' overlaps the full-screen 'start' region, so check it first.
    if (canDare && (pressedThisFrame.has('KeyD') || taps.has('dare'))) {
      enterInvite('results'); // ESC on the invite screen returns here
    } else if (pressedThisFrame.has('Escape') || taps.has('back')) {
      if (arcade) {
        endArcade(); // quitting the gauntlet → title, never the select screen
      } else if (queuedMode === 'friendly') {
        // Friendly done → back to the invite screen (a wager-mode select here
        // would be an accidental 10-credit queue). Rematch is still ENTER.
        net?.close();
        net = null;
        selectingFriendly = false;
        screen = 'invite';
      } else {
        net?.close();
        net = null;
        screen = 'select'; locked = [false, false];
        void audio.playBgm('player_select', { fadeInSec: 0.5 });
      }
    } else if (pressedThisFrame.has('Enter') || taps.has('start')) {
      if (arcade) {
        // Forward is the MAP: the next decision is a route, not a rematch.
        // Ranked runs re-read the server first — it, not this client, owns
        // where the run now stands and what ended up in the bag.
        net?.close();
        net = null;
        enterMap();
        if (!arcade.practice) refreshArcadeRun();
      } else if (net) {
        // INSTANT REMATCH (P0): one input → straight back into the queue
        // with the same fighter and mode. No select detour, no re-confirm.
        // A dare-vs-agent solo rematches the SAME trained agent (run it back).
        const again = queuedMode;
        const againAgent = queuedAgentOf || undefined;
        net.close();
        net = null;
        startOnline(again, undefined, againAgent);
      } else {
        startFight();
      }
    }
  } else if (screen === 'gameover' && game) {
    // AGENT ARCADE run-ender: the frozen final frame under a GAME OVER card.
    // Any input — or the 10s countdown — returns to the title screen.
    gameOverAge++;
    // Ranked: fold the settlement into the title wallet chip (same sync the
    // results screen does) so the balance is honest the moment we return.
    if (net?.xp && account) {
      account = {
        ...account, credits: net.xp.credits, level: net.xp.level,
        xp: net.xp.xp, wins: net.xp.wins, losses: net.xp.losses,
      };
    }
    renderFight(game);
    drawGameOver(ctx, uiTick, gameOverAge, {
      by: fighters?.[1]?.bundle.name ?? 'THE HOUSE',
      stage: (arcade?.fights ?? 0) + 1,
      total: arcade?.total ?? 1,
    });
    // Ranked run: the server's verdict (and the XP burn) land moments after
    // the KO — surface them on the card so the loss reads as settled.
    if (net) {
      ctx.font = 'bold 13px "Courier New", monospace';
      ctx.textAlign = 'center';
      if (net.result) {
        const ok = net.result.reason === 'verified';
        ctx.fillStyle = ok ? '#7ee85a' : '#ffd166';
        const burn = net.xp ? `   ·   ${net.xp.gained} XP · ${net.xp.creditsDelta} CR` : '';
        ctx.fillText(`${ok ? '✓ SERVER-VERIFIED' : `RESULT: ${net.result.reason.toUpperCase()}`}${burn}`, VW / 2, VH - 60);
      } else {
        ctx.fillStyle = '#ffffff88';
        ctx.fillText('VERIFYING WITH SERVER…', VW / 2, VH - 60);
      }
    } else if (!isSignedIn()) {
      // GUEST arcade loss — the SOFT sign-in prompt ("play some more"). They can
      // still re-enter the free gauntlet from the title; signing in banks
      // credits/XP and unlocks RANKED. Drawn AFTER drawGameOver so this tap
      // zone wins over its full-screen 'start' (dismiss-to-title) region. The
      // OAuth dialog fires in-gesture from the pointerdown handler above.
      const bw = 380, bh = 42, bx = VW / 2 - bw / 2, by = VH - 100;
      ctx.save();
      ctx.fillStyle = 'rgba(20,10,30,0.92)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = uiTick % 44 < 34 ? '#ffe9a3' : '#ffd166';
      ctx.lineWidth = 2;
      ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
      ctx.textAlign = 'center';
      ctx.font = 'bold 15px "Courier New", monospace';
      ctx.fillStyle = '#ffd166';
      ctx.fillText('◆ SIGN IN TO PLAY MORE', VW / 2, by + 19);
      ctx.font = '11px "Courier New", monospace';
      ctx.fillStyle = '#ffffffaa';
      ctx.fillText('bank credits & XP · unlock ranked · +10 free daily', VW / 2, by + 34);
      ctx.restore();
      tapZone(bx, by, bw, bh, 'signin');
    }
    const dismiss = pressedThisFrame.has('Enter') || pressedThisFrame.has('Space')
      || pressedThisFrame.has('Escape') || taps.has('start');
    if (gameOverAge > 600 || (dismiss && gameOverAge > 30)) endArcade();
  }

  // The arcade overlay belongs to the match only — push the screen this frame
  // ended on, so it appears/disappears in lockstep with what was just drawn.
  setTouchScreen(screen);
  // …and whether the phone's SPECIAL button has a bar to spend. Same source of
  // truth as the brand badge's charged glow (drawHud), so the two cues can
  // never disagree about whether the super is available.
  setTouchCharged(screen === 'fight' && !!game && autoSpecialCharged(game.fighters[localSide()]));

  // The ambient menu video is invisible during fights but its decoder keeps
  // running — on a memory-tight phone that headroom matters (iOS jetsam guard,
  // same fix family as the audio-cache eviction). Pause in-fight, resume on
  // menus. Edge-triggered; play() is a promise that can reject on iOS, hence
  // the silent catch (a paused backdrop just falls back to the static stage).
  const wantVideo = screen !== 'fight';
  if (bgVideoRef && wantVideo !== bgVideoPlaying) {
    bgVideoPlaying = wantVideo;
    if (wantVideo) bgVideoRef.el.play().catch(() => { /* gesture-gated — retried by chrome.ts */ });
    else bgVideoRef.el.pause();
  }

  pressedThisFrame.clear();
  taps.clear();
};

// ---------------------------------------------------------------- loop
let last = performance.now();
let acc = 0;

// Perf overlay (F): live FPS (rAF cadence), frame cost (sim+render ms), and
// the netcode stall counter — the triage tool for "the game feels slow":
// low FPS = this machine/browser; high ms/f = our renderer; stalls = network.
let perfShow = false;
let perfFps = 60;
let perfMs = 0;
// F toggles perf — except on MY AGENT, where F = CREATE AGENT FIGHTER.
addEventListener('keydown', (e) => {
  if (e.code === 'KeyF' && screen !== 'agent') perfShow = !perfShow;
});

// Touch path to the same overlay (no keyboard on mobile): 3 quick taps in
// the top-right corner of the canvas. Passive observer — game input never
// routes through this, and the corner is dead HUD space during fights.
let perfTaps = 0;
let perfTapAt = 0;
ctx.canvas.addEventListener('pointerdown', (e) => {
  const r = ctx.canvas.getBoundingClientRect();
  if (r.width === 0 || e.clientX - r.left < r.width * 0.85 || e.clientY - r.top > r.height * 0.15) return;
  const now = performance.now();
  perfTaps = now - perfTapAt < 600 ? perfTaps + 1 : 1;
  perfTapAt = now;
  if (perfTaps >= 3) { perfShow = !perfShow; perfTaps = 0; }
});

const drawPerf = (): void => {
  const stalled = net ? net.stalled : 0;
  // ping = RTT to the relay (netplay only; solo sims locally and shows —).
  // rb last/max = rollback re-sim depth — how hard prediction is working.
  const netTxt = net
    ? `  ·  ping ${net.rtt < 0 ? '—' : `${Math.round(net.rtt)}ms`}  ·  rb ${net.lastRollback}/${net.maxRollback}  ·  stall ${stalled}`
    : '';
  const txt = `${perfFps.toFixed(0)} FPS  ·  ${perfMs.toFixed(1)} ms/f${netTxt}`;
  ctx.save();
  ctx.font = 'bold 11px "Courier New", monospace';
  ctx.textAlign = 'right';
  const w = ctx.measureText(txt).width + 14;
  ctx.fillStyle = '#000000aa';
  ctx.fillRect(VW - w - 6, VH - 40, w, 18);
  ctx.fillStyle = perfFps > 55 ? '#7ee85a' : perfFps > 40 ? '#ffd166' : '#ff6b6b';
  ctx.fillText(txt, VW - 13, VH - 27);
  ctx.restore();
};

const loop = (now: number): void => {
  const rafDt = now - last;
  acc = Math.min(acc + rafDt, 200); // tab-switch guard
  last = now;
  perfFps += ((1000 / Math.max(1, rafDt)) - perfFps) * 0.05; // EMA
  const t0 = performance.now();
  try {
    // Count the fixed-timestep ticks owed this rAF, then advance + render ONCE
    // (frame loops the sim internally). Rendering once per SIM TICK — up to 12
    // per rAF at the 200ms cap — was the CT-2 catch-up spiral (audit 2026-07-20).
    let steps = 0;
    while (acc >= TICK_MS) { acc -= TICK_MS; steps++; }
    if (steps > 0) {
      frame(steps);
      perfMs += (performance.now() - t0 - perfMs) * 0.1; // EMA
    } else if (screen === 'loading') {
      frame(1); // keep the loading screen painted while nothing else advances
    }
    if (perfShow) drawPerf();
  } catch (err) {
    acc = 0; // don't re-enter a throwing frame repeatedly within one catch-up burst
    reportClientError('loop', err);
  }
  // ALWAYS re-arm the loop. A single thrown exception must never skip this and
  // freeze the game permanently (audit 2026-07-20 CT-1); a transient throw
  // self-heals on the next frame instead of killing the canvas.
  requestAnimationFrame(loop);
};

void boot();
requestAnimationFrame(loop);

/**
 * Console/automation hooks. `afStep(n)` advances exactly n frames without
 * rAF — the hook automated visual tests and headless screenshots drive
 * (browsers throttle rAF to zero in hidden tabs). Replay export lands here
 * later; the input log is already the full match record.
 */
Object.assign(globalThis, {
  afGame: () => game,
  afRosters: () => allRosters,
  afScreen: () => screen,
  afCam: () => ({ ...cam }),
  afStep: (n = 1) => { for (let k = 0; k < n; k++) frame(); },
  afPress: (code: string) => { pressedThisFrame.add(code); keys.add(code); },
  afRelease: (code: string) => { keys.delete(code); },
  /**
   * Queue a semantic UI action as if the canvas had been tapped there. The
   * phone overlay's SPECIAL button uses this (touch.ts) so a DOM control and a
   * canvas tapZone converge on ONE handler — the alternative, having the
   * overlay poke the sim directly, would fork the Auto-Special path and drift.
   * Drained by the next frame, exactly like a real tap.
   */
  afTap: (action: string) => { taps.add(action); },
  afMode: (m?: Mode) => { if (m) mode = m; return mode; },
  afProfile: () => ({ ...profile, lever }),
  afAccount: () => (account ? { ...account, fetch: accountFetch } : { fetch: accountFetch }),
  afSetLever: (v: number) => { lever = Math.max(-10, Math.min(10, v | 0)); saveLever(lever); },
  afNet: () => (net ? {
    status: net.status, error: net.error, setup: net.setup, result: net.result,
    stalled: net.stalled, side: net.side, oppGoneUntil: net.oppGoneUntil,
    rtt: net.rtt, rollback: net.lastRollback, maxRollback: net.maxRollback, stallTotal: net.stallTotal,
    auto: net instanceof SoloSession ? net.auto : false,
    coached: !!agentCfg,
  } : null),
  // Sever the live socket WITHOUT the leave-intent flag — simulates a wifi
  // blip so the reconnect path can be tested from the console/automation.
  afNetDrop: () => { net?.debugDrop(); },
  /**
   * AGENT ARCADE v2 run state. Exposed deliberately: the last time a new
   * field was verified live it was missing from the hooks, so the browser
   * probe read `undefined` and a working feature looked broken for ten
   * cycles. Anything automation needs to assert about a run goes HERE.
   */
  afArcade: () => (arcade ? {
    practice: arcade.practice,
    templateId: arcade.board.templateId,
    seed: arcade.board.seed,
    nodes: arcade.board.nodes.length,
    at: arcade.at,
    pending: arcade.pending,
    fights: arcade.fights,
    total: arcade.total,
    bag: { credits: arcade.bag.credits, drinks: arcade.bag.drinks.length },
    moves: successors(arcade.board, arcade.at).map((id) => {
      const n = nodeById(arcade!.board, id)!;
      return { id, kind: n.kind, charId: n.charId, exitTier: n.exitTier };
    }),
    busy: mapBusy,
    toast: mapToast,
  } : null),
});

// Actions that open an OS / OAuth surface (share sheet, clipboard, the AIR
// sign-in dialog) MUST run in the same turn as the pointer event. The menu
// frame loop drains taps one frame later, which pushes them past iOS Safari's
// user-activation window → a silent NotAllowedError / blocked popup, felt as
// "the buttons do nothing". Handle those few here, in-gesture, and delete the
// tap so the frame loop never fires it a second time.
canvas.addEventListener('pointerdown', () => {
  // Home-screen sign-in toggle: RANKED + the account tools are unreachable on
  // iPhone if this dialog can't open. (Guard on the audio dropdown so a tap
  // meant to dismiss it isn't hijacked into a login — mirrors the frame loop's
  // branch order.)
  if (screen === 'title' && !audioMenuOpen && taps.has('signin')) {
    toggleSignIn();
    taps.delete('signin');
    return;
  }
  // GUEST account-gated title actions (RANKED wager row, shop, my agent, dare)
  // open the AIR OAuth dialog — same iOS user-activation rule as the gate
  // button, so fire it in-gesture and drop the taps. AGENT ARCADE (mode:cpu),
  // rankings, and change-fighter are NOT here: guests reach those freely.
  if (screen === 'title' && !audioMenuOpen && !isSignedIn()
    && (taps.has('mode:online') || taps.has('shop') || taps.has('myagent') || taps.has('dare'))) {
    void authLogin();
    taps.delete('mode:online'); taps.delete('shop'); taps.delete('myagent'); taps.delete('dare');
    return;
  }
  // GAME OVER (guest arcade loss): the "SIGN IN TO PLAY MORE" CTA is the same
  // in-gesture OAuth surface. Any OTHER tap dismisses to the title (frame loop).
  if (screen === 'gameover' && taps.has('signin')) {
    toggleSignIn();
    taps.delete('signin');
    return;
  }
  // MY AGENT: copying the freshly minted coach key is a clipboard write —
  // same iOS user-activation rule as the share sheet (see block comment).
  if (screen === 'agent' && taps.has('agent:copykey') && mintedKey) {
    void navigator.clipboard?.writeText(mintedKey)
      .then(() => { keyCopiedAge = 0; })
      .catch(() => { window.prompt('COPY YOUR COACH KEY:', mintedKey); keyCopiedAge = 0; });
    taps.delete('agent:copykey');
    return;
  }
  if (screen !== 'invite') return;
  if (taps.has('copydare')) {
    shareDare();
    taps.delete('copydare'); // frame handler must not fire a second share
  } else if (taps.has('challenge') && account?.refCode) {
    const code = account.refCode;
    void navigator.clipboard
      ?.writeText(`${location.origin}/?room=${encodeURIComponent(code)}&ref=${encodeURIComponent(code)}`)
      .catch(() => { /* lobby shows the room code as fallback */ });
    startFriendly(code);
    taps.delete('challenge');
  }
});

// Mobile: auto-detect touch devices and lay the on-screen controls over the
// canvas; register the PWA + offer install on the first landing. Both are
// no-ops on desktop / when already installed. Runs after afScreen (above) is
// exposed so the overlay can sync its visibility to the current game screen.
initPwa();
initTouchControls();
