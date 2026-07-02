# Room Protocol Spec

The room protocol is the boundary between client transports and the pure room domain.

## Principles

- Client messages must be decoded from `unknown` before reaching room commands.
- Every client command carries either a host/guest capability token or an explicit join token hash.
- System events are produced by trusted server-side effects, not by clients.
- Settlement events carry the settled private item only; the room command layer computes the score-affecting settlement.
- Every successful room state mutation increments the room revision exactly once and broadcasts a public room snapshot.
- Presence-only broadcasts are not room state mutations, so they can carry the same room revision as the previous public room snapshot.
- Every rejected command returns a typed room-domain error and preserves the previous room state.
- Public room snapshots include live presence booleans and never include capability secrets, token hashes, persistence envelopes, or pre-settlement private values.
- Pre-settlement public item snapshots expose only `round_id`, `item_title`, `category`, and `context_clue`; they must redact `true_value`, `scraped_items`, and `amazon_url` even if those fields are present on an internal object.
- Post-settlement public item snapshots expose `true_value` and may expose Amazon `scraped_items` and `amazon_url` when those fields are present on the settled generated item.

## Presence

- Runtime transports supply `RoomPresence` to command dispatch. Clients do not send or prove presence in command payloads.
- Occupied seats are not live presence. A joined guest with no accepted current WebSocket is offline for liveness-gated commands.
- Presence is public, non-secret, ephemeral, and Durable Object-authoritative in the Cloudflare runtime. It is computed from accepted WebSockets whose attached role and token hash still match the current room seats, and it is not persisted.
- HTTP and WebSocket command handling use the same runtime presence source before dispatching room commands.
- `START_ROOM` is rejected with `player_offline` while Player B is disconnected.
- Non-final `ADVANCE_ROUND` is rejected with `player_offline` while Player B is disconnected.
- Final-round `ADVANCE_ROUND` that moves the game to `gameOver` remains allowed while Player B is disconnected.

## Client Commands

- `JOIN_ROOM`: guest display name and guest token hash.
- `CONFIGURE_ROOM`: host credential and partial config.
- `START_ROOM`: host credential.
- `RESET_TO_LOBBY`: host credential.
- `KICK_GUEST`: host credential.
- `ADVANCE_ROUND`: host credential.
- `RETRY_ITEM_GENERATION`: host credential. Accepted only for active rooms whose game is `error` with `previousPhase === "generatingItem"`.
- `SUBMIT_INITIAL_WIDTH`: active player credential and width.
- `TIGHTEN_WIDTH`: active player credential and width.
- `TRADE_ON_WIDTH`: active player credential.
- `SUBMIT_MARKET_QUOTE`: active player credential and quote.
- `EXECUTE_TRADE`: active player credential and side.

## System Events

- `ITEM_RECEIVED`: generated public item.
- `ITEM_FAILED`: safe error message.
- `SETTLEMENT_RECEIVED`: settled private item. No caller-provided settlement is accepted.
- `SETTLEMENT_FAILED`: safe error message.

## Transport Notes

The Durable Object slice should implement one runtime decoder for these messages and one dispatcher that calls the pure room command functions. WebSocket broadcasts should contain public room snapshots, never persistence envelopes.

WebSocket connect, close, and error presence changes rebroadcast updated public snapshots to remaining authorized sockets. These snapshots may reuse the current room revision when only presence changed, and they must not expose secrets, token hashes, persistence metadata, or private generated values.

## Client Snapshot Application

- Clients apply public room snapshots monotonically by room id and revision.
- A lower-revision snapshot for the current room is stale and must be ignored.
- A same-revision snapshot may be accepted only when the public room state excluding `presence` is unchanged. This permits presence-only WebSocket broadcasts without allowing stale command responses to overwrite game, seat, config, timestamp, or settlement state.
- A cross-room snapshot must be ignored unless the caller is intentionally switching rooms, such as after joining or creating a different room.
- A create-room response with `created: false` is an invite preview only. A client with a stored host or guest session for that room must call the access route to hydrate the full public room snapshot before opening the room socket or rendering game state.
- If that access call fails because the stored session is stale, invalid, or for the wrong room, the client clears the stored session and keeps only the invite preview state.
