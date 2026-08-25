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
- Pre-settlement public item snapshots expose only `round_id`, `item_title`, `category`, and `context_clue`; they must redact `true_value` even if that field is present on an internal object.
- Post-settlement public item snapshots expose `true_value`; no scrape metadata fields exist on the settled generated item.
- Public room snapshots expose `turnDeadlineMs` on the `proposingWidth`, `negotiatingWidth`, `configuringMarket`, and `choosingSide` game phases: an absolute, server-stamped Unix millisecond deadline for the F-05 turn shot clock, never a client-computed or remaining-seconds value.
- A `choosingSide` snapshot may additionally carry `lockedPendingTrade` (see F-06's settlement-failure bounce-back in room-domain.md) when this `choosingSide` was re-entered after `SETTLEMENT_FAILED` rather than reached normally. It is forwarded from internal state as-is, never derived from private data. Clients must treat its presence as "the decision is locked - do not present Buy/Sell as a live choice", not merely as extra display data.

## Presence

- Runtime transports supply `RoomPresence` to public room snapshots. Clients do not send or prove presence in command payloads.
- Occupied seats are not live presence. A joined guest with no accepted current WebSocket is offline.
- Presence is public, non-secret, ephemeral, and Durable Object-authoritative in the Cloudflare runtime. It is computed from accepted WebSockets whose attached role and token hash still match the current room seats, and it is not persisted.
- HTTP and WebSocket command handling use the same runtime presence source when building the public snapshot broadcast after a command.
- Presence does not gate any room command (F-04). `START_ROOM` and `ADVANCE_ROUND` (final and non-final) all succeed regardless of Player B's live presence; an idle or absent opponent is instead handled by the F-05 turn shot clock forfeiting the round they are on the clock for. Presence is a purely cosmetic connection indicator in the public snapshot, not an authorization input to any room command.
- A room socket whose TCP connection has died without a close frame (killed tab, sleeping laptop, blackholed network path) is not distinguishable from a healthy idle socket by the accepted-WebSockets list alone, since the Durable Object never wakes on a client ping (see Transport Notes for the F-08 liveness sweep that reclaims it).

## Client Commands

- `JOIN_ROOM`: guest display name and guest token hash. No `commandId` (see Command Identity And Replay below).
- `CONFIGURE_ROOM`: host credential, `commandId`, and partial config.
- `START_ROOM`: host credential and `commandId`.
- `RESET_TO_LOBBY`: host credential and `commandId`.
- `KICK_GUEST`: host credential and `commandId`.
- `ADVANCE_ROUND`: host credential and `commandId`.
- `SUBMIT_INITIAL_WIDTH`: active player credential, `commandId`, and width.
- `TIGHTEN_WIDTH`: active player credential, `commandId`, and width.
- `TRADE_ON_WIDTH`: active player credential and `commandId`.
- `SUBMIT_MARKET_QUOTE`: active player credential, `commandId`, and quote.
- `EXECUTE_TRADE`: active player credential, `commandId`, and side.

## Command Identity And Replay

- Every client command other than `JOIN_ROOM` carries a client-generated `commandId`: an opaque, bounded, character-restricted string (not a secret). It is decoded and shape-validated the same as any other untrusted field.
- The Durable Object recognizes a replay by the pair `(credential role, commandId)`, scoped per role so a guest cannot forge a commandId to collide with -- and block -- a future host command, or vice versa. Only commands that already succeeded are recorded, so an unauthorized or otherwise-rejected attempt can never poison the record and block a legitimate later command with the same id.
- Recognizing a replay and persisting a newly-applied command's id both happen inside the same storage transaction as the command dispatch itself, so a replay can never race a fresh copy of the same command.
- A recognized replay does not re-run the command. It returns the room's current state as an `ok: true` response instead of an error, and does not re-run any automatic effect (item generation, settlement fetch) that already ran for the original attempt. The client's revision guard makes applying that snapshot again a no-op, so a lost HTTP or WebSocket response converges silently instead of surfacing a confusing failure for a command that already committed.
- `JOIN_ROOM` does not carry a `commandId`: replaying it does not silently re-apply a past mutation, it mints a fresh guest token, which is a different (and already separately handled) concern from replaying a game-state mutation.
- This mechanism provides server-side idempotency only. Clients do not yet automatically retry commands after a failed or lost response; that remains a manual retry (the user clicking again), which this mechanism now makes safe.

## System Events

- `ITEM_RECEIVED`: generated public item.
- `ITEM_FAILED`: safe error message.
- `SETTLEMENT_RECEIVED`: settled private item. No caller-provided settlement is accepted; `EXECUTE_TRADE` composes it synchronously inside the same storage transaction that commits the trade, so there is no separate settlement-failure or retry path.
- `TURN_EXPIRED`: F-05 turn shot-clock expiry. Carries no caller-supplied data beyond the server's own timestamp. For `proposingWidth`, `negotiatingWidth`, and `configuringMarket`, the room command layer derives who forfeits, who is awarded, and the penalty entirely from the room's own current state (active role for the phase, and the spread width in play, or a named fallback constant in `proposingWidth` where no width has been proposed yet). For `choosingSide`, F-06 instead moves the room to `settling` with an unresolved `pendingTrade` (`{ kind: "timeoutForcedWorstSide" }`) - see room-domain.md - rather than forfeiting, since the trader has already seen a quote by that point. Valid only while the room is in `proposingWidth`, `negotiatingWidth`, `configuringMarket`, or `choosingSide`; rejected with `invalid_game_phase` everywhere else. Dispatched only by the Worker's Durable Object alarm when a stamped `turnDeadlineMs` elapses - never accepted from a client. Like every other successful mutation, committing `TURN_EXPIRED` (and any settlement effect it triggers via F-06) broadcasts a public snapshot - alarm-driven mutations are not a client request/response a caller is waiting on, so without an explicit broadcast a connected client would never learn a genuinely expired clock happened until its own next unrelated command.

## Transport Notes

The Durable Object slice should implement one runtime decoder for these messages and one dispatcher that calls the pure room command functions. WebSocket broadcasts should contain public room snapshots, never persistence envelopes.

### Test-only: `POST /api/rooms/:id/test-expire-turn`

Fast-forwards a room's currently-armed F-05 `turnDeadlineMs` to a few seconds from now and re-arms the real Durable Object alarm against it, so an e2e test can observe a genuine clock expiry (the countdown reaching its urgent state, the alarm firing, `TURN_EXPIRED` committing, and the broadcast reaching connected clients) without sleeping out the real 30-60s duration. Takes the same `{ credential }` body as `access`, authorized the same way (any valid host or guest credential for the room); rejected with `invalid_game_phase` if the room has no active turn clock. The route only exists when `WORKER_ITEM_PROVIDER` is set (the same test/dev signal item generation already gates on - see `wrangler dev --var` in `playwright.config.ts`); it 404s like any other unknown route otherwise, so it cannot be reached in a real deploy. See `E2E_FAST_FORWARD_TURN_OFFSET_MS` in `src/worker/index.ts` and `fastForwardTurnClock` in `e2e/helpers.ts`.

WebSocket connect, close, and error presence changes rebroadcast updated public snapshots to remaining authorized sockets. These snapshots may reuse the current room revision when only presence changed, and they must not expose secrets, token hashes, persistence metadata, or private generated values.

The Durable Object registers a hibernation auto-response pair so a client's own heartbeat ping is answered at the edge without waking the object. A server-side liveness sweep, driven by the Durable Object's single alarm slot, independently detects a room socket that has gone silent for too long (no observed auto-response, and no recent accept) and closes it with a close code the client's reconnect supervisor treats as retryable - never one of the terminal eviction/teardown codes. This sweep is folded into the same alarm slot used for room TTL housekeeping and pending-effect resumption; it only contributes a deadline while at least one socket is connected, so a room with no connected sockets is not woken for this purpose.

## Client Snapshot Application

- Clients apply public room snapshots monotonically by room id and revision.
- A lower-revision snapshot for the current room is stale and must be ignored.
- A same-revision snapshot may be accepted only when the public room state excluding `presence` is unchanged. This permits presence-only WebSocket broadcasts without allowing stale command responses to overwrite game, seat, config, timestamp, or settlement state.
- A cross-room snapshot must be ignored unless the caller is intentionally switching rooms, such as after joining or creating a different room.
- A create-room response with `created: false` is an invite preview only. A client with a stored host or guest session for that room must call the access route to hydrate the full public room snapshot before opening the room socket or rendering game state.
- If that access call fails because the stored session is stale, invalid, or for the wrong room, the client clears the stored session and keeps only the invite preview state.
