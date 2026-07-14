import { held, pressed } from './input.js';
import { clamp, fp, fpToPx } from './fp.js';
import { STAGE } from './data.js';
import { characters } from './state.js';
const FLOOR = fp(STAGE.floorYPx);
const WALL_L = fp(STAGE.wallPad);
const WALL_R = fp(STAGE.widthPx - STAGE.wallPad);
const FRICTION = fp(0.5);
/** Mirror a character-space rect into world space based on facing. */
const worldRect = (f, rc) => {
    const rx = fp(rc.x);
    const rw = fp(rc.w);
    const l = f.facing === 1 ? f.x + rx : f.x - rx - rw;
    return { l, t: f.y + fp(rc.y), r: l + rw, b: f.y + fp(rc.y) + fp(rc.h) };
};
const overlaps = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
/** Resolve the current MoveStep for an attacking fighter, or null. */
const attackStep = (f, def) => {
    if (f.action !== 3 /* Action.Attack */)
        return null;
    let acc = 0;
    for (const step of def.attack.steps) {
        acc += step.frames;
        if (f.actionFrame < acc)
            return step;
    }
    return null;
};
const totalAttackFrames = (def) => def.attack.steps.reduce((n, s) => n + s.frames, 0);
const currentHurtbox = (f, def) => {
    const step = attackStep(f, def);
    return step ? step.hurtbox : def.standHurtbox;
};
const grounded = (f) => f.y >= FLOOR;
const setAction = (f, a) => {
    f.action = a;
    f.actionFrame = 0;
};
const updateFighter = (f, input, def) => {
    const prev = f.prevInput;
    switch (f.action) {
        case 5 /* Action.KO */:
            // Dead fighters still fall.
            break;
        case 4 /* Action.Hitstun */:
            f.hitstunLeft--;
            if (f.hitstunLeft <= 0 && grounded(f))
                setAction(f, 0 /* Action.Idle */);
            break;
        case 3 /* Action.Attack */: {
            f.actionFrame++;
            if (f.actionFrame >= totalAttackFrames(def))
                setAction(f, 0 /* Action.Idle */);
            break;
        }
        case 2 /* Action.Jump */:
            if (grounded(f) && f.velY >= 0) {
                f.velX = 0;
                setAction(f, 0 /* Action.Idle */);
            }
            break;
        case 0 /* Action.Idle */:
        case 1 /* Action.Walk */: {
            if (pressed(input, prev, 16 /* Btn.Attack */)) {
                f.velX = 0;
                f.attackHasHit = 0;
                setAction(f, 3 /* Action.Attack */);
                break;
            }
            if (held(input, 4 /* Btn.Up */)) {
                f.velY = def.jumpVelY;
                f.velX = held(input, 1 /* Btn.Left */) ? -def.walkSpeed : held(input, 2 /* Btn.Right */) ? def.walkSpeed : 0;
                setAction(f, 2 /* Action.Jump */);
                break;
            }
            const dir = (held(input, 2 /* Btn.Right */) ? 1 : 0) - (held(input, 1 /* Btn.Left */) ? 1 : 0);
            f.velX = dir * def.walkSpeed;
            const next = dir !== 0 ? 1 /* Action.Walk */ : 0 /* Action.Idle */;
            if (f.action !== next)
                setAction(f, next);
            else
                f.actionFrame++;
            break;
        }
    }
    // Physics: gravity + integrate + floor/walls.
    if (!grounded(f) || f.velY < 0)
        f.velY += def.gravity;
    f.x += f.velX;
    f.y += f.velY;
    if (f.y >= FLOOR) {
        f.y = FLOOR;
        f.velY = 0;
        if (f.action === 4 /* Action.Hitstun */ && f.hitstunLeft <= 0)
            setAction(f, 0 /* Action.Idle */);
    }
    f.x = clamp(f.x, WALL_L, WALL_R);
    // Hitstun ground friction.
    if (f.action === 4 /* Action.Hitstun */ && grounded(f)) {
        if (f.velX > 0)
            f.velX = Math.max(0, f.velX - FRICTION);
        else if (f.velX < 0)
            f.velX = Math.min(0, f.velX + FRICTION);
    }
    f.prevInput = input;
};
const applyHit = (victim, attacker, dmg, stun, push) => {
    victim.health = Math.max(0, victim.health - dmg);
    victim.hitstunLeft = stun;
    victim.velX = attacker.facing * push;
    victim.velY = 0;
    setAction(victim, victim.health <= 0 ? 5 /* Action.KO */ : 4 /* Action.Hitstun */);
};
/**
 * Advance the simulation exactly one tick. Mutates `s` in place.
 * This is the ONLY way state changes. Deterministic by construction.
 */
export const step = (s, inputs) => {
    s.tick++;
    if (s.phase === 1 /* Phase.Over */)
        return;
    // Global hitstop: the crunch. Freeze everything except the countdown.
    if (s.hitstopLeft > 0) {
        s.hitstopLeft--;
        s.fighters[0].prevInput = inputs[0];
        s.fighters[1].prevInput = inputs[1];
        return;
    }
    const [f0, f1] = s.fighters;
    const [c0, c1] = characters;
    // Auto-face opponent (grounded, actionable states only).
    for (const [me, other] of [[f0, f1], [f1, f0]]) {
        if ((me.action === 0 /* Action.Idle */ || me.action === 1 /* Action.Walk */) && grounded(me)) {
            me.facing = other.x >= me.x ? 1 : -1;
        }
    }
    updateFighter(f0, inputs[0], c0);
    updateFighter(f1, inputs[1], c1);
    // Body push: fighters cannot fully overlap.
    const halfBodies = fp((c0.bodyWidth + c1.bodyWidth) / 2);
    const dx = f1.x - f0.x;
    const absDx = dx < 0 ? -dx : dx;
    if (absDx < halfBodies && Math.abs(fpToPx(f0.y - f1.y)) < 100) {
        const pushAmt = Math.trunc((halfBodies - absDx) / 2);
        const sign = dx === 0 ? f0.facing : dx > 0 ? 1 : -1;
        f0.x = clamp(f0.x - sign * pushAmt, WALL_L, WALL_R);
        f1.x = clamp(f1.x + sign * pushAmt, WALL_L, WALL_R);
    }
    // Hit detection — symmetric, allows trades. Boxes computed post-movement.
    const step0 = attackStep(f0, c0);
    const step1 = attackStep(f1, c1);
    const hit0 = // does f0's attack connect this tick?
     step0?.hitbox && !f0.attackHasHit && f1.action !== 5 /* Action.KO */ &&
        overlaps(worldRect(f0, step0.hitbox.rect), worldRect(f1, currentHurtbox(f1, c1)))
        ? step0.hitbox : null;
    const hit1 = step1?.hitbox && !f1.attackHasHit && f0.action !== 5 /* Action.KO */ &&
        overlaps(worldRect(f1, step1.hitbox.rect), worldRect(f0, currentHurtbox(f0, c0)))
        ? step1.hitbox : null;
    if (hit0) {
        f0.attackHasHit = 1;
        applyHit(f1, f0, hit0.damage, hit0.hitstun, hit0.pushbackHit);
        s.hitstopLeft = Math.max(s.hitstopLeft, hit0.hitstopFrames);
    }
    if (hit1) {
        f1.attackHasHit = 1;
        applyHit(f0, f1, hit1.damage, hit1.hitstun, hit1.pushbackHit);
        s.hitstopLeft = Math.max(s.hitstopLeft, hit1.hitstopFrames);
    }
    // Round end: KO or timeout.
    s.timerTicks--;
    const dead0 = f0.health <= 0;
    const dead1 = f1.health <= 0;
    if (dead0 || dead1) {
        s.phase = 1 /* Phase.Over */;
        s.winner = dead0 && dead1 ? 2 : dead0 ? 1 : 0;
    }
    else if (s.timerTicks <= 0) {
        s.phase = 1 /* Phase.Over */;
        s.winner = f0.health === f1.health ? 2 : f0.health > f1.health ? 0 : 1;
    }
};
/** Debug/render helper: world-space boxes in whole pixels. */
export const debugBoxes = (s) => s.fighters.map((f, i) => {
    const def = characters[i];
    const stp = attackStep(f, def);
    const hb = stp?.hitbox && !f.attackHasHit ? worldRect(f, stp.hitbox.rect) : null;
    const hurt = worldRect(f, currentHurtbox(f, def));
    const toPx = (r) => ({
        x: fpToPx(r.l), y: fpToPx(r.t), w: fpToPx(r.r - r.l), h: fpToPx(r.b - r.t),
    });
    return { hurtbox: toPx(hurt), hitbox: hb ? toPx(hb) : null };
});
