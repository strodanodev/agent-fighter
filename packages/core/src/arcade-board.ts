/**
 * AGENT ARCADE v2 — board GENERATION (ADR 0008).
 *
 * Lives in `@af/core` for the same reason `items.ts` does: it is pure data
 * plus pure functions that BOTH ends need. In a ranked run the server is the
 * only authority — it picks the seed, keeps the board, and validates every
 * move against its own copy — but the client also needs to generate boards
 * outright for the guest/offline PRACTICE gauntlet, which never touches a
 * server. One generator, one set of templates, no drift.
 *
 * The sim never reads any of this: no GameState field, no ENGINE_VERSION
 * bump, goldens untouched. `seed` is a REQUIRED argument precisely so this
 * module stays free of ambient randomness (see core's determinism guards).
 *
 * ## The shape, and why it is this shape
 *
 * Every board is a **spine + spurs** DAG. The SPINE is the mandatory line —
 * region gatekeepers and exit guards — and it is what pins the 2 / 4 / 7
 * fight floors. A SPUR is a side loop carrying one pickup with **one extra
 * fighter standing in front of it**, rejoining the spine afterwards.
 *
 * So: **every pickup costs exactly one more fight.** That single rule is the
 * whole mode. Two earlier shapes were tried and both collapse:
 *   · loot as free lateral nodes → with no step budget, loot is free, you
 *     take all of it, and greed-vs-speed stops being a decision;
 *   · a fighter on every branch → route choice never changes the fight
 *     count, so only exit depth matters and the map is decoration.
 *
 * ## Why the spine is a fixed 7 rungs
 *
 * The rung sequence [fight, fight, GATE, fight, GATE, fight, BOSS] is not a
 * tuning value — it IS the 2 / 4 / 7 contract, and `validateBoard` asserts
 * each exit sits at EXACTLY its floor. Variety lives in the branching
 * (forks, spur count/side/length, exit sides) and in the seeded shuffle of
 * which fighter guards what and which spur holds which pickup. Templates
 * that drift the floors fail their test rather than quietly changing the
 * economy.
 */

import {
  BOARD_H, BOARD_W, EXIT_FIGHT_FLOOR, REGION_CREDITS, REGION_SKILL,
  exitNodes, isFightNode, minFights, nodeById, predecessors, successors, topoOrder,
} from './arcade-map.js';
import type { Board, BoardNode, BoardRegion, ExitTier } from './arcade-map.js';
import { ITEMS } from './items.js';

// ------------------------------------------------------------ template DSL

type Side = -1 | 1;
type PickupSpec = 'cr' | 'drink';

/** A side loop off the spine: `chain.length` guarded pickups, then rejoin. */
interface SpurSpec {
  side: Side;
  /** One entry = one (fighter → pickup) pair. Length 1 or 2. */
  chain: PickupSpec[];
}

interface RungSpec {
  spurs?: SpurSpec[];
  /** A parallel fight node on this side — pure variety, same fight cost. */
  fork?: Side;
  /** An extraction point hanging off this rung. */
  exit?: { tier: ExitTier; side: Side };
}

interface Template {
  id: string;
  /** Exactly SPINE_KINDS.length entries, bottom (start) to top (boss). */
  rungs: RungSpec[];
}

/** The mandatory line. Changing this changes the 2/4/7 contract — don't. */
const SPINE_KINDS = ['fight', 'fight', 'gate', 'fight', 'gate', 'fight', 'boss'] as const;
const SPINE_REGIONS: BoardRegion[] = [1, 1, 2, 2, 3, 3, 3];
const RUNGS = SPINE_KINDS.length;

/** Lattice geometry. Display only — the sim and the economy never read x/y. */
const SPINE_X = Math.floor(BOARD_W / 2);
const START_Y = BOARD_H - 1;
const rungY = (i: number): number => START_Y - 3 - i * 4; // 28 … 4
const EXIT3_Y = 1;

/**
 * The authored templates. Eight skeletons, all honouring the same floors.
 * Read them as a picture: rung index = how deep, `side` = which way a branch
 * leans, `chain` = how many guarded pickups deep the detour goes.
 */
const TEMPLATES: Template[] = [
  {
    id: 'scrap-run',
    rungs: [
      { spurs: [{ side: -1, chain: ['cr'] }] },
      { exit: { tier: 1, side: 1 } },
      { spurs: [{ side: 1, chain: ['drink'] }] },
      { spurs: [{ side: 1, chain: ['cr'] }], exit: { tier: 2, side: -1 } },
      { spurs: [{ side: -1, chain: ['cr'] }] },
      { spurs: [{ side: 1, chain: ['drink'] }] },
      { exit: { tier: 3, side: 1 } },
    ],
  },
  {
    id: 'twin-stacks',
    rungs: [
      { fork: -1 },
      { spurs: [{ side: 1, chain: ['cr'] }], exit: { tier: 1, side: -1 } },
      {},
      { fork: 1, spurs: [{ side: -1, chain: ['cr'] }], exit: { tier: 2, side: 1 } },
      { spurs: [{ side: -1, chain: ['drink'] }] },
      { fork: -1, spurs: [{ side: 1, chain: ['cr'] }] },
      { exit: { tier: 3, side: 1 } },
    ],
  },
  {
    id: 'deep-vault',
    rungs: [
      { spurs: [{ side: 1, chain: ['cr'] }] },
      { exit: { tier: 1, side: -1 } },
      { spurs: [{ side: -1, chain: ['cr', 'drink'] }] },
      { exit: { tier: 2, side: 1 } },
      { spurs: [{ side: 1, chain: ['cr'] }] },
      { spurs: [{ side: -1, chain: ['cr', 'drink'] }] },
      { exit: { tier: 3, side: 1 } },
    ],
  },
  {
    id: 'lean-line',
    rungs: [
      {},
      { exit: { tier: 1, side: 1 } },
      { spurs: [{ side: -1, chain: ['drink'] }] },
      { exit: { tier: 2, side: -1 } },
      {},
      { spurs: [{ side: 1, chain: ['cr'] }] },
      { exit: { tier: 3, side: 1 } },
    ],
  },
  {
    id: 'both-sides',
    rungs: [
      { spurs: [{ side: -1, chain: ['cr'] }, { side: 1, chain: ['cr'] }] },
      { exit: { tier: 1, side: 1 } },
      { spurs: [{ side: -1, chain: ['drink'] }, { side: 1, chain: ['cr'] }] },
      { exit: { tier: 2, side: -1 } },
      { spurs: [{ side: 1, chain: ['cr'] }] },
      { spurs: [{ side: -1, chain: ['drink'] }, { side: 1, chain: ['cr'] }] },
      { exit: { tier: 3, side: 1 } },
    ],
  },
  {
    id: 'gauntlet-fork',
    rungs: [
      { fork: 1 },
      { spurs: [{ side: -1, chain: ['cr'] }], exit: { tier: 1, side: 1 } },
      { fork: -1 },
      { spurs: [{ side: 1, chain: ['drink'] }], exit: { tier: 2, side: -1 } },
      { fork: 1 },
      { spurs: [{ side: -1, chain: ['cr', 'drink'] }] },
      { exit: { tier: 3, side: 1 } },
    ],
  },
  {
    id: 'core-rush',
    rungs: [
      { spurs: [{ side: 1, chain: ['cr'] }] },
      { exit: { tier: 1, side: -1 } },
      {},
      { spurs: [{ side: -1, chain: ['cr'] }], exit: { tier: 2, side: 1 } },
      { spurs: [{ side: -1, chain: ['drink'] }, { side: 1, chain: ['cr'] }] },
      { spurs: [{ side: 1, chain: ['cr', 'drink'] }] },
      { exit: { tier: 3, side: 1 } },
    ],
  },
  {
    id: 'the-long-way',
    rungs: [
      { spurs: [{ side: -1, chain: ['cr'] }] },
      { fork: 1, exit: { tier: 1, side: -1 } },
      { spurs: [{ side: 1, chain: ['cr'] }] },
      { spurs: [{ side: -1, chain: ['drink'] }], exit: { tier: 2, side: 1 } },
      { fork: -1 },
      { spurs: [{ side: 1, chain: ['cr'] }, { side: -1, chain: ['drink'] }] },
      { exit: { tier: 3, side: 1 } },
    ],
  },
];

export const templateIds = (): string[] => TEMPLATES.map((t) => t.id);

// ------------------------------------------------------------------- rng

/**
 * xorshift32 — seeded, dependency-free, and deliberately NOT Math.random:
 * a board must be exactly reproducible from (templateId, seed) so a support
 * question or a test can rebuild the exact run a player saw.
 */
const rng = (seed: number): (() => number) => {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x1_0000_0000;
  };
};

const shuffled = <T>(items: readonly T[], rand: () => number): T[] => {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/**
 * AI skill for a rung: interpolated across ITS REGION's band, so difficulty
 * tracks DEPTH rather than how many optional fights the player has taken.
 * A long, safe, low-tier detour must never be free money.
 */
const rungSkill = (i: number): number => {
  const region = SPINE_REGIONS[i]!;
  const first = SPINE_REGIONS.indexOf(region);
  const last = SPINE_REGIONS.lastIndexOf(region);
  const [lo, hi] = REGION_SKILL[region];
  const t = last === first ? 1 : (i - first) / (last - first);
  return Math.round(lo + (hi - lo) * t);
};

/** Board drinks roll HERE, at generation — never in the sim (ADR 0007). */
const rollDrink = (region: BoardRegion, rand: () => number): { itemId: string; tier: number } => {
  const tier = region === 1 ? 1
    : region === 2 ? (rand() < 0.7 ? 1 : 2)
    : (rand() < 0.6 ? 2 : 3);
  const pool = ITEMS.filter((i) => i.tier === tier);
  const def = pool[Math.floor(rand() * pool.length)] ?? ITEMS[0]!;
  return { itemId: def.id, tier: def.tier };
};

// ------------------------------------------------------------- generation

export interface GenerateOptions {
  /** Enabled roster ids MINUS the player's fighter. */
  roster: string[];
  /**
   * REQUIRED. Everything downstream is derived from it, so a board is exactly
   * reproducible from (templateId, seed) — a support question or a test can
   * rebuild the precise run a player saw. Required rather than defaulted
   * because core must not reach for ambient randomness (determinism guards).
   */
  seed: number;
  /** Force a template. Default: picked from the seed. */
  templateId?: string;
}

/**
 * Stamp one run's board. Throws if the produced graph fails validation —
 * a template bug must be loud at generation time, never a silently
 * unwinnable (or silently free) run in a player's hands.
 */
export const generateBoard = (opts: GenerateOptions): Board => {
  const seed = opts.seed | 0;
  const rand = rng(seed);
  const template = opts.templateId
    ? TEMPLATES.find((t) => t.id === opts.templateId)
    : TEMPLATES[Math.floor(rand() * TEMPLATES.length)];
  if (!template) throw new Error(`unknown arcade template "${opts.templateId}"`);

  const nodes: BoardNode[] = [];
  const edges: [number, number][] = [];
  const add = (n: Omit<BoardNode, 'id'>): number => {
    nodes.push({ ...n, id: nodes.length });
    return nodes.length - 1;
  };
  const link = (from: number, to: number): void => { edges.push([from, to]); };

  const start = add({ x: SPINE_X, y: START_Y, kind: 'start', region: 1 });

  /** Nodes you can be standing on at rung i (spine + optional fork). */
  const rungEntries: number[][] = [];
  /**
   * Spurs hanging off rung i: enter at `head`, rejoin the next rung from any
   * `tail`. EVERY pickup in a chain is a tail, not just the last one — a
   * 2-deep spur must let you bank the first pickup and bail back to the
   * spine, or "go one deeper?" stops being a decision and becomes a trap.
   */
  const rungSpurs: { head: number; tails: number[] }[][] = [];
  /** The exit hanging off rung i, if any. */
  const rungExit: (number | null)[] = [];

  for (let i = 0; i < RUNGS; i++) {
    const spec = template.rungs[i] ?? {};
    const region = SPINE_REGIONS[i]!;
    const skill = rungSkill(i);
    const y = rungY(i);

    const entries: number[] = [
      add({ x: SPINE_X, y, kind: SPINE_KINDS[i]!, region, skill }),
    ];
    if (spec.fork !== undefined) {
      entries.push(add({ x: SPINE_X + spec.fork * 5, y, kind: 'fight', region, skill }));
    }
    rungEntries.push(entries);

    // Spurs: a chain of (fighter → pickup) pairs that rejoins the next rung.
    // Geometry is fixed per chain length so nothing overlaps — validateBoard
    // asserts coordinate uniqueness, so a bad offset fails loudly.
    const spurs: { head: number; tails: number[] }[] = [];
    for (const spur of spec.spurs ?? []) {
      const s = spur.side;
      const single = spur.chain.length === 1;
      const tails: number[] = [];
      let head = -1;
      let prevLoot = -1;
      spur.chain.forEach((pickup, k) => {
        const fx = SPINE_X + s * (single ? 7 : k === 0 ? 6 : 13);
        const fy = y - (single ? 1 : k === 0 ? 1 : 3);
        const lx = SPINE_X + s * (single ? 11 : k === 0 ? 10 : 9);
        const ly = y - (single ? 3 : k === 0 ? 2 : 4);
        const fight = add({ x: fx, y: fy, kind: 'fight', region, skill });
        const loot = add({
          x: lx, y: ly, kind: 'loot', region,
          loot: pickup === 'cr'
            ? { kind: 'credits', amount: REGION_CREDITS[region] }
            : { kind: 'drink', ...rollDrink(region, rand) },
        });
        link(fight, loot);
        if (prevLoot >= 0) link(prevLoot, fight);
        if (head < 0) head = fight;
        prevLoot = loot;
        tails.push(loot);
      });
      if (head >= 0) spurs.push({ head, tails });
    }
    rungSpurs.push(spurs);

    rungExit.push(spec.exit
      ? add({
        x: spec.exit.tier === 3 ? SPINE_X : SPINE_X + spec.exit.side * 11,
        y: spec.exit.tier === 3 ? EXIT3_Y : y - 2,
        kind: 'exit', region, exitTier: spec.exit.tier,
      })
      : null);
  }

  // ---- wire it up. A rung's fight nodes lead to: the next rung, this
  // rung's spur heads, and this rung's exit. Spur tails rejoin the next rung.
  for (const e of rungEntries[0]!) link(start, e);
  for (let i = 0; i < RUNGS; i++) {
    const next = rungEntries[i + 1];
    const ex = rungExit[i];
    for (const from of rungEntries[i]!) {
      if (next) for (const to of next) link(from, to);
      for (const spur of rungSpurs[i]!) link(from, spur.head);
      if (ex !== null && ex !== undefined) link(from, ex);
    }
    if (next) {
      for (const spur of rungSpurs[i]!) for (const t of spur.tails) for (const to of next) link(t, to);
    }
  }

  // ---- populate the fighters. Shuffled roster, no repeats until it runs out.
  const pool = opts.roster.length > 0 ? shuffled(opts.roster, rand) : [];
  let pick = 0;
  for (const n of nodes) {
    if (!isFightNode(n)) continue;
    n.charId = pool.length > 0 ? pool[pick++ % pool.length]! : '';
  }

  const board: Board = { templateId: template.id, seed, nodes, edges, start };
  const problems = validateBoard(board);
  if (problems.length > 0) {
    throw new Error(`arcade template "${template.id}" produced an invalid board:\n  ${problems.join('\n  ')}`);
  }
  return board;
};

// ------------------------------------------------------------- validation

/**
 * Structural audit of a generated board. Returns human-readable problems;
 * empty means the board honours every rule the economy depends on.
 *
 * These are not style checks. Each one, if violated, breaks real money:
 * a cycle lets a player farm one loot node forever; an unguarded pickup is
 * a credit printer; a short path to a deep exit sells 18 credits for two
 * fights.
 */
export const validateBoard = (b: Board): string[] => {
  const problems: string[] = [];
  const say = (m: string): void => { problems.push(m); };

  // ---- ids, coordinates, uniqueness
  const seenIds = new Set<number>();
  const seenXY = new Set<string>();
  for (const n of b.nodes) {
    if (seenIds.has(n.id)) say(`duplicate node id ${n.id}`);
    seenIds.add(n.id);
    if (n.x < 0 || n.x >= BOARD_W || n.y < 0 || n.y >= BOARD_H) {
      say(`node ${n.id} is off the ${BOARD_W}×${BOARD_H} lattice at (${n.x},${n.y})`);
    }
    const xy = `${n.x},${n.y}`;
    if (seenXY.has(xy)) say(`two nodes occupy (${xy}) — they would draw on top of each other`);
    seenXY.add(xy);
  }
  for (const [from, to] of b.edges) {
    if (!seenIds.has(from) || !seenIds.has(to)) say(`edge ${from}→${to} references a missing node`);
    if (from === to) say(`node ${from} links to itself`);
  }

  // ---- it must be a DAG: backtracking would make loot farmable
  const order = topoOrder(b);
  if (!order) {
    say('board contains a cycle — one-way progression is what makes loot finite');
    return problems; // every check below assumes a DAG
  }

  // ---- reachability + no dead ends
  const reached = new Set<number>([b.start]);
  for (const id of order) {
    if (!reached.has(id)) continue;
    for (const s of successors(b, id)) reached.add(s);
  }
  for (const n of b.nodes) {
    if (!reached.has(n.id)) say(`node ${n.id} (${n.kind}) is unreachable from the start`);
    if (n.kind !== 'exit' && successors(b, n.id).length === 0) {
      say(`node ${n.id} (${n.kind}) is a dead end — only exits may terminate`);
    }
    if (isFightNode(n) && (n.skill === undefined || n.skill <= 0)) {
      say(`fight node ${n.id} has no skill`);
    }
  }

  // ---- THE rule: every pickup is guarded
  for (const n of b.nodes) {
    if (n.kind !== 'loot') continue;
    if (!n.loot) { say(`loot node ${n.id} carries nothing`); continue; }
    const preds = predecessors(b, n.id);
    if (preds.length === 0) say(`loot node ${n.id} has no predecessor`);
    for (const p of preds) {
      const pn = nodeById(b, p);
      if (!pn || !isFightNode(pn)) {
        say(`loot node ${n.id} can be reached without a fight (via ${p}) — free credits`);
      }
    }
    if (successors(b, n.id).length === 0) say(`loot node ${n.id} does not rejoin the board`);
  }

  // ---- the 2 / 4 / 7 contract, asserted EXACTLY
  const exits = exitNodes(b);
  const tiers = new Set(exits.map((e) => e.exitTier));
  for (const tier of [1, 2, 3] as ExitTier[]) {
    if (!tiers.has(tier)) say(`board has no tier-${tier} exit`);
  }
  for (const e of exits) {
    const tier = e.exitTier as ExitTier;
    const floor = EXIT_FIGHT_FLOOR[tier];
    const got = minFights(b, b.start, e.id);
    if (got !== floor) {
      say(`exit tier ${tier} sits ${got} fights from the start — the contract is exactly ${floor}`);
    }
  }

  // ---- the boss guards the deep exit, and nothing else does
  const boss = b.nodes.filter((n) => n.kind === 'boss');
  if (boss.length !== 1) say(`expected exactly 1 boss node, found ${boss.length}`);
  const deep = exits.find((e) => e.exitTier === 3);
  if (boss[0] && deep && !predecessors(b, deep.id).includes(boss[0].id)) {
    say('the tier-3 exit is not behind the boss');
  }

  return problems;
};

/**
 * Validate every authored template at boot (cheap — eight small graphs). A
 * template that drifts out of contract should stop the server, not quietly
 * mis-price a run. Returns problems keyed by template id.
 */
export const validateAllTemplates = (roster: string[]): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const t of TEMPLATES) {
    try {
      const b = generateBoard({ roster, templateId: t.id, seed: 12345 });
      const p = validateBoard(b);
      if (p.length > 0) out[t.id] = p;
    } catch (e) {
      out[t.id] = [String(e instanceof Error ? e.message : e)];
    }
  }
  return out;
};
