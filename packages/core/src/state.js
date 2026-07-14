import { fp } from './fp.js';
import { RECT_FIGHTER, ROUND_SECONDS, STAGE, TICKS_PER_SEC } from './data.js';
/** M0: both players use the rectangle archetype. Later: per-player bundles. */
export const characters = [RECT_FIGHTER, RECT_FIGHTER];
const spawnFighter = (x, facing, def) => ({
    x: fp(x),
    y: fp(STAGE.floorYPx),
    velX: 0,
    velY: 0,
    facing,
    health: def.maxHealth,
    action: 0 /* Action.Idle */,
    actionFrame: 0,
    hitstunLeft: 0,
    attackHasHit: 0,
    prevInput: 0,
});
export const createGameState = (seed) => ({
    tick: 0,
    rngSeed: seed | 0,
    phase: 0 /* Phase.Fighting */,
    winner: -1,
    timerTicks: ROUND_SECONDS * TICKS_PER_SEC,
    hitstopLeft: 0,
    fighters: [
        spawnFighter(STAGE.widthPx / 2 - 160, 1, characters[0]),
        spawnFighter(STAGE.widthPx / 2 + 160, -1, characters[1]),
    ],
});
/** Cheap deep copy — the whole state is flat numbers. Required for rollback. */
export const snapshot = (s) => ({
    ...s,
    fighters: [{ ...s.fighters[0] }, { ...s.fighters[1] }],
});
export const restore = (dst, snap) => {
    Object.assign(dst, snap, {
        fighters: dst.fighters,
    });
    Object.assign(dst.fighters[0], snap.fighters[0]);
    Object.assign(dst.fighters[1], snap.fighters[1]);
};
const FIGHTER_FIELDS = [
    'x', 'y', 'velX', 'velY', 'facing', 'health',
    'action', 'actionFrame', 'hitstunLeft', 'attackHasHit', 'prevInput',
];
/** Deterministic flat serialization — field order is part of the protocol. */
export const serialize = (s) => {
    const out = new Int32Array(6 + FIGHTER_FIELDS.length * 2);
    let i = 0;
    out[i++] = s.tick;
    out[i++] = s.rngSeed;
    out[i++] = s.phase;
    out[i++] = s.winner;
    out[i++] = s.timerTicks;
    out[i++] = s.hitstopLeft;
    for (const f of s.fighters) {
        for (const k of FIGHTER_FIELDS)
            out[i++] = f[k];
    }
    return out;
};
/** FNV-1a over the serialized state. Used for desync detection + CI replay tests. */
export const stateHash = (s) => {
    const data = serialize(s);
    let h = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
        const v = data[i];
        h ^= v & 0xff;
        h = Math.imul(h, 0x01000193);
        h ^= (v >>> 8) & 0xff;
        h = Math.imul(h, 0x01000193);
        h ^= (v >>> 16) & 0xff;
        h = Math.imul(h, 0x01000193);
        h ^= (v >>> 24) & 0xff;
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
};
