/**
 * supabasePersistence WIRE SHAPE — the implementation that actually runs in
 * production, and the one that had no coverage at all until it broke prod.
 *
 * WHAT HAPPENED (2026-07-27): `arcadeExtract` grew a fourth parameter when the
 * arcade payout was retuned (loot and bonus had to be tapered differently).
 * The interface, the memory impl, the caller and the SQL were all updated —
 * but the Supabase impl still declared `(sub, runToken, credits)` and still
 * posted `{_profile,_key,_credits}`.
 *
 * TypeScript did not complain, and this is the part worth remembering: **a
 * function with FEWER parameters is assignable to a signature with more.** So
 * the 3-parameter impl satisfied the 4-parameter interface, `credits` silently
 * bound to `loot`, and `bonus` was discarded. `tsc` was green, every existing
 * test was green (they all exercise memoryPersistence), and every extraction
 * on prod 404'd against the re-signed Postgres function.
 *
 * So: these tests assert the REQUEST BODY each RPC puts on the wire. They need
 * no database — a stubbed `fetch` captures the call. Anything that changes an
 * RPC's argument list has to change a test here too, which is exactly the
 * coupling that was missing.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { supabasePersistence } from '../src/persist.js';

interface Captured { url: string; body: Record<string, unknown> }

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Stub `fetch`, run `fn`, and hand back every request it made. */
const capture = async (
  reply: unknown, fn: (p: ReturnType<typeof supabasePersistence>) => Promise<unknown>,
): Promise<Captured[]> => {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(reply),
    } as unknown as Response;
  }) as typeof fetch;
  await fn(supabasePersistence('https://stub.supabase.co', 'service-key'));
  return calls;
};

test('arcadeExtract posts _loot and _bonus SEPARATELY (the prod 404 regression)', async () => {
  const reply = [{
    credits: 40, granted: 32, multiplier_pct: 100, drink_budget: 3, duplicate: false,
  }];
  const calls = await capture(reply, (p) => p.arcadeExtract('sub-1', 'run-token', 14, 18));

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/rest\/v1\/rpc\/arcade_extract$/);
  assert.deepEqual(calls[0]!.body, {
    _profile: 'sub-1', _key: 'run-token', _loot: 14, _bonus: 18,
  }, 'the wire shape must match the 4-arg SQL signature exactly');
  // The old bug in one assertion: a body carrying _credits means the bonus was
  // folded into the loot (and would be tapered), and the RPC would 404.
  assert.ok(!('_credits' in calls[0]!.body), 'no _credits — that signature is gone');
});

test('arcadeExtract maps the snake_case reply onto the ArcadeExtract shape', async () => {
  const reply = [{
    credits: 40, granted: 32, multiplier_pct: 80, drink_budget: 1, duplicate: false,
  }];
  let out: unknown;
  await capture(reply, async (p) => { out = await p.arcadeExtract('s', 'k', 5, 8); return out; });
  assert.deepEqual(out, {
    credits: 40, granted: 32, multiplierPct: 80, drinkBudget: 1, duplicate: false,
  });
});

test('arcadeExtract clamps negatives rather than sending them to Postgres', async () => {
  const reply = [{ credits: 0, granted: 0, multiplier_pct: 100, drink_budget: 3, duplicate: false }];
  const calls = await capture(reply, (p) => p.arcadeExtract('s', 'k', -5, -2));
  assert.deepEqual(calls[0]!.body, { _profile: 's', _key: 'k', _loot: 0, _bonus: 0 });
});

test('debit_credits wire shape (control: this one never changed)', async () => {
  const reply = [{ credits: 9, duplicate: false }];
  const calls = await capture(reply, (p) => p.debitCredits('sub-1', 1, 'arcade', 'nonce-1'));
  assert.match(calls[0]!.url, /\/rest\/v1\/rpc\/debit_credits$/);
  assert.deepEqual(calls[0]!.body, {
    _profile: 'sub-1', _amount: 1, _reason: 'arcade', _key: 'nonce-1',
  });
});

/**
 * The structural guard. TypeScript cannot catch an impl that declares fewer
 * parameters than its interface, so assert the arity directly: if someone adds
 * an argument to an RPC and updates only one implementation, this fails.
 */
test('every money RPC impl declares its FULL parameter list', () => {
  const p = supabasePersistence('https://stub.supabase.co', 'k');
  const expected: [keyof typeof p, number][] = [
    ['arcadeExtract', 4],
    ['debitCredits', 4],
    ['buyItem', 5],
    ['escrowMatch', 3],
  ];
  for (const [name, arity] of expected) {
    assert.equal(
      (p[name] as (...a: unknown[]) => unknown).length, arity,
      `${String(name)} must declare ${arity} parameters — a short list silently `
      + 'satisfies the interface and drops the trailing arguments',
    );
  }
});
