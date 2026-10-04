/**
 * Entry point a litnode node spawns for one placed Agent Fighter match (gauntlet.ts says what that means).
 *
 *   node <checkout>/node_modules/tsx/dist/cli.mjs <checkout>/packages/server/src/gauntlet-server.ts
 *
 * with the node's GAUNTLET_* environment. Listens on GAUNTLET_PORT (the node's gateway proxies
 * wss://<host>/<room> to it), seats the two placed players, plays the match, hands the result to the
 * node, and exits. The node also ends it when the match settles, or at its time to live.
 */
import { createMatchServer } from './server.js';
import { gauntletFromEnv } from './gauntlet.js';

const g = gauntletFromEnv();
const port = Number(process.env.GAUNTLET_PORT ?? process.env.PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error('gauntlet: GAUNTLET_PORT is not set');

let server: Awaited<ReturnType<typeof createMatchServer>> | null = null;
const exit = (code: number): void => {
  setTimeout(() => process.exit(code), 10_000).unref(); // a drain that hangs must not hold the port
  void (server?.shutdown() ?? Promise.resolve()).finally(() => process.exit(code));
};

server = await createMatchServer({
  port,
  persistence: null,
  // The wall-clock pace checks protect an economy from tool-assisted play; a gauntlet has none. Only the
  // node's gauntlet config can set this (an end-to-end test whose bots play faster than real time).
  noPaceCheck: process.env.AF_NO_PACE_CHECK === '1',
  gauntlet: {
    ...g,
    onDone: (o) => {
      console.log(`[gauntlet] ${o.posted ? 'settled by the node' : `not settled (${o.error ?? o.status ?? 'no answer'})`}; exiting`);
      setTimeout(() => exit(o.posted ? 0 : 1), 2000).unref();
    },
  },
});
console.log(`[gauntlet] agent-fighter match ${g.matchId.slice(0, 12)} (${g.placedMode}) on :${server.port} · room ${g.room} · seats ${g.seats.map((s) => s.sub.slice(0, 8)).join(' v ')}`);

process.on('SIGTERM', () => exit(0));
process.on('SIGINT', () => exit(0));
// One match per process: a stray error must not end the match it is serving.
process.on('unhandledRejection', (reason) => console.error('[gauntlet] unhandledRejection (kept alive):', reason));
process.on('uncaughtException', (err) => console.error('[gauntlet] uncaughtException (kept alive):', err));
