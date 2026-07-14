import { fp } from './fp.js';
export const STAGE = {
    widthPx: 960,
    floorYPx: 460,
    wallPad: 24,
};
export const TICKS_PER_SEC = 60;
export const ROUND_SECONDS = 99;
/** M0 archetype: the rectangle fighter. */
export const RECT_FIGHTER = {
    name: 'Rect Fighter',
    maxHealth: 1000,
    walkSpeed: fp(3),
    jumpVelY: fp(-13),
    gravity: fp(0.75),
    bodyWidth: 56,
    standHurtbox: { x: -28, y: -110, w: 56, h: 110 },
    attack: {
        id: '5P',
        steps: [
            { frames: 4, phase: 'startup', hurtbox: { x: -28, y: -110, w: 56, h: 110 } },
            {
                frames: 3,
                phase: 'active',
                hurtbox: { x: -28, y: -110, w: 60, h: 110 },
                hitbox: {
                    rect: { x: 20, y: -95, w: 55, h: 30 },
                    damage: 90,
                    hitstun: 14,
                    hitstopFrames: 6,
                    pushbackHit: fp(5),
                    knockdown: false,
                },
            },
            { frames: 9, phase: 'recovery', hurtbox: { x: -28, y: -110, w: 56, h: 110 } },
        ],
    },
};
