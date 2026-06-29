# Room Domain Spec

The room domain models a private two-player game room. A room has exactly one host seat and at most one guest seat. Spectators are not supported.

## Identity And Access

- A room is addressed by `RoomId`.
- Host and guest access are represented by capability tokens held by the browser and verified against stored token hashes.
- The host controls lobby configuration, start, reset, kick, and round advancement.
- Active game commands are accepted only from the player whose role is active for the current phase.
- Failed authorization and invalid lifecycle or phase commands return typed domain errors and preserve the original room state.

## Lifecycle

- `lobby`: host may configure; guest may join if the slot is empty.
- `active`: game commands and system events progress the reducer-managed game state.
- `finished`: old game state is retained only until expiration and can be reset to a fresh lobby by the host.

Reset returns the room to `lobby`, clears the guest seat, and frees the guest slot for a new invite join. Kick removes the guest, returns the room to `lobby`, and also frees the guest slot.

## Settlement

Room settlement is server-authoritative. The room layer computes settlement from the active settling state and the private settled item value; callers cannot provide score-affecting settlement data.

## Persistence And Privacy

Persistence envelopes are private and may contain token hashes. Clients must receive only public room snapshots. Public snapshots redact token hashes, persistence metadata, and pre-settlement item values.

Abandoned lobby or active rooms expire after two hours. Finished rooms expire after fifteen minutes.
