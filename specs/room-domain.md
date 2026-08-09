# Room Domain Spec

The room domain models a private two-player game room. A room has exactly one host seat and at most one guest seat. Spectators are not supported.

## Identity And Access

- A room is addressed by `RoomId`.
- Host and guest access are represented by capability tokens held by the browser and verified against stored token hashes.
- The host controls lobby configuration, start, reset, kick, and round advancement.
- Active game commands are accepted only from the player whose role is active for the current phase.
- Failed authorization and invalid lifecycle or phase commands return typed domain errors and preserve the original room state.

## Presence

- Seat occupancy and live presence are separate concepts. An occupied guest seat means a valid guest joined the room; it is not proof that Player B currently has a live socket.
- Presence is public, non-secret, ephemeral room data made only of live booleans for Player A and Player B.
- The Cloudflare Durable Object is authoritative for presence. It computes presence from accepted WebSockets whose attached room id, role, and token hash still match the current host or guest seat token hashes.
- Presence is not persisted in room envelopes and is not a capability, token hash, persistence field, or private game value.
- Public room snapshots include live presence booleans. Presence-only updates do not mutate room state and can be rebroadcast with the same room revision.
- Presence does not authorize or gate any room command (F-04). It is a cosmetic connection indicator only. Earlier revisions of this spec rejected `START_ROOM` and non-final `ADVANCE_ROUND` with `player_offline` while Player B was disconnected; that gating has been removed in favor of the F-05 turn shot clock, which forfeits a round to whichever player fails to act in time regardless of why (disconnected, distracted, or otherwise idle).

## Lifecycle

- `lobby`: host may configure; guest may join if the slot is empty.
- `active`: game commands and system events progress the reducer-managed game state.
- `finished`: old game state is retained only until expiration and can be reset to a fresh lobby by the host.

Reset returns the room to `lobby`, clears the guest seat, and frees the guest slot for a new invite join. Kick removes the guest, returns the room to `lobby`, and also frees the guest slot.

Reset and kick are otherwise unrestricted host-control commands, but both are rejected with `round_settling` while the active game is in the `settling` phase, and the room state is preserved. A trade's outcome is already fixed the instant `EXECUTE_TRADE` commits (the private true value was fixed when the item was generated; only the reveal and score update are still pending), so allowing either command mid-settle would let a host who is also this round's trader duck an unfavorable outcome by discarding the room before it resolves - and since reset/kick also delete the round's private item, the guest would never even learn what the outcome would have been. The same guard covers an F-06 forced-timeout settlement, which also lands in `settling`. Every other active phase - including `choosingSide` before a side is taken, `settlement` after the outcome is revealed, `roundForfeited`, and the terminal `error` phase an F-07 capped settlement failure ends in - leaves reset and kick fully available, so a genuinely abandoned guest or a stuck room is never unrecoverable. See Settlement below for how a room stuck in `settling` leaves that phase without reset or kick.

Starting a room requires a guest seat, but not live Player B presence: `START_ROOM` succeeds even while a joined guest has no live socket.

Round advancement after settlement or a round forfeit is host-controlled. `ADVANCE_ROUND` succeeds regardless of Player B's live presence, both non-final and on the final round (which transitions to `gameOver`).

## Turn Shot Clock (F-05)

- The four phases where a specific player must act - `proposingWidth`, `negotiatingWidth`, `configuringMarket`, `choosingSide` - each carry a `turnDeadlineMs`: an absolute Unix millisecond deadline, stamped by the server from its own clock when the room enters (or, for `negotiatingWidth`, re-enters via `TIGHTEN_WIDTH`) that phase. Durations are per-phase, since a binary choice needs less thinking time than making a market: `proposingWidth` 60s, `negotiatingWidth` 45s, `configuringMarket` 60s, `choosingSide` 30s.
- The deadline is server-authoritative end to end: it is computed from the server's own request time, never from a client-supplied timestamp, and clients render a countdown from the absolute value rather than being sent a decrementing remaining-seconds integer (which would desync on every reconnect).
- The clock keeps running while a player is disconnected. There is no pause and no grace budget tied to presence - deliberately, so a losing player cannot freeze the game by pulling their network. Presence remains only a cosmetic indicator (see Presence above).
- When a deadline elapses, the Cloudflare Durable Object alarm dispatches a `TURN_EXPIRED` system event. For `proposingWidth`, `negotiatingWidth`, and `configuringMarket`, the room moves to a terminal-for-the-round `roundForfeited` phase carrying which round and phase timed out, who forfeited, who was awarded, and the zero-sum penalty applied to the score (`scores[forfeitedBy] -= penalty`, `scores[awardedTo] += penalty`). `choosingSide` is handled differently - see F-06 below.
- The penalty is the spread width in play at the time the clock ran out, since that is the natural stake already in price units for `negotiatingWidth` and `configuringMarket`. `proposingWidth` has no spread width yet (the market maker has not proposed one), so it uses a named fallback constant instead.
- `ADVANCE_ROUND` accepts `roundForfeited` exactly as it accepts `settlement`: the next round starts, or the game ends on the final round.
- `TURN_EXPIRED` is routed through the same pure reducer as every other game action, exactly like `SETTLEMENT_RECEIVED`, so the FSM remains the single source of truth. A player command that arrives after the round has already moved on (to `roundForfeited`, or to `settling` for a choosingSide timeout) is a harmless no-op via the reducer's existing phase guard - no special-casing is needed in the room or Worker layers.

## Forced Worst-Side Settlement On A choosingSide Timeout (F-06)

By the time a room reaches `choosingSide`, the trader has already seen the market maker's two-sided quote. Settlement PnL (`trueValue - transactionPrice`) is unbounded and unrelated to the spread width, so a flat, width-sized forfeit penalty there would let a trader who reads the quote as badly mispriced against them deliberately let the clock run out to cap their loss at the spread width instead of taking a much larger settlement loss - the shot clock, meant to force action, would instead hand them a free downside-capped option.

- A `choosingSide` clock expiry does not produce a `RoundForfeit`. Instead `TURN_EXPIRED` moves the room from `choosingSide` straight to `settling`, exactly like `EXECUTE_TRADE` does, except the side is not yet chosen.
- `settling` carries a `pendingTrade` decision instead of a bare side: either `{ kind: "chosen", side }` for a trader's own `EXECUTE_TRADE`, or `{ kind: "timeoutForcedWorstSide" }` for an F-06 timeout. The reducer cannot resolve `timeoutForcedWorstSide` into an actual side by itself - that requires the private `true_value`, which never reaches the client-visible game state and only exists server-side.
- The Worker resolves `pendingTrade` into a concrete side at the same point it already computes settlement (once it has fetched the private item): a `chosen` decision passes its side through unchanged; `timeoutForcedWorstSide` resolves to whichever of BUY (`trueValue - ask`) or SELL (`bid - trueValue`) yields the *lower* trader PnL, so stalling can never beat acting. A tie resolves to BUY deterministically.
- Like a chosen trade, this still goes through the ordinary `settling` -> `SETTLEMENT_RECEIVED` settlement effect (including F-02's stuck-`settling` recovery), so a forced timeout gets identical retry and durability guarantees to a trade the trader actually made.
- The resulting `RoundSettlement` carries `forcedByTimeout: true` so the round log and settlement UI can say the trader did not choose this side, rather than implying they did. `side` still always records the side actually settled against.
- If settlement then fails to commit (`SETTLEMENT_FAILED` - the private item is unavailable, or F-02's `forceFailStuckSettlement` exhaustion fallback), the room re-enters `choosingSide` carrying the failed `pendingTrade` forward as `lockedPendingTrade`, rather than discarding it. This is what keeps F-06 closed across a settlement bounce-back: without it, a trader who stalled the clock to force a worst-side settlement could get an unlocked, freely-re-chosen side for free any time settlement happened to fail - reopening the exact exploit F-06 exists to close. This applies identically whether the pending decision was `timeoutForcedWorstSide` or a trader's own `chosen` side; either way it is now locked, not just the timeout case.
- A `choosingSide` with `lockedPendingTrade` set still carries a fresh `turnDeadlineMs` (the same clock, same duration, as an ordinary `choosingSide`), but the choice is no longer live: `EXECUTE_TRADE`'s requested side is ignored and `settling` is re-entered with the locked decision instead, and a re-expiry of that clock (`TURN_EXPIRED`) re-enters `settling` with the same locked decision rather than resolving a fresh `timeoutForcedWorstSide`. Keeping the clock running (rather than dropping it) preserves this room's existing self-healing property - a transient settlement failure keeps retrying on a bounded cadence without requiring host intervention - while the locked decision keeps the retry from becoming a second, free roll of the dice. The client must not present Buy/Sell as a live choice while `lockedPendingTrade` is set, since clicking either one is ignored server-side.

## Bounded Settlement-Failure Episodes (F-07)

The F-06 bounce-back keeps a round self-healing, but nothing in F-06 itself limits how many times `choosingSide(locked) -> settling -> SETTLEMENT_FAILED -> choosingSide(locked)` may repeat for the same round. If the underlying cause is persistent rather than transient (for example, a permanently missing private item), that cycle had no terminal state.

- `SettlingGameState` carries a required `settlementFailureCount`, and a locked `ChoosingSideGameState` carries the same value alongside `lockedPendingTrade` (always set together, never one without the other). Both `EXECUTE_TRADE` and `TURN_EXPIRED` re-entering `settling` carry this count forward unchanged - entering or re-entering `settling` is not itself a failure.
- `SETTLEMENT_FAILED` increments the count. Below `SETTLEMENT_FAILURE_EPISODE_CAP` consecutive failures for the round, it bounces back to `choosingSide(locked)` exactly as F-06 describes. At the cap, it instead routes to the terminal `error` phase (the same phase `ITEM_FAILED` uses), with `previousPhase: "settling"` distinguishing it from an item-generation error. A permanently failed settlement has no `RoundSettlement` and no revealed `true_value`, which is exactly the shape `error` already has.
- The count cannot survive into a new round: `NEXT_ROUND` and `START_GAME` only ever produce phases (`generatingItem`, `settlement`, `roundForfeited`) that do not have this field in the `GameState` union at all, so a stale count is structurally unrepresentable there rather than reset by a runtime call. The same guard applies across a storage round-trip - persistence's per-phase key allowlist rejects an envelope that carries the field on a phase that cannot have it, or that carries `lockedPendingTrade`/`settlementFailureCount` unpaired.
- Once terminal, the room is no longer in a turn-clocked phase and carries no pending settle effect, so the Durable Object alarm is armed only against the room's own TTL - the dead round does not keep waking the object.
- The host's only recovery action from this terminal state is `RESET_TO_LOBBY`; unlike an item-generation `error`, `RETRY_ITEM_GENERATION` is not offered (`previousPhase` is `"settling"`, not `"generatingItem"`).

## Settlement

Room settlement is server-authoritative. The room layer computes settlement from the active settling state and the private settled item value; callers cannot provide score-affecting settlement data.

If the settlement effect that normally follows an `EXECUTE_TRADE` transition never runs, the room can remain durably in `settling`. The host can recover it with `RETRY_ITEM_GENERATION`, which re-runs settlement for the current round from the already-committed item, quote, and side. Settlement is a pure function of those three values, so retrying cannot change the outcome or restart the round. If settlement instead keeps failing outright for the same round, F-07 above bounds how many times it will retry before giving up.

## Persistence And Privacy

Persistence envelopes are private and may contain token hashes. Clients must receive only public room snapshots. Public snapshots redact token hashes, persistence metadata, and pre-settlement item values.

Abandoned lobby or active rooms expire after two hours. Finished rooms expire after fifteen minutes.
