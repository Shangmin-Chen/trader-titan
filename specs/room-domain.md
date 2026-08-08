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

Starting a room requires a guest seat, but not live Player B presence: `START_ROOM` succeeds even while a joined guest has no live socket.

Round advancement after settlement or a round forfeit is host-controlled. `ADVANCE_ROUND` succeeds regardless of Player B's live presence, both non-final and on the final round (which transitions to `gameOver`).

## Turn Shot Clock (F-05)

- The four phases where a specific player must act - `proposingWidth`, `negotiatingWidth`, `configuringMarket`, `choosingSide` - each carry a `turnDeadlineMs`: an absolute Unix millisecond deadline, stamped by the server from its own clock when the room enters (or, for `negotiatingWidth`, re-enters via `TIGHTEN_WIDTH`) that phase. Durations are per-phase, since a binary choice needs less thinking time than making a market: `proposingWidth` 60s, `negotiatingWidth` 45s, `configuringMarket` 60s, `choosingSide` 30s.
- The deadline is server-authoritative end to end: it is computed from the server's own request time, never from a client-supplied timestamp, and clients render a countdown from the absolute value rather than being sent a decrementing remaining-seconds integer (which would desync on every reconnect).
- The clock keeps running while a player is disconnected. There is no pause and no grace budget tied to presence - deliberately, so a losing player cannot freeze the game by pulling their network. Presence remains only a cosmetic indicator (see Presence above).
- When a deadline elapses, the Cloudflare Durable Object alarm dispatches a `TURN_EXPIRED` system event. The room moves to a terminal-for-the-round `roundForfeited` phase carrying which round and phase timed out, who forfeited, who was awarded, and the zero-sum penalty applied to the score (`scores[forfeitedBy] -= penalty`, `scores[awardedTo] += penalty`).
- The penalty is the spread width in play at the time the clock ran out, since that is the natural stake already in price units for `negotiatingWidth`, `configuringMarket`, and `choosingSide`. `proposingWidth` has no spread width yet (the market maker has not proposed one), so it uses a named fallback constant instead.
- `ADVANCE_ROUND` accepts `roundForfeited` exactly as it accepts `settlement`: the next round starts, or the game ends on the final round.
- `TURN_EXPIRED` is routed through the same pure reducer as every other game action, exactly like `SETTLEMENT_RECEIVED`, so the FSM remains the single source of truth. A player command that arrives after the round has already been forfeited is a harmless no-op via the reducer's existing phase guard - no special-casing is needed in the room or Worker layers.

## Settlement

Room settlement is server-authoritative. The room layer computes settlement from the active settling state and the private settled item value; callers cannot provide score-affecting settlement data.

If the settlement effect that normally follows an `EXECUTE_TRADE` transition never runs, the room can remain durably in `settling`. The host can recover it with `RETRY_ITEM_GENERATION`, which re-runs settlement for the current round from the already-committed item, quote, and side. Settlement is a pure function of those three values, so retrying cannot change the outcome or restart the round.

## Persistence And Privacy

Persistence envelopes are private and may contain token hashes. Clients must receive only public room snapshots. Public snapshots redact token hashes, persistence metadata, and pre-settlement item values.

Abandoned lobby or active rooms expire after two hours. Finished rooms expire after fifteen minutes.
