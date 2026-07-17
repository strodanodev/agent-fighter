# ADR 0005 — Disconnect settlement: the ledger is the truth

Status: accepted · 2026-07-17
Builds on: [0003 — online architecture](0003-online-architecture-agents-first.md) ·
[0004 — credits economy](0004-credits-economy.md)

## The problem

Credits make disconnection an *economic* event. "Who wins when a socket
dies?" stops being a UX question and becomes an attack surface: if quitting
escapes a loss, every losing player quits; if quitting is always punished, a
player whose wifi blinks while winning is robbed — and anyone who can knock
you offline can take your pot.

## Decision — the settlement ladder

A dropped socket **never** overrules the input ledger. On any disconnect,
idle timeout, or shutdown, the server re-simulates what it has and applies,
in order:

1. **Ledger reached MatchOver → `verified`.** The real result stands no
   matter what happened to the connections. Winning and then dropping still
   wins; rage-quitting after the final KO still loses.
2. **Undecided + exactly one side gone/silent → `forfeit`.** That side loses;
   the other takes the pot. Quitting is never an escape hatch.
3. **Undecided + nobody to blame** (both gone, server restart) →
   `incomplete`: a no-contest that refunds both entry fees. Previously the
   *first socket to close* was arbitrarily named the loser — a coin flip
   deciding real credits.

Leaving is a **loss**, and that is the deterrent. There is no "draw by
disconnect" to farm.

## Silence is a disconnect (anti lag-switch)

Closing the socket was the only modelled way to leave, so a client could keep
it open, stop sending inputs, and stall the match **forever** — freezing the
opponent's escrowed credits. That's griefing with a free option on the pot.
Now: no input for `IDLE_FORFEIT_MS` (30s) settles the match by the same
ladder — silent side forfeits, both silent is a no-contest. Generous enough
for a stutter, short enough that nobody's pot is hostage.

## Threats and where they land

| Vector | Outcome |
| --- | --- |
| Rage-quit a losing match | Forfeit → loss. No escape. |
| Pull the cable after the KO lands | Ledger already decided → the real result. |
| Genuine blip while winning | RECONNECT (below); if you can't get back inside the grace: ledger decided → you still win, undecided → you lose. |
| Lag switch / stall to hold the pot | Idle timeout → forfeit. |
| Both drop / server dies mid-match | No-contest → both refunded. |
| **DDoS the opponent offline** | They forfeit — but the transport is a **relay**: peers never learn each other's IPs, so there is nothing to attack. **This protection dies the day WebRTC P2P lands** (ADR 0003's transport upgrade) — revisit before shipping it. |

The honest-blip case is covered by RESUME: the match setup carries a
per-side bearer token; a dropped client reconnects, sends `resume`, and the
server re-attaches the seat and returns the full input ledger so the sim
rebuilds by replay (both flavours: lockstep-replay for wager rollback,
AI-replay for local-sim solo). The client retries automatically (~6 attempts
inside the 20s grace) behind a RECONNECTING overlay. Only a blip that
outlasts the grace falls through to the forfeit rule — which stays
deliberately unforgiving, because past that point we cannot distinguish it
from a rage-quit, and pricing it in favour of the quitter would make
quitting free.

## Client contract

A dead session must never render a live-looking frozen frame — that reads as
a crash (it was reported as one). The client freezes the sim, states what
happened, states **what happens to the money**, and always offers the exit
(`drawNetError`). Progression is server-awarded regardless: the verdict
arrives from the server or the fee comes back.

## Orphaned escrow — CLOSED

Fees are escrowed at pair time and refunded by `record_match` on an
undecided outcome; a server crash between the two used to strand the fee
forever. `sweep_orphaned_escrow` (migration 0003 + memoryPersistence mirror)
now runs at startup and hourly: any fee row past the cutoff whose match id
has no `matches` row is SETTLED as a synthetic no-contest first (so a late
settlement finds the id taken and awards nothing) and then refunded, guarded
by the unique refund ledger row. Deploy restarts no longer freeze pots.
