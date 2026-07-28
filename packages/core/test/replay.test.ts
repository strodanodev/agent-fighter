import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPLAY_CODEC_VERSION, encodeLedger, decodeLedger, ledgerTicks,
  encodeInputTrack, decodeInputTrack, bytesToBase64Url, base64UrlToBytes,
  canonicalJson,
  Btn, createGameState, setCharacters, step, stateHash, loadCharacter, ANALOG,
  Phase,
} from '../src/index.js';

/**
 * REPLAY CODEC (ADR 0010).
 *
 * The contract these tests defend is not "the bytes are small" — it is that a
 * decoded ledger drives the simulation to the IDENTICAL final state. A replay
 * that round-trips its numbers but diverges by one tick is worthless, because
 * the whole point is reproducing a result the server already settled money on.
 */

const ch = () => loadCharacter(ANALOG);

describe('replay codec', () => {
  it('round-trips an empty track', () => {
    assert.deepEqual(decodeInputTrack(encodeInputTrack([])), []);
  });

  it('round-trips arbitrary values, including the full 13-bit input space', () => {
    // Btn currently reaches bit 12 (the third item slot), so 0..8191 is the
    // live domain. Encode the whole range rather than a sample.
    const track: number[] = [];
    for (let v = 0; v < 8192; v++) track.push(v);
    assert.deepEqual(decodeInputTrack(encodeInputTrack(track)), track);
  });

  it('treats holes as neutral input, exactly like the server verifier', () => {
    // The verifier reads `inputs[t]! | 0`, so a missing tick IS a 0. The codec
    // must agree with the authority that decided the match.
    const sparse: number[] = [];
    sparse[0] = Btn.Right;
    sparse[3] = Btn.LP; // 1 and 2 are holes
    assert.deepEqual(decodeInputTrack(encodeInputTrack(sparse)), [
      Btn.Right, 0, 0, Btn.LP,
    ]);
  });

  it('compresses run-heavy input hard (the reason the format exists)', () => {
    // 6000 ticks ≈ 100 seconds, the measured average match length.
    const held = new Array<number>(6000).fill(Btn.Right);
    const bytes = encodeInputTrack(held);
    assert.ok(
      bytes.length < 12,
      `a single held direction should collapse to a few bytes, got ${bytes.length}`,
    );
  });

  it('encodes a realistic two-sided ledger in a few kilobytes', () => {
    // Change input every ~6 ticks — busier than real play, so this is an
    // upper bound on size rather than a flattering case.
    const mk = (salt: number): number[] => {
      const t: number[] = [];
      for (let i = 0; i < 6000; i++) t.push(((i / 6) | 0) * 2654435761 % 8192 ^ salt);
      return t;
    };
    const encoded = encodeLedger([mk(1), mk(2)]);
    assert.ok(
      encoded.length < 12_000,
      `expected a few KB for a 100s match, got ${encoded.length} chars`,
    );
    const [a, b] = decodeLedger(encoded);
    assert.deepEqual(a, mk(1));
    assert.deepEqual(b, mk(2));
  });

  it('reports tick count without materialising the tracks', () => {
    const encoded = encodeLedger([new Array<number>(1234).fill(0), []]);
    assert.equal(ledgerTicks(encoded), 1234);
  });

  it('base64url is URL-safe and round-trips every byte value', () => {
    const bytes = Uint8Array.from(Array.from({ length: 256 }, (_, i) => i));
    const s = bytesToBase64Url(bytes);
    assert.ok(!/[+/=]/.test(s), 'must not emit +, / or = (URL-hostile)');
    assert.deepEqual([...base64UrlToBytes(s)], [...bytes]);
  });

  it('round-trips base64url at every length remainder (padding edges)', () => {
    for (let n = 0; n < 12; n++) {
      const bytes = Uint8Array.from(Array.from({ length: n }, (_, i) => (i * 37) & 0xff));
      assert.deepEqual(
        [...base64UrlToBytes(bytesToBase64Url(bytes))],
        [...bytes],
        `length ${n} failed`,
      );
    }
  });

  it('rejects corrupt payloads instead of returning silent garbage', () => {
    assert.throws(() => decodeLedger('!!!!'), /bad base64url/);
    assert.throws(() => decodeLedger(''), /truncated varint/);
    // A ledger whose declared codec version we do not know must fail loudly:
    // parsing it with today's rules could mis-decode into a plausible-looking
    // but wrong match, which is worse than an error.
    const wrongVersion = bytesToBase64Url(Uint8Array.from([REPLAY_CODEC_VERSION + 9, 2]));
    assert.throws(() => decodeLedger(wrongVersion), /unsupported codec version/);
  });

  /**
   * REGRESSION (2026-07-28, caught on real production data).
   *
   * The match digest was originally hashed over `JSON.stringify(pin)`, which
   * bakes in the key order of whichever code path happened to build the
   * object. The pin is then stored as Postgres `jsonb` — which does NOT
   * preserve key order — so nobody reading the row back could reproduce the
   * hash. That defeated the field's only purpose.
   *
   * Canonical form must therefore be invariant to key order, which is exactly
   * what a jsonb round-trip does to it.
   */
  it('canonicalJson is invariant to key order (survives a jsonb round-trip)', () => {
    const asWritten = {
      seed: 1, stage: 'bgc', chars: ['a', 'b'],
      result: { winner: 0, hash: 42, rounds: [2, 0] },
      bounds: { left: 0, right: 1065 },
    };
    // The same data with every object's keys in a different order — what a
    // storage layer is free to hand back.
    const asStored = {
      bounds: { right: 1065, left: 0 },
      result: { rounds: [2, 0], hash: 42, winner: 0 },
      chars: ['a', 'b'], stage: 'bgc', seed: 1,
    };
    assert.equal(canonicalJson(asWritten), canonicalJson(asStored));
    assert.notEqual(
      JSON.stringify(asWritten), JSON.stringify(asStored),
      'the test is meaningless if plain stringify already agreed',
    );
    // Array order is DATA, not formatting — it must never be sorted away.
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  /**
   * THE TEST THAT MATTERS: a decoded ledger must reproduce the match.
   *
   * Two sims are stepped from the same seed — one from the original inputs,
   * one from inputs that went through encode → decode — and their state hashes
   * must agree at EVERY tick, not merely at the end. A codec that only matched
   * at the final frame could still be corrupting the middle of a replay.
   */
  it('a decoded ledger reproduces the match tick-for-tick', () => {
    const inputsFor = (side: number): number[] => {
      const t: number[] = [];
      for (let i = 0; i < 900; i++) {
        // Deterministic pseudo-play: walk, crouch, and throw out attacks.
        const phase = (i + side * 7) % 24;
        t.push(
          phase < 6 ? Btn.Right
            : phase < 10 ? Btn.Down
            : phase === 12 ? Btn.LP
            : phase === 16 ? Btn.HK
            : phase < 20 ? Btn.Left
            : 0,
        );
      }
      return t;
    };
    const original: [number[], number[]] = [inputsFor(0), inputsFor(1)];
    const [d0, d1] = decodeLedger(encodeLedger(original));

    setCharacters(ch(), ch());
    const a = createGameState(12345);
    setCharacters(ch(), ch());
    const b = createGameState(12345);

    for (let t = 0; t < original[0].length; t++) {
      if (a.phase === Phase.MatchOver) break;
      step(a, [original[0][t]!, original[1][t]!]);
      step(b, [d0[t]!, d1[t]!]);
      assert.equal(
        stateHash(b), stateHash(a),
        `replay diverged from the original at tick ${t}`,
      );
    }
    assert.equal(stateHash(b), stateHash(a));
  });
});
