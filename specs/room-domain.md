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

## Lifecycle

- `lobby`: host may configure; guest may join if the slot is empty.
- `active`: game commands and system events progress the reducer-managed game state.
- `finished`: old game state is retained only until expiration and can be reset to a fresh lobby by the host.

Reset returns the room to `lobby`, clears the guest seat, and frees the guest slot for a new invite join. Kick removes the guest, returns the room to `lobby`, and also frees the guest slot.

Starting a room requires a guest seat and live Player B presence. If Player B has joined but is disconnected, `START_ROOM` is rejected with `player_offline` and the room state is preserved.

Round advancement after settlement is host-controlled. Non-final `ADVANCE_ROUND` is rejected with `player_offline` while Player B is disconnected. Final-round `ADVANCE_ROUND` that transitions to `gameOver` remains allowed even if Player B is disconnected.

## Settlement

Room settlement is server-authoritative. The room layer computes settlement from the active settling state and the private settled item value; callers cannot provide score-affecting settlement data.

## Persistence And Privacy

Persistence envelopes are private and may contain token hashes. Clients must receive only public room snapshots. Public snapshots redact token hashes, persistence metadata, and pre-settlement item values.

Abandoned lobby or active rooms expire after two hours. Finished rooms expire after fifteen minutes.
