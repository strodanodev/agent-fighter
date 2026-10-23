/**
 * ARCADE MATCHES NEVER RUN ON THE RELAY (ADR 0014).
 *
 * An arcade-placed match (`LIT-…` room) is played on the gauntlet of the host
 * the mesh placed it on, where the node's seat tickets prove both keys and the
 * signed log goes to the node. The always-on relay used to host such a room as
 * a casual fallback; it shares the gauntlet's machine and tunnel, so it added
 * no uptime and only turned failed ranked matches into silent casual ones. The
 * relay now turns the room away, and nothing it archives names a mesh key.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryPersistence } from '../src/persist.js';
import { createMatchServer } from '../src/server.js';
import { playOneMatch } from '../src/agent-session.js';

const here = dirname(fileURLToPath(import.meta.url));
const charactersDir = join(here, '..', '..', '..', 'characters');

test('the relay turns away an arcade-placed room', async (t) => {
  const server = await createMatchServer({ port: 0, persistence: memoryPersistence(), noPaceCheck: true });
  t.after(() => server.close());
  const room = `LIT-${randomBytes(16).toString('hex').toUpperCase()}`;
  await assert.rejects(
    playOneMatch({ url: `ws://127.0.0.1:${server.port}`, name: 'ARCADE', character: 'analog', skill: 70, charactersDir, aiSeed: 1, paceMs: 1, mode: 'friendly', room, playerKey: randomBytes(32).toString('hex') }),
    /arcade matches are played on the host/,
    'no casual fallback room is opened',
  );
});
