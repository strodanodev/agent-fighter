/**
 * BOSS MONSTER + BOSS STAGE (Studio toggles, v1.0.3.bossfight).
 *
 * The contract under test:
 *  - a character with `meta.boss` guards the board's BOSS NODE instead of a
 *    shuffled roster fighter, and appears NOWHERE else on the board;
 *  - boss monsters are never playable — the server refuses to queue one in
 *    any mode, whatever a hand-rolled client claims;
 *  - a stage with `boss: true` in stage.json sits out the normal per-match
 *    rotation and is pinned for the boss-node fight;
 *  - with no boss authored, everything behaves exactly as before (covered by
 *    the untouched arcade.test.ts suite running against the real roster).
 *
 * Runs against a THROWAWAY root (temp characters/ + stages/) so the repo's
 * real roster never needs a boss character for the suite to stay green.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  ENGINE_VERSION, Phase, aiPoll, createAi, createGameState, exitNodes,
  generateBoard, isFightNode, loadCharacter, nodeById, pathTo, setCharacters,
  step, templateIds, validateBoard,
} from '@af/core';
import type { Board, CharacterBundle } from '@af/core';
import { memoryPersistence } from '../src/persist.js';
import { createMatchServer } from '../src/server.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { SMatch, ServerMsg } from '../src/protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const realCharactersDir = join(here, '..', '..', '..', 'characters');

// ---------------------------------------------------------------- fixture root

/** Real enabled character ids (the fixtures copy real bundles — loadCharacter
 *  must accept them, so inventing minimal ones would test the wrong thing). */
const realEnabledIds = (): string[] =>
  readdirSync(realCharactersDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(realCharactersDir, d.name, 'character.json')))
    .map((d) => d.name)
    .filter((id) => {
      const meta = (JSON.parse(readFileSync(join(realCharactersDir, id, 'character.json'), 'utf8')) as {
        meta?: { disabled?: boolean; boss?: boolean };
      }).meta;
      return !meta?.disabled && !meta?.boss;
    });

/**
 * Build a throwaway repo root: 3 normal fighters copied from the real roster,
 * one of them re-minted as the boss monster "warden" (meta.boss), plus one
 * rotation stage and one boss stage.
 */
const makeFixtureRoot = (): { root: string; roster: string[] } => {
  const root = mkdtempSync(join(tmpdir(), 'af-boss-'));
  const src = realEnabledIds().slice(0, 3);
  assert.ok(src.length >= 2, 'the repo roster has at least two enabled fighters');
  for (const id of src) {
    mkdirSync(join(root, 'characters', id), { recursive: true });
    writeFileSync(
      join(root, 'characters', id, 'character.json'),
      readFileSync(join(realCharactersDir, id, 'character.json')),
    );
  }
  // The warden: a real bundle wearing the boss flag (sprites are irrelevant
  // server-side; the sim pins only frame data, which the copy carries whole).
  const wardenBase = JSON.parse(
    readFileSync(join(realCharactersDir, src[0]!, 'character.json'), 'utf8'),
  ) as CharacterBundle & { meta?: Record<string, unknown>; name: string };
  wardenBase.name = 'THE WARDEN';
  wardenBase.meta = { ...(wardenBase.meta ?? {}), boss: true };
  mkdirSync(join(root, 'characters', 'warden'), { recursive: true });
  writeFileSync(join(root, 'characters', 'warden', 'character.json'), JSON.stringify(wardenBase));

  const stage = (name: string, boss: boolean): object => ({
    name, imageW: 1536, imageH: 640, floorY: 520,
    skyColor: '#2b1b4d', deckColor: '#3a3644',
    ...(boss ? { boss: true } : {}),
  });
  mkdirSync(join(root, 'stages', 'plain'), { recursive: true });
  writeFileSync(join(root, 'stages', 'plain', 'stage.json'), JSON.stringify(stage('plain', false)));
  mkdirSync(join(root, 'stages', 'lair'), { recursive: true });
  writeFileSync(join(root, 'stages', 'lair', 'stage.json'), JSON.stringify(stage('lair', true)));
  return { root, roster: src };
};

// ------------------------------------------------------------- protocol client

const client = (url: string, name: string) => {
  const ws = new WebSocket(url);
  const queued: ServerMsg[] = [];
  const waiters: Array<{ t: string; go: (m: ServerMsg) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as ServerMsg;
    const i = waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0]!.go(m);
    else queued.push(m);
  });
  const next = <T extends ServerMsg>(t: T['t'], ms = 30_000): Promise<T> => {
    const i = queued.findIndex((m) => m.t === t);
    if (i >= 0) return Promise.resolve(queued.splice(i, 1)[0] as T);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error(`timeout waiting for "${t}" (${name})`)), ms);
      waiters.push({ t, go: (m) => { clearTimeout(to); res(m as T); } });
    });
  };
  const send = (m: unknown): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  const ready = new Promise<void>((res) => ws.on('open', () => {
    send({ t: 'hello', v: PROTOCOL_VERSION, name, engine: ENGINE_VERSION });
    res();
  }));
  return { ws, next, send, ready, close: () => ws.close() };
};

// -------------------------------------------------------------- offline sim

const fixtureBundleOf = (root: string, id: string): CharacterBundle =>
  JSON.parse(readFileSync(join(root, 'characters', id, 'character.json'), 'utf8')) as CharacterBundle;

const winningLine = (root: string, setup: SMatch): number[] => {
  for (let salt = 1; salt <= 12; salt++) {
    setCharacters(
      loadCharacter(fixtureBundleOf(root, setup.chars[0].id)),
      loadCharacter(fixtureBundleOf(root, setup.chars[1].id)),
    );
    const g = createGameState(setup.seed, setup.bounds);
    const house = createAi(1, setup.solo!.skill, setup.solo!.aiSeed, setup.solo!.personality);
    const me = createAi(0, 100, salt * 977);
    const inputs: number[] = [];
    while (g.phase !== Phase.MatchOver && inputs.length < 60 * 60 * 10) {
      const my = aiPoll(me, g);
      const opp = aiPoll(house, g);
      inputs.push(my);
      step(g, [my, opp]);
    }
    if (g.winner === 0) return inputs;
  }
  throw new Error('no winning line found in 12 salts (house is skill 0 — should be trivial)');
};

// ------------------------------------------------------------------ the tests

test('CORE: generateBoard puts the boss monster on the boss node and nowhere else', () => {
  const roster = realEnabledIds().slice(0, 4);
  for (const templateId of templateIds()) {
    const b = generateBoard({ roster, templateId, seed: 777, boss: 'warden' });
    assert.deepEqual(validateBoard(b), [], `${templateId} stays valid with a boss cast`);
    const bossNodes = b.nodes.filter((n) => n.kind === 'boss');
    assert.equal(bossNodes.length, 1);
    assert.equal(bossNodes[0]!.charId, 'warden', `${templateId}: the warden guards the boss node`);
    for (const n of b.nodes) {
      if (n.kind === 'boss' || !isFightNode(n)) continue;
      assert.notEqual(n.charId, 'warden', `${templateId}: the warden stands ONLY on the boss node`);
    }
    // Same seed without a boss: the roster spread is identical — the boss
    // never eats a roster assignment (it is cast outside the pool).
    const plain = generateBoard({ roster, templateId, seed: 777 });
    for (const n of b.nodes) {
      if (n.kind === 'boss' || !isFightNode(n)) continue;
      assert.equal(n.charId, nodeById(plain, n.id)?.charId, `${templateId}: roster spread unchanged`);
    }
  }
});

test('SERVER: a boss monster cannot be queued as a fighter, in any mode', async (t) => {
  const { root } = makeFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = await createMatchServer({ port: 0, root, persistence: memoryPersistence(), noPaceCheck: true });
  t.after(() => server.close());
  const c = client(`ws://localhost:${server.port}`, 'Imposter');
  t.after(() => c.close());
  await c.ready;
  for (const mode of ['arcade', 'wager', 'solo', 'friendly']) {
    c.send({ t: 'queue', character: 'warden', mode });
    const err = await c.next<Extract<ServerMsg, { t: 'error' }>>('error');
    assert.match(err.msg, /boss monster/, `${mode}: refused with the boss reason`);
  }
});

test('SERVER: the minted board casts the warden on the boss node; the boss fight pins the boss stage', async (t) => {
  const { root } = makeFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const persistence = memoryPersistence();
  // Skill 0 house so every winning line is found on the first salts.
  const server = await createMatchServer({
    port: 0, root, persistence, noPaceCheck: true, arcadeSkill: () => 0,
  });
  t.after(() => server.close());
  const http = `http://localhost:${server.port}`;
  const H = { 'X-Dev-Name': 'Slayer', 'Content-Type': 'application/json' };
  await fetch(`${http}/me`, { headers: H }); // profile + daily credits

  const player = realEnabledIds().slice(0, 3)[1]!; // fixture roster, not the warden's base
  const enter = await fetch(`${http}/arcade/enter`, {
    method: 'POST', headers: H, body: JSON.stringify({ nonce: 'bossrun_1' }),
  });
  assert.equal(enter.status, 200, await enter.clone().text());
  const { token } = await enter.json() as { token: string };
  const res = await fetch(`${http}/arcade/run`, {
    method: 'POST', headers: H, body: JSON.stringify({ token, character: player }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const run = await res.json() as { board: Board; at: number };

  // The board contract, as served to a real client.
  const bossNode = run.board.nodes.find((n) => n.kind === 'boss')!;
  assert.ok(bossNode, 'the board has its boss node');
  assert.equal(bossNode.charId, 'warden', 'the warden guards the boss node');
  for (const n of run.board.nodes) {
    if (n.kind !== 'boss' && isFightNode(n)) {
      assert.notEqual(n.charId, 'warden', 'the warden appears nowhere else');
    }
  }

  // Walk the pure spine to the warden. pathTo quotes the cheapest line to the
  // deep exit — all fights, ending [.., boss, exit3].
  const deep = exitNodes(run.board).find((e) => e.exitTier === 3)!;
  const spine = pathTo(run.board, run.board.start, deep.id)
    .map((id) => nodeById(run.board, id)!)
    .filter(isFightNode);
  assert.equal(spine[spine.length - 1]!.kind, 'boss', 'the spine ends at the warden');

  const c = client(`ws://localhost:${server.port}`, 'Slayer');
  t.after(() => c.close());
  await c.ready;
  for (const node of spine) {
    c.send({ t: 'queue', character: player, mode: 'arcade', runToken: token, arcadeNode: node.id });
    const setup = await c.next<SMatch>('match');
    if (node.kind === 'boss') {
      // THE point of the feature: the warden, in the boss arena.
      assert.equal(setup.chars[1].id, 'warden', 'the boss fight is against the warden');
      assert.equal(setup.stage, 'lair', 'the boss fight pins the BOSS STAGE');
    } else {
      assert.notEqual(setup.chars[1].id, 'warden', 'roster fights never draw the warden');
      assert.equal(setup.stage, 'plain', 'rotation never picks the boss stage');
    }
    const line = winningLine(root, setup);
    line.forEach((v, k) => c.send({ t: 'i', k, v }));
    c.send({ t: 'over', k: line.length });
    const result = await c.next<Extract<ServerMsg, { t: 'result' }>>('result');
    assert.equal(result.reason, 'verified', `fight at node ${node.id} verifies`);
    assert.equal(result.winner, 0, `fight at node ${node.id} is won`);
    await c.next('xp');
  }
});
