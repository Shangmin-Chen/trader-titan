# Cloudflare Worker Spec

The Cloudflare target uses OpenNext for the existing Next app and a Durable Object class for authoritative room state.

## Worker Entry

- Wrangler `main` points to `src/worker/index.ts`.
- The Worker delegates normal app requests to the generated OpenNext worker at `.open-next/worker.js`.
- Worker tests alias that generated worker to a smoke implementation before the OpenNext build artifact exists.
- Legacy process-local game routes (`/api/generate-item`, `/api/generate-custom-amazon-item`, `/api/commit-market`, and `/api/settle-round`) are rejected by the Worker with `410` before OpenNext can serve them.

## Public Room Routes

The Worker exposes room routes before delegating unmatched requests to OpenNext:

- `POST /api/rooms`: generates a valid room id, forwards the request body to that room object's `POST /room`, and returns the Durable Object response. Newly created rooms return the host capability token and the full public room snapshot.
- `GET /api/rooms/:roomId`: validates `roomId` and forwards to `GET /room`, which returns only a minimal invite preview with host name, lifecycle, joinability, and guest occupancy.
- `POST /api/rooms/:roomId/access`: validates `roomId` and forwards to `POST /room/access`, which requires a host or current guest capability token and returns the full public room snapshot.
- `POST /api/rooms/:roomId/join`: validates `roomId` and forwards to `POST /room/join`.
- `POST /api/rooms/:roomId/command`: validates `roomId` and forwards to `POST /room/command`.
- `POST /api/rooms/:roomId/custom-amazon-item`: validates `roomId` and forwards to `POST /room/custom-amazon-item`.
- `GET /api/rooms/:roomId/socket` with `Upgrade: websocket`: validates `roomId` and forwards to the room object's WebSocket endpoint. Socket auth is carried in `Sec-WebSocket-Protocol`, not the URL.

Room ids are validated with the room-domain parser before `idFromName` is called. Non-room routes continue to delegate to OpenNext unchanged.

Public room POST routes and public WebSocket upgrades reject browser requests whose `Origin` does not match the request URL origin before forwarding to the Durable Object. Requests without an `Origin` header remain allowed for non-browser clients and server-to-server calls. Rejections use Worker-style JSON with `403`:

```json
{ "ok": false, "error": { "code": "origin_not_allowed", "message": "Request origin is not allowed." } }
```

`POST /api/rooms` and `POST /api/rooms/:roomId/custom-amazon-item` also apply bounded in-memory per-Cloudflare-client-IP rate limiting before forwarding. Normal room joins, access, command gameplay, and socket messages are not broadly rate-limited by this guard. Limit rejections use Worker-style JSON with `429`:

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
- `POST /room/custom-amazon-item`: accepts `{ credential, query }`, authorizes the credential as the current trader while the active room is in `generatingItem` with `customAmazonQuery: true` (the default for every mode unless the room opted into `aiGenerated`), generates the item from the query, stores the private item, dispatches `ITEM_RECEIVED`, and returns the public snapshot.
- `GET /room/socket` with `Upgrade: websocket`: validates the capability token from `Sec-WebSocket-Protocol`, authorizes room access, and upgrades to a hibernatable Durable Object WebSocket using `acceptWebSocket`.

Private room state is stored through the room persistence envelope and loaded through the persistence decoder. Unauthenticated invite reads never include game state. Authenticated clients receive public snapshots only; persistence metadata and token hashes must never be returned. Capability token secrets and hashes are generated with Worker crypto, and Durable Object storage stores only hashes.

## Room Presence

The Durable Object is the authoritative source for live room presence:

- Presence is public, non-secret, ephemeral data made only of live booleans for Player A and Player B.
- Presence is computed from currently accepted hibernatable WebSockets. A socket counts only when its attachment has the current room id, the correct role, and a token hash matching the current host or guest seat.
- Presence is never written to Durable Object storage or room persistence envelopes.
- Seat occupancy is not live presence. An occupied guest seat means the room has a current guest token hash; it does not prove Player B has an accepted socket.
- Every authenticated public room snapshot includes presence booleans. Presence-only snapshots can keep the same room revision because the room state did not mutate.
- HTTP joins, HTTP commands, WebSocket commands, and authenticated access responses use the same `currentRoomPresence` source when dispatching commands or returning full public snapshots.

`START_ROOM` is rejected with `player_offline` when Player B is disconnected. `ADVANCE_ROUND` is also rejected with `player_offline` for non-final settlements while Player B is disconnected. Final-round `ADVANCE_ROUND` that moves the room to `finished` with a `gameOver` game state remains allowed while Player B is disconnected.

## Private Item Storage And Effects

The Durable Object is the gameplay authority for generated item values and settlement:

- Private generated items are stored separately from the room envelope under keys derived from `round_id`.
- The stored private item includes `true_value` plus optional Amazon scrape metadata. The public room state receives only `round_id`, `item_title`, `category`, and `context_clue` until settlement.
- After a successful `START_ROOM`, `ADVANCE_ROUND`, or `RETRY_ITEM_GENERATION` command leaves the room in `active/generatingItem`, the Durable Object automatically invokes the Worker item provider, stores the private item, dispatches `ITEM_RECEIVED`, persists the updated room envelope, and broadcasts only the final public snapshot.
- Automatic generation is skipped for rooms with `customAmazonQuery: true` (any mode); those rooms wait for `POST /room/custom-amazon-item` or the equivalent public route, including after `RETRY_ITEM_GENERATION` returns a failed custom-query room to `generatingItem`.
- After a successful `EXECUTE_TRADE` command leaves the room in `settling`, the Durable Object loads the private item by the active `round_id`, dispatches `SETTLEMENT_RECEIVED`, persists the room envelope, deletes that round's private item key in the same storage transaction after the room envelope write, and broadcasts the final settlement snapshot. Settlement is computed by the room command layer from the stored private item and active quote; clients never supply settlement fields.
- If provider generation fails, including after a retry command, the Durable Object dispatches `ITEM_FAILED` and persists the room error snapshot without resetting scores, roles, lifecycle, or prior log entries. If the private settlement item is missing, it dispatches `SETTLEMENT_FAILED` rather than accepting client-provided values.
- Successful `RESET_TO_LOBBY` and `KICK_GUEST` commands persist the lobby replacement and delete all `room:private-generated-item:v1:*` keys for the room object in the same storage transaction.
- Room envelope writes schedule a Durable Object alarm for the room persistence expiration. When the alarm runs and the room envelope is missing, expired, or invalid, the Durable Object deletes all `room:private-generated-item:v1:*` keys and clears the alarm; if the room is still loadable, the alarm is rescheduled to the current room expiration.

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

Successful WebSocket commands are dispatched through the room command layer with the same presence source used by HTTP commands, persisted as room persistence envelopes, and broadcast as `ROOM_SNAPSHOT` only to sockets whose attached token hash still matches the current host or guest seat. Stale kicked/reset/replaced guest sockets are closed before broadcast. Successful HTTP joins and HTTP commands also broadcast a new public snapshot so HTTP and WebSocket clients remain synchronized.

## Environment

- `ASSETS` serves OpenNext assets.
- `GEMINI_API_KEY` is available as a secret for provider-backed generation.
- `NEXT_PUBLIC_APP_ENV` may distinguish local, preview, and production deployments.

## Gates

Cloudflare-facing changes should pass:

- `npm run worker-test`
- `npm run build:cloudflare`

Shared app changes should also pass lint, typecheck, unit tests, and the Next build.
