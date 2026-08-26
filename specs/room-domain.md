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
- Presence does not authorize or gate any room command (F-04). It is a cosmetic connection indicator only. Earlier revisions of this spec rejected `START_ROOM` and non-final `ADVANCE_ROUND` with `player_offline` while Player B was disconnected; that gating has been removed. There is no shot clock to force an idle player's hand either - a missing opponent stalls only their own turn, and the host's recourse is `RESET_TO_LOBBY` or `KICK_GUEST`.

## Lifecycle

- `lobby`: host may configure; guest may join if the slot is empty.
- `active`: game commands and system events progress the reducer-managed game state.
- `finished`: old game state is retained only until expiration and can be reset to a fresh lobby by the host.

Reset returns the room to `lobby`, clears the guest seat, and frees the guest slot for a new invite join. Kick removes the guest, returns the room to `lobby`, and also frees the guest slot.

Reset and kick are otherwise unrestricted host-control commands: they are valid in every phase the reducer accepts. There is no durable `settling` phase for a guard to protect - settlement now resolves synchronously inside the same storage transaction that commits `EXECUTE_TRADE`, so by the time any command response or public snapshot is observable the round's outcome is already computed and revealed. No mid-settle window exists in which discarding the room could hide the outcome from either player, so no special guard is needed.

Starting a room requires a guest seat, but not live Player B presence: `START_ROOM` succeeds even while a joined guest has no live socket.

Round advancement after settlement is host-controlled. `ADVANCE_ROUND` succeeds regardless of Player B's live presence, both non-final and on the final round (which transitions to `gameOver`).

## Settlement

Room settlement is server-authoritative. `EXECUTE_TRADE` commits the `choosingSide` -> `settlement` transition atomically in a single storage transaction: the room layer derives the round's true value from the static deck (keyed by the active `round_id`), computes zero-sum PnL from it, persists once, and broadcasts once. Callers cannot provide score-affecting settlement data. Because nothing in the settlement path is asynchronous, there is no retry path - no durable `settling` state and no separate settlement effect that could fail after the trade commits.

## Persistence And Privacy

Persistence envelopes are private and may contain token hashes. Clients must receive only public room snapshots. Public snapshots redact token hashes, persistence metadata, and pre-settlement item values.

The persistence envelope carries a version (`ROOM_PERSISTENCE_VERSION`, currently 6), and decoding is a hard cutover with no migration policy: `ROOM_PERSISTENCE_MIN_SUPPORTED_VERSION` always equals the current version and no read-time migration chain exists. An envelope tagged with any other version fails decode with `persistence_version_unsupported` and the room's self-heal paths purge it, after which the room reads as never-created. Blast radius per deploy: rooms live in the ≤2 h TTL window.

Cutover history (one hard bump per phase that changed persisted shapes):

- **v4:** static-deck provider landed and the custom-Amazon/AI layer was cut - config flags (`customAmazonQuery`/`aiGenerated`) and scraped fields (`scraped_items`/`amazon_url`) left the envelope; the v1→v3 migration chain was deleted.
- **v5:** settlement became synchronous with `EXECUTE_TRADE` - `generatingItem`, `settling`, and `error` stopped being persistable phases, and `lockedPendingTrade`/`settlementFailureCount` left `choosingSide`.
- **v6:** the shot-clock layer was cut - `roundForfeited` stopped being a persistable phase, and forfeit/forced-timeout fields (`RoundForfeit`, `RoundSettlement.forcedByTimeout`) no longer exist.

Abandoned lobby or active rooms expire after two hours. Finished rooms expire after fifteen minutes.
