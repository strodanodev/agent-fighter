/**
 * AGENT ARCADE v2 — the gauntlet map (ADR 0008). PURE DATA + PURE GRAPH MATH.
 *
 * This module is the shared vocabulary for the arcade board: the server
 * GENERATES boards (packages/server/src/arcade-board.ts — templates, seeded
 * shuffling, validation) and the client RENDERS them and shows route stats.
 * Both ends need the same types and the same route arithmetic, and
 * `@af/core` is the only package both already depend on — exactly the
 * precedent `items.ts` set (data the sim never reads, living in core because
 * everyone shares it).
 *
 * THE SIM NEVER READS ANY OF THIS. No GameState field, no input bit, no
 * ENGINE_VERSION bump, goldens untouched. A board decides WHICH matches get
 * played, never what happens inside one.
 *
 * Nothing here is random or stateful: every function is a pure query over a
 * Board the caller already has. The server is the only authority on where a
 * player actually IS (`ArcadeRun.at`) and what they picked up — the client's
 * copy of the board is for drawing and for arithmetic it is welcome to get
 * wrong, because the server never reads it back.
 */

/** Lattice size. 32 × 32 is the board's coordinate space, not its node count. */
export const BOARD_W = 32;
export const BOARD_H = 32;

/**
 * What sits on a node.
 *  · start — where the run begins (never a fight)
 *  · fight — a roster fighter guarding this step
 *  · gate  — a fighter guarding the entrance to the NEXT region
 *  · boss  — the Core warden; the only way to EXIT 3
 *  · loot  — credits or an energy drink (ALWAYS preceded by a fight — see
 *            validateBoard: free loot is a credit printer)
 *  · exit  — an extraction point; reaching one banks the run bag
 */
export type BoardNodeKind = 'start' | 'fight' | 'gate' | 'boss' | 'loot' | 'exit';

export type BoardRegion = 1 | 2 | 3;
export type ExitTier = 1 | 2 | 3;

/** Zone names + AI skill bands. Skill ramps by DEPTH, never by fight count —
 *  otherwise a long, safe, low-tier detour would be free money. */
export const REGION_NAME: Record<BoardRegion, string> = {
  1: 'SCRAPYARD ROW',
  2: 'THE STACKS',
  3: 'THE CORE',
};
export const REGION_SKILL: Record<BoardRegion, readonly [number, number]> = {
  1: [35, 50],
  2: [50, 70],
  3: [70, 95],
};

/** Base extraction bonus by exit tier (ADR 0008: 2 / 8 / 18). */
export const EXIT_BONUS: Record<ExitTier, number> = { 1: 2, 2: 8, 3: 18 };

/**
 * The fight FLOOR each exit must sit behind. This is the contract the whole
 * mode rests on — every template is validated against it, so "2 / 4 / 7
 * fights" is a structural guarantee, not a tuning value someone can drift.
 */
export const EXIT_FIGHT_FLOOR: Record<ExitTier, number> = { 1: 2, 2: 4, 3: 7 };

/** Credits in one pile, by region. */
export const REGION_CREDITS: Record<BoardRegion, number> = { 1: 2, 2: 6, 3: 12 };

/** Loot carried by a node. Exactly one of these. */
export type BoardLoot =
  | { kind: 'credits'; amount: number }
  | { kind: 'drink'; itemId: string; tier: number };

/**
 * A STABLE identity guarding a fight node (ADR 0009 step 3): a real coached
 * agent — fleet persona or another player's trained agent — with a name and
 * a record, instead of an anonymous archetype. Assigned server-side at board
 * generation ("casting"); PURE DATA the sim never reads. `personality` is the
 * clamped style pin the server will install for this bout — it reaches the
 * client at match time anyway (the client sims locally per ADR 0008), so
 * carrying it on the board leaks nothing new. `id` is the public profile id,
 * the same one leaderboard/agent_roster already expose.
 */
export interface BoardAgent {
  id: string;
  name: string;
  level: number;
  wins: number;
  losses: number;
  motto?: string;
  personality?: Record<string, number>;
}

export interface BoardNode {
  id: number;
  /** Lattice position, 0..BOARD_W-1 / 0..BOARD_H-1. Display only. */
  x: number;
  y: number;
  kind: BoardNodeKind;
  region: BoardRegion;
  /** fight | gate | boss: the roster character standing here. */
  charId?: string;
  /** fight | gate | boss: the AI skill for this bout (region band). */
  skill?: number;
  /**
   * fight | gate | boss: the stable identity standing here. Absent = the
   * anonymous archetype (pre-stable behavior, and the empty-stable fallback).
   * Identity supplies NAME + STYLE; `skill` above keeps supplying difficulty
   * (ADR 0009: a LV40 agent guarding a region-1 node is still a region-1
   * fight — the ladder must never eat the difficulty curve).
   */
  agent?: BoardAgent;
  /** loot: what you pick up by stepping here. */
  loot?: BoardLoot;
  /** exit: which extraction point this is. */
  exitTier?: ExitTier;
}

export interface Board {
  /** Which authored template this board was stamped from (forensics + tests). */
  templateId: string;
  /** The generation seed — a board is fully reproducible from it. */
  seed: number;
  nodes: BoardNode[];
  /** DIRECTED edges. The board is a DAG: you never backtrack. */
  edges: [number, number][];
  /** Node id the run starts on. */
  start: number;
}

/** True when standing on this node costs a match. */
export const isFightNode = (n: BoardNode): boolean =>
  n.kind === 'fight' || n.kind === 'gate' || n.kind === 'boss';

export const nodeById = (b: Board, id: number): BoardNode | undefined =>
  b.nodes.find((n) => n.id === id);

/** Node ids reachable in ONE step from `from` — the legal moves. */
export const successors = (b: Board, from: number): number[] =>
  b.edges.filter(([a]) => a === from).map(([, to]) => to);

/** Node ids with an edge INTO `to`. */
export const predecessors = (b: Board, to: number): number[] =>
  b.edges.filter(([, t]) => t === to).map(([f]) => f);

/** Is this move legal? The server asks this before applying any pickup. */
export const isLegalMove = (b: Board, from: number, to: number): boolean =>
  b.edges.some(([a, t]) => a === from && t === to);

/**
 * Topological order (parents before children). Returns null if the graph has
 * a cycle — which validateBoard treats as a hard template bug, because the
 * whole no-backtracking economy assumes a DAG (a cycle would let a player
 * farm the same loot node forever).
 */
export const topoOrder = (b: Board): number[] | null => {
  const indeg = new Map<number, number>();
  for (const n of b.nodes) indeg.set(n.id, 0);
  for (const [, to] of b.edges) indeg.set(to, (indeg.get(to) ?? 0) + 1);
  const queue = b.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const out: number[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    out.push(id);
    for (const s of successors(b, id)) {
      const d = (indeg.get(s) ?? 0) - 1;
      indeg.set(s, d);
      if (d === 0) queue.push(s);
    }
  }
  return out.length === b.nodes.length ? out : null;
};

/** One route's cost/reward summary, as shown on the map screen. */
export interface RouteStat {
  /** Fights between here and there, taking the cheapest line. */
  fights: number;
  /** Credits pickable on the cheapest line (NOT the max — see bestLoot). */
  credits: number;
  /** Drinks pickable on the cheapest line. */
  drinks: number;
  /** False when there is no path at all. */
  reachable: boolean;
}

const EMPTY_ROUTE: RouteStat = { fights: 0, credits: 0, drinks: 0, reachable: false };

/**
 * One forward DP pass over the DAG from `from`: for every reachable node,
 * the cheapest-in-fights route to it and the predecessor that achieved it.
 * Ties break toward MORE loot — of two equally short lines the player would
 * obviously take the richer one, so that is the one worth quoting.
 *
 * Display only. The server recomputes nothing from this; it just walks the
 * moves the player actually makes.
 */
const solveFrom = (b: Board, from: number): Map<number, { stat: RouteStat; prev: number }> => {
  const out = new Map<number, { stat: RouteStat; prev: number }>();
  const order = topoOrder(b);
  if (!order) return out;
  out.set(from, { stat: { fights: 0, credits: 0, drinks: 0, reachable: true }, prev: -1 });
  let seenFrom = false;
  for (const id of order) {
    if (id === from) { seenFrom = true; continue; }
    if (!seenFrom) continue; // nodes before `from` in topo order are behind us
    const node = nodeById(b, id);
    if (!node) continue;
    let acc: { stat: RouteStat; prev: number } | null = null;
    for (const p of predecessors(b, id)) {
      const prev = out.get(p);
      if (!prev?.stat.reachable) continue;
      const stat: RouteStat = {
        reachable: true,
        fights: prev.stat.fights + (isFightNode(node) ? 1 : 0),
        credits: prev.stat.credits + (node.loot?.kind === 'credits' ? node.loot.amount : 0),
        drinks: prev.stat.drinks + (node.loot?.kind === 'drink' ? 1 : 0),
      };
      const better = !acc
        || stat.fights < acc.stat.fights
        || (stat.fights === acc.stat.fights
          && stat.credits + stat.drinks * 5 > acc.stat.credits + acc.stat.drinks * 5);
      if (better) acc = { stat, prev: p };
    }
    if (acc) out.set(id, acc);
  }
  return out;
};

/** Cheapest-in-fights route from `from` to `to`, and what it collects. */
export const routeTo = (b: Board, from: number, to: number): RouteStat =>
  solveFrom(b, from).get(to)?.stat ?? EMPTY_ROUTE;

/**
 * The actual node sequence of that cheapest route, `from` exclusive and `to`
 * inclusive. Empty when unreachable. The map screen highlights this; a
 * player following it step by step walks exactly the quoted fight count.
 */
export const pathTo = (b: Board, from: number, to: number): number[] => {
  const solved = solveFrom(b, from);
  if (!solved.get(to)?.stat.reachable) return [];
  const out: number[] = [];
  for (let id = to; id !== from && id >= 0;) {
    out.unshift(id);
    const step: number | undefined = solved.get(id)?.prev;
    if (step === undefined || step < 0) break;
    id = step;
  }
  return out;
};

/**
 * Fewest fights from `from` to `to`, or -1 when unreachable. The validator's
 * workhorse: every exit's floor is asserted against this.
 */
export const minFights = (b: Board, from: number, to: number): number => {
  const r = routeTo(b, from, to);
  return r.reachable ? r.fights : -1;
};

/** Every exit node, shallowest first. */
export const exitNodes = (b: Board): BoardNode[] =>
  b.nodes.filter((n) => n.kind === 'exit').sort((a, c) => (a.exitTier ?? 0) - (c.exitTier ?? 0));

/**
 * The map screen's headline numbers: for each exit, what it costs from where
 * the player is standing right now. Unreachable exits (already routed past)
 * come back with reachable:false so the UI can grey them out — a real state,
 * since the board is one-way.
 */
export const exitRoutes = (b: Board, from: number): { node: BoardNode; route: RouteStat }[] =>
  exitNodes(b).map((node) => ({ node, route: routeTo(b, from, node.id) }));

/** Total credits sitting on the board (balance sanity + the run summary). */
export const boardCredits = (b: Board): number =>
  b.nodes.reduce((sum, n) => sum + (n.loot?.kind === 'credits' ? n.loot.amount : 0), 0);
