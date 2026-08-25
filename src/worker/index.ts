/**
 * This module is the Worker's entrypoint (see wrangler config `main`).
 * workerd inspects every named export of an entrypoint module and requires
 * each one to be either an `ExportedHandler` (the `default` export) or a
 * class usable as a Durable Object / service binding (`GameRoomDurableObject`
 * below). A plain value or function export that is neither fails the whole
 * service at boot with "Incorrect type for map entry ...: the provided
 * value is not of type 'function or ExportedHandler'" - not a build error,
 * not a test failure, a boot failure that only surfaces once something
 * actually starts this module as a service (`wrangler dev`, a real deploy).
 *
 * Do not add another named export here. If a constant or helper needs to be
 * shared with a test file, put it in a non-entrypoint module (e.g.
 * ../lib/room-socket-supervisor.ts, alongside what gives it meaning) and
 * import it into both sides instead. entrypoint-exports.worker-test.ts
 * (`npm run worker-test`) asserts this module's export surface directly -
 * see that file before disabling or working around it.
 */
import { DurableObject } from "cloudflare:workers";
import openNextWorker from "../../.open-next/worker.js";
import {
  createRoomCreationRateLimiter,
  isAllowedOrigin
} from "../api/request-guards";
import type {
  GeneratedItem,
  GameState,
  GeneratingItemGameState,
  SettledGeneratedItem,
  SettlingGameState
} from "../lib/game";
import {
  authorizeRoomAccess,
  authorizeRoomAction,
  createLobbyRoom,
  dispatchRoomCommand,
  dispatchSystemRoomEvent,
  loadPersistenceEnvelope,
  parseClientRoomCommand,
  parseCapabilityToken,
  parseRoomId,
  parseRoomGameConfigPatch,
  parseTokenHash,
  roomExpiresAtMs,
  setRoomMaxTotalRounds,
  toPersistenceEnvelope,
  toPublicRoomInvitePreview,
  toPublicRoomSnapshot,
  type CapabilityRole,
  type ClientRoomCommand,
  type PublicRoomInvitePreview,
  type PresentedCapabilityToken,
  type PublicRoomSnapshot,
  type RoomCapabilityToken,
  type RoomDomainError,
  type RoomGameConfig,
  type RoomId,
  type RoomPresence,
  type RoomProtocolDecodeError,
  type RoomState,
  type TokenHash,
  type TokenVerifier,
  type UnixTimeMs
} from "../lib/room";
import { itemForRound, maxRoundsForDeck } from "./static-deck";
import {
  ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS,
  ROOM_SOCKET_LIVENESS_SWEEP_CLOSE_CODE
} from "../lib/room-socket-supervisor";

// D3: a match can never outlive its item variety - cap totalRounds at the
// static deck's per-mode length for every config decoded by this Worker.
setRoomMaxTotalRounds(maxRoundsForDeck());

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const ROOM_ENDPOINT = "/room";
const ROOM_ACCESS_ENDPOINT = "/room/access";
const ROOM_JOIN_ENDPOINT = "/room/join";
const ROOM_COMMAND_ENDPOINT = "/room/command";
const ROOM_SOCKET_ENDPOINT = "/room/socket";
const ROOM_TEST_EXPIRE_TURN_ENDPOINT = "/room/test-expire-turn";
const PUBLIC_ROOMS_ENDPOINT = "/api/rooms";
const PUBLIC_TEST_EXPIRE_TURN_ROUTE = "test-expire-turn";
/**
 * Test-only affordance for e2e coverage of the F-05 shot clock (PR #18,
 * "Add e2e coverage of the shot clock"). Real turn durations are 30-60s
 * (see *_TURN_DURATION_MS in src/lib/game/types.ts) - too slow for
 * Playwright to honestly sleep out. Rather than mocking the countdown or
 * the expiry logic, testExpireTurnSoon (below) fast-forwards a room's
 * already-armed, server-authoritative turnDeadlineMs to this many ms from
 * now and re-arms the *real* Durable Object alarm against it, so the
 * production alarm handler, reducer transition, persistence, and
 * WebSocket broadcast all still run for real - only the wait is
 * shortened. It is only reachable when this.env.WORKER_TEST_MODE is set
 * (see testExpireTurnSoon's own comment for why that is the gate), which is
 * never the case in a real deploy.
 */
const E2E_FAST_FORWARD_TURN_OFFSET_MS = 3_000;
const LEGACY_NEXT_GAME_API_PATHS = new Set([
  "/api/commit-market",
  "/api/generate-custom-amazon-item",
  "/api/generate-item",
  "/api/settle-round",
]);
const ROOM_STORAGE_KEY = "room:persistence:v1";
const ROOM_COMMAND_DEDUPE_STORAGE_KEY = "room:command-dedupe:v1";
// A rolling record of the most recently applied (actor, commandId) pairs.
// Bounded so storage never grows with a room's lifetime: since each
// successful command increments revision by exactly one, capping the record
// at this many entries is equivalent to only protecting replays of the last
// COMMAND_DEDUPE_MAX_ENTRIES committed commands, which comfortably covers a
// lost-ACK retry burst without needing per-room cleanup as rounds progress
// (rooms can run up to MAX_ROUNDS rounds).
const COMMAND_DEDUPE_MAX_ENTRIES = 64;
const ROOM_SOCKET_MESSAGE_ROOM_SNAPSHOT = "ROOM_SNAPSHOT";
const ROOM_SOCKET_MESSAGE_ROOM_ERROR = "ROOM_ERROR";
const ROOM_SOCKET_PROTOCOL = "tt-room-v1";
const ROOM_SOCKET_ROLE_PROTOCOL_PREFIX = "tt-role-";
const ROOM_SOCKET_SECRET_PROTOCOL_PREFIX = "tt-secret-";
const ROOM_SOCKET_PING_MESSAGE = "tt-ping";
const ROOM_SOCKET_PONG_MESSAGE = "tt-pong";
const HTTP_SWITCHING_PROTOCOLS_STATUS = 101;
const ROOM_ID_GENERATION_ATTEMPTS = 3;
const TOKEN_SECRET_BYTE_LENGTH = 32;
const BYTE_HEX_RADIX = 16;
const BYTE_HEX_PAD_LENGTH = 2;
const TOKEN_HASH_ALGORITHM = "SHA-256";
const TOKEN_HASH_PREFIX = "sha256";
const TOKEN_HASH_INPUT_PREFIX = "trader-titan.room-token.v1";
const rejectTokenVerification: TokenVerifier = () => false;
const publicRoomCreationRateLimiter = createRoomCreationRateLimiter();

type OpenNextWorker = Required<Pick<ExportedHandler<Cloudflare.Env>, "fetch">>;
type WorkerFetchContext = Parameters<OpenNextWorker["fetch"]>[2];
type WorkerFetchEnv = Parameters<OpenNextWorker["fetch"]>[1];
type WorkerFetchRequest = Parameters<OpenNextWorker["fetch"]>[0];
type JsonRecord = Record<string, unknown>;
type DecodedRoomCommand = Exclude<ClientRoomCommand, { type: "JOIN_ROOM" }>;
type CommandDedupeEntry = Readonly<{
  role: string;
  commandId: string;
  revision: number;
}>;

type RoomHttpError = Readonly<{
  code: string;
  message: string;
}>;

type RoomErrorResponse = Readonly<{
  ok: false;
  error: RoomHttpError | RoomDomainError;
}>;

type CreateRoomResponse =
  | Readonly<{
      ok: true;
      created: true;
      room: PublicRoomSnapshot;
      hostToken: RoomCapabilityToken;
    }>
  | Readonly<{
      ok: true;
      created: false;
      room: PublicRoomInvitePreview;
    }>;

type GetRoomResponse = Readonly<{
  ok: true;
  room: PublicRoomInvitePreview;
}>;

type AccessRoomResponse = Readonly<{
  ok: true;
  room: PublicRoomSnapshot;
}>;

type JoinRoomResponse = Readonly<{
  ok: true;
  room: PublicRoomSnapshot;
  guestToken: RoomCapabilityToken;
}>;

type CommandRoomResponse = Readonly<{
  ok: true;
  room: PublicRoomSnapshot;
}>;

type CreateRoomBody = Readonly<{
  hostName: string;
  config?: Partial<RoomGameConfig>;
}>;

type JoinRoomBody = Readonly<{
  guestName: string;
}>;

type AccessRoomBody = Readonly<{
  credential: PresentedCapabilityToken;
}>;

type BodyDecodeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; response: Response }>;

type StoredRoomLoadResult =
  | Readonly<{ ok: true; room: RoomState }>
  | Readonly<{
      ok: false;
      reason: "missing" | "expired" | "invalid";
      error: RoomHttpError | RoomDomainError;
    }>;

type StoredRoomCommandResult =
  | Readonly<{ ok: true; room: RoomState }>
  | Readonly<{ ok: false; status: number; error: RoomHttpError | RoomDomainError }>;

type CreateOrLoadRoomResult =
  | Readonly<{ ok: true; created: true; room: RoomState }>
  | Readonly<{ ok: true; created: false; room: RoomState }>
  | Readonly<{ ok: false; status: number; error: RoomHttpError | RoomDomainError }>;

/**
 * runDueTurnExpiry's own transaction result: distinguishes "nothing about
 * the room actually changed" (a stale wake, a rejected event, or the room
 * having already expired) from "TURN_EXPIRED genuinely committed", since
 * only the latter needs a broadcast afterward. A committed F-06
 * choosingSide timeout settles in the SAME transaction (see
 * settledDeckItemForRoom), so the caller only ever broadcasts the final,
 * already-settled room.
 */
type TurnExpiryOutcome =
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "committed"; room: RoomState }>;

type RoomSocketAttachment = Readonly<{
  kind: "trader-titan.room-socket.v1";
  roomId: RoomId;
  role: CapabilityRole;
  tokenHash: TokenHash;
  /**
   * Acceptance time, used only as the liveness sweep's fallback "last seen"
   * signal (see socketLastSeenMs) for a socket that has not yet had its
   * first edge auto-response recorded - getWebSocketAutoResponseTimestamp
   * returns null until then. Not presence: presence stays derived solely
   * from ctx.getWebSockets() membership and is never persisted.
   *
   * Optional deliberately: a socket accepted by pre-deploy code before this
   * field existed hibernates with an attachment that lacks it, and that
   * attachment keeps arriving at parseRoomSocketAttachment for the lifetime
   * of the socket - hibernation does not re-run acceptRoomSocket. Every
   * attachment-consuming path other than socketLastSeenMs (snapshot
   * eligibility, presence, the per-seat eviction match) never looked at this
   * field at all, so treating it as required there would only have made a
   * liveness-only concern reject the whole attachment. See socketLastSeenMs
   * for how a missing value is treated for liveness purposes - including
   * that socketLastSeenMs itself is the *other* writer of this field: for a
   * legacy socket lacking it entirely, socketLastSeenMs memoizes a
   * first-observed time back onto this same field via serializeAttachment
   * the first time it is asked, rather than leaving the gap open forever.
   */
  acceptedAtMs?: UnixTimeMs;
}>;

type RoomSocketError = RoomHttpError | RoomDomainError | RoomProtocolDecodeError;

type RoomSocketMessage =
  | Readonly<{
      type: typeof ROOM_SOCKET_MESSAGE_ROOM_SNAPSHOT;
      room: PublicRoomSnapshot;
    }>
  | Readonly<{
      type: typeof ROOM_SOCKET_MESSAGE_ROOM_ERROR;
      error: RoomSocketError;
    }>;

type RoomSocketBroadcastOptions = Readonly<{
  excludeRecipient?: WebSocket;
  presence?: RoomPresence;
}>;

/**
 * Owns the private room state for one Cloudflare Durable Object id.
 *
 * The object persists only the private room persistence envelope and returns
 * public snapshots to clients so transport code cannot leak credential hashes.
 */
export class GameRoomDurableObject extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    // The DO uses the Hibernation API (acceptWebSocket below), so an
    // application-level ping/pong would wake this object on every heartbeat
    // and bill for it. The edge auto-responder replies to "tt-ping" with
    // "tt-pong" without waking the DO, keeping idle sockets alive through
    // intermediaries during long thinking turns.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(ROOM_SOCKET_PING_MESSAGE, ROOM_SOCKET_PONG_MESSAGE)
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = normalizePathname(url.pathname);

    if (hasWebSocketUpgrade(request)) {
      if (pathname !== ROOM_SOCKET_ENDPOINT) {
        return errorResponse(
          { code: "not_found", message: "Room WebSocket endpoint was not found." },
          404
        );
      }

      return this.acceptRoomSocket(request);
    }

    if (pathname === ROOM_ENDPOINT && request.method === "POST") {
      return this.createOrLoadRoom(request);
    }

    if (pathname === ROOM_ENDPOINT && request.method === "GET") {
      return this.getRoom();
    }

    if (pathname === ROOM_ACCESS_ENDPOINT && request.method === "POST") {
      return this.accessRoom(request);
    }

    if (pathname === ROOM_JOIN_ENDPOINT && request.method === "POST") {
      return this.joinRoom(request);
    }

    if (pathname === ROOM_COMMAND_ENDPOINT && request.method === "POST") {
      return this.applyRoomCommand(request);
    }

    if (pathname === ROOM_TEST_EXPIRE_TURN_ENDPOINT && request.method === "POST") {
      return this.testExpireTurnSoon(request);
    }

    if (
      pathname === ROOM_ENDPOINT ||
      pathname === ROOM_ACCESS_ENDPOINT ||
      pathname === ROOM_JOIN_ENDPOINT ||
      pathname === ROOM_COMMAND_ENDPOINT ||
      pathname === ROOM_SOCKET_ENDPOINT ||
      pathname === ROOM_TEST_EXPIRE_TURN_ENDPOINT
    ) {
      return errorResponse(
        { code: "method_not_allowed", message: "HTTP method is not supported for this room endpoint." },
        405
      );
    }

    return errorResponse(
      { code: "not_found", message: "Room endpoint was not found." },
      404
    );
  }

  private async createOrLoadRoom(request: Request): Promise<Response> {
    const body = await decodeCreateRoomBody(request);

    if (!body.ok) {
      return body.response;
    }

    const roomId = this.roomId();

    if (!roomId.ok) {
      return roomId.response;
    }

    const nowMs = currentUnixTimeMs();
    const hostToken = generateCapabilityToken("host", roomId.roomId);
    const hostTokenHash = await hashCapabilityToken(hostToken);
    const result = await this.ctx.storage.transaction(async (transaction) =>
      this.createOrLoadStoredRoom(
        transaction,
        roomId.roomId,
        body.value,
        hostTokenHash,
        nowMs
      )
    );

    if (!result.ok) {
      return errorResponse(result.error, result.status);
    }

    if (!result.created) {
      return jsonResponse<CreateRoomResponse>({
        ok: true,
        created: false,
        room: toPublicRoomInvitePreview(result.room)
      });
    }

    return jsonResponse<CreateRoomResponse>(
      {
        ok: true,
        created: true,
        room: this.publicRoomSnapshot(result.room),
        hostToken
      },
      201
    );
  }

  private async getRoom(): Promise<Response> {
    const nowMs = currentUnixTimeMs();
    const loaded = await this.loadStoredRoom(nowMs);

    if (!loaded.ok) {
      return errorResponse(loaded.error, statusForStoredRoomLoadFailure(loaded));
    }

    return jsonResponse<GetRoomResponse>({
      ok: true,
      room: toPublicRoomInvitePreview(loaded.room)
    });
  }

  private async accessRoom(request: Request): Promise<Response> {
    const decoded = await decodeAccessRoomBody(request);

    if (!decoded.ok) {
      return decoded.response;
    }

    const verifyToken = await buildTokenVerifier(decoded.value.credential);
    const loaded = await this.loadStoredRoom(currentUnixTimeMs());

    if (!loaded.ok) {
      return errorResponse(loaded.error, statusForStoredRoomLoadFailure(loaded));
    }

    const authorized = authorizeRoomAction(
      loaded.room,
      decoded.value.credential,
      { type: "access" },
      verifyToken
    );

    if (!authorized.ok) {
      return errorResponse(authorized.error, statusForDomainError(authorized.error));
    }

    return jsonResponse<AccessRoomResponse>({
      ok: true,
      room: this.publicRoomSnapshot(loaded.room)
    });
  }

  private async joinRoom(request: Request): Promise<Response> {
    const body = await decodeJoinRoomBody(request);

    if (!body.ok) {
      return body.response;
    }

    const roomId = this.roomId();

    if (!roomId.ok) {
      return roomId.response;
    }

    const guestToken = generateCapabilityToken("guest", roomId.roomId);
    const guestTokenHash = await hashCapabilityToken(guestToken);
    const nowMs = currentUnixTimeMs();
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const loaded = loadStoredRoomEnvelope(
        await transaction.get<unknown>(ROOM_STORAGE_KEY),
        nowMs
      );

      if (!loaded.ok) {
        // B1: purge here too (not just on the alarm path - see alarm() and
        // purgeExpiredRoomState) so a room whose envelope cannot be loaded
        // self-heals into "missing" (404) after being observed once,
        // instead of returning the same status on every join attempt until
        // whatever deadline this room's now-orphaned alarm was scheduled
        // against eventually fires - up to ABANDONED_ROOM_TTL_MS later.
        await purgeExpiredRoomState(transaction);
        return {
          ok: false,
          status: statusForStoredRoomLoadFailure(loaded),
          error: loaded.error
        } as const;
      }

      const joined = dispatchRoomCommand(
        loaded.room,
        {
          type: "JOIN_ROOM",
          guestName: body.value.guestName,
          guestTokenHash,
          nowMs
        },
        {
          verifyToken: rejectTokenVerification
        }
      );

      if (!joined.ok) {
        return {
          ok: false,
          status: statusForDomainError(joined.error),
          error: joined.error
        } as const;
      }

      await this.persistRoomEnvelope(transaction, joined.room, nowMs);

      return {
        ok: true,
        room: joined.room
      } as const;
    });

    if (!result.ok) {
      return errorResponse(result.error, result.status);
    }

    this.broadcastRoomSnapshot(result.room);

    return jsonResponse<JoinRoomResponse>({
      ok: true,
      room: this.publicRoomSnapshot(result.room),
      guestToken
    });
  }

  private async applyRoomCommand(request: Request): Promise<Response> {
    const decoded = await decodeRoomCommandBody(request, currentUnixTimeMs());

    if (!decoded.ok) {
      return decoded.response;
    }

    const verifyToken = await buildTokenVerifier(decoded.value.credential);
    const nowMs = decoded.value.nowMs;
    const result = await this.applyDecodedRoomCommand(
      decoded.value,
      verifyToken,
      nowMs
    );

    if (!result.ok) {
      return errorResponse(result.error, result.status);
    }

    this.broadcastRoomSnapshot(result.room);

    return jsonResponse<CommandRoomResponse>({
      ok: true,
      room: this.publicRoomSnapshot(result.room)
    });
  }

  /**
   * Test-only (see E2E_FAST_FORWARD_TURN_OFFSET_MS above): fast-forwards
   * the room's currently-armed F-05 turn deadline to a few seconds from
   * now and re-arms the real Durable Object alarm against it, instead of
   * requiring a Playwright test to sleep out the genuine 30-60s duration.
   * Everything downstream of the deadline - the alarm firing, TURN_EXPIRED
   * dispatch, the settling/roundForfeited transition, persistence, and the
   * WebSocket broadcast - still runs through the exact same production
   * code path a real deadline would trigger; only the wait is shortened.
   *
   * Gated on this.env.WORKER_TEST_MODE being set - a dedicated var with no
   * meaning anywhere else in this codebase and no legitimate reason to be
   * set on a real deploy. It deliberately does not double as any other
   * operational override: nothing else in this file reads it, so setting it
   * can only ever be a deliberate, test-specific choice (see
   * playwright.config.ts and vitest.worker.config.ts).
   *
   * Authorization below is intentionally `{ type: "access" }` rather than
   * `{ type: "activePlayer" }`: this lets *either* seated player expire the
   * *other* player's active turn, not just their own. That is load-bearing
   * for the e2e helper (e2e/helpers.ts's fastForwardTurnClock), which forces
   * the guest's turn from the host's page. This is safe specifically
   * because it is unreachable outside test/dev once the gate above holds -
   * it does not, and must not, ship as a general "either player can expire
   * either player's clock" affordance in production; do not loosen it
   * without also reconsidering this gate.
   */
  private async testExpireTurnSoon(request: Request): Promise<Response> {
    if (this.env.WORKER_TEST_MODE === undefined) {
      return errorResponse(
        { code: "not_found", message: "Room endpoint was not found." },
        404
      );
    }

    const decoded = await decodeAccessRoomBody(request);

    if (!decoded.ok) {
      return decoded.response;
    }

    const verifyToken = await buildTokenVerifier(decoded.value.credential);
    const nowMs = currentUnixTimeMs();

    const result = await this.ctx.storage.transaction(async (transaction) => {
      const loaded = loadStoredRoomEnvelope(
        await transaction.get<unknown>(ROOM_STORAGE_KEY),
        nowMs
      );

      if (!loaded.ok) {
        return {
          ok: false,
          status: statusForStoredRoomLoadFailure(loaded),
          error: loaded.error
        } as const;
      }

      const authorized = authorizeRoomAction(
        loaded.room,
        decoded.value.credential,
        { type: "access" },
        verifyToken
      );

      if (!authorized.ok) {
        return {
          ok: false,
          status: statusForDomainError(authorized.error),
          error: authorized.error
        } as const;
      }

      if (
        loaded.room.game.phase !== "proposingWidth" &&
        loaded.room.game.phase !== "negotiatingWidth" &&
        loaded.room.game.phase !== "configuringMarket" &&
        loaded.room.game.phase !== "choosingSide"
      ) {
        return {
          ok: false,
          status: 409,
          error: {
            code: "invalid_game_phase",
            message: "Room has no active turn clock to fast-forward."
          }
        } as const;
      }

      const patchedRoom: RoomState = {
        ...loaded.room,
        game: { ...loaded.room.game, turnDeadlineMs: nowMs + E2E_FAST_FORWARD_TURN_OFFSET_MS },
        revision: loaded.room.revision + 1
      };

      await this.persistRoomEnvelope(transaction, patchedRoom, nowMs);

      return { ok: true, room: patchedRoom } as const;
    });

    if (!result.ok) {
      return errorResponse(result.error, result.status);
    }

    this.broadcastRoomSnapshot(result.room);

    return jsonResponse<CommandRoomResponse>({
      ok: true,
      room: this.publicRoomSnapshot(result.room)
    });
  }

  private async acceptRoomSocket(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return errorResponse(
        { code: "method_not_allowed", message: "Room WebSocket upgrades must use GET." },
        405
      );
    }

    const roomId = this.roomId();

    if (!roomId.ok) {
      return roomId.response;
    }

    const credential = decodeSocketCredential(request, roomId.roomId);

    if (!credential.ok) {
      return credential.response;
    }

    const nowMs = currentUnixTimeMs();
    const loaded = await this.loadStoredRoom(nowMs);

    if (!loaded.ok) {
      return errorResponse(loaded.error, statusForStoredRoomLoadFailure(loaded));
    }

    const verifyToken = await buildTokenVerifier(credential.value);
    const authorized = authorizeRoomAction(
      loaded.room,
      credential.value,
      { type: "access" },
      verifyToken
    );

    if (!authorized.ok) {
      return errorResponse(authorized.error, statusForDomainError(authorized.error));
    }

    const credentialToken = parseCapabilityToken(credential.value);

    if (!credentialToken.ok) {
      return errorResponse(
        { code: "invalid_request", message: "Room socket requires a valid player credential." },
        400
      );
    }

    const tokenHash = await hashCapabilityToken(credentialToken.token);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.serializeAttachment({
      kind: "trader-titan.room-socket.v1",
      roomId: roomId.roomId,
      role: credentialToken.token.role,
      tokenHash,
      acceptedAtMs: nowMs
    } satisfies RoomSocketAttachment);

    // One seat, one socket: evict any prior live socket for this exact
    // (roomId, role, tokenHash) before accepting the new one, so a zombie
    // socket the edge has not reaped yet cannot mask a genuine disconnect
    // once client reconnect logic lands.
    for (const existingSocket of this.ctx.getWebSockets()) {
      const existingAttachment = parseRoomSocketAttachment(
        existingSocket.deserializeAttachment()
      );

      if (
        existingAttachment !== null &&
        existingAttachment.roomId === roomId.roomId &&
        existingAttachment.role === credentialToken.token.role &&
        existingAttachment.tokenHash === tokenHash
      ) {
        closeSocketQuietly(existingSocket, "Room seat opened a new socket.");
      }
    }

    this.ctx.acceptWebSocket(server);
    const presence = this.currentRoomPresence(loaded.room);

    server.send(roomSnapshotSocketMessage(toPublicRoomSnapshot(loaded.room, presence)));
    this.broadcastRoomSnapshot(loaded.room, {
      excludeRecipient: server,
      presence
    });

    // F-08: fold this new socket's liveness deadline into the single alarm
    // slot now, rather than waiting for some unrelated future room mutation
    // to reschedule it. Without this, a room that sits open with a live
    // socket but no further commands (e.g. a lobby waiting on a second
    // player) would keep whatever far-future TTL-only deadline was already
    // armed, and this socket would never be checked for staleness until the
    // room itself expired.
    await this.rearmAlarmForLiveSockets(nowMs);

    return new Response(null, {
      headers: {
        "sec-websocket-protocol": ROOM_SOCKET_PROTOCOL
      },
      status: HTTP_SWITCHING_PROTOCOLS_STATUS,
      webSocket: client
    });
  }

  /**
   * WebSocket events can resume after hibernation, so each message reloads the
   * canonical room envelope before dispatching and persists only successful commands.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      sendSocketError(ws, {
        code: "invalid_request",
        message: "Room WebSocket messages must be JSON text commands."
      });

      return;
    }

    const decoded = decodeRoomCommandText(message, currentUnixTimeMs());

    if (!decoded.ok) {
      sendSocketError(ws, decoded.error);

      return;
    }

    const verifyToken = await buildTokenVerifier(decoded.command.credential);
    const result = await this.applyDecodedRoomCommand(
      decoded.command,
      verifyToken,
      decoded.command.nowMs
    );

    if (!result.ok) {
      sendSocketError(ws, result.error);

      return;
    }

    this.broadcastRoomSnapshot(result.room);
  }

  /**
   * A close the liveness sweep (alarm()) itself initiated also reaches this
   * handler once the close handshake completes - closing a hibernatable
   * WebSocket always fires webSocketClose(), regardless of who or what
   * requested the close - so a server-evicted stale socket rebroadcasts
   * presence through exactly this same path as an ordinary client-driven
   * disconnect. No separate presence-update wiring is needed in the sweep
   * itself.
   */
  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.broadcastPresenceChangeForSocket(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.broadcastPresenceChangeForSocket(ws);
  }

  /**
   * Multiplexes the Durable Object's single alarm slot between three
   * concerns: room TTL housekeeping, F-05's turn shot clock, and the F-08
   * liveness sweep (closing room sockets the client-side heartbeat cannot
   * itself detect as dead - see sweepStaleSockets). Synchronous settlement
   * (Phase 3) removed the fourth: a pending settle-effect marker and its
   * retry/backoff machinery no longer exist, because EXECUTE_TRADE now
   * settles inside its own single storage transaction.
   *
   * Each alarm invocation runs the liveness sweep unconditionally first (it
   * is cheap - a scan of this room's live sockets plus timestamp
   * comparisons, no storage I/O) and then figures out which *stored*
   * deadline - TTL or turn clock - actually fired, handling only that one.
   * Every write path that follows reschedules via scheduleNextAlarm() so
   * the slot never falls out of sync with whichever deadline is now
   * soonest. scheduleNextAlarm() recomputes the liveness deadline from live
   * sockets on every call (it is never persisted), so once the sweep above
   * has closed every stale socket (or there were none to begin with), a
   * room with no remaining sockets naturally drops the liveness term and
   * this alarm settles back to firing only for TTL/turn-clock purposes -
   * it does not re-arm itself forever.
   *
   * The liveness sweep is independent of the turn clock: it acts directly
   * on live sockets rather than on stored room state, so it can fire
   * alongside either (or neither) of them on the same tick. While idle
   * (no turn-clocked phase, no live sockets), the only armed deadline left
   * is the room's TTL.
   */
  async alarm(): Promise<void> {
    const nowMs = currentUnixTimeMs();

    this.sweepStaleSockets(nowMs);

    const due = await this.ctx.storage.transaction(async (transaction) => {
      const loaded = loadStoredRoomEnvelope(
        await transaction.get<unknown>(ROOM_STORAGE_KEY),
        nowMs
      );

      if (!loaded.ok) {
        await purgeExpiredRoomState(transaction);
        return null;
      }

      const turnDeadlineMs = turnDeadlineForRoom(loaded.room);

      if (turnDeadlineMs === null || nowMs < turnDeadlineMs) {
        // The room's TTL hasn't actually expired (loadStoredRoomEnvelope
        // would have reported that above), and the turn clock is not due,
        // so this tick is a no-op besides keeping the single alarm slot
        // pointed at whichever deadline - including the liveness sweep's -
        // is now soonest.
        await this.scheduleNextAlarm(transaction, loaded.room, nowMs);
        return null;
      }

      return { kind: "turnExpiry", room: loaded.room } as const;
    });

    if (due === null) {
      return;
    }

    await this.runDueTurnExpiry(due.room, nowMs);
  }

  /**
   * F-05 turn-clock resume: re-validates the room is still on the same
   * outstanding deadline before dispatching TURN_EXPIRED, exactly like the
   * old runDueSettleEffect re-checked phase/round_id before resuming
   * settlement. This is what keeps a stale alarm wake - the round already
   * advanced past the deadline that armed this wake, between alarm()'s outer
   * transaction and this one - from forfeiting a round that has already
   * moved on.
   *
   * F-06: when the expired deadline was choosingSide's, TURN_EXPIRED moves
   * the room into "settling". Since synchronous settlement (Phase 3) there
   * is no pending-effect marker to persist for it: the SETTLEMENT_RECEIVED
   * that resolves settling is composed in THIS SAME transaction (see
   * settledDeckItemForRoom), so the room is persisted and broadcast exactly
   * once, already in its final settlement state.
   */
  private async runDueTurnExpiry(room: RoomState, nowMs: UnixTimeMs): Promise<void> {
    const outcome: TurnExpiryOutcome = await this.ctx.storage.transaction(async (transaction) => {
      const loaded = loadStoredRoomEnvelope(
        await transaction.get<unknown>(ROOM_STORAGE_KEY),
        nowMs
      );

      if (!loaded.ok) {
        // The room expired in the gap between alarm()'s outer transaction
        // and this one. Purge fully rather than leaving an expired envelope
        // behind with no alarm armed to clean it up.
        await purgeExpiredRoomState(transaction);
        return { kind: "unchanged" };
      }

      const turnDeadlineMs = turnDeadlineForRoom(loaded.room);

      if (turnDeadlineMs === null || nowMs < turnDeadlineMs) {
        // Stale wake: the round already advanced out of the turn-clocked
        // phase (or a fresh deadline was stamped later than the one that
        // armed this alarm) between this alarm firing and being processed.
        // Reschedule against the freshly-loaded room instead of forfeiting
        // a round that has already moved on.
        await this.scheduleNextAlarm(transaction, loaded.room, nowMs);
        return { kind: "unchanged" };
      }

      const eventResult = dispatchSystemRoomEvent(loaded.room, {
        type: "TURN_EXPIRED",
        nowMs
      });

      if (!eventResult.ok) {
        // The reducer rejected TURN_EXPIRED even though the phase/deadline
        // check above passed (should not happen - this guard mirrors the
        // reducer's own phase guard exactly). Reschedule rather than
        // looping on an alarm that cannot make progress.
        await this.scheduleNextAlarm(transaction, loaded.room, nowMs);
        return { kind: "unchanged" };
      }

      // Only an F-06 choosingSide timeout lands in "settling" here; a
      // forfeit into "roundForfeited" carries nothing further to compose,
      // same as before synchronous settlement existed. Settling is transient:
      // resolve it in this same transaction so no un-decodable `settling`
      // envelope is ever persisted (the persistence decoder rejects the
      // phase outright as of v5).
      let committed = eventResult.room;

      if (isSettlingActiveRoom(committed)) {
        const settledResult = dispatchSystemRoomEvent(committed, {
          type: "SETTLEMENT_RECEIVED",
          item: settledDeckItemForRound(committed),
          nowMs
        });

        if (!settledResult.ok) {
          // Structurally unreachable right after TURN_EXPIRED succeeded
          // (settling -> settlement always mutates), but never loop on an
          // alarm that cannot make progress: leave the pre-expiry room
          // untouched and reschedule.
          await this.scheduleNextAlarm(transaction, loaded.room, nowMs);
          return { kind: "unchanged" };
        }

        committed = settledResult.room;
      }

      await this.persistRoomEnvelope(transaction, committed, nowMs);

      return { kind: "committed", room: committed };
    });

    if (outcome.kind === "unchanged") {
      return;
    }

    // Connected clients only ever hear about a room mutation through an
    // explicit broadcast - unlike every HTTP command handler, nothing here
    // is a request/response the caller is waiting on, so without this call
    // a genuinely expired clock would commit and persist correctly but
    // never reach a client sitting on an open WebSocket watching it happen,
    // which is exactly what the shot clock exists to do in real time.
    this.broadcastRoomSnapshot(outcome.room);
  }

  /**
   * A lost HTTP/WebSocket response after the Durable Object already committed
   * is a normal mobile-network event, and the client's only recourse is to
   * resend the identical command. The commandId dedupe check and its write
   * both run inside this same storage transaction as the dispatch itself, so
   * a replay can never race a fresh copy of the same command: a recognized
   * replay short-circuits to the current room (a no-op the revision guard on
   * the client makes safe to apply again) instead of re-running a command
   * whose safety would otherwise depend on the reducer's phase guard
   * happening to reject its own replay.
   */
  private async applyDecodedRoomCommand(
    command: DecodedRoomCommand,
    verifyToken: TokenVerifier,
    nowMs: UnixTimeMs
  ): Promise<StoredRoomCommandResult> {
    const commandResult = await this.ctx.storage.transaction(async (transaction) => {
      const loaded = loadStoredRoomEnvelope(
        await transaction.get<unknown>(ROOM_STORAGE_KEY),
        nowMs
      );

      if (!loaded.ok) {
        // B1: same self-heal as joinRoom above - see the comment there and
        // on purgeExpiredRoomState. This is the hot path: every player
        // command (SUBMIT_INITIAL_WIDTH, EXECUTE_TRADE, ...) routes through
        // here, so without this a genuinely undecodable envelope would
        // otherwise 500 on every single command from both players until
        // this room's alarm happens to fire.
        await purgeExpiredRoomState(transaction);
        return {
          ok: false,
          status: statusForStoredRoomLoadFailure(loaded),
          error: loaded.error
        } as const;
      }

      const dedupeEntries = loadCommandDedupeEntries(
        await transaction.get<unknown>(ROOM_COMMAND_DEDUPE_STORAGE_KEY)
      );

      if (findCommandDedupeEntry(dedupeEntries, command) !== undefined) {
        // A dedupe hit only means *some* past command from this role used
        // this commandId -- it says nothing about whether the credential on
        // *this* request is still valid right now. The room may have kicked
        // this guest or otherwise rotated tokens since then, so the replay
        // short-circuit must not skip the same access check the normal
        // dispatch path would have performed. Otherwise a kicked guest could
        // replay their own last (pre-kick) commandId forever and keep
        // reading the room's current state with no valid credential at all.
        const access = authorizeRoomAccess(loaded.room, command.credential, verifyToken);

        if (!access.ok) {
          return {
            ok: false,
            status: statusForDomainError(access.error),
            error: access.error
          } as const;
        }

        return {
          ok: true,
          room: loaded.room,
          replay: true
        } as const;
      }

      const commandResult = dispatchRoomCommand(
        loaded.room,
        command,
        {
          verifyToken
        }
      );

      if (!commandResult.ok) {
        return {
          ok: false,
          status: statusForDomainError(commandResult.error),
          error: commandResult.error
        } as const;
      }

      // Synchronous composition (Phase 3): every round-opening or closing
      // command resolves its follow-up system event inside THIS SAME
      // transaction. `generatingItem` and `settling` are transient-only
      // phases - the persistence decoder rejects them outright as of v5 -
      // so persisting either would strand the room; composing here means a
      // crash mid-command rolls the whole thing back instead.
      let committed = commandResult.room;

      if (isSettlingActiveRoom(committed)) {
        if (command.type !== "EXECUTE_TRADE") {
          // Only EXECUTE_TRADE can commit into settling (the reducer's
          // TURN_EXPIRED path is composed separately on the alarm). Treat
          // anything else as an invariant violation rather than guessing.
          return {
            ok: false,
            status: 500,
            error: {
              code: "persistence_invalid",
              message: "Room committed a transient settling state."
            }
          } as const;
        }

        const settledResult = dispatchSystemRoomEvent(committed, {
          type: "SETTLEMENT_RECEIVED",
          item: settledDeckItemForRound(committed),
          nowMs
        });

        if (!settledResult.ok) {
          return {
            ok: false,
            status: statusForDomainError(settledResult.error),
            error: settledResult.error
          } as const;
        }

        committed = settledResult.room;
      } else if (
        (command.type === "START_ROOM" || command.type === "ADVANCE_ROUND") &&
        isGeneratingActiveRoom(committed)
      ) {
        const itemResult = dispatchSystemRoomEvent(committed, {
          type: "ITEM_RECEIVED",
          item: deckItemForRound(committed),
          nowMs
        });

        if (!itemResult.ok) {
          return {
            ok: false,
            status: statusForDomainError(itemResult.error),
            error: itemResult.error
          } as const;
        }

        committed = itemResult.room;
      }

      await this.persistRoomEnvelope(transaction, committed, nowMs);
      await transaction.put(
        ROOM_COMMAND_DEDUPE_STORAGE_KEY,
        withCommandDedupeEntry(dedupeEntries, command, committed.revision)
      );

      return {
        ok: true,
        room: committed,
        replay: false
      } as const;
    });

    if (!commandResult.ok) {
      return commandResult;
    }

    if (commandResult.replay) {
      // The mutation already committed on a prior attempt - including the
      // composed ITEM_RECEIVED / SETTLEMENT_RECEIVED follow-ups, which live
      // in that same original transaction. Re-running them would duplicate
      // side effects rather than just re-deliver the response the client
      // lost.
      return { ok: true, room: commandResult.room };
    }

    return { ok: true, room: commandResult.room };
  }

  private broadcastRoomSnapshot(
    room: RoomState,
    options: RoomSocketBroadcastOptions = {}
  ): void {
    const presence = options.presence ?? this.currentRoomPresence(room);
    const message = roomSnapshotSocketMessage(toPublicRoomSnapshot(room, presence));

    for (const socket of this.ctx.getWebSockets()) {
      if (socket === options.excludeRecipient) {
        continue;
      }

      if (!socketCanReceiveRoomSnapshot(socket, room)) {
        closeSocketQuietly(socket, "Room seat changed.");
        continue;
      }

      sendSocketMessage(socket, message);
    }
  }

  private async broadcastPresenceChangeForSocket(socket: WebSocket): Promise<void> {
    const attachment = parseRoomSocketAttachment(socket.deserializeAttachment());

    if (attachment === null) {
      return;
    }

    const loaded = await this.loadStoredRoom(currentUnixTimeMs());

    if (!loaded.ok || loaded.room.id !== attachment.roomId) {
      return;
    }

    this.broadcastRoomSnapshot(loaded.room, {
      excludeRecipient: socket,
      presence: this.currentRoomPresence(loaded.room, socket)
    });
  }

  /**
   * F-08 mitigation: closes any room socket that has gone at least
   * ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS without a fresh edge
   * auto-response. This is the one gap the existing client-side heartbeat
   * (room-socket-supervisor.ts) cannot cover: a dead TCP connection with no
   * close frame does not make socket.send() throw on the client, it just
   * queues, and because this DO registers a hibernation auto-response pair
   * for "tt-ping" in the constructor, a live client's own pings never wake
   * this object to notice the silence either. getWebSocketAutoResponseTimestamp
   * is the one signal that updates without waking the DO, so this is only
   * ever reached from alarm(), which scheduleNextAlarm() already arms for
   * the earliest such deadline via nextLivenessSweepDeadline().
   *
   * Deliberately does not touch presence or persisted state directly:
   * closing a hibernatable WebSocket always fires webSocketClose() once the
   * handshake completes, regardless of who initiated the close, so the
   * normal broadcastPresenceChangeForSocket() path rebroadcasts presence
   * for a swept socket exactly as it would for an ordinary client-driven
   * disconnect.
   */
  private sweepStaleSockets(nowMs: UnixTimeMs): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = parseRoomSocketAttachment(socket.deserializeAttachment());

      if (attachment === null) {
        continue;
      }

      const lastSeenMs = this.socketLastSeenMs(socket, attachment, nowMs);

      if (nowMs - lastSeenMs >= ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS) {
        closeStaleRoomSocket(socket);
      }
    }
  }

  /**
   * Earliest time at which some currently-connected room socket would go
   * stale if it received no further auto-response before then, or `null`
   * if there is nothing to watch (no live sockets right now). Recomputed
   * from live socket state on every call rather than cached/persisted, so
   * once the last socket disconnects this naturally stops contributing a
   * deadline at all: scheduleNextAlarm() then arms only the TTL/pending-
   * effect deadline, and the DO stops waking for liveness purposes until a
   * new socket connects - this is how an idle (fully vacant) room settles
   * back to quiescence instead of re-arming a liveness check forever.
   */
  private nextLivenessSweepDeadline(nowMs: UnixTimeMs): UnixTimeMs | null {
    let earliest: UnixTimeMs | null = null;

    for (const socket of this.ctx.getWebSockets()) {
      const attachment = parseRoomSocketAttachment(socket.deserializeAttachment());

      if (attachment === null) {
        continue;
      }

      const deadline =
        this.socketLastSeenMs(socket, attachment, nowMs) + ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS;

      if (earliest === null || deadline < earliest) {
        earliest = deadline;
      }
    }

    return earliest;
  }

  /**
   * A socket's last observed liveness signal: the edge auto-response
   * timestamp if it has ever received one, otherwise the socket's
   * acceptance time (getWebSocketAutoResponseTimestamp returns `null` until
   * the first "tt-ping" has been auto-answered for this specific socket,
   * which for a freshly-connected client can legitimately be true for up to
   * one ping interval), otherwise a *memoized* first-observed time.
   *
   * The third fallback is the compatibility case: a socket accepted by
   * pre-deploy code has no `acceptedAtMs` on its attachment at all (see
   * RoomSocketAttachment). The first time that happens for a given socket,
   * this writes `nowMs` back onto the attachment as `acceptedAtMs` via
   * serializeAttachment before returning it, so the value becomes a fixed
   * point in time rather than something recomputed as "now" on every call.
   * Without that write-back, a socket that never completes a single
   * ping-pong would read `nowMs - lastSeenMs === 0` on every sweep forever
   * and could never age out. With it, a legacy socket gets exactly one full
   * fresh threshold window from whichever moment this is first evaluated,
   * and from then on is indistinguishable from any other socket for
   * liveness purposes: its next real auto-response takes over (via the
   * first branch above, which is preferred over the memoized value), or,
   * absent one, it ages out and is swept like anything else once that
   * window elapses.
   *
   * serializeAttachment always writes back the *whole* parsed attachment
   * (spread first, `acceptedAtMs` added last) so the fields other paths
   * depend on - `roomId`, `role`, `tokenHash` - are round-tripped unchanged;
   * this only ever adds the missing timestamp, never touches anything else.
   */
  private socketLastSeenMs(
    socket: WebSocket,
    attachment: RoomSocketAttachment,
    nowMs: UnixTimeMs
  ): UnixTimeMs {
    const autoResponseMs = this.readSocketAutoResponseTimestamp(socket)?.getTime();

    if (autoResponseMs !== undefined) {
      return autoResponseMs;
    }

    if (attachment.acceptedAtMs !== undefined) {
      return attachment.acceptedAtMs;
    }

    socket.serializeAttachment({
      ...attachment,
      acceptedAtMs: nowMs
    } satisfies RoomSocketAttachment);

    return nowMs;
  }

  /**
   * Thin indirection around ctx.getWebSocketAutoResponseTimestamp so tests
   * can substitute a synthetic "last seen" clock for a specific socket
   * without waiting out ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS in real
   * time. The timestamp itself is produced entirely inside workerd's edge
   * auto-responder in response to real "tt-ping" frames and cannot be set
   * from test code any other way - see index.worker-test.ts.
   */
  private readSocketAutoResponseTimestamp(ws: WebSocket): Date | null {
    return this.ctx.getWebSocketAutoResponseTimestamp(ws);
  }

  /**
   * Folds a just-connected socket's liveness deadline into the single alarm
   * slot immediately (called from acceptRoomSocket right after
   * ctx.acceptWebSocket()). Connect does not mutate persisted room state, so
   * this deliberately does not go through persistRoomEnvelope - it only
   * needs to re-run the same min-of-deadlines computation
   * scheduleNextAlarm() already owns, now that ctx.getWebSockets() includes
   * the new socket. No-op if the room can no longer be loaded (a race with
   * expiry/purge - nothing left to schedule against).
   */
  private async rearmAlarmForLiveSockets(nowMs: UnixTimeMs): Promise<void> {
    const loaded = await this.loadStoredRoom(nowMs);

    if (!loaded.ok) {
      return;
    }

    await this.ctx.storage.transaction(async (transaction) => {
      await this.scheduleNextAlarm(transaction, loaded.room, nowMs);
    });
  }

  /**
   * Persists a room state, then reschedules the single alarm slot to match.
   */
  private async persistRoomEnvelope(
    transaction: DurableObjectTransaction,
    room: RoomState,
    nowMs: UnixTimeMs
  ): Promise<void> {
    await transaction.put(ROOM_STORAGE_KEY, persistenceEnvelopeForStorage(room, nowMs));
    await this.scheduleNextAlarm(transaction, room, nowMs);
  }

  /**
   * The reusable alarm multiplexer. A Durable Object has exactly one alarm
   * slot, so every transaction that can change any of the three deadlines
   * this folds together - room TTL, F-05's turn shot clock, and (F-08) the
   * earliest liveness-sweep deadline among currently connected room sockets -
   * must call this rather than setAlarm() directly, or the concerns will
   * race to clobber each other's schedule.
   *
   * The turn deadline is not persisted separately from the room: it is
   * already durably part of the committed `room.game` for exactly the four
   * phases where a specific player must act, so it is derived straight from
   * `room` here via turnDeadlineForRoom().
   *
   * The liveness term comes from nextLivenessSweepDeadline(), which reads
   * live socket state (ctx.getWebSockets() /
   * getWebSocketAutoResponseTimestamp()) rather than anything persisted, so
   * it costs nothing extra in this already-open transaction and cannot fall
   * out of sync the way a stored marker could.
   */
  private async scheduleNextAlarm(
    transaction: DurableObjectTransaction,
    room: RoomState,
    nowMs: UnixTimeMs
  ): Promise<void> {
    const deadlines: UnixTimeMs[] = [roomExpiresAtMs(room)];

    const turnDeadline = turnDeadlineForRoom(room);

    if (turnDeadline !== null) {
      deadlines.push(turnDeadline);
    }

    const livenessDeadline = this.nextLivenessSweepDeadline(nowMs);

    if (livenessDeadline !== null) {
      deadlines.push(livenessDeadline);
    }

    await transaction.setAlarm(Math.min(...deadlines));
  }

  private publicRoomSnapshot(room: RoomState): PublicRoomSnapshot {
    return toPublicRoomSnapshot(room, this.currentRoomPresence(room));
  }

  private currentRoomPresence(
    room: RoomState,
    excludedSocket?: WebSocket
  ): RoomPresence {
    const players = {
      A: false,
      B: false
    };

    for (const socket of this.ctx.getWebSockets()) {
      if (socket === excludedSocket) {
        continue;
      }

      const attachment = parseRoomSocketAttachment(socket.deserializeAttachment());

      if (attachment === null || attachment.roomId !== room.id) {
        continue;
      }

      if (attachment.role === "host" && attachment.tokenHash === room.host.tokenHash) {
        players.A = true;
        continue;
      }

      if (
        room.guest !== null &&
        attachment.role === "guest" &&
        attachment.tokenHash === room.guest.tokenHash
      ) {
        players.B = true;
      }
    }

    return { players };
  }

  private async createOrLoadStoredRoom(
    transaction: DurableObjectTransaction,
    roomId: RoomId,
    body: CreateRoomBody,
    hostTokenHash: TokenHash,
    nowMs: UnixTimeMs
  ): Promise<CreateOrLoadRoomResult> {
    const loaded = loadStoredRoomEnvelope(
      await transaction.get<unknown>(ROOM_STORAGE_KEY),
      nowMs
    );

    if (loaded.ok) {
      return {
        ok: true,
        created: false,
        room: loaded.room
      };
    }

    const room = createLobbyRoom({
      id: roomId,
      hostName: body.hostName,
      hostTokenHash,
      config: body.config,
      nowMs
    });

    await this.persistRoomEnvelope(transaction, room, nowMs);
    // A prior room in this same Durable Object may have expired without its
    // alarm having fired yet, leaving its command-dedupe record behind.
    // Clearing it here (as the alarm-driven full cleanup also does) keeps a
    // brand new room's dedupe history empty rather than inheriting entries
    // minted under a completely different room lifetime and token set.
    await transaction.delete(ROOM_COMMAND_DEDUPE_STORAGE_KEY);

    return {
      ok: true,
      created: true,
      room
    };
  }

  private async loadStoredRoom(nowMs: UnixTimeMs): Promise<StoredRoomLoadResult> {
    return loadStoredRoomEnvelope(
      await this.ctx.storage.get<unknown>(ROOM_STORAGE_KEY),
      nowMs
    );
  }

  private roomId():
    | Readonly<{ ok: true; roomId: RoomId }>
    | Readonly<{ ok: false; response: Response }> {
    const parsed = parseRoomId(this.ctx.id.name ?? this.ctx.id.toString());

    if (parsed.ok) {
      return parsed;
    }

    return {
      ok: false,
      response: errorResponse(parsed.error, 400)
    };
  }
}

const worker = {
  fetch(
    request: WorkerFetchRequest,
    env: WorkerFetchEnv,
    ctx: WorkerFetchContext
  ): Response | Promise<Response> {
    const roomResponse = routePublicRoomRequest(request, env);

    if (roomResponse !== null) {
      return roomResponse;
    }

    return getOpenNextWorker().fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Cloudflare.Env>;

export default worker;

function getOpenNextWorker(): OpenNextWorker {
  if (typeof openNextWorker.fetch !== "function") {
    throw new Error("Generated OpenNext worker is missing a fetch handler.");
  }

  return openNextWorker;
}

function routePublicRoomRequest(
  request: WorkerFetchRequest,
  env: WorkerFetchEnv
): Response | Promise<Response> | null {
  const url = new URL(request.url);
  const pathname = normalizePathname(url.pathname);

  if (LEGACY_NEXT_GAME_API_PATHS.has(pathname)) {
    return errorResponse(
      {
        code: "legacy_game_api_disabled",
        message: "This endpoint has moved to Durable Object room routes."
      },
      410
    );
  }

  if (pathname === PUBLIC_ROOMS_ENDPOINT) {
    if (request.method !== "POST") {
      return errorResponse(
        { code: "method_not_allowed", message: "HTTP method is not supported for this room endpoint." },
        405
      );
    }

    const originRejection = publicRoomOriginRejection(request);

    if (originRejection !== null) {
      return originRejection;
    }

    const rateLimitRejection = publicRoomRateLimitRejection(
      request,
      publicRoomCreationRateLimiter
    );

    if (rateLimitRejection !== null) {
      return rateLimitRejection;
    }

    return forwardRoomRequest(request, env, generateRoomId(), ROOM_ENDPOINT);
  }

  if (!pathname.startsWith(`${PUBLIC_ROOMS_ENDPOINT}/`)) {
    return null;
  }

  const routeParts = pathname.slice(PUBLIC_ROOMS_ENDPOINT.length + 1).split("/");
  const parsedRoomId = parseRoomId(routeParts[0]);

  if (!parsedRoomId.ok) {
    return errorResponse(parsedRoomId.error, 400);
  }

  if (routeParts.length === 1 && request.method === "GET") {
    return forwardRoomRequest(request, env, parsedRoomId.roomId, ROOM_ENDPOINT);
  }

  if (routeParts.length === 2 && routeParts[1] === "access" && request.method === "POST") {
    const originRejection = publicRoomOriginRejection(request);

    if (originRejection !== null) {
      return originRejection;
    }

    return forwardRoomRequest(request, env, parsedRoomId.roomId, ROOM_ACCESS_ENDPOINT);
  }

  if (routeParts.length === 2 && routeParts[1] === "join" && request.method === "POST") {
    const originRejection = publicRoomOriginRejection(request);

    if (originRejection !== null) {
      return originRejection;
    }

    return forwardRoomRequest(request, env, parsedRoomId.roomId, ROOM_JOIN_ENDPOINT);
  }

  if (routeParts.length === 2 && routeParts[1] === "command" && request.method === "POST") {
    const originRejection = publicRoomOriginRejection(request);

    if (originRejection !== null) {
      return originRejection;
    }

    return forwardRoomRequest(request, env, parsedRoomId.roomId, ROOM_COMMAND_ENDPOINT);
  }

  if (routeParts.length === 2 && routeParts[1] === PUBLIC_TEST_EXPIRE_TURN_ROUTE && request.method === "POST") {
    const originRejection = publicRoomOriginRejection(request);

    if (originRejection !== null) {
      return originRejection;
    }

    return forwardRoomRequest(request, env, parsedRoomId.roomId, ROOM_TEST_EXPIRE_TURN_ENDPOINT);
  }

  if (routeParts.length === 2 && routeParts[1] === "socket") {
    if (request.method !== "GET") {
      return errorResponse(
        { code: "method_not_allowed", message: "Room WebSocket upgrades must use GET." },
        405
      );
    }

    if (!hasWebSocketUpgrade(request)) {
      return errorResponse(
        { code: "invalid_request", message: "Room socket route requires a WebSocket upgrade." },
        400
      );
    }

    const originRejection = publicRoomOriginRejection(request);

    if (originRejection !== null) {
      return originRejection;
    }

    return forwardRoomRequest(request, env, parsedRoomId.roomId, ROOM_SOCKET_ENDPOINT);
  }

  if (routeParts.length === 2) {
    // An unknown room subpath is a missing endpoint, not a known endpoint
    // hit with the wrong method: it gets a 404, not a 405. This is what
    // retired routes like custom-amazon-item degrade into.
    return errorResponse(
      { code: "not_found", message: "Room endpoint was not found." },
      404
    );
  }

  if (routeParts.length === 1) {
    return errorResponse(
      { code: "method_not_allowed", message: "HTTP method is not supported for this room endpoint." },
      405
    );
  }

  return errorResponse(
    { code: "not_found", message: "Room endpoint was not found." },
    404
  );
}

function publicRoomOriginRejection(request: Request): Response | null {
  if (isAllowedOrigin(request)) {
    return null;
  }

  return errorResponse(
    {
      code: "origin_not_allowed",
      message: "Request origin is not allowed."
    },
    403
  );
}

function publicRoomRateLimitRejection(
  request: Request,
  rateLimiter: (request: Request) => boolean
): Response | null {
  if (rateLimiter(request)) {
    return null;
  }

  return errorResponse(
    {
      code: "rate_limited",
      message: "Room request rate limit exceeded."
    },
    429
  );
}

function forwardRoomRequest(
  request: WorkerFetchRequest,
  env: WorkerFetchEnv,
  roomId: RoomId,
  roomPathname: string
): Promise<Response> {
  const roomUrl = new URL(request.url);
  roomUrl.pathname = roomPathname;
  const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomId));

  return stub.fetch(new Request(roomUrl.toString(), request));
}

function generateRoomId(): RoomId {
  for (let attempt = 0; attempt < ROOM_ID_GENERATION_ATTEMPTS; attempt += 1) {
    const parsed = parseRoomId(`room-${crypto.randomUUID()}`);

    if (parsed.ok) {
      return parsed.roomId;
    }
  }

  throw new Error("Generated room id failed validation.");
}

function generateRoundId(): string {
  return crypto.randomUUID();
}

function decodeRoomCommandText(
  text: string,
  nowMs: UnixTimeMs
):
  | Readonly<{ ok: true; command: DecodedRoomCommand }>
  | Readonly<{ ok: false; error: RoomSocketError }> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: "Room WebSocket message must be valid JSON."
      }
    };
  }

  const decoded = parseClientRoomCommand(parsed, nowMs);

  if (!decoded.ok) {
    return {
      ok: false,
      error: decoded.error
    };
  }

  if (decoded.command.type === "JOIN_ROOM") {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: "JOIN_ROOM commands must use POST /room/join."
      }
    };
  }

  return {
    ok: true,
    command: decoded.command
  };
}

function roomSnapshotSocketMessage(room: PublicRoomSnapshot): string {
  return JSON.stringify({
    type: ROOM_SOCKET_MESSAGE_ROOM_SNAPSHOT,
    room
  } satisfies RoomSocketMessage);
}

function roomErrorSocketMessage(error: RoomSocketError): string {
  return JSON.stringify({
    type: ROOM_SOCKET_MESSAGE_ROOM_ERROR,
    error
  } satisfies RoomSocketMessage);
}

function sendSocketError(socket: WebSocket, error: RoomSocketError): void {
  sendSocketMessage(socket, roomErrorSocketMessage(error));
}

function sendSocketMessage(socket: WebSocket, message: string): void {
  try {
    socket.send(message);
  } catch {
    socket.close();
  }
}

function socketCanReceiveRoomSnapshot(socket: WebSocket, room: RoomState): boolean {
  const attachment = parseRoomSocketAttachment(socket.deserializeAttachment());

  if (attachment === null || attachment.roomId !== room.id) {
    return false;
  }

  if (attachment.role === "host") {
    return attachment.tokenHash === room.host.tokenHash;
  }

  return room.guest !== null && attachment.tokenHash === room.guest.tokenHash;
}

function parseRoomSocketAttachment(value: unknown): RoomSocketAttachment | null {
  if (!isRecord(value) || value.kind !== "trader-titan.room-socket.v1") {
    return null;
  }

  const roomId = parseRoomId(value.roomId);
  const tokenHash = parseTokenHash(value.tokenHash);

  // acceptedAtMs is intentionally NOT validated as required here: a socket
  // accepted by pre-deploy code hibernates with an attachment that has no
  // acceptedAtMs at all, and that attachment must keep parsing successfully
  // for every path below (snapshot eligibility, presence, seat eviction) -
  // none of which read this field. Only socketLastSeenMs cares about it, and
  // it already treats a missing value as "unknown, not stale". A present but
  // malformed value (wrong type, negative, non-finite) still fails parsing,
  // exactly like a malformed roomId/tokenHash/role would.
  if (
    !roomId.ok ||
    !tokenHash.ok ||
    (value.role !== "host" && value.role !== "guest") ||
    (value.acceptedAtMs !== undefined && !isFiniteNonNegativeNumber(value.acceptedAtMs))
  ) {
    return null;
  }

  return {
    kind: "trader-titan.room-socket.v1",
    roomId: roomId.roomId,
    role: value.role,
    tokenHash: tokenHash.tokenHash,
    ...(value.acceptedAtMs !== undefined ? { acceptedAtMs: value.acceptedAtMs } : {})
  };
}

function closeSocketQuietly(socket: WebSocket, reason: string): void {
  try {
    socket.close(1008, reason);
  } catch {
    try {
      socket.close();
    } catch {}
  }
}

/**
 * F-08 liveness sweep's own close helper, kept separate from
 * closeSocketQuietly (1008, terminal) because this close must land on the
 * retryable side of isRetryableRoomSocketCloseCode - see
 * ROOM_SOCKET_LIVENESS_SWEEP_CLOSE_CODE.
 */
function closeStaleRoomSocket(socket: WebSocket): void {
  try {
    socket.close(ROOM_SOCKET_LIVENESS_SWEEP_CLOSE_CODE, "No recent client activity.");
  } catch {
    try {
      socket.close();
    } catch {}
  }
}

function decodeSocketCredential(
  request: Request,
  roomId: RoomId
): BodyDecodeResult<PresentedCapabilityToken> {
  const protocols = socketProtocolsFromHeader(
    request.headers.get("sec-websocket-protocol")
  );

  if (!protocols.includes(ROOM_SOCKET_PROTOCOL)) {
    return invalidRequest("Room socket requires a valid player credential.");
  }

  const role = decodeSocketProtocolValue(
    protocols,
    ROOM_SOCKET_ROLE_PROTOCOL_PREFIX
  );
  const secret = decodeSocketProtocolValue(
    protocols,
    ROOM_SOCKET_SECRET_PROTOCOL_PREFIX
  );
  const parsed = parseCapabilityToken({
    roomId,
    role,
    secret
  });

  if (!parsed.ok) {
    return invalidRequest("Room socket requires a valid player credential.");
  }

  return {
    ok: true,
    value: {
      roomId: parsed.token.roomId,
      role: parsed.token.role,
      secret: parsed.token.secret
    }
  };
}

function socketProtocolsFromHeader(header: string | null): string[] {
  return header === null
    ? []
    : header.split(",").map((protocol) => protocol.trim()).filter(Boolean);
}

function decodeSocketProtocolValue(
  protocols: string[],
  prefix: string
): string | null {
  const protocol = protocols.find((candidate) => candidate.startsWith(prefix));

  return protocol === undefined ? null : protocol.slice(prefix.length);
}

async function decodeCreateRoomBody(
  request: Request
): Promise<BodyDecodeResult<CreateRoomBody>> {
  const parsed = await readJsonObjectBody(request, true);

  if (!parsed.ok) {
    return parsed;
  }

  const hostName = decodeOptionalDisplayName(parsed.value.hostName, "Host");

  if (!hostName.ok) {
    return hostName;
  }

  const config = decodeOptionalRoomConfigPatch(parsed.value.config);

  if (!config.ok) {
    return config;
  }

  return {
    ok: true,
    value: {
      hostName: hostName.value,
      config: config.value
    }
  };
}

async function decodeJoinRoomBody(
  request: Request
): Promise<BodyDecodeResult<JoinRoomBody>> {
  const parsed = await readJsonObjectBody(request, true);

  if (!parsed.ok) {
    return parsed;
  }

  const guestName = decodeOptionalDisplayName(parsed.value.guestName, "Guest");

  if (!guestName.ok) {
    return guestName;
  }

  return {
    ok: true,
    value: {
      guestName: guestName.value
    }
  };
}

async function decodeRoomCommandBody(
  request: Request,
  nowMs: UnixTimeMs
): Promise<BodyDecodeResult<DecodedRoomCommand>> {
  const parsed = await readJsonObjectBody(request, false);

  if (!parsed.ok) {
    return parsed;
  }

  const decoded = parseClientRoomCommand(parsed.value, nowMs);

  if (!decoded.ok) {
    return invalidProtocolRequest(decoded.error);
  }

  if (decoded.command.type === "JOIN_ROOM") {
    return invalidRequest("JOIN_ROOM commands must use POST /room/join.");
  }

  return {
    ok: true,
    value: decoded.command
  };
}

async function decodeAccessRoomBody(
  request: Request
): Promise<BodyDecodeResult<AccessRoomBody>> {
  const parsed = await readJsonObjectBody(request, false);

  if (!parsed.ok) {
    return parsed;
  }

  const credential = parseCapabilityToken(parsed.value.credential);

  if (!credential.ok) {
    return invalidRequest("Room access requires a valid player credential.");
  }

  return {
    ok: true,
    value: {
      credential: {
        roomId: credential.token.roomId,
        role: credential.token.role,
        secret: credential.token.secret
      }
    }
  };
}

async function readJsonObjectBody(
  request: Request,
  allowEmpty: boolean
): Promise<BodyDecodeResult<JsonRecord>> {
  const text = await request.text();

  if (text.trim().length === 0) {
    if (allowEmpty) {
      return { ok: true, value: {} };
    }

    return invalidRequest("JSON request body is required.");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return invalidRequest("JSON request body is malformed.");
  }

  if (!isRecord(parsed)) {
    return invalidRequest("JSON request body must be an object.");
  }

  return { ok: true, value: parsed };
}

function decodeOptionalDisplayName(
  value: unknown,
  fallback: string
): BodyDecodeResult<string> {
  if (value === undefined) {
    return { ok: true, value: fallback };
  }

  if (typeof value !== "string") {
    return invalidRequest("Display name must be a string.");
  }

  return { ok: true, value };
}

function decodeOptionalRoomConfigPatch(
  value: unknown
): BodyDecodeResult<Partial<RoomGameConfig> | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  const config = parseRoomGameConfigPatch(value);

  if (!config.ok) {
    return invalidProtocolRequest(config.error);
  }

  return {
    ok: true,
    value: config.config
  };
}

function loadStoredRoomEnvelope(
  envelope: unknown,
  nowMs: UnixTimeMs
): StoredRoomLoadResult {
  if (envelope === undefined) {
    return {
      ok: false,
      reason: "missing",
      error: {
        code: "room_not_found",
        message: "Room has not been created."
      }
    };
  }

  const loaded = loadPersistenceEnvelope(envelope, nowMs);

  if (loaded.ok) {
    return loaded;
  }

  return {
    ok: false,
    reason: loaded.error.code === "persistence_expired" ? "expired" : "invalid",
    error: loaded.error
  };
}

function persistenceEnvelopeForStorage(room: RoomState, nowMs: UnixTimeMs): unknown {
  return JSON.parse(JSON.stringify(toPersistenceEnvelope(room, nowMs))) as unknown;
}

/**
 * The outstanding F-05 shot-clock deadline for a room, or null when the
 * current phase has none. Only the four actionable phases
 * (proposingWidth / negotiatingWidth / configuringMarket / choosingSide)
 * carry `turnDeadlineMs` at all - see the GameState union in
 * src/lib/game/types.ts. Kept as a module-level function (rather than an
 * instance method) since it is a pure derivation from `room` alone - see
 * DurableObjectRoom.scheduleNextAlarm(), which is the sole caller and folds
 * this in alongside room TTL, the pending settle effect, and the F-08
 * liveness deadline.
 */
function turnDeadlineForRoom(room: RoomState): UnixTimeMs | null {
  switch (room.game.phase) {
    case "proposingWidth":
    case "negotiatingWidth":
    case "configuringMarket":
    case "choosingSide":
      return room.game.turnDeadlineMs;
    default:
      return null;
  }
}

/**
 * The public item attached to the round the given room state is in: deck
 * fields from the pure modulo seam (D3), round_id freshly minted per round.
 * Composed into ITEM_RECEIVED inside the same transaction that opened the
 * round (see applyDecodedRoomCommand).
 */

function isGeneratingActiveRoom(
  room: RoomState
): room is RoomState & { game: GeneratingItemGameState } {
  return room.lifecycle === "active" && room.game.phase === "generatingItem";
}

/**
 * The public item attached to the round the given room state is in: deck
 * fields from the pure modulo seam (D3), round_id freshly minted per round.
 * Composed into ITEM_RECEIVED inside the same transaction that opened the
 * round (see applyDecodedRoomCommand). The deck's private true_value is
 * deliberately omitted here - it is recomputed at settle time by
 * settledDeckItemForRoom instead of being carried on the public item.
 */
function deckItemForRound(room: RoomState): GeneratedItem {
  const deckItem = itemForRound(room.game.mode, room.game.roundNumber);

  return {
    item_title: deckItem.item_title,
    category: deckItem.category,
    context_clue: deckItem.context_clue,
    round_id: generateRoundId()
  };
}

function isSettlingActiveRoom(
  room: RoomState
): room is RoomState & { game: SettlingGameState } {
  return room.lifecycle === "active" && room.game.phase === "settling";
}

/**
 * The settled item for the round a committed `settling` room state is in
 * (Phase 3 synchronous settlement). LOAD-BEARING round_id continuation rule:
 * the settled item MUST reuse `room.game.item.round_id` - the id attached by
 * the composed ITEM_RECEIVED earlier in the same round - because
 * SETTLEMENT_RECEIVED hard-rejects a mismatched round_id, and post-v5 a
 * rejected settling state can no longer be persisted (the next touch would
 * purge the room). Deck fields are recomputed from itemForRound(mode,
 * roundNumber), which is exactly what ITEM_RECEIVED drew from. The identity
 * assert immediately before dispatch is belt-and-suspenders: the spread
 * above already makes it structurally true.
 */
function settledDeckItemForRound(
  room: RoomState & { game: Extract<GameState, { phase: "settling" }> }
): SettledGeneratedItem {
  const settled = {
    ...itemForRound(room.game.mode, room.game.roundNumber),
    round_id: room.game.item.round_id
  };

  if (settled.round_id !== room.game.item.round_id) {
    throw new Error("Settlement round_id drifted from the active round's item.");
  }

  return settled;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Full teardown for a room envelope that loadStoredRoomEnvelope has just
 * reported as missing/expired/invalid: the room envelope itself, its
 * command-dedupe record, and the alarm slot. Every call site that discovers
 * expiry this way must run this rather than returning bare - alarms are
 * one-shot, so leaving the alarm unset here would strand the expired
 * envelope with nothing left to purge it.
 */
async function purgeExpiredRoomState(
  transaction: DurableObjectTransaction
): Promise<void> {
  await transaction.delete(ROOM_STORAGE_KEY);
  await transaction.delete(ROOM_COMMAND_DEDUPE_STORAGE_KEY);
  await transaction.deleteAlarm();
}

/**
 * Scoped by credential role (host/guest), not just commandId: a room only
 * ever has one active actor per role, so this is equivalent to per-actor
 * scoping without needing a verified identity before dispatch runs. It also
 * means a guest cannot forge a commandId to collide with -- and block -- a
 * future host command, or vice versa. Entries are only ever written after a
 * command succeeds (see applyDecodedRoomCommand), so an unauthorized or
 * otherwise-rejected attempt can never poison the dedupe record and block a
 * legitimate later command with the same id.
 */
function findCommandDedupeEntry(
  entries: readonly CommandDedupeEntry[],
  command: DecodedRoomCommand
): CommandDedupeEntry | undefined {
  return entries.find(
    (entry) => entry.role === command.credential.role && entry.commandId === command.commandId
  );
}

function withCommandDedupeEntry(
  entries: readonly CommandDedupeEntry[],
  command: DecodedRoomCommand,
  revision: number
): CommandDedupeEntry[] {
  const next = [
    ...entries,
    { role: command.credential.role, commandId: command.commandId, revision }
  ];

  return next.length > COMMAND_DEDUPE_MAX_ENTRIES
    ? next.slice(next.length - COMMAND_DEDUPE_MAX_ENTRIES)
    : next;
}

function loadCommandDedupeEntries(raw: unknown): CommandDedupeEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const entries: CommandDedupeEntry[] = [];

  for (const item of raw) {
    if (
      isRecord(item) &&
      (item.role === "host" || item.role === "guest") &&
      typeof item.commandId === "string" &&
      typeof item.revision === "number" &&
      Number.isInteger(item.revision)
    ) {
      entries.push({ role: item.role, commandId: item.commandId, revision: item.revision });
    }
  }

  return entries.length > COMMAND_DEDUPE_MAX_ENTRIES
    ? entries.slice(entries.length - COMMAND_DEDUPE_MAX_ENTRIES)
    : entries;
}

function generateCapabilityToken(
  role: CapabilityRole,
  roomId: RoomId
): RoomCapabilityToken {
  const secretBytes = new Uint8Array(TOKEN_SECRET_BYTE_LENGTH);
  crypto.getRandomValues(secretBytes);
  const parsed = parseCapabilityToken({
    roomId,
    role,
    secret: bytesToHex(secretBytes)
  });

  if (!parsed.ok) {
    throw new Error(`Generated room capability token failed validation: ${parsed.error.code}`);
  }

  return parsed.token;
}

async function hashCapabilityToken(token: RoomCapabilityToken): Promise<TokenHash> {
  const digest = await crypto.subtle.digest(
    TOKEN_HASH_ALGORITHM,
    new TextEncoder().encode(
      `${TOKEN_HASH_INPUT_PREFIX}:${token.roomId}:${token.role}:${token.secret}`
    )
  );
  const parsed = parseTokenHash(
    `${TOKEN_HASH_PREFIX}:${bytesToHex(new Uint8Array(digest))}`
  );

  if (!parsed.ok) {
    throw new Error(`Generated room capability token hash failed validation: ${parsed.error.code}`);
  }

  return parsed.tokenHash;
}

async function buildTokenVerifier(
  credential: PresentedCapabilityToken
): Promise<TokenVerifier> {
  const parsed = parseCapabilityToken(credential);

  if (!parsed.ok) {
    return () => false;
  }

  const credentialHash = await hashCapabilityToken(parsed.token);

  return (token, expectedHash) =>
    capabilityTokensEqual(token, parsed.token) && expectedHash === credentialHash;
}

function capabilityTokensEqual(
  left: RoomCapabilityToken,
  right: RoomCapabilityToken
): boolean {
  return left.roomId === right.roomId &&
    left.role === right.role &&
    left.secret === right.secret;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(BYTE_HEX_RADIX).padStart(BYTE_HEX_PAD_LENGTH, "0")
  ).join("");
}

function currentUnixTimeMs(): UnixTimeMs {
  return Date.now();
}

function normalizePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

function hasWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest<T>(message: string): BodyDecodeResult<T> {
  return {
    ok: false,
    response: errorResponse(
      {
        code: "invalid_request",
        message
      },
      400
    )
  };
}

function invalidProtocolRequest<T>(
  error: RoomProtocolDecodeError
): BodyDecodeResult<T> {
  return {
    ok: false,
    response: errorResponse(
      {
        code: error.code,
        message: error.message
      },
      400
    )
  };
}

function statusForStoredRoomLoadFailure(
  result: Exclude<StoredRoomLoadResult, { ok: true }>
): number {
  if (result.error.code === "persistence_version_unsupported") {
    // Same rationale as statusForDomainError: a hard persistence cutover is
    // a planned invalidation, not a server bug.
    return 410;
  }

  switch (result.reason) {
    case "missing":
      return 404;
    case "expired":
      return 410;
    case "invalid":
      return 500;
    default:
      return assertNever(result.reason);
  }
}

function statusForDomainError(error: RoomDomainError): number {
  switch (error.code) {
    case "missing_token":
      return 401;
    case "invalid_token":
    case "wrong_room":
    case "spectator_access_denied":
    case "token_mismatch":
    case "stale_guest":
    case "host_control_denied":
    case "wrong_active_role":
      return 403;
    case "invalid_config":
      return 400;
    case "persistence_expired":
    // A planned invalidation (hard persistence cutover), not a server bug:
    // the room's stored envelope predates this build's floor version, so
    // self-heal paths purge it and the room reads as never-created.
    case "persistence_version_unsupported":
      return 410;
    case "persistence_invalid":
      return 500;
    case "room_not_in_lobby":
    case "room_not_active":
    case "room_not_finished":
    case "guest_slot_full":
    case "guest_slot_empty":
    case "guest_required":
    case "invalid_game_phase":
      return 409;
    default:
      return assertNever(error.code);
  }
}

function jsonResponse<T>(body: T, status = 200): Response {
  return Response.json(body, {
    headers: {
      "content-type": JSON_CONTENT_TYPE
    },
    status
  });
}

function errorResponse(
  error: RoomHttpError | RoomDomainError,
  status: number
): Response {
  return jsonResponse<RoomErrorResponse>(
    {
      ok: false,
      error
    },
    status
  );
}

function assertNever(value: never): never {
  throw new Error(`Unexpected room worker value: ${JSON.stringify(value)}`);
}
