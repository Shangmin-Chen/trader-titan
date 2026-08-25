# Cloudflare Worker Spec

The Cloudflare target uses OpenNext for the existing Next app and a Durable Object class for authoritative room state.

## Worker Entry

- Wrangler `main` points to `src/worker/index.ts`.
- The Worker delegates normal app requests to the generated OpenNext worker at `.open-next/worker.js`.
- Worker tests alias that generated worker to a smoke implementation before the OpenNext build artifact exists.
- Legacy process-local game routes (`/api/generate-item`, `/api/commit-market`, and `/api/settle-round`) are rejected by the Worker with `410` before OpenNext can serve them.

## Public Room Routes

The Worker exposes room routes before delegating unmatched requests to OpenNext:

- `POST /api/rooms`: generates a valid room id, forwards the request body to that room object's `POST /room`, and returns the Durable Object response. Newly created rooms return the host capability token and the full public room snapshot.
- `GET /api/rooms/:roomId`: validates `roomId` and forwards to `GET /room`, which returns only a minimal invite preview with host name, lifecycle, joinability, and guest occupancy.
- `POST /api/rooms/:roomId/access`: validates `roomId` and forwards to `POST /room/access`, which requires a host or current guest capability token and returns the full public room snapshot.
- `POST /api/rooms/:roomId/join`: validates `roomId` and forwards to `POST /room/join`.
- `POST /api/rooms/:roomId/command`: validates `roomId` and forwards to `POST /room/command`.
- `GET /api/rooms/:roomId/socket` with `Upgrade: websocket`: validates `roomId` and forwards to the room object's WebSocket endpoint. Socket auth is carried in `Sec-WebSocket-Protocol`, not the URL.

Room ids are validated with the room-domain parser before `idFromName` is called. Non-room routes continue to delegate to OpenNext unchanged.

Public room POST routes and public WebSocket upgrades reject browser requests whose `Origin` does not match the request URL origin before forwarding to the Durable Object. Requests without an `Origin` header remain allowed for non-browser clients and server-to-server calls. Rejections use Worker-style JSON with `403`:

```json
{ "ok": false, "error": { "code": "origin_not_allowed", "message": "Request origin is not allowed." } }
```

`POST /api/rooms` also applies a bounded in-memory per-Cloudflare-client-IP rate limit before forwarding. Normal room joins, access, command gameplay, and socket messages are not broadly rate-limited by this guard. Limit rejections use Worker-style JSON with `429`:

```json
{ "ok": false, "error": { "code": "rate_limited", "message": "Room request rate limit exceeded." } }
```

## Durable Object Room Lifecycle

- Binding name: `GAME_ROOM`
- Class name: `GameRoomDurableObject`
- Storage migration uses SQLite Durable Objects.

The Durable Object owns one room per object id. Named ids must also be valid room ids.

Implemented HTTP endpoints on the Durable Object stub:

- `POST /room`: creates a lobby if no loadable, non-expired private room envelope exists, or loads the existing room. Missing, expired, or corrupt envelopes are replaced by a new lobby and any stored private generated item keys for the object are deleted. The host capability token and full public snapshot are returned only for a newly created room; existing rooms return only an invite preview.
- `GET /room`: returns only the invite preview.
- `POST /room/access`: accepts `{ credential }`, authorizes access for the host or current guest, and returns the full public room snapshot.
- `POST /room/join`: joins one guest through the room command layer and returns the guest capability token only for the successful join.
- `POST /room/command`: decodes known host/player protocol commands and dispatches to the pure room command functions.
- `GET /room/socket` with `Upgrade: websocket`: validates the capability token from `Sec-WebSocket-Protocol`, authorizes room access, and upgrades to a hibernatable Durable Object WebSocket using `acceptWebSocket`.

Both `POST /room/join` and `POST /room/command` purge a missing, expired, or invalid stored envelope (private generated items, the room envelope, any pending-effect marker, and the alarm) in the same storage transaction as the error they return, mirroring the cleanup-alarm behavior below. Without this, an envelope that fails to decode would return the same error on every subsequent request against that room object until its already-scheduled alarm eventually fired - up to `ABANDONED_ROOM_TTL_MS` later for a room with no sooner turn-clock or pending-settlement deadline armed. The next request against the same room object instead sees `room_not_found` (missing), not a repeat of the original error.

Private room state is stored through the room persistence envelope and loaded through the persistence decoder. Unauthenticated invite reads never include game state. Authenticated clients receive public snapshots only; persistence metadata and token hashes must never be returned. Capability token secrets and hashes are generated with Worker crypto, and Durable Object storage stores only hashes.

The persistence envelope carries a version, and decoding is a hard cutover: `ROOM_PERSISTENCE_VERSION` and `ROOM_PERSISTENCE_MIN_SUPPORTED_VERSION` in `src/lib/room/persistence.ts` move together (currently 4) and there is no read-time migration chain, so an envelope tagged with any other version fails decode with `persistence_version_unsupported` and the existing self-heal paths purge it so the room reads as never-created. Version bumps happen once per phase that changes persisted shapes (see D2 in `specs/cleanup/MVP_CLEANUP_PLAN.md`).

## Room Presence

The Durable Object is the authoritative source for live room presence:

- Presence is public, non-secret, ephemeral data made only of live booleans for Player A and Player B.
- Presence is computed from currently accepted hibernatable WebSockets. A socket counts only when its attachment has the current room id, the correct role, and a token hash matching the current host or guest seat.
- Presence is never written to Durable Object storage or room persistence envelopes.
- Seat occupancy is not live presence. An occupied guest seat means the room has a current guest token hash; it does not prove Player B has an accepted socket.
- Every authenticated public room snapshot includes presence booleans. Presence-only snapshots can keep the same room revision because the room state did not mutate.
- HTTP joins, HTTP commands, WebSocket commands, and authenticated access responses use the same `currentRoomPresence` source when returning full public snapshots.

Presence does not gate any room command (F-04). `START_ROOM` and `ADVANCE_ROUND` (both non-final and final-round, which moves the room to `finished` with a `gameOver` game state) succeed regardless of whether Player B is connected. An idle or absent opponent is instead handled by the F-05 turn shot clock, which forfeits the round they are on the clock for; presence is a purely cosmetic connection indicator in the snapshot.

## Private Item Storage And Effects

The Durable Object is the gameplay authority for generated item values and settlement:

- Private generated items are stored separately from the room envelope under keys derived from `round_id`.
- The stored private item includes `true_value`. The public room state receives only `round_id`, `item_title`, `category`, and `context_clue` until settlement.
- After a successful `START_ROOM` or `ADVANCE_ROUND` command leaves the room in `active/generatingItem`, the Durable Object derives the round's item from the static deck (`itemForRound` in `src/worker/static-deck.ts`) and synchronously stores the private item, dispatches `ITEM_RECEIVED`, persists the updated room envelope, and broadcasts only the final public snapshot - all inside the same storage transaction as the command itself.
- There is no provider-failure path: the deck pick cannot fail, so the Durable Object never dispatches `ITEM_FAILED`.
- After a successful `EXECUTE_TRADE` command commits the trade, settlement completes synchronously inside the same storage transaction: the Durable Object derives the settled item from the static deck keyed by the active `round_id` (`settledDeckItemForRoom`), dispatches `SETTLEMENT_RECEIVED` through the room command layer, persists the room envelope once, and broadcasts the final public settlement snapshot. Clients never supply settlement fields.
- Successful `RESET_TO_LOBBY` and `KICK_GUEST` commands persist the lobby replacement and delete all `room:private-generated-item:v1:*` keys for the room object in the same storage transaction.
- Room envelope writes schedule a Durable Object alarm for the room persistence expiration. When the alarm runs and the room envelope is missing, expired, or invalid, the Durable Object deletes all `room:private-generated-item:v1:*` keys and clears the alarm; if the room is still loadable, the alarm is rescheduled to the current room expiration.

## Turn Shot Clock Alarm (F-05)

A Durable Object has exactly one alarm slot. `scheduleNextAlarm` multiplexes it across up to three candidate deadlines and arms it at whichever is soonest:

1. The room's TTL expiration (unchanged, see above).
2. The F-08 socket-liveness sweep deadline: the earliest time at which some currently-connected room socket would go stale with no further auto-response (`nextLivenessSweepDeadline`, recomputed from live socket state on every call; `null` - contributing no deadline - when no sockets are connected).
3. The F-05 turn shot clock's `turnDeadlineMs`, read directly off the room's current game state rather than a separate persisted marker - it is already durable as part of the committed room envelope for the four turn-clocked phases (`proposingWidth`, `negotiatingWidth`, `configuringMarket`, `choosingSide`).

When the alarm fires and a turn deadline is the one that is due, the Durable Object re-loads the room in a fresh transaction, re-validates that the same phase and deadline are still outstanding, and only then dispatches `TURN_EXPIRED` through the room command layer and persists the result. This re-validation is what keeps a stale alarm wake from forfeiting a round that has already advanced past that phase.

If the alarm fires while the room envelope is missing, expired, or invalid, the Durable Object purges the room's private items, envelope, and any pending markers exactly as the plain TTL case above - a turn deadline being simultaneously outstanding does not suppress this cleanup.

## Room WebSocket Contract

The Durable Object WebSocket transport is authoritative for live room updates. On connect, the object requires the client to request the `tt-room-v1` subprotocol plus `tt-role-<host|guest>` and `tt-secret-<capability-secret>` values in `Sec-WebSocket-Protocol`. Missing or invalid tokens, stale kicked guest tokens, and missing/expired/invalid envelopes return a normal non-`101` JSON error response when the upgrade can still be rejected. Valid upgrades echo only `tt-room-v1`, attach role plus token hash metadata to the hibernatable socket, return `101`, and immediately send:

```json
{ "type": "ROOM_SNAPSHOT", "room": "<public room snapshot>" }
```

After accepting a valid socket, the Durable Object also rebroadcasts the updated public snapshot to remaining authorized sockets so they see the new presence state. WebSocket close and error events rebroadcast updated public snapshots with the departing socket excluded from presence. These presence rebroadcasts do not persist anything, can carry the same room revision, and must never expose capability secrets, token hashes, persistence envelopes, or private generated values.

Incoming text messages are JSON client room commands with the same shape accepted by `POST /room/command`. `JOIN_ROOM` is rejected on WebSocket because `POST /room/join` generates the guest token. Malformed JSON, invalid protocol messages, authorization failures, and domain errors are sent only to the sender as:

```json
{ "type": "ROOM_ERROR", "error": { "code": "<code>", "message": "<message>" } }
```

Successful WebSocket commands are dispatched through the same room command layer as HTTP commands (presence is not an input to dispatch - see Room Presence above), persisted as room persistence envelopes, and broadcast as `ROOM_SNAPSHOT` only to sockets whose attached token hash still matches the current host or guest seat. Stale kicked/reset/replaced guest sockets are closed before broadcast. Successful HTTP joins and HTTP commands also broadcast a new public snapshot so HTTP and WebSocket clients remain synchronized.

## Environment

- `ASSETS` serves OpenNext assets.
- `NEXT_PUBLIC_APP_ENV` may distinguish local, preview, and production deployments.

## Gates

Cloudflare-facing changes should pass:

- `npm run worker-test`
- `npm run build:cloudflare`

Shared app changes should also pass lint, typecheck, unit tests, and the Next build.
