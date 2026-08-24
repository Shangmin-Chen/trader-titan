/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker, { GameRoomDurableObject } from "./index";
import {
  privateGeneratedItemStorageKey,
  privateGeneratedItemStoragePrefix
} from "./private-generated-items";
import {
  SMOKE_HEADER_NAME,
  SMOKE_HEADER_VALUE
} from "./testing/open-next-worker";
import { applySettlementToScores, SETTLEMENT_FAILURE_EPISODE_CAP } from "../lib/game";
import type { TradeSide } from "../lib/game";
import {
  isRetryableRoomSocketCloseCode,
  ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS,
  ROOM_SOCKET_LIVENESS_SWEEP_CLOSE_CODE
} from "../lib/room-socket-supervisor";
import {
  ROOM_CREATION_RATE_LIMIT_MAX_REQUESTS
} from "../api/request-guards";
import {
  dispatchRoomCommand,
  loadPersistenceEnvelope,
  roomExpiresAtMs,
  toPersistenceEnvelope
} from "../lib/room";
import type {
  PublicRoomInvitePreview,
  PublicRoomSnapshot,
  RoomCapabilityToken,
  RoomState
} from "../lib/room";

const CREATE_ROOM_NAME = "worker-room-create-load";
const JOIN_ROOM_NAME = "worker-room-join-persist";
const COMMAND_ROOM_NAME = "worker-room-command";
const START_OFFLINE_ROOM_NAME = "worker-room-start-offline";
const SETTLEMENT_ROOM_NAME = "worker-room-settlement";
const MISSING_SETTLEMENT_ITEM_ROOM_NAME = "worker-room-missing-settlement-item";
const CORRUPT_SETTLEMENT_ITEM_ROOM_NAME = "worker-room-corrupt-settlement-item";
const STUCK_SETTLING_ROOM_NAME = "worker-room-stuck-settling";
const STUCK_SETTLING_UNAUTHORIZED_ROOM_NAME = "worker-room-stuck-settling-unauthorized";
const STUCK_SETTLING_AUTO_RESUME_ROOM_NAME = "worker-room-stuck-settling-auto-resume";
const STUCK_SETTLING_TTL_ROOM_NAME = "worker-room-stuck-settling-ttl";
const STUCK_SETTLING_BOTH_DEADLINES_ROOM_NAME = "worker-room-stuck-settling-both-deadlines";
const STUCK_SETTLING_EXHAUSTION_ROOM_NAME = "worker-room-stuck-settling-exhaustion";
const STUCK_SETTLING_STALE_ROUND_EXHAUSTION_ROOM_NAME =
  "worker-room-stuck-settling-stale-round-exhaustion";
const STUCK_SETTLING_NO_DOUBLE_SETTLE_ROOM_NAME = "worker-room-stuck-settling-no-double-settle";
const PERMANENT_SETTLEMENT_FAILURE_ROOM_NAME = "worker-room-permanent-settlement-failure";
const STUCK_SETTLING_MID_ALARM_EXPIRY_ROOM_NAME = "worker-room-stuck-settling-mid-alarm-expiry";
const SETTLING_ABORT_ROOM_NAME = "worker-room-settling-abort";
const RETRY_SUCCESS_ROOM_NAME = "worker-room-retry-success";
const RETRY_FAILURE_ROOM_NAME = "worker-room-retry-failure";
const RETRY_UNAUTHORIZED_ROOM_NAME = "worker-room-retry-unauthorized";
const RESET_PRIVATE_ITEM_ROOM_NAME = "worker-room-reset-private-item";
const KICK_PRIVATE_ITEM_ROOM_NAME = "worker-room-kick-private-item";
const REPLACE_PRIVATE_ITEM_ROOM_NAME = "worker-room-replace-private-item";
const ALARM_PRIVATE_ITEM_ROOM_NAME = "worker-room-alarm-private-item";
const COMMAND_PURGE_ON_INVALID_ROOM_NAME = "worker-room-command-purge-on-invalid";
const JOIN_PURGE_ON_INVALID_ROOM_NAME = "worker-room-join-purge-on-invalid";
const ALARM_MISSING_PRIVATE_ITEM_ROOM_NAME = "worker-room-alarm-missing-private-item";
const ALARM_EXPIRED_PRIVATE_ITEM_ROOM_NAME = "worker-room-alarm-expired-private-item";
const ALARM_VALID_PRIVATE_ITEM_ROOM_NAME = "worker-room-alarm-valid-private-item";
const SOCKET_INITIAL_ROOM_NAME = "worker-room-socket-initial";
const SOCKET_COMMAND_ROOM_NAME = "worker-room-socket-command";
const SOCKET_ERROR_ROOM_NAME = "worker-room-socket-error";
const SOCKET_START_OFFLINE_ROOM_NAME = "worker-room-socket-start-offline";
const SOCKET_ADVANCE_OFFLINE_ROOM_NAME = "worker-room-socket-advance-offline";
const SOCKET_PRESENCE_ROOM_NAME = "worker-room-socket-presence";
const ADVANCE_PRESENCE_ROOM_NAME = "worker-room-advance-presence";
const RESET_STALE_SOCKET_ROOM_NAME = "worker-room-reset-stale-socket";
const HOST_SOCKET_EVICTION_ROOM_NAME = "worker-room-host-socket-eviction";
const GUEST_SOCKET_CHURN_ROOM_NAME = "worker-room-guest-socket-churn";
const PING_PONG_ROOM_NAME = "worker-room-ping-pong";
const LIVENESS_SWEEP_STALE_VS_LIVE_ROOM_NAME = "worker-room-liveness-sweep-stale-vs-live";
const LIVENESS_SWEEP_EXACT_BOUNDARY_ROOM_NAME = "worker-room-liveness-sweep-exact-boundary";
const LIVENESS_SWEEP_ALARM_MULTIPLEX_ROOM_NAME = "worker-room-liveness-sweep-alarm-multiplex";
const LIVENESS_SWEEP_WITH_PENDING_EFFECT_ROOM_NAME = "worker-room-liveness-sweep-with-pending-effect";
const LIVENESS_LEGACY_ATTACHMENT_ROOM_NAME = "worker-room-liveness-legacy-attachment";
const LIVENESS_LEGACY_ATTACHMENT_SWEEP_ROOM_NAME = "worker-room-liveness-legacy-attachment-sweep";
const LIVENESS_LEGACY_ATTACHMENT_LONG_RUN_ROOM_NAME =
  "worker-room-liveness-legacy-attachment-long-run";
const LIVENESS_LEGACY_ATTACHMENT_REAL_PING_ROOM_NAME =
  "worker-room-liveness-legacy-attachment-real-ping";
const TIGHTEN_REPLAY_SAME_ID_ROOM_NAME = "worker-room-tighten-replay-same-id";
const TIGHTEN_REPLAY_DIFFERENT_ID_ROOM_NAME = "worker-room-tighten-replay-different-id";
const KICKED_GUEST_REPLAY_ROOM_NAME = "worker-room-kicked-guest-replay";
const NEARER_DEADLINE_ROOM_NAME = "worker-room-nearer-deadline";
const NEAREST_OF_THREE_ROOM_NAME = "worker-room-nearest-of-three";
const PURGE_DEDUPE_ROOM_NAME = "worker-room-purge-dedupe";
const STALE_ROUND_SETTLE_ROOM_NAME = "worker-room-stale-round-settle";
const TURN_EXPIRY_ALARM_ROOM_NAME = "worker-room-turn-expiry-alarm";
const TURN_EXPIRY_TTL_ROOM_NAME = "worker-room-turn-expiry-ttl";
const STALE_TURN_EXPIRY_ROOM_NAME = "worker-room-stale-turn-expiry";
const CHOOSING_SIDE_TIMEOUT_BUY_WORSE_ROOM_NAME = "worker-room-choosing-side-timeout-buy-worse";
const CHOOSING_SIDE_TIMEOUT_SELL_WORSE_ROOM_NAME = "worker-room-choosing-side-timeout-sell-worse";
const CHOOSING_SIDE_TIMEOUT_TIE_ROOM_NAME = "worker-room-choosing-side-timeout-tie";
const TEST_EXPIRE_TURN_GATE_ROOM_NAME = "worker-room-test-expire-turn-gate";
const TEST_EXPIRE_TURN_CREDENTIALS_ROOM_NAME = "worker-room-test-expire-turn-credentials";
const TEST_EXPIRE_TURN_OTHER_ROOM_NAME = "worker-room-test-expire-turn-other-room";
const GAME_ROOM_SMOKE_URL = "https://trader-titan.worker.test/room";
const ROOM_COMMAND_URL = `${GAME_ROOM_SMOKE_URL}/command`;
const ROOM_JOIN_URL = `${GAME_ROOM_SMOKE_URL}/join`;
const ROOM_SOCKET_URL = `${GAME_ROOM_SMOKE_URL}/socket`;
const ROOM_TEST_EXPIRE_TURN_URL = `${GAME_ROOM_SMOKE_URL}/test-expire-turn`;
const PUBLIC_ROOMS_URL = "https://trader-titan.worker.test/api/rooms";
const TEST_ROOM_STORAGE_KEY = "room:persistence:v1";
const TEST_PENDING_EFFECT_STORAGE_KEY = "room:pending-effect:v1";
// Mirrors ROOM_COMMAND_DEDUPE_STORAGE_KEY in src/worker/index.ts.
const TEST_COMMAND_DEDUPE_STORAGE_KEY = "room:command-dedupe:v1";
// Mirrors PENDING_SETTLE_EFFECT_MAX_ATTEMPTS in src/worker/index.ts.
const TEST_PENDING_SETTLE_EFFECT_MAX_ATTEMPTS = 5;
const HTTP_BAD_REQUEST_STATUS = 400;
const HTTP_FORBIDDEN_STATUS = 403;
const HTTP_NOT_FOUND_STATUS = 404;
const HTTP_CREATED_STATUS = 201;
const HTTP_OK_STATUS = 200;
const HTTP_SWITCHING_PROTOCOLS_STATUS = 101;
const HTTP_CONFLICT_STATUS = 409;
const HTTP_GONE_STATUS = 410;
const HTTP_TOO_MANY_REQUESTS_STATUS = 429;
const HTTP_INTERNAL_SERVER_ERROR_STATUS = 500;
const SOCKET_MESSAGE_TIMEOUT_MS = 1_000;
const WORKER_SMOKE_PATH = "/worker-smoke";
const WORKER_SMOKE_URL = `https://trader-titan.worker.test${WORKER_SMOKE_PATH}`;
const LEGACY_GENERATE_ITEM_URL = "https://trader-titan.worker.test/api/generate-item";
type WorkerFetchRequest = Parameters<typeof worker.fetch>[0];
type GameRoomStub = ReturnType<typeof roomStub>;
type RoomSocketConnection = Readonly<{
  socket: WebSocket;
  initial: RoomSnapshotSocketMessage;
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

type RoomErrorResponse = Readonly<{
  ok: false;
  error: Readonly<{
    code: string;
    message: string;
  }>;
}>;

type RoomSocketMessage =
  | Readonly<{
      type: "ROOM_SNAPSHOT";
      room: PublicRoomSnapshot;
    }>
  | Readonly<{
      type: "ROOM_ERROR";
      error: Readonly<{
        code: string;
        message: string;
      }>;
    }>;

type RoomSnapshotSocketMessage = Extract<RoomSocketMessage, { type: "ROOM_SNAPSHOT" }>;

describe("Cloudflare worker scaffold", () => {
  it("delegates fetch requests to the OpenNext worker entrypoint", async () => {
    const request = new Request(WORKER_SMOKE_URL) as WorkerFetchRequest;
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, env, ctx);

    await waitOnExecutionContext(ctx);

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      path: WORKER_SMOKE_PATH,
      runtime: "workerd"
    });
    expect(response.headers.get(SMOKE_HEADER_NAME)).toBe(SMOKE_HEADER_VALUE);
  });

  it("blocks legacy process-local game API routes at the Worker boundary", async () => {
    const request = new Request(LEGACY_GENERATE_ITEM_URL, {
      body: JSON.stringify({ mode: "Chaos Quant" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }) as WorkerFetchRequest;
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, env, ctx);
    const blocked = await expectPublicJson<RoomErrorResponse>(response);

    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(HTTP_GONE_STATUS);
    expect(blocked.error.code).toBe("legacy_game_api_disabled");
    expect(response.headers.get(SMOKE_HEADER_NAME)).toBeNull();
  });

  it("creates a generated room through the public Worker route", async () => {
    const request = new Request(PUBLIC_ROOMS_URL, {
      body: JSON.stringify({ hostName: "Ada" }),
      method: "POST"
    }) as WorkerFetchRequest;
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, env, ctx);
    const created = await expectPublicJson<CreateRoomResponse>(response);

    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(HTTP_CREATED_STATUS);
    expect(created.ok).toBe(true);
    expect(created.created).toBe(true);

    if (!created.created) {
      throw new Error("Expected public route to create a new room.");
    }

    expect(created.room.id).toMatch(/^room-[A-Za-z0-9-]+$/u);
    expect(created.hostToken).toMatchObject({
      role: "host",
      roomId: created.room.id
    });
    expectRoomPresence(created.room, { A: false, B: false });

    const getRequest = new Request(`${PUBLIC_ROOMS_URL}/${created.room.id}`) as WorkerFetchRequest;
    const getCtx = createExecutionContext();
    const getResponse = await worker.fetch(getRequest, env, getCtx);
    const loaded = await expectPublicJson<GetRoomResponse>(getResponse);

    await waitOnExecutionContext(getCtx);

    expect(getResponse.status).toBe(HTTP_OK_STATUS);
    expect(loaded.room).toMatchObject({
      id: created.room.id,
      lifecycle: "lobby",
      host: { displayName: "Ada" },
      guest: { occupied: false },
      joinable: true
    });
    expect("game" in loaded.room).toBe(false);

    const accessResponse = await accessPublicRoom(created.room.id, created.hostToken);
    const accessed = await expectPublicJson<AccessRoomResponse>(accessResponse);

    expect(accessResponse.status).toBe(HTTP_OK_STATUS);
    expectRoomPresence(accessed.room, { A: false, B: false });
    expect(accessed.room).toEqual(created.room);
  });

  it("rejects cross-origin public room mutations and socket upgrades", async () => {
    const headers = {
      "content-type": "application/json",
      origin: "https://evil.example"
    };
    const createResponse = await fetchPublicWorker(new Request(PUBLIC_ROOMS_URL, {
      body: JSON.stringify({ hostName: "Mallory" }),
      headers,
      method: "POST"
    }));
    const createRejected = await expectPublicJson<RoomErrorResponse>(createResponse);

    expect(createResponse.status).toBe(HTTP_FORBIDDEN_STATUS);
    expect(createRejected.error.code).toBe("origin_not_allowed");

    for (const request of [
      new Request(`${PUBLIC_ROOMS_URL}/room-cross-origin/access`, {
        body: JSON.stringify({ credential: "invalid" }),
        headers,
        method: "POST"
      }),
      new Request(`${PUBLIC_ROOMS_URL}/room-cross-origin/join`, {
        body: JSON.stringify({ guestName: "Mallory" }),
        headers,
        method: "POST"
      }),
      new Request(`${PUBLIC_ROOMS_URL}/room-cross-origin/command`, {
        body: JSON.stringify({ type: "START_ROOM", credential: "invalid" }),
        headers,
        method: "POST"
      }),
      // Retired route (P1+2): unknown subpaths 404 before origin checks
      // would even matter, but a cross-origin probe must never leak anything.
      new Request(`${PUBLIC_ROOMS_URL}/room-cross-origin/test-expire-turn`, {
        body: "{}",
        headers,
        method: "POST"
      })
    ]) {
      const response = await fetchPublicWorker(request);
      const rejected = await expectPublicJson<RoomErrorResponse>(response);

      expect(response.status).toBe(HTTP_FORBIDDEN_STATUS);
      expect(rejected.error.code).toBe("origin_not_allowed");
    }

    const socketResponse = await fetchPublicWorker(new Request(
      `${PUBLIC_ROOMS_URL}/room-cross-origin/socket`,
      {
        headers: {
          origin: "https://evil.example",
          upgrade: "websocket"
        }
      }
    ));
    const socketRejected = await expectPublicJson<RoomErrorResponse>(socketResponse);

    expect(socketResponse.status).toBe(HTTP_FORBIDDEN_STATUS);
    expect(socketResponse.webSocket).toBeNull();
    expect(socketRejected.error.code).toBe("origin_not_allowed");
  });

  it("rate limits public room creation per Cloudflare client IP", async () => {
    const limitedIp = "198.51.100.10";

    for (let requestIndex = 0; requestIndex < ROOM_CREATION_RATE_LIMIT_MAX_REQUESTS; requestIndex += 1) {
      const response = await postPublicRoomCreate(
        `Rate Limited Host ${requestIndex}`,
        limitedIp
      );

      expect(response.status).toBe(HTTP_CREATED_STATUS);
    }

    const limitedResponse = await postPublicRoomCreate("Rate Limited Host", limitedIp);
    const limited = await expectPublicJson<RoomErrorResponse>(limitedResponse);

    expect(limitedResponse.status).toBe(HTTP_TOO_MANY_REQUESTS_STATUS);
    expect(limited.error.code).toBe("rate_limited");

    const otherIpResponse = await postPublicRoomCreate(
      "Other IP Host",
      "198.51.100.11"
    );

    expect(otherIpResponse.status).toBe(HTTP_CREATED_STATUS);
  });

  it("404s POST /api/rooms/:id/custom-amazon-item now that the route is gone", async () => {
    const response = await postPublicCustomAmazonItemBody("room-custom-rate-limit", {});

    expect(response.status).toBe(HTTP_NOT_FOUND_STATUS);

    const body = await expectPublicJson<RoomErrorResponse>(response);

    expect(body.error.code).toBe("not_found");
  });

  it("creates and then loads a lobby for the Durable Object id", async () => {
    const stub = roomStub(CREATE_ROOM_NAME);

    const createResponse = await stub.fetch(GAME_ROOM_SMOKE_URL, {
      body: JSON.stringify({ hostName: "Ada" }),
      method: "POST"
    });
    const created = await expectPublicJson<CreateRoomResponse>(createResponse);

    expect(createResponse.status).toBe(HTTP_CREATED_STATUS);
    expect(created.ok).toBe(true);
    expect(created.created).toBe(true);

    if (!created.created) {
      throw new Error("Expected a newly created Durable Object room.");
    }

    expect(created.hostToken).toMatchObject({
      role: "host",
      roomId: CREATE_ROOM_NAME
    });
    expect(created.hostToken.secret).toEqual(expect.any(String));
    expect(created.room.id).toBe(CREATE_ROOM_NAME);
    expect(created.room.lifecycle).toBe("lobby");
    expect(created.room.seats.host).toMatchObject({
      occupied: true,
      displayName: "Ada",
      playerId: "A",
      role: "host"
    });
    expect(created.room.seats.guest).toMatchObject({
      occupied: false,
      displayName: null,
      playerId: "B",
      role: "guest"
    });
    expectRoomPresence(created.room, { A: false, B: false });

    const loadResponse = await stub.fetch(GAME_ROOM_SMOKE_URL, {
      method: "POST"
    });
    const loaded = await expectPublicJson<CreateRoomResponse>(loadResponse);

    expect(loadResponse.status).toBe(HTTP_OK_STATUS);
    expect(loaded).toMatchObject({
      ok: true,
      created: false
    });
    expect("hostToken" in loaded).toBe(false);
    expect(loaded.room).toMatchObject({
      id: created.room.id,
      lifecycle: "lobby",
      host: { displayName: "Ada" },
      guest: { occupied: false },
      joinable: true
    });
    expect("game" in loaded.room).toBe(false);

    const getResponse = await stub.fetch(GAME_ROOM_SMOKE_URL);
    const snapshot = await expectPublicJson<GetRoomResponse>(getResponse);

    expect(getResponse.status).toBe(HTTP_OK_STATUS);
    expect(snapshot.room).toEqual(loaded.room);

    const accessed = await accessRoom(stub, created.hostToken);
    expectRoomPresence(accessed.room, { A: false, B: false });
    expect(accessed.room).toEqual(created.room);
  });

  it("joins one guest, persists the private room, and rejects spectators by capacity", async () => {
    const stub = roomStub(JOIN_ROOM_NAME);

    await createRoom(stub, "Host");

    const joinResponse = await stub.fetch(ROOM_JOIN_URL, {
      body: JSON.stringify({ guestName: "Grace" }),
      method: "POST"
    });
    const joined = await expectPublicJson<JoinRoomResponse>(joinResponse);

    expect(joinResponse.status).toBe(HTTP_OK_STATUS);
    expect(joined.guestToken).toMatchObject({
      role: "guest",
      roomId: JOIN_ROOM_NAME
    });
    expect(joined.room.seats.guest).toMatchObject({
      occupied: true,
      displayName: "Grace",
      playerId: "B",
      role: "guest"
    });
    expectRoomPresence(joined.room, { A: false, B: false });
    expect("hostToken" in joined).toBe(false);

    const secondJoinResponse = await stub.fetch(ROOM_JOIN_URL, {
      body: JSON.stringify({ guestName: "Mallory" }),
      method: "POST"
    });
    const secondJoin = await expectPublicJson<RoomErrorResponse>(secondJoinResponse);

    expect(secondJoinResponse.status).toBe(HTTP_CONFLICT_STATUS);
    expect(secondJoin).toMatchObject({
      ok: false,
      error: {
        code: "guest_slot_full"
      }
    });
    expect("guestToken" in secondJoin).toBe(false);

    const persisted = await accessRoom(roomStub(JOIN_ROOM_NAME), joined.guestToken);

    expectRoomPresence(persisted.room, { A: false, B: false });
    expect(persisted.room).toEqual(joined.room);
  });

  it("applies known host commands through the HTTP command dispatcher", async () => {
    const stub = roomStub(COMMAND_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created command room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);

    expectRoomPresence(guestConnection.initial.room, { A: false, B: true });

    const startResponse = await postRoomCommand(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });
    const started = await expectPublicJsonWithoutTrueValue<CommandRoomResponse>(startResponse);

    expect(startResponse.status).toBe(HTTP_OK_STATUS);
    expect(started.room.lifecycle).toBe("active");
    expect(started.room.game.phase).toBe("proposingWidth");
    expect(started.room.revision).toBe(3);
    expectRoomPresence(started.room, { A: false, B: true });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    expect(started.room.game.item).toMatchObject({
      category: "Chaos Quant",
      context_clue: "Convert the binary string to a decimal integer.",
      item_title: "Base 10 representation of binary 101010"
    });
    expect("true_value" in started.room.game.item).toBe(false);

    const persisted = await accessRoom(roomStub(COMMAND_ROOM_NAME), created.hostToken);

    expect(persisted.room).toEqual(started.room);

    guestConnection.socket.close();
  });

  it("applies a lost-ACK TIGHTEN_WIDTH replay exactly once instead of double-swapping roles", async () => {
    // Simulates the client re-sending an identical command after losing the
    // HTTP response for one that the Durable Object already committed --
    // packet loss on a lost ACK, not a second click. TIGHTEN_WIDTH is a
    // negotiatingWidth -> negotiatingWidth self-loop that swaps
    // roles.marketMaker/roles.trader, so replaying it without dedupe would
    // swap roles a second time; only validateTightenedWidth's "must be
    // tighter than current" check would happen to catch it, and only
    // because the width also happens to stay the same across the replay.
    const stub = roomStub(TIGHTEN_REPLAY_SAME_ID_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created tighten-replay room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);

    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected a room ready for width proposal.");
    }

    // Round-1 roles come from the uniform rolesForRound calendar: A is
    // marketMaker, B is trader.
    const proposed = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: created.hostToken,
      width: 10
    });

    if (proposed.room.game.phase !== "negotiatingWidth") {
      throw new Error("Expected negotiating width phase.");
    }

    expect(proposed.room.game.spreadWidth).toBe(10);
    expect(proposed.room.game.roles).toEqual({ marketMaker: "A", trader: "B" });

    const revisionBeforeTighten = proposed.room.revision;
    const tightenCommand = {
      type: "TIGHTEN_WIDTH",
      credential: joined.guestToken,
      commandId: "tighten-replay-same-id",
      width: 6
    };

    const firstResponse = await postRoomCommand(stub, tightenCommand);
    const first = await expectPublicJson<CommandRoomResponse>(firstResponse);

    expect(firstResponse.status).toBe(HTTP_OK_STATUS);
    expect(first.room.revision).toBe(revisionBeforeTighten + 1);

    if (first.room.game.phase !== "negotiatingWidth") {
      throw new Error("Expected negotiating width phase after tighten.");
    }

    expect(first.room.game.spreadWidth).toBe(6);
    expect(first.room.game.roles).toEqual({ marketMaker: "B", trader: "A" });
    expect(first.room.game.lastError).toBeUndefined();

    // Resend the identical command body -- same commandId, same everything --
    // exactly as a client would after losing the first response.
    const secondResponse = await postRoomCommand(stub, tightenCommand);
    const second = await expectPublicJson<CommandRoomResponse>(secondResponse);

    expect(secondResponse.status).toBe(HTTP_OK_STATUS);
    expect(second.room).toEqual(first.room);
    expect(second.room.revision).toBe(first.room.revision);
    expect(second.room.game.roles).toEqual({ marketMaker: "B", trader: "A" });

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room).toEqual(first.room);
    expect(persisted.room.revision).toBe(revisionBeforeTighten + 1);

    guestConnection.socket.close();
  });

  it("treats a different commandId as a fresh command, preserving the existing validateTightenedWidth guard", async () => {
    const stub = roomStub(TIGHTEN_REPLAY_DIFFERENT_ID_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created tighten-replay room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);

    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected a room ready for width proposal.");
    }

    const proposed = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: created.hostToken,
      width: 10
    });

    if (proposed.room.game.phase !== "negotiatingWidth") {
      throw new Error("Expected negotiating width phase.");
    }

    const revisionBeforeTighten = proposed.room.revision;

    const firstResponse = await postRoomCommand(stub, {
      type: "TIGHTEN_WIDTH",
      credential: joined.guestToken,
      commandId: "tighten-different-id-first",
      width: 6
    });
    const first = await expectPublicJson<CommandRoomResponse>(firstResponse);

    expect(firstResponse.status).toBe(HTTP_OK_STATUS);
    expect(first.room.revision).toBe(revisionBeforeTighten + 1);

    if (first.room.game.phase !== "negotiatingWidth") {
      throw new Error("Expected negotiating width phase after tighten.");
    }

    expect(first.room.game.spreadWidth).toBe(6);
    expect(first.room.game.roles).toEqual({ marketMaker: "B", trader: "A" });

    // A genuinely new command (different commandId) attempting the same
    // nominal width is not recognized as a replay, so it reaches the
    // reducer. The active trader is now A (post-swap), and the reducer's
    // own validateTightenedWidth guard -- unchanged by this fix -- declines
    // it because 6 is not tighter than the current width of 6. The command
    // still records as an applied room mutation (matching pre-existing
    // reducer behavior for domain-rejected actions), but the roles and
    // width are left exactly as the first tighten set them: no second swap.
    const secondResponse = await postRoomCommand(stub, {
      type: "TIGHTEN_WIDTH",
      credential: created.hostToken,
      commandId: "tighten-different-id-second",
      width: 6
    });
    const second = await expectPublicJson<CommandRoomResponse>(secondResponse);

    expect(secondResponse.status).toBe(HTTP_OK_STATUS);
    expect(second.room.revision).toBe(first.room.revision + 1);

    if (second.room.game.phase !== "negotiatingWidth") {
      throw new Error("Expected negotiating width phase after the rejected tighten.");
    }

    expect(second.room.game.spreadWidth).toBe(6);
    expect(second.room.game.roles).toEqual({ marketMaker: "B", trader: "A" });
    expect(second.room.game.lastError).toBe(
      "New spread width must be tighter than current width."
    );

    guestConnection.socket.close();
  });

  it("rejects a kicked guest's replay of their own pre-kick commandId instead of leaking current room state", async () => {
    // A dedupe hit only proves *some* past command from this role used this
    // commandId -- it says nothing about whether the credential on the
    // replay request is still valid right now. If the replay short-circuit
    // skipped authorization, a guest who was kicked (and whose token is now
    // stale) could keep "successfully" replaying their last pre-kick
    // commandId forever and read the room's current state -- who else has
    // joined, current config, and so on -- with no valid credential at all.
    // The commandId and credential used in the replay are genuinely the
    // kicked guest's own, from a command that really did succeed before the
    // kick, so this is not a guessing attack -- it must be rejected on
    // authorization, not on the attacker failing to guess anything.
    const stub = roomStub(KICKED_GUEST_REPLAY_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created kicked-guest-replay room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);

    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected a room ready for width proposal.");
    }

    const proposed = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: created.hostToken,
      width: 10
    });

    if (proposed.room.game.phase !== "negotiatingWidth") {
      throw new Error("Expected negotiating width phase.");
    }

    // aiGenerated rooms keep round-1 roles unswapped: A is marketMaker, B is
    // trader, so the guest (B) is the active player for TIGHTEN_WIDTH here.
    const guestTightenCommand = {
      type: "TIGHTEN_WIDTH",
      credential: joined.guestToken,
      commandId: "kicked-guest-replay-tighten",
      width: 6
    };

    const tightenResponse = await postRoomCommand(stub, guestTightenCommand);
    const tightened = await expectPublicJson<CommandRoomResponse>(tightenResponse);

    expect(tightenResponse.status).toBe(HTTP_OK_STATUS);

    if (tightened.room.game.phase !== "negotiatingWidth") {
      throw new Error("Expected negotiating width phase after tighten.");
    }

    expect(tightened.room.game.spreadWidth).toBe(6);

    const guestClosed = nextSocketClose(guestConnection.socket);
    const kicked = await applyRoomCommand(stub, {
      type: "KICK_GUEST",
      credential: created.hostToken
    });

    expect(kicked.room.lifecycle).toBe("lobby");
    expect(kicked.room.seats.guest.occupied).toBe(false);
    await expect(guestClosed).resolves.toBeUndefined();

    // The kicked guest resends their own last pre-kick command verbatim.
    const replayResponse = await postRoomCommand(stub, guestTightenCommand);
    const replay = await expectPublicJson<{ ok: false; error: { code: string } }>(
      replayResponse
    );

    expect(replayResponse.status).toBe(403);
    expect(replay.ok).toBe(false);
    expect(replay.error.code).toBe("stale_guest");

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room).toEqual(kicked.room);
  });

  // F-04: presence gating was dropped entirely (the F-05 turn shot clock
  // now handles an absent opponent instead), so HTTP START_ROOM succeeds
  // even when the joined guest has no live socket.
  it("allows HTTP START_ROOM when a joined guest has no live socket (F-04)", async () => {
    const stub = roomStub(START_OFFLINE_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created offline-start room.");
    }

    const joined = await joinRoom(stub, "Guest");

    expect(joined.room.lifecycle).toBe("lobby");
    expect(joined.room.game.phase).toBe("setup");
    expect(joined.room.seats.guest.occupied).toBe(true);
    expectRoomPresence(joined.room, { A: false, B: false });

    const startResponse = await postRoomCommand(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });
    const started = await expectPublicJsonWithoutTrueValue<CommandRoomResponse>(startResponse);

    expect(startResponse.status).toBe(HTTP_OK_STATUS);
    expect(started.room.lifecycle).toBe("active");

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room.lifecycle).toBe("active");
    expect(persisted.room.seats.guest.occupied).toBe(true);
    expectRoomPresence(persisted.room, { A: false, B: false });
  });

  it("START_ROOM response lands directly in proposingWidth with the deck item", async () => {
    const stub = roomStub(RETRY_SUCCESS_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created deck-start room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);

    expectRoomPresence(guestConnection.initial.room, { A: false, B: true });

    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    // The static deck makes item receipt synchronous with START_ROOM: the
    // response IS the proposingWidth state, with the round-1 modulo pick.
    expect(started.room.lifecycle).toBe("active");
    expect(started.room.game.phase).toBe("proposingWidth");
    expect(started.room.revision).toBe(3);

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected the deck item to be ready.");
    }

    expect(started.room.game.item).toMatchObject({
      category: "Chaos Quant",
      context_clue: "Convert the binary string to a decimal integer.",
      item_title: "Base 10 representation of binary 101010"
    });

    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateGeneratedItemStorageKey(started.room.game.item.round_id)
    ]);

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room).toEqual(started.room);

    guestConnection.socket.close();
  });

  it("ADVANCE_ROUND picks deck index (round - 1) % deck length", async () => {
    const stub = roomStub(RETRY_FAILURE_ROOM_NAME);
    const created = await createRoom(stub, "Host", { totalRounds: 3 });

    if (!created.created) {
      throw new Error("Expected a newly created deck-advance room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    expect(started.room.game.roundNumber).toBe(1);

    const firstSettlement = await settleCurrentRound(
      stub,
      started.room,
      created.hostToken,
      joined.guestToken
    );

    expect(firstSettlement.game.phase).toBe("settlement");

    const roundTwo = await applyRoomCommandWithoutTrueValue(stub, {
      type: "ADVANCE_ROUND",
      credential: created.hostToken
    });

    expect(roundTwo.room.game.phase).toBe("proposingWidth");
    expect(roundTwo.room.game.roundNumber).toBe(2);

    if (roundTwo.room.game.phase !== "proposingWidth") {
      throw new Error("Expected the round 2 deck item to be ready.");
    }

    expect(roundTwo.room.game.item).toMatchObject({
      item_title: "The 10th Fibonacci number",
      context_clue: "F(1) = 1, F(2) = 1, F(3) = 2, ..., find F(10)."
    });
  });

  it("rejects guest item-generation retries over HTTP and WebSocket", async () => {
    const stub = roomStub(RETRY_UNAUTHORIZED_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created unauthorized retry room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    expect(started.room.game.phase).toBe("proposingWidth");

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected the deck item to be ready.");
    }

    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateGeneratedItemStorageKey(started.room.game.item.round_id)
    ]);

    const httpRetryResponse = await postRoomCommand(stub, {
      type: "RETRY_ITEM_GENERATION",
      credential: joined.guestToken
    });
    const httpRetry = await expectPublicJson<RoomErrorResponse>(httpRetryResponse);

    expect(httpRetryResponse.status).toBe(HTTP_FORBIDDEN_STATUS);
    expect(httpRetry.error.code).toBe("host_control_denied");

    const socketRetryError = nextSocketMessage<RoomSocketMessage>(guestConnection.socket);

    guestConnection.socket.send(JSON.stringify(withTestCommandId({
      type: "RETRY_ITEM_GENERATION",
      credential: joined.guestToken
    })));

    await expect(socketRetryError).resolves.toMatchObject({
      type: "ROOM_ERROR",
      error: {
        code: "host_control_denied"
      }
    });

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room.revision).toBe(started.room.revision);
    expect(persisted.room.game).toEqual(started.room.game);
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateGeneratedItemStorageKey(started.room.game.item.round_id)
    ]);

    guestConnection.socket.close();
  });

  it("settles from the private Durable Object item after a fresh stub", async () => {
    const stub = roomStub(SETTLEMENT_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created settlement room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);

    expectRoomPresence(guestConnection.initial.room, { A: false, B: true });

    const startResponse = await postRoomCommand(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });
    const started = await expectPublicJsonWithoutTrueValue<CommandRoomResponse>(startResponse);

    expect(started.room.game.phase).toBe("proposingWidth");

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const privateItemKey = privateGeneratedItemStorageKey(
      started.room.game.item.round_id
    );

    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateItemKey
    ]);

    const freshStub = roomStub(SETTLEMENT_ROOM_NAME);
    const widthResponse = await postRoomCommand(freshStub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: created.hostToken,
      width: 100
    });
    const width = await expectPublicJsonWithoutTrueValue<CommandRoomResponse>(widthResponse);

    expect(widthResponse.status).toBe(HTTP_OK_STATUS);
    expect(width.room.game.phase).toBe("negotiatingWidth");

    const tradeOnWidthResponse = await postRoomCommand(freshStub, {
      type: "TRADE_ON_WIDTH",
      credential: joined.guestToken
    });
    const tradeOnWidth = await expectPublicJsonWithoutTrueValue<CommandRoomResponse>(tradeOnWidthResponse);

    expect(tradeOnWidthResponse.status).toBe(HTTP_OK_STATUS);
    expect(tradeOnWidth.room.game.phase).toBe("configuringMarket");

    const quoteResponse = await postRoomCommand(freshStub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: created.hostToken,
      quote: {
        bid: 3500,
        ask: 3600
      }
    });
    const quoted = await expectPublicJsonWithoutTrueValue<CommandRoomResponse>(quoteResponse);

    expect(quoteResponse.status).toBe(HTTP_OK_STATUS);
    expect(quoted.room.game.phase).toBe("choosingSide");

    const settlementResponse = await postRoomCommand(freshStub, {
      type: "EXECUTE_TRADE",
      credential: joined.guestToken,
      side: "BUY"
    });
    const settled = await expectPublicJson<CommandRoomResponse>(settlementResponse);

    expect(settlementResponse.status).toBe(HTTP_OK_STATUS);
    expect(settled.room.game.phase).toBe("settlement");

    if (settled.room.game.phase !== "settlement") {
      throw new Error("Expected settlement phase.");
    }

    expect(settled.room.game.item.true_value).toBe(42);
    expect(settled.room.game.settlement.trueValue).toBe(42);
    expect(settled.room.game.settlement.side).toBe("BUY");

    const persisted = await accessRoom(roomStub(SETTLEMENT_ROOM_NAME), created.hostToken);

    expect(persisted.room).toEqual(settled.room);
    await expect(privateGeneratedItemKeys(freshStub)).resolves.toEqual([]);

    guestConnection.socket.close();
  });

  it.each([
    {
      roomName: MISSING_SETTLEMENT_ITEM_ROOM_NAME,
      storageState: "missing",
      expectedPrivateKeys: noPrivateItemKeys,
      prepareUnavailableItem: deleteStoredPrivateGeneratedItem
    },
    {
      roomName: CORRUPT_SETTLEMENT_ITEM_ROOM_NAME,
      storageState: "corrupt",
      expectedPrivateKeys: (privateItemKey: string) => [privateItemKey],
      prepareUnavailableItem: corruptStoredPrivateGeneratedItem
    }
  ] as const)(
    "fails settlement without leaking private item data when the stored item is $storageState",
    async ({ roomName, expectedPrivateKeys, prepareUnavailableItem }) => {
      const stub = roomStub(roomName);
      const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created unavailable-settlement-item room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const privateItemKey = privateGeneratedItemStorageKey(
      started.room.game.item.round_id
    );

    await prepareUnavailableItem(stub, privateItemKey);
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual(
      expectedPrivateKeys(privateItemKey)
    );

    const marketMakerToken = tokenForPlayer(
      started.room.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );
    const traderToken = tokenForPlayer(
      started.room.game.roles.trader,
      created.hostToken,
      joined.guestToken
    );
    const width = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: marketMakerToken,
      width: 100
    });

    expect(width.room.game.phase).toBe("negotiatingWidth");

    const configuring = await applyRoomCommandWithoutTrueValue(stub, {
      type: "TRADE_ON_WIDTH",
      credential: traderToken
    });

    expect(configuring.room.game.phase).toBe("configuringMarket");

    const quoted = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: marketMakerToken,
      quote: {
        bid: 3500,
        ask: 3600
      }
    });

    expect(quoted.room.game.phase).toBe("choosingSide");

    const settlementResponse = await postRoomCommand(stub, {
      type: "EXECUTE_TRADE",
      credential: traderToken,
      side: "BUY"
    });
    const failed = await expectPublicJsonWithoutPrivateItemMetadata<CommandRoomResponse>(
      settlementResponse
    );

    expect(settlementResponse.status).toBe(HTTP_OK_STATUS);
    expect(failed.room.game.phase).toBe("choosingSide");
    expect(failed.room.revision).toBe(quoted.room.revision + 2);

    if (failed.room.game.phase !== "choosingSide") {
      throw new Error("Expected settlement failure to return to side choice.");
    }

    expect(failed.room.game.lastError).toBe(
      "Private generated item is unavailable for settlement."
    );
    expect(failed.room.game.scores).toEqual(quoted.room.game.scores);
    expect(failed.room.game.log.at(-1)?.message).toBe(
      "Settlement failed: Private generated item is unavailable for settlement."
    );

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room).toEqual(failed.room);
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual(
      expectedPrivateKeys(privateItemKey)
    );

    guestConnection.socket.close();
  });

  it("recovers a room durably stuck in settling via host retry, preserving prior-round scores (F-02)", async () => {
    const stub = roomStub(STUCK_SETTLING_ROOM_NAME);
    const created = await createRoom(stub, "Host", { totalRounds: 2 });

    if (!created.created) {
      throw new Error("Expected a newly created stuck-settling room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    // Round 1 settles normally and contributes to the scoreboard. Recovering
    // round 2 must not touch this. Quote away from round 1's deck true_value
    // (42, the Chaos Quant deck's first item) so round 1's PnL is non-zero and
    // score preservation is a meaningful assertion, not a 0 === 0 coincidence.
    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected a room ready for round 1 width proposal.");
    }

    const round1MarketMakerToken = tokenForPlayer(
      started.room.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );
    const round1TraderToken = tokenForPlayer(
      started.room.game.roles.trader,
      created.hostToken,
      joined.guestToken
    );

    const round1Width = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: round1MarketMakerToken,
      width: 100
    });

    expect(round1Width.room.game.phase).toBe("negotiatingWidth");

    const round1Configuring = await applyRoomCommandWithoutTrueValue(stub, {
      type: "TRADE_ON_WIDTH",
      credential: round1TraderToken
    });

    expect(round1Configuring.room.game.phase).toBe("configuringMarket");

    const round1Quoted = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: round1MarketMakerToken,
      quote: {
        bid: 3400,
        ask: 3500
      }
    });

    expect(round1Quoted.room.game.phase).toBe("choosingSide");

    const firstSettlementResponse = await applyRoomCommand(stub, {
      type: "EXECUTE_TRADE",
      credential: round1TraderToken,
      side: "BUY"
    });

    if (firstSettlementResponse.room.game.phase !== "settlement") {
      throw new Error("Expected round 1 to settle.");
    }

    const firstSettlement = firstSettlementResponse.room;
    const priorScores = firstSettlement.game.scores;

    expect(priorScores.A !== 0 || priorScores.B !== 0).toBe(true);

    const round2 = await applyRoomCommandWithoutTrueValue(stub, {
      type: "ADVANCE_ROUND",
      credential: created.hostToken
    });

    if (round2.room.game.phase !== "proposingWidth") {
      throw new Error("Expected round 2 item to be ready.");
    }

    expect(round2.room.game.roundNumber).toBe(2);

    const marketMakerToken = tokenForPlayer(
      round2.room.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );
    const traderToken = tokenForPlayer(
      round2.room.game.roles.trader,
      created.hostToken,
      joined.guestToken
    );

    const width = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: marketMakerToken,
      width: 100
    });

    expect(width.room.game.phase).toBe("negotiatingWidth");

    const configuring = await applyRoomCommandWithoutTrueValue(stub, {
      type: "TRADE_ON_WIDTH",
      credential: traderToken
    });

    expect(configuring.room.game.phase).toBe("configuringMarket");

    const quoted = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: marketMakerToken,
      quote: {
        bid: 3500,
        ask: 3600
      }
    });

    expect(quoted.room.game.phase).toBe("choosingSide");

    // Simulate the F-02 trapdoor: the settling transition is durably
    // persisted, but the settlement effect that should follow it never runs
    // (isolate evicted / request abandoned before applyAutomaticRoomEffects
    // reached receiveStoredSettlement).
    const stuck = await forceStuckSettling(stub, traderToken, "BUY");

    expect(stuck.game.phase).toBe("settling");

    // Confirm the room is durably stuck: a fresh load still shows settling,
    // and no client command targets that phase today.
    const reloadedWhileStuck = await accessRoom(stub, created.hostToken);

    expect(reloadedWhileStuck.room.game.phase).toBe("settling");
    expect(reloadedWhileStuck.room.game.roundNumber).toBe(2);

    const blockedTrade = await postRoomCommand(stub, {
      type: "EXECUTE_TRADE",
      credential: traderToken,
      side: "SELL"
    });
    const blockedTradeResult = await expectPublicJson<RoomErrorResponse>(blockedTrade);

    expect(blockedTrade.status).toBe(HTTP_CONFLICT_STATUS);
    expect(blockedTradeResult.error.code).toBe("invalid_game_phase");

    // Host recovery: retrying re-runs settlement for THIS round from the
    // already-committed item, quote, and side. It must not regenerate the
    // item, restart the round, or touch round 1's scores.
    const recovered = await applyRoomCommand(stub, {
      type: "RETRY_ITEM_GENERATION",
      credential: created.hostToken
    });

    expect(recovered.room.game.phase).toBe("settlement");

    if (recovered.room.game.phase !== "settlement") {
      throw new Error("Expected host retry to complete round 2 settlement.");
    }

    expect(recovered.room.game.roundNumber).toBe(2);
    expect(recovered.room.game.settlement.side).toBe("BUY");
    expect(recovered.room.game.settlement.transactionPrice).toBe(3600);
    expect(recovered.room.game.scores).toEqual(
      applySettlementToScores(priorScores, recovered.room.game.settlement)
    );

    // The round can now complete without ever resetting to the lobby.
    const finished = await applyRoomCommandWithoutTrueValue(stub, {
      type: "ADVANCE_ROUND",
      credential: created.hostToken
    });

    expect(finished.room.lifecycle).toBe("finished");
    expect(finished.room.game.phase).toBe("gameOver");

    if (finished.room.game.phase !== "gameOver") {
      throw new Error("Expected the game to finish.");
    }

    expect(finished.room.game.scores).toEqual(recovered.room.game.scores);

    guestConnection.socket.close();
  });

  it("blocks the host from resetting or kicking while a trade is settling, and both work again once retry resolves it", async () => {
    // The competitive-integrity gap: a host who is the trader this round has
    // already locked in an outcome the instant EXECUTE_TRADE lands (the
    // private true_value was fixed back at item generation), but the
    // reveal/score update is still pending in `settling`. RESET_TO_LOBBY and
    // KICK_GUEST are host-control commands with no other phase restriction,
    // so without this guard the host could always duck a trade going
    // against them by nuking the room before settlement resolves - and the
    // private item would be deleted with it, so the outcome would never
    // even be computed.
    const stub = roomStub(SETTLING_ABORT_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created settling-abort room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const marketMakerToken = tokenForPlayer(
      started.room.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );
    const traderToken = tokenForPlayer(
      started.room.game.roles.trader,
      created.hostToken,
      joined.guestToken
    );

    const width = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: marketMakerToken,
      width: 100
    });

    expect(width.room.game.phase).toBe("negotiatingWidth");

    const configuring = await applyRoomCommandWithoutTrueValue(stub, {
      type: "TRADE_ON_WIDTH",
      credential: traderToken
    });

    expect(configuring.room.game.phase).toBe("configuringMarket");

    const quoted = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: marketMakerToken,
      quote: {
        bid: 3400,
        ask: 3500
      }
    });

    expect(quoted.room.game.phase).toBe("choosingSide");

    // Force the round into `settling` and leave it there, exactly like the
    // F-02 fixture above - this is the window RESET_TO_LOBBY/KICK_GUEST must
    // not be able to short-circuit.
    const stuck = await forceStuckSettling(stub, traderToken, "BUY");

    if (stuck.game.phase !== "settling") {
      throw new Error("Expected forceStuckSettling to land in settling.");
    }

    const roundId = stuck.game.item.round_id;

    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateGeneratedItemStorageKey(roundId)
    ]);

    const blockedReset = await postRoomCommand(stub, {
      type: "RESET_TO_LOBBY",
      credential: created.hostToken
    });
    const blockedResetResult = await expectPublicJson<RoomErrorResponse>(blockedReset);

    expect(blockedReset.status).toBe(HTTP_CONFLICT_STATUS);
    expect(blockedResetResult.error.code).toBe("round_settling");

    const blockedKick = await postRoomCommand(stub, {
      type: "KICK_GUEST",
      credential: created.hostToken
    });
    const blockedKickResult = await expectPublicJson<RoomErrorResponse>(blockedKick);

    expect(blockedKick.status).toBe(HTTP_CONFLICT_STATUS);
    expect(blockedKickResult.error.code).toBe("round_settling");

    // Neither rejected command may have mutated the room or torn down the
    // private true_value the eventual settlement still needs.
    const reloadedWhileBlocked = await accessRoom(stub, created.hostToken);

    expect(reloadedWhileBlocked.room.game.phase).toBe("settling");
    expect(reloadedWhileBlocked.room.revision).toBe(stuck.revision);
    expect(reloadedWhileBlocked.room.seats.guest.occupied).toBe(true);
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateGeneratedItemStorageKey(roundId)
    ]);

    // Recovery path: the host is not stranded. RETRY_ITEM_GENERATION is
    // already authorized for hostControl and already resolves a room stuck
    // in `settling` (F-02); it is untouched by this guard.
    const recovered = await applyRoomCommand(stub, {
      type: "RETRY_ITEM_GENERATION",
      credential: created.hostToken
    });

    expect(recovered.room.game.phase).toBe("settlement");

    // Now that the round has left `settling`, both host-control commands
    // work normally again.
    const reset = await applyRoomCommandWithoutTrueValue(stub, {
      type: "RESET_TO_LOBBY",
      credential: created.hostToken
    });

    expect(reset.room.lifecycle).toBe("lobby");
    expect(reset.room.game.phase).toBe("setup");
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([]);

    guestConnection.socket.close();
  });

  it("rejects guest recovery of a room stuck in settling without mutating it", async () => {
    const stub = roomStub(STUCK_SETTLING_UNAUTHORIZED_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created unauthorized stuck-settling room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const marketMakerToken = tokenForPlayer(
      started.room.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );
    const traderToken = tokenForPlayer(
      started.room.game.roles.trader,
      created.hostToken,
      joined.guestToken
    );

    const width = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: marketMakerToken,
      width: 100
    });

    expect(width.room.game.phase).toBe("negotiatingWidth");

    const configuring = await applyRoomCommandWithoutTrueValue(stub, {
      type: "TRADE_ON_WIDTH",
      credential: traderToken
    });

    expect(configuring.room.game.phase).toBe("configuringMarket");

    const quoted = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: marketMakerToken,
      quote: {
        bid: 3500,
        ask: 3600
      }
    });

    expect(quoted.room.game.phase).toBe("choosingSide");

    const stuck = await forceStuckSettling(stub, traderToken, "BUY");

    expect(stuck.game.phase).toBe("settling");

    const guestCredential = tokenForPlayer("B", created.hostToken, joined.guestToken);
    const httpRetryResponse = await postRoomCommand(stub, {
      type: "RETRY_ITEM_GENERATION",
      credential: guestCredential
    });
    const httpRetry = await expectPublicJson<RoomErrorResponse>(httpRetryResponse);

    expect(httpRetryResponse.status).toBe(HTTP_FORBIDDEN_STATUS);
    expect(httpRetry.error.code).toBe("host_control_denied");

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room.game.phase).toBe("settling");
    expect(persisted.room.revision).toBe(stuck.revision);

    guestConnection.socket.close();
  });

  it("recovers a room durably stuck in settling automatically via the alarm, with no client command (F-02 auto-resume)", async () => {
    const stub = roomStub(STUCK_SETTLING_AUTO_RESUME_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created auto-resume room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const marketMakerToken = tokenForPlayer(
      started.room.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );
    const traderToken = tokenForPlayer(
      started.room.game.roles.trader,
      created.hostToken,
      joined.guestToken
    );

    await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: marketMakerToken,
      width: 100
    });
    await applyRoomCommandWithoutTrueValue(stub, {
      type: "TRADE_ON_WIDTH",
      credential: traderToken
    });
    const quoted = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: marketMakerToken,
      quote: { bid: 3400, ask: 3500 }
    });

    expect(quoted.room.game.phase).toBe("choosingSide");

    const stuck = await forceStuckSettling(stub, traderToken, "BUY");

    expect(stuck.game.phase).toBe("settling");

    if (stuck.game.phase !== "settling") {
      throw new Error("Expected forceStuckSettling to land in settling.");
    }

    const pendingBeforeAlarm = await readPendingRoomEffect(stub);

    expect(pendingBeforeAlarm).toMatchObject({
      kind: "settle",
      roundId: stuck.game.item.round_id,
      attempts: 0
    });

    // Registered before the alarm runs (see the identical comment on the
    // F-05 forfeit-broadcast test above) so the listener is armed before
    // runDueSettleEffect's own broadcastRoomSnapshot call fires.
    const autoResumeBroadcast = nextSocketMessage<RoomSnapshotSocketMessage>(
      guestConnection.socket
    );

    // The alarm fires on its own here - no RETRY_ITEM_GENERATION, no other
    // client command touches this room between forceStuckSettling and the
    // assertions below.
    await runRoomCleanupAlarm(stub);

    const resumed = await accessRoom(stub, created.hostToken);

    expect(resumed.room.game.phase).toBe("settlement");

    if (resumed.room.game.phase !== "settlement") {
      throw new Error("Expected the alarm to auto-resume settlement.");
    }

    expect(resumed.room.game.settlement.side).toBe("BUY");
    expect(resumed.room.game.settlement.transactionPrice).toBe(3500);
    expect(resumed.room.game.scores).toEqual(
      applySettlementToScores(quoted.room.game.scores, resumed.room.game.settlement)
    );
    expect(resumed.room.revision).toBe(stuck.revision + 1);

    await expect(readPendingRoomEffect(stub)).resolves.toBeNull();
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual(noPrivateItemKeys());

    // This auto-resume is not a response to any request a client is
    // waiting on either - without runDueSettleEffect's own broadcast, a
    // connected client would never hear that F-02's own recovery path
    // just settled the round out from under it.
    const broadcast = await autoResumeBroadcast;

    expect(broadcast.room.game.phase).toBe("settlement");
    expect(broadcast.room.revision).toBe(resumed.room.revision);

    guestConnection.socket.close();
  });

  it("still purges an expired room and its pending settlement marker when the TTL deadline wins the race (regression)", async () => {
    const stub = roomStub(STUCK_SETTLING_TTL_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created TTL-regression room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const marketMakerToken = tokenForPlayer(
      started.room.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );
    const traderToken = tokenForPlayer(
      started.room.game.roles.trader,
      created.hostToken,
      joined.guestToken
    );

    await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: marketMakerToken,
      width: 100
    });
    await applyRoomCommandWithoutTrueValue(stub, {
      type: "TRADE_ON_WIDTH",
      credential: traderToken
    });
    const quoted = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: marketMakerToken,
      quote: { bid: 3400, ask: 3500 }
    });

    expect(quoted.room.game.phase).toBe("choosingSide");

    await forceStuckSettling(stub, traderToken, "BUY");
    await expect(readPendingRoomEffect(stub)).resolves.not.toBeNull();

    // The room's TTL has *also* elapsed while a settlement effect is still
    // pending. Multiplexing the single alarm slot between the two deadlines
    // must not let the outstanding pending effect suppress TTL cleanup -
    // this is the regression the multiplexer most likely introduces.
    await expireStoredRoomEnvelope(stub);
    await runRoomCleanupAlarm(stub);

    await expect(storedRoomEnvelopeExists(stub)).resolves.toBe(false);
    await expect(readPendingRoomEffect(stub)).resolves.toBeNull();
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual(noPrivateItemKeys());
    await expect(storedRoomAlarm(stub)).resolves.toBeNull();

    guestConnection.socket.close();
  });

  it("multiplexes both outstanding deadlines: the nearer pending effect fires first, and the farther TTL deadline stays scheduled afterward", async () => {
    const stub = roomStub(STUCK_SETTLING_BOTH_DEADLINES_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created both-deadlines room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const marketMakerToken = tokenForPlayer(
      started.room.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );
    const traderToken = tokenForPlayer(
      started.room.game.roles.trader,
      created.hostToken,
      joined.guestToken
    );

    await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: marketMakerToken,
      width: 100
    });
    await applyRoomCommandWithoutTrueValue(stub, {
      type: "TRADE_ON_WIDTH",
      credential: traderToken
    });
    const quoted = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: marketMakerToken,
      quote: { bid: 3400, ask: 3500 }
    });

    expect(quoted.room.game.phase).toBe("choosingSide");

    const stuck = await forceStuckSettling(stub, traderToken, "BUY");
    const pendingEffect = await readPendingRoomEffect(stub);

    if (pendingEffect === null) {
      throw new Error("Expected a pending settlement marker.");
    }

    const ttlDeadline = roomExpiresAtMs(stuck);

    expect(pendingEffect.notBeforeMs).toBeLessThan(ttlDeadline);

    // This test is specifically about TTL/pending-effect multiplexing, not
    // the F-08 liveness sweep - close the still-open guest socket (opened
    // above only so START_ROOM's presence gate would pass) and confirm the
    // DO's live-socket-derived state has caught up, so the alarm math below
    // is not also folding in a liveness deadline.
    await closeSocketAndWaitOffline(stub, guestConnection.socket, created.hostToken, {
      A: false,
      B: false
    });

    // forceStuckSettling deliberately leaves the *scheduled* DO alarm at the
    // far TTL deadline rather than the pending effect's earlier, already-due
    // notBeforeMs (see its comment - an overdue alarm can fire
    // opportunistically the moment this fixture is next touched, which
    // would race the assertions below). alarm() must still resolve the
    // nearer pending effect on the very next invocation regardless, because
    // it compares now against the stored marker's notBeforeMs directly
    // rather than trusting whatever deadline it happened to be woken for.
    await expect(storedRoomAlarm(stub)).resolves.toBe(ttlDeadline);

    await runRoomCleanupAlarm(stub);

    const resumed = await accessRoom(stub, created.hostToken);

    expect(resumed.room.game.phase).toBe("settlement");
    await expect(readPendingRoomEffect(stub)).resolves.toBeNull();

    // Once the nearer deadline resolves, the farther TTL deadline must still
    // be scheduled - the multiplexer must not have dropped it.
    const ttlAfterResolution = await storedRoomExpiresAt(stub);

    await expect(storedRoomAlarm(stub)).resolves.toBe(ttlAfterResolution);
    expect(ttlAfterResolution).toBeGreaterThan(Date.now());
  });

  it("fires a due F-05 turn deadline via the alarm and forfeits the round into roundForfeited", async () => {
    const stub = roomStub(TURN_EXPIRY_ALARM_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created turn-expiry room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const forced = await forcePastTurnDeadline(stub);

    if (forced.game.phase !== "proposingWidth") {
      throw new Error("Expected proposingWidth after forcing the deadline.");
    }

    const { marketMaker, trader } = forced.game.roles;

    // Registered before the alarm runs, mirroring how openRoomSocket itself
    // registers its own "initial" listener before accept() - the alarm's
    // broadcast (see runDueTurnExpiry's own broadcastRoomSnapshot call)
    // happens synchronously inside runRoomCleanupAlarm below, so listening
    // for it must start first or the message could already have been sent.
    const forfeitBroadcast = nextSocketMessage<RoomSnapshotSocketMessage>(
      guestConnection.socket
    );

    await runRoomCleanupAlarm(stub);

    const resumed = await accessRoom(stub, created.hostToken);

    expect(resumed.room.game.phase).toBe("roundForfeited");

    if (resumed.room.game.phase !== "roundForfeited") {
      throw new Error("Expected roundForfeited after the alarm fired.");
    }
    expect(resumed.room.game.forfeit).toMatchObject({
      roundNumber: 1,
      phase: "proposingWidth",
      forfeitedBy: marketMaker,
      awardedTo: trader
    });
    expect(resumed.room.revision).toBe(forced.revision + 1);

    // The alarm-driven forfeit is not a response to any request the client
    // is waiting on, so a connected client only ever learns about it
    // through an explicit broadcast - closing a gap where the round
    // genuinely forfeited and persisted correctly but a connected client's
    // own socket never heard about it until some unrelated later command.
    const broadcast = await forfeitBroadcast;

    expect(broadcast.room.game.phase).toBe("roundForfeited");
    expect(broadcast.room.revision).toBe(resumed.room.revision);

    guestConnection.socket.close();
  });

  // F-06: closes the shot-clock exploit where a trader who reads the quote
  // as badly mispriced against them could deliberately stall choosingSide's
  // clock to cap their loss at the spread width instead of taking a larger
  // settlement loss. A choosingSide timeout must settle - via the exact same
  // settling -> SETTLEMENT_RECEIVED path EXECUTE_TRADE uses, not a
  // roundForfeited shortcut - against whichever side is worse for the
  // trader, so stalling can never beat acting. The static deck fixes round 1's
  // Chaos Quant true_value at 42 for every room in this file.
  it("settles a choosingSide timeout against BUY when BUY is the worse side for the trader (F-06)", async () => {
    const stub = roomStub(CHOOSING_SIDE_TIMEOUT_BUY_WORSE_ROOM_NAME);
    // trueValue 42, quote 40/60: buyPnL = 42-60 = -18,
    // sellPnL = 42-40 = 2. BUY is worse.
    const { hostToken, guestToken, quoted } = await readyChoosingSide(stub, { bid: 40, ask: 60 });
    // Opened after the room reaches choosingSide (a socket does not need to
    // have been present since room creation to receive a later broadcast),
    // so runDueTurnExpiry's own broadcastRoomSnapshot call - not just the
    // committed storage - can be asserted on below.
    const guestConnection = await openRoomSocket(stub, guestToken);

    const forced = await forcePastTurnDeadline(stub);

    if (forced.game.phase !== "choosingSide") {
      throw new Error("Expected choosingSide after forcing the deadline.");
    }

    // Registered before the alarm runs (see the identical comment on the
    // F-05 forfeit-broadcast test above): F-06's choosingSide timeout
    // synchronously broadcasts twice within the one alarm invocation - once
    // for runDueTurnExpiry's own settling transition, and again once
    // receiveStoredSettlement resolves it - so both listeners must already
    // be attached before the alarm runs (see nextSocketMessages).
    const broadcasts = nextSocketMessages<RoomSnapshotSocketMessage>(
      guestConnection.socket,
      2
    );

    await runRoomCleanupAlarm(stub);

    const resumed = await accessRoom(stub, hostToken);

    expect(resumed.room.game.phase).toBe("settlement");

    if (resumed.room.game.phase !== "settlement") {
      throw new Error("Expected settlement after the F-06 forced settle effect ran.");
    }
    expect(resumed.room.game.settlement.side).toBe("BUY");
    expect(resumed.room.game.settlement.forcedByTimeout).toBe(true);
    expect(resumed.room.game.settlement.traderPnL).toBe(-18);
    expect(resumed.room.game.item.true_value).toBe(42);
    expect(resumed.room.revision).toBe(quoted.room.revision + 2);
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual(noPrivateItemKeys());

    // F-06's settling -> settlement transition runs off the alarm just
    // like a plain forfeit does - without runDueTurnExpiry's broadcast
    // after entering settling, and receiveStoredSettlement's own broadcast
    // once it resolves, a connected trader would never learn their clock
    // ran out and which side it settled against.
    const [settlingBroadcast, settlementBroadcast] = await broadcasts;

    expect(settlingBroadcast.room.game.phase).toBe("settling");
    expect(settlementBroadcast.room.game.phase).toBe("settlement");
    expect(settlementBroadcast.room.revision).toBe(resumed.room.revision);

    guestConnection.socket.close();
  });

  it("settles a choosingSide timeout against SELL when SELL is the worse side for the trader (F-06)", async () => {
    const stub = roomStub(CHOOSING_SIDE_TIMEOUT_SELL_WORSE_ROOM_NAME);
    // trueValue 42, quote 30/50: buyPnL = 42-50 = -8,
    // sellPnL = 30-42 = -12. SELL is worse.
    const { hostToken } = await readyChoosingSide(stub, { bid: 30, ask: 50 });

    const forced = await forcePastTurnDeadline(stub);

    if (forced.game.phase !== "choosingSide") {
      throw new Error("Expected choosingSide after forcing the deadline.");
    }

    await runRoomCleanupAlarm(stub);

    const resumed = await accessRoom(stub, hostToken);

    expect(resumed.room.game.phase).toBe("settlement");

    if (resumed.room.game.phase !== "settlement") {
      throw new Error("Expected settlement after the F-06 forced settle effect ran.");
    }
    expect(resumed.room.game.settlement.side).toBe("SELL");
    expect(resumed.room.game.settlement.forcedByTimeout).toBe(true);
    expect(resumed.room.game.settlement.traderPnL).toBe(-12);
  });

  it("breaks an exact choosingSide-timeout PnL tie by deterministically forcing BUY (F-06)", async () => {
    const stub = roomStub(CHOOSING_SIDE_TIMEOUT_TIE_ROOM_NAME);
    // trueValue 42, quote 32/52: buyPnL = 42-52 = -10,
    // sellPnL = 32-42 = -10. Tied - must resolve to BUY, not depend on
    // iteration order or floating point.
    const { hostToken } = await readyChoosingSide(stub, { bid: 32, ask: 52 });

    const forced = await forcePastTurnDeadline(stub);

    if (forced.game.phase !== "choosingSide") {
      throw new Error("Expected choosingSide after forcing the deadline.");
    }

    await runRoomCleanupAlarm(stub);

    const resumed = await accessRoom(stub, hostToken);

    expect(resumed.room.game.phase).toBe("settlement");

    if (resumed.room.game.phase !== "settlement") {
      throw new Error("Expected settlement after the F-06 forced settle effect ran.");
    }
    expect(resumed.room.game.settlement.side).toBe("BUY");
    expect(resumed.room.game.settlement.forcedByTimeout).toBe(true);
    expect(resumed.room.game.settlement.traderPnL).toBe(-10);
  });

  // testExpireTurnSoon's own gate: WORKER_TEST_MODE is the *only* thing
  // standing between this route and production, since wrangler.toml sets no
  // vars at all (so the var is unset in every real deploy) and the route's
  // own authorization is deliberately access-level, not activePlayer-level
  // (see testExpireTurnSoon's doc comment) - either seated player can force
  // the *other* player's clock. That is safe only because the gate makes the
  // route unreachable outside test/dev; these tests pin both halves of that
  // safety property directly, since nothing previously asserted either one.
  it("404s POST /room/test-expire-turn, and its public /api/rooms alias, when WORKER_TEST_MODE is unset - even for an otherwise-valid, well-authenticated request", async () => {
    const stub = roomStub(TEST_EXPIRE_TURN_GATE_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created test-expire-turn gate room.");
    }

    await joinRoom(stub, "Guest");
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    // A perfectly well-formed, correctly-authenticated request from the
    // room's own host, while the room genuinely has a turn clock running -
    // every other precondition the route checks is satisfied. Only the
    // env-var gate stands between this and a successful fast-forward.
    const directResponse = await stub.fetch(ROOM_TEST_EXPIRE_TURN_URL, {
      body: JSON.stringify({ credential: created.hostToken }),
      method: "POST"
    });
    const directRejected = await expectPublicJson<RoomErrorResponse>(directResponse);

    expect(directResponse.status).toBe(HTTP_NOT_FOUND_STATUS);
    expect(directRejected.error.code).toBe("not_found");

    const publicResponse = await fetchPublicWorker(new Request(
      `${PUBLIC_ROOMS_URL}/${created.room.id}/test-expire-turn`,
      {
        body: JSON.stringify({ credential: created.hostToken }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }
    ));
    const publicRejected = await expectPublicJson<RoomErrorResponse>(publicResponse);

    expect(publicResponse.status).toBe(HTTP_NOT_FOUND_STATUS);
    expect(publicRejected.error.code).toBe("not_found");

    // Neither rejected request mutated the room: the turn clock the request
    // would have fast-forwarded is untouched.
    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room.revision).toBe(started.room.revision);
    expect(persisted.room.game).toEqual(started.room.game);
  });

  it("rejects missing, malformed, and wrong-room credentials for POST /room/test-expire-turn once WORKER_TEST_MODE is enabled, but fast-forwards the clock for a valid one", async () => {
    const stub = roomStub(TEST_EXPIRE_TURN_CREDENTIALS_ROOM_NAME);
    const otherStub = roomStub(TEST_EXPIRE_TURN_OTHER_ROOM_NAME);

    await withWorkerTestModeEnabled(stub, async () => {
      const created = await createRoom(stub, "Host");

      if (!created.created) {
        throw new Error("Expected a newly created test-expire-turn credentials room.");
      }

      const joined = await joinRoom(stub, "Guest");
      const started = await applyRoomCommandWithoutTrueValue(stub, {
        type: "START_ROOM",
        credential: created.hostToken
      });

      if (started.room.game.phase !== "proposingWidth") {
        throw new Error("Expected generated item to be ready.");
      }

      // Missing credential: rejected the same way every other room POST
      // endpoint rejects an absent `credential` field, before authorization
      // is ever reached (see decodeAccessRoomBody).
      const missingResponse = await stub.fetch(ROOM_TEST_EXPIRE_TURN_URL, {
        body: JSON.stringify({}),
        method: "POST"
      });
      const missingRejected = await expectPublicJson<RoomErrorResponse>(missingResponse);

      expect(missingResponse.status).toBe(HTTP_BAD_REQUEST_STATUS);
      expect(missingRejected.error.code).toBe("invalid_request");

      // Malformed credential: a string is not a capability token object.
      const malformedResponse = await stub.fetch(ROOM_TEST_EXPIRE_TURN_URL, {
        body: JSON.stringify({ credential: "not-a-token" }),
        method: "POST"
      });
      const malformedRejected = await expectPublicJson<RoomErrorResponse>(malformedResponse);

      expect(malformedResponse.status).toBe(HTTP_BAD_REQUEST_STATUS);
      expect(malformedRejected.error.code).toBe("invalid_request");

      // Wrong-room credential: structurally a valid token, correctly signed,
      // but minted for a different room entirely.
      const otherCreated = await createRoom(otherStub, "Someone Else");

      if (!otherCreated.created) {
        throw new Error("Expected a newly created unrelated room.");
      }

      const wrongRoomResponse = await stub.fetch(ROOM_TEST_EXPIRE_TURN_URL, {
        body: JSON.stringify({ credential: otherCreated.hostToken }),
        method: "POST"
      });
      const wrongRoomRejected = await expectPublicJson<RoomErrorResponse>(wrongRoomResponse);

      expect(wrongRoomResponse.status).toBe(HTTP_FORBIDDEN_STATUS);
      expect(wrongRoomRejected.error.code).toBe("wrong_room");

      // None of the three rejections above touched the room.
      const afterRejections = await accessRoom(stub, created.hostToken);

      expect(afterRejections.room.revision).toBe(started.room.revision);
      expect(afterRejections.room.game).toEqual(started.room.game);

      // A valid credential from the room's own guest (proving this is not
      // merely "the host's own request succeeds" but genuinely
      // access-level, per testExpireTurnSoon's own comment - either seated
      // player, not just the active one, can fast-forward the clock) still
      // works once the gate is enabled.
      const validResponse = await stub.fetch(ROOM_TEST_EXPIRE_TURN_URL, {
        body: JSON.stringify({ credential: joined.guestToken }),
        method: "POST"
      });
      const validAccepted = await expectPublicJson<CommandRoomResponse>(validResponse);

      expect(validResponse.status).toBe(HTTP_OK_STATUS);

      if (validAccepted.room.game.phase !== "proposingWidth") {
        throw new Error("Expected the room to remain in proposingWidth after fast-forwarding.");
      }

      expect(validAccepted.room.game.turnDeadlineMs).toBeLessThan(
        started.room.game.turnDeadlineMs
      );
      expect(validAccepted.room.game.turnDeadlineMs).toBeGreaterThan(Date.now());
      expect(validAccepted.room.revision).toBe(started.room.revision + 1);
    });
  });

  it("schedules the nearest of all three deadlines: the F-05 turn clock outranks the TTL when no settle effect is pending", async () => {
    // Extends "schedules the nearer of the two deadlines..." above to the
    // third deadline scheduleNextAlarm now multiplexes. A pending settle
    // effect and a turn deadline are mutually exclusive (settle only exists
    // in "settling"; a turn deadline only exists in the four other
    // actionable phases - see the class-level alarm() comment), so this
    // needs its own case: proposingWidth with a null pending effect, so
    // Math.min's third argument is the only thing standing between the far
    // TTL and the near turn clock. Flipping scheduleNextAlarm's Math.min to
    // Math.max would pick Infinity (the null pending effect's placeholder)
    // over both real deadlines, which the assertion below rules out.
    const stub = roomStub(NEAREST_OF_THREE_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created nearest-of-three room.");
    }

    await joinRoom(stub, "Guest");
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const ttlDeadline = await storedRoomExpiresAt(stub);
    const turnDeadline = started.room.game.turnDeadlineMs;

    expect(turnDeadline).toBeLessThan(ttlDeadline);
    await expect(readPendingRoomEffect(stub)).resolves.toBeNull();

    // Force the scheduled alarm to look overdue, then let alarm() re-derive
    // and reschedule purely from the freshly-loaded room's candidate
    // deadlines (none of which is actually due yet).
    await setStoredRoomAlarm(stub, Date.now() - 1);
    await runRoomCleanupAlarm(stub);

    await expect(storedRoomAlarm(stub)).resolves.toBe(turnDeadline);
  });

  it("keeps a turn deadline outstanding reachable by TTL purge (regression)", async () => {
    // Mirrors "still purges an expired room and its pending settlement
    // marker when the TTL deadline wins the race" for F-05: a turn-clocked
    // room whose TTL has also elapsed must still be purged, not stranded
    // because the multiplexer favored the nearer turn deadline.
    const stub = roomStub(TURN_EXPIRY_TTL_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created turn-expiry TTL room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    await expireStoredRoomEnvelope(stub);
    await runRoomCleanupAlarm(stub);

    await expect(storedRoomEnvelopeExists(stub)).resolves.toBe(false);
    await expect(readPendingRoomEffect(stub)).resolves.toBeNull();
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual(noPrivateItemKeys());
    await expect(storedRoomAlarm(stub)).resolves.toBeNull();

    guestConnection.socket.close();
  });

  it("does not forfeit a round that already advanced past a stale turn-expiry wake (TOCTOU regression)", async () => {
    // Mirrors "ignores a settlement effect whose round no longer matches
    // the stored room" for F-05: runDueTurnExpiry is invoked directly with
    // a deliberately stale room snapshot (proposingWidth, an old past
    // deadline) while the actually-persisted room has already moved past
    // that phase via a genuine player command - precisely the TOCTOU
    // window between alarm()'s outer transaction and this method's own
    // re-validating one.
    const stub = roomStub(STALE_TURN_EXPIRY_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created stale turn-expiry room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const staleRoom = await loadInternalRoomState(stub);

    if (staleRoom.game.phase !== "proposingWidth") {
      throw new Error("Expected internal room state in proposingWidth.");
    }

    const marketMakerToken = tokenForPlayer(
      staleRoom.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );

    // The round genuinely advances out of proposingWidth before the stale
    // wake is processed.
    const advanced = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: marketMakerToken,
      width: 100
    });

    expect(advanced.room.game.phase).toBe("negotiatingWidth");

    const staleRoomWithPastDeadline: RoomState = {
      ...staleRoom,
      game: { ...staleRoom.game, turnDeadlineMs: Date.now() - 1 }
    };

    await runDueTurnExpiryDirect(stub, staleRoomWithPastDeadline, Date.now());

    // The stale wake must not forfeit a round that already moved on.
    const after = await accessRoom(stub, created.hostToken);

    expect(after.room.game.phase).toBe("negotiatingWidth");
    expect(after.room.revision).toBe(advanced.room.revision);

    guestConnection.socket.close();
  });

  it("schedules the nearer of the two deadlines while a pending effect is not yet due", async () => {
    // Closes a mutation gap: flipping scheduleNextAlarm's Math.min to Math.max
    // (i.e. always scheduling the *farther* deadline, the exact failure its own
    // docstring warns about) previously passed the entire suite.
    //
    // The neighbouring "multiplexes both outstanding deadlines" test cannot
    // catch that, because it only observes the alarm either while the fixture
    // has deliberately pinned it to the TTL, or after the effect has resolved
    // and the marker is null -- and with a null marker scheduleNextAlarm
    // short-circuits to the TTL without ever comparing the two deadlines.
    //
    // This exercises alarm()'s not-yet-due branch, which is the one place the
    // comparison actually runs with a live marker: a pending effect whose
    // notBeforeMs is in the future but well inside the room's TTL must leave
    // the alarm armed at notBeforeMs, not at the TTL.
    const stub = roomStub(NEARER_DEADLINE_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created nearer-deadline room.");
    }

    await joinRoom(stub, "Guest");

    const ttlDeadline = await storedRoomExpiresAt(stub);
    const notBeforeMs = Date.now() + 60_000;

    expect(notBeforeMs).toBeLessThan(ttlDeadline);

    await writePendingRoomEffectForTest(stub, {
      kind: "settle",
      roundId: "round-not-yet-due",
      attempts: 0,
      notBeforeMs
    });

    await runRoomCleanupAlarm(stub);

    // The nearer deadline wins. Under Math.max this is ttlDeadline instead,
    // and the pending settlement would not be retried until the room expired.
    await expect(storedRoomAlarm(stub)).resolves.toBe(notBeforeMs);

    // Not-yet-due means untouched: the marker must survive this tick intact.
    await expect(readPendingRoomEffect(stub)).resolves.toMatchObject({
      kind: "settle",
      roundId: "round-not-yet-due",
      attempts: 0,
      notBeforeMs
    });
  });

  it("purges the command dedupe table along with the rest of an expired room's state", async () => {
    // Closes a mutation gap: deleting the dedupe-table line from
    // purgeExpiredRoomState previously passed the entire suite, because every
    // purge test asserted only on the room envelope and the private items.
    //
    // It matters because the Durable Object id is derived from the room slug
    // (idFromName), so a reused slug lands in the same storage. Stale
    // (role, commandId) entries surviving a purge would let a replay from a
    // previous room be recognised as a dedupe hit in the new one.
    const stub = roomStub(PURGE_DEDUPE_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created purge-dedupe room.");
    }

    const joined = await joinRoom(stub, "Guest");

    await openRoomSocket(stub, joined.guestToken);
    // A real command, so the dedupe entry is written by the production path
    // rather than planted directly into storage.
    await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    await expect(readCommandDedupeEntries(stub)).resolves.not.toHaveLength(0);

    await expireStoredRoomEnvelope(stub);
    await runRoomCleanupAlarm(stub);

    await expect(readCommandDedupeEntries(stub)).resolves.toEqual([]);
    await expect(readPendingRoomEffect(stub)).resolves.toBeNull();
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual(noPrivateItemKeys());
    await expect(storedRoomAlarm(stub)).resolves.toBeNull();
  });

  it("ignores a settlement effect whose round no longer matches the stored room", async () => {
    // Closes a mutation gap: removing the `item.round_id !== roundId` clause
    // from receiveStoredSettlement's re-validation previously passed the whole
    // suite. The test that claims to cover it ("does not double-settle when a
    // manual retry races the alarm") is stopped one layer earlier by the
    // reducer's phase guard, so the round_id clause itself was never reached.
    //
    // The guard defends a TOCTOU window: the room is re-read inside a fresh
    // transaction, and the round may have moved on since the caller loaded it.
    // Reproduced here by invoking receiveStoredSettlement with a room object
    // whose round_id does not match what is actually persisted, which is
    // precisely the state that window produces.
    const stub = roomStub(STALE_ROUND_SETTLE_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created stale-round room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });
    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const marketMakerToken = tokenForPlayer(
      started.room.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );
    const traderToken = tokenForPlayer(
      started.room.game.roles.trader,
      created.hostToken,
      joined.guestToken
    );

    await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: marketMakerToken,
      width: 100
    });
    await applyRoomCommandWithoutTrueValue(stub, {
      type: "TRADE_ON_WIDTH",
      credential: traderToken
    });
    await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: marketMakerToken,
      quote: { bid: 3400, ask: 3500 }
    });

    const stuck = await forceStuckSettling(stub, traderToken, "BUY");

    if (stuck.game.phase !== "settling") {
      throw new Error("Expected forceStuckSettling to land in settling.");
    }

    const revisionBefore = stuck.revision;
    const staleRoom = {
      ...stuck,
      game: {
        ...stuck.game,
        item: { ...stuck.game.item, round_id: "round-from-a-previous-round" }
      }
    };

    await runInDurableObject(stub, async (instance) => {
      await (
        instance as unknown as {
          receiveStoredSettlement(room: unknown, nowMs: number): Promise<unknown>;
        }
      ).receiveStoredSettlement(staleRoom, Date.now());
    });

    // The stale effect must not settle the round it no longer belongs to.
    const after = await accessRoom(stub, created.hostToken);

    expect(after.room.game.phase).toBe("settling");
    expect(after.room.revision).toBe(revisionBefore);

    // And the genuine, matching effect must still be able to settle it, so the
    // guard rejects the stale round rather than wedging the room.
    await runRoomCleanupAlarm(stub);

    const resumed = await accessRoom(stub, created.hostToken);

    expect(resumed.room.game.phase).toBe("settlement");

    guestConnection.socket.close();
  });

  it("exhausts retries after the attempt cap and lands in the existing choosingSide fallback instead of looping forever", async () => {
    const stub = roomStub(STUCK_SETTLING_EXHAUSTION_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created exhaustion room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const marketMakerToken = tokenForPlayer(
      started.room.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );
    const traderToken = tokenForPlayer(
      started.room.game.roles.trader,
      created.hostToken,
      joined.guestToken
    );

    await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: marketMakerToken,
      width: 100
    });
    await applyRoomCommandWithoutTrueValue(stub, {
      type: "TRADE_ON_WIDTH",
      credential: traderToken
    });
    const quoted = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: marketMakerToken,
      quote: { bid: 3400, ask: 3500 }
    });

    expect(quoted.room.game.phase).toBe("choosingSide");

    const stuck = await forceStuckSettling(stub, traderToken, "BUY");

    if (stuck.game.phase !== "settling") {
      throw new Error("Expected forceStuckSettling to land in settling.");
    }

    // Simulate a marker whose attempt budget is already exhausted (as if
    // several prior alarm wakes each failed to complete the effect). The
    // stored private item is still genuinely present and valid here - the
    // point of this test is that exhaustion terminates regardless of
    // whether the next attempt would actually have succeeded.
    await writePendingRoomEffectForTest(stub, {
      kind: "settle",
      roundId: stuck.game.item.round_id,
      attempts: TEST_PENDING_SETTLE_EFFECT_MAX_ATTEMPTS,
      notBeforeMs: Date.now() - 1
    });

    // Registered before the alarm runs (see the identical comment on the
    // F-05 forfeit-broadcast test above) so the listener is armed before
    // forceFailStuckSettlement's own broadcastRoomSnapshot call fires.
    const exhaustionBroadcast = nextSocketMessage<RoomSnapshotSocketMessage>(
      guestConnection.socket
    );

    await runRoomCleanupAlarm(stub);

    const afterExhaustion = await accessRoom(stub, created.hostToken);

    expect(afterExhaustion.room.game.phase).toBe("choosingSide");

    if (afterExhaustion.room.game.phase !== "choosingSide") {
      throw new Error("Expected exhaustion to fall back to choosingSide.");
    }

    expect(afterExhaustion.room.game.lastError).toBe(
      "Automatic settlement retries were exhausted. A host can retry settlement manually."
    );
    expect(afterExhaustion.room.revision).toBe(stuck.revision + 1);
    await expect(readPendingRoomEffect(stub)).resolves.toBeNull();

    // The exhaustion fallback runs off the alarm too - without
    // forceFailStuckSettlement's own broadcast, a connected client would
    // be stuck watching a "settling" spinner that silently resolved to
    // choosingSide with a "retries exhausted" error it never received.
    const broadcast = await exhaustionBroadcast;

    expect(broadcast.room.game.phase).toBe("choosingSide");
    expect(broadcast.room.revision).toBe(afterExhaustion.room.revision);

    // This test's remaining assertions are about the F-02/F-05 alarm
    // deadline exactly matching the fresh turn clock, not about the F-08
    // liveness sweep - close the guest socket (kept open only so the
    // exhaustion broadcast above could be observed) and run one more no-op
    // alarm tick so the liveness deadline the still-open socket would
    // otherwise fold into the alarm slot is dropped before checking the
    // exact stored alarm value below.
    await closeSocketAndWaitOffline(stub, guestConnection.socket, created.hostToken, {
      A: false,
      B: false
    });
    await runRoomCleanupAlarm(stub);

    // The alarm slot must not spin: the pending settle-effect marker is
    // gone after exhaustion, so the only deadlines left are the room's TTL
    // and the fresh F-05 turn clock SETTLEMENT_FAILED just armed on
    // re-entering choosingSide - and the turn clock is far nearer than the
    // two-hour TTL. Either way, a further alarm tick is a stable no-op.
    const alarmAfterExhaustion = await storedRoomAlarm(stub);

    expect(alarmAfterExhaustion).toBe(afterExhaustion.room.game.turnDeadlineMs);
    expect(alarmAfterExhaustion).toBeLessThan(await storedRoomExpiresAt(stub));

    await runRoomCleanupAlarm(stub);

    const afterSecondTick = await accessRoom(stub, created.hostToken);

    expect(afterSecondTick.room.revision).toBe(afterExhaustion.room.revision);
  });

  it("does not force-fail a settling round whose round_id no longer matches the exhausted pending effect (self-heals instead)", async () => {
    // forceFailStuckSettlement's own round_id re-check (see the guard right
    // after its fresh transactional read) defends the identical TOCTOU
    // window as receiveStoredSettlement's round_id clause, proven reachable
    // above by "ignores a settlement effect whose round no longer matches
    // the stored room": forceFailStuckSettlement is invoked (from
    // runDueSettleEffect, once pendingEffect.attempts >= the cap) using a
    // pendingEffect/room snapshot that may already be stale by the time its
    // own fresh transaction actually runs - the room could since have
    // settled this exact round through another path and moved on to a
    // later round that is *also* stuck in settling, which is phase
    // "settling" again but for a different round_id. The exhaustion test
    // above ("exhausts retries after the attempt cap...") only ever
    // exercises the matching-round_id branch, since it hands
    // forceFailStuckSettlement the round_id of the very room it just got
    // stuck on - so the mismatch branch itself was unreached. Reproduced
    // here the same way the earlier stale-round test reproduces its TOCTOU
    // window: call the method directly with a round_id that does not match
    // what is actually persisted.
    const stub = roomStub(STUCK_SETTLING_STALE_ROUND_EXHAUSTION_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created stale-round exhaustion room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const marketMakerToken = tokenForPlayer(
      started.room.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );
    const traderToken = tokenForPlayer(
      started.room.game.roles.trader,
      created.hostToken,
      joined.guestToken
    );

    await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: marketMakerToken,
      width: 100
    });
    await applyRoomCommandWithoutTrueValue(stub, {
      type: "TRADE_ON_WIDTH",
      credential: traderToken
    });
    await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: marketMakerToken,
      quote: { bid: 3400, ask: 3500 }
    });

    const stuck = await forceStuckSettling(stub, traderToken, "BUY");

    if (stuck.game.phase !== "settling") {
      throw new Error("Expected forceStuckSettling to land in settling.");
    }

    const revisionBefore = stuck.revision;
    const stuckRoundId = stuck.game.item.round_id;

    // Invoke the exhaustion fallback with a round_id that does not match
    // the genuinely stuck round persisted above - simulating exactly the
    // TOCTOU window the guard exists for, without needing to actually race
    // a manual retry against a real alarm tick.
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as unknown as {
          forceFailStuckSettlement(roundId: string, nowMs: number): Promise<void>;
        }
      ).forceFailStuckSettlement("round-from-a-previous-round", Date.now());
    });

    const afterMismatch = await accessRoom(stub, created.hostToken);

    // The stale-round_id call must not touch a round it does not belong to.
    expect(afterMismatch.room.game.phase).toBe("settling");
    expect(afterMismatch.room.revision).toBe(revisionBefore);

    // And the guard must not be a blanket no-op: the genuine, matching
    // round_id still forces the fallback, proving the branch above rejects
    // specifically the mismatch rather than forceFailStuckSettlement being
    // broken outright.
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as unknown as {
          forceFailStuckSettlement(roundId: string, nowMs: number): Promise<void>;
        }
      ).forceFailStuckSettlement(stuckRoundId, Date.now());
    });

    const afterGenuine = await accessRoom(stub, created.hostToken);

    expect(afterGenuine.room.game.phase).toBe("choosingSide");

    if (afterGenuine.room.game.phase !== "choosingSide") {
      throw new Error("Expected the matching round_id to fall back to choosingSide.");
    }

    expect(afterGenuine.room.game.lastError).toBe(
      "Automatic settlement retries were exhausted. A host can retry settlement manually."
    );
    expect(afterGenuine.room.revision).toBe(revisionBefore + 1);

    guestConnection.socket.close();
  });

  // F-07: nothing previously bounded how many times choosingSide(locked) ->
  // settling -> SETTLEMENT_FAILED -> choosingSide(locked) could repeat for
  // the same round. PENDING_SETTLE_EFFECT_MAX_ATTEMPTS only bounds retries
  // *within* one settling episode before forceFailStuckSettlement bounces
  // back to choosingSide - each bounce re-arms a fresh turn clock and a
  // fresh pending-settle-effect with attempts reset to 0, so a persistent
  // (non-transient) cause could cycle indefinitely with no terminal state.
  // This reproduces that persistent cause directly (the private item is
  // deleted once and never restored, so every settlement attempt fails the
  // same way) and proves three things end to end: the failure count is
  // tracked across episodes rather than reset by each bounce, the round
  // reaches a genuinely terminal phase at exactly SETTLEMENT_FAILURE_EPISODE_CAP
  // failures, and the Durable Object stops re-arming a near-term alarm for
  // the dead round once it gets there.
  it("stops bouncing choosingSide <-> settling after SETTLEMENT_FAILURE_EPISODE_CAP consecutive failures and reaches a terminal error phase (F-07)", async () => {
    const stub = roomStub(PERMANENT_SETTLEMENT_FAILURE_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created permanent-settlement-failure room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const privateItemKey = privateGeneratedItemStorageKey(
      started.room.game.item.round_id
    );

    // The underlying cause is persistent, not transient: the private item
    // is gone for good, so every settlement attempt for this round fails
    // identically, no matter how many times it is retried.
    await deleteStoredPrivateGeneratedItem(stub, privateItemKey);

    const marketMakerToken = tokenForPlayer(
      started.room.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );
    const traderToken = tokenForPlayer(
      started.room.game.roles.trader,
      created.hostToken,
      joined.guestToken
    );

    await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: marketMakerToken,
      width: 100
    });
    await applyRoomCommandWithoutTrueValue(stub, {
      type: "TRADE_ON_WIDTH",
      credential: traderToken
    });
    const quoted = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: marketMakerToken,
      quote: { bid: 3400, ask: 3500 }
    });

    expect(quoted.room.game.phase).toBe("choosingSide");

    // Every failure before the cap-th must still bounce back to a locked
    // choosingSide, with the failure count climbing across episodes rather
    // than resetting each time (the exact property that was previously
    // unbounded).
    for (let attempt = 1; attempt < SETTLEMENT_FAILURE_EPISODE_CAP; attempt += 1) {
      const settlementResponse = await postRoomCommand(stub, {
        type: "EXECUTE_TRADE",
        credential: traderToken,
        side: "BUY"
      });
      const failed = await expectPublicJsonWithoutPrivateItemMetadata<CommandRoomResponse>(
        settlementResponse
      );

      expect(settlementResponse.status).toBe(HTTP_OK_STATUS);
      expect(failed.room.game.phase).toBe("choosingSide");

      if (failed.room.game.phase !== "choosingSide") {
        throw new Error("Expected settlement failure to bounce back to side choice.");
      }

      expect(failed.room.game.lockedPendingTrade).toEqual({ kind: "chosen", side: "BUY" });
      expect(failed.room.game.settlementFailureCount).toBe(attempt);
    }

    // The cap-th failure - and only the cap-th - must be terminal.
    const finalResponse = await postRoomCommand(stub, {
      type: "EXECUTE_TRADE",
      credential: traderToken,
      side: "BUY"
    });
    const terminal = await expectPublicJsonWithoutPrivateItemMetadata<CommandRoomResponse>(
      finalResponse
    );

    expect(finalResponse.status).toBe(HTTP_OK_STATUS);
    expect(terminal.room.game.phase).toBe("error");

    if (terminal.room.game.phase !== "error") {
      throw new Error("Expected a terminal error phase.");
    }

    expect(terminal.room.game.previousPhase).toBe("settling");
    expect(terminal.room.lifecycle).toBe("active");
    // No RoundSettlement and no revealed true_value exist for a
    // permanently failed settlement - the terminal error state must not
    // carry either.
    expect("item" in terminal.room.game).toBe(false);
    expect("settlement" in terminal.room.game).toBe(false);

    // A dead round must not keep waking the object: no pending settle
    // effect and no turn-clocked deadline remain, so the only thing left to
    // schedule the alarm against is the room's own TTL.
    await expect(readPendingRoomEffect(stub)).resolves.toBeNull();

    // This assertion is about the F-02/F-05 alarm collapsing to the room's
    // TTL, not about the F-08 liveness sweep - close the still-open guest
    // socket (it never gated presence in this test) so it does not fold an
    // unrelated liveness deadline into the alarm slot and break the exact
    // equality check below.
    await closeSocketAndWaitOffline(stub, guestConnection.socket, created.hostToken, {
      A: false,
      B: false
    });
    await runRoomCleanupAlarm(stub);

    const alarmAfterTerminal = await storedRoomAlarm(stub);
    const ttlAfterTerminal = await storedRoomExpiresAt(stub);

    expect(alarmAfterTerminal).toBe(ttlAfterTerminal);

    // A further alarm tick (simulating time passing with nothing left to
    // do) must be a stable no-op, not another bounce.
    const revisionBeforeExtraTick = terminal.room.revision;

    await runRoomCleanupAlarm(stub);

    const afterExtraTick = await accessRoom(stub, created.hostToken);

    expect(afterExtraTick.room.revision).toBe(revisionBeforeExtraTick);
    expect(afterExtraTick.room.game.phase).toBe("error");

    // A further EXECUTE_TRADE (e.g. a stale client retry) must be rejected
    // rather than resuming the dead round - `error` is not choosingSide.
    const staleRetryResponse = await postRoomCommand(stub, {
      type: "EXECUTE_TRADE",
      credential: traderToken,
      side: "BUY"
    });

    expect(staleRetryResponse.status).not.toBe(HTTP_OK_STATUS);
  });

  it("does not double-settle when a manual retry races the alarm: the alarm settles once, and the losing retry is rejected unchanged", async () => {
    const stub = roomStub(STUCK_SETTLING_NO_DOUBLE_SETTLE_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created no-double-settle room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const marketMakerToken = tokenForPlayer(
      started.room.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );
    const traderToken = tokenForPlayer(
      started.room.game.roles.trader,
      created.hostToken,
      joined.guestToken
    );

    await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: marketMakerToken,
      width: 100
    });
    await applyRoomCommandWithoutTrueValue(stub, {
      type: "TRADE_ON_WIDTH",
      credential: traderToken
    });
    const quoted = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: marketMakerToken,
      quote: { bid: 3400, ask: 3500 }
    });

    expect(quoted.room.game.phase).toBe("choosingSide");

    const stuck = await forceStuckSettling(stub, traderToken, "BUY");

    // The alarm wins the race and resolves settlement first.
    await runRoomCleanupAlarm(stub);

    const resolved = await accessRoom(stub, created.hostToken);

    expect(resolved.room.game.phase).toBe("settlement");
    expect(resolved.room.revision).toBe(stuck.revision + 1);

    // A host's manual retry arrives moments later, unaware the alarm already
    // resolved it. receiveStoredSettlement's fresh phase/round_id re-check -
    // shared by both the alarm path and this manual path - must reject the
    // late retry rather than settle a second time.
    const raced = await postRoomCommand(stub, {
      type: "RETRY_ITEM_GENERATION",
      credential: created.hostToken
    });
    const racedResult = await expectPublicJson<RoomErrorResponse>(raced);

    expect(raced.status).toBe(HTTP_CONFLICT_STATUS);
    expect(racedResult.error.code).toBe("invalid_game_phase");

    const afterRace = await accessRoom(stub, created.hostToken);

    expect(afterRace.room.revision).toBe(resolved.room.revision);
    expect(afterRace.room).toEqual(resolved.room);

    guestConnection.socket.close();
  });

  it("purges storage and clears the alarm rather than leaking an expired room when it disappears mid-alarm-invocation (regression)", async () => {
    // alarm() reads the room and its pending-effect marker in one outer
    // transaction, then (for the mismatch/self-heal path) re-reads the room
    // in a second, separate transaction inside runDueSettleEffect. Both
    // reads share the same frozen `nowMs`, so under normal conditions they
    // agree on whether the room has expired. The only way the second read
    // can find the room gone when the first read found it fine is a
    // concurrent write landing in the gap between the two transactions -
    // this test reproduces that outcome directly by expiring storage and
    // then invoking the inner method with a stale marker that forces the
    // mismatch branch, exactly the shape alarm() would have handed it just
    // before such a race.
    const stub = roomStub(STUCK_SETTLING_MID_ALARM_EXPIRY_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created mid-alarm-expiry room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const marketMakerToken = tokenForPlayer(
      started.room.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );
    const traderToken = tokenForPlayer(
      started.room.game.roles.trader,
      created.hostToken,
      joined.guestToken
    );

    await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: marketMakerToken,
      width: 100
    });
    await applyRoomCommandWithoutTrueValue(stub, {
      type: "TRADE_ON_WIDTH",
      credential: traderToken
    });
    const quoted = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: marketMakerToken,
      quote: { bid: 3400, ask: 3500 }
    });

    expect(quoted.room.game.phase).toBe("choosingSide");

    const stuck = await forceStuckSettling(stub, traderToken, "BUY");

    await expect(readPendingRoomEffect(stub)).resolves.not.toBeNull();
    await expect(privateGeneratedItemKeys(stub)).resolves.not.toEqual(noPrivateItemKeys());

    // The room expires (simulating the concurrent write that would have
    // raced alarm()'s two transactions in production). Deliberately do NOT
    // arm an overdue DO alarm here (unlike expireStoredRoomEnvelope) -
    // workerd in this harness can fire an overdue alarm opportunistically
    // the moment the object is next touched (see forceStuckSettling's own
    // comment on the same hazard), which would race runDueSettleEffectDirect
    // below via the real alarm() entrypoint instead of isolating the exact
    // method call this test means to exercise. Leaving the actually-scheduled
    // alarm at its existing future TTL deadline avoids that entirely.
    await expireStoredRoomEnvelopeWithoutArmingAlarm(stub);

    // A marker whose roundId no longer matches the (pre-expiry) room
    // forces runDueSettleEffect's first branch: the mismatch/self-heal path
    // that reloads the room fresh and, prior to this fix, returned bare on
    // !loaded.ok instead of purging.
    const staleMismatchedPendingEffect: TestPendingRoomEffect = {
      kind: "settle",
      roundId: "round-that-no-longer-matches",
      attempts: 0,
      notBeforeMs: Date.now()
    };

    await runDueSettleEffectDirect(stub, stuck, staleMismatchedPendingEffect, Date.now());

    await expect(storedRoomEnvelopeExists(stub)).resolves.toBe(false);
    await expect(readPendingRoomEffect(stub)).resolves.toBeNull();
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual(noPrivateItemKeys());
    await expect(storedRoomAlarm(stub)).resolves.toBeNull();

    guestConnection.socket.close();
  });

  it("deletes private generated items when resetting to the lobby", async () => {
    const stub = roomStub(RESET_PRIVATE_ITEM_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created reset cleanup room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateGeneratedItemStorageKey(started.room.game.item.round_id)
    ]);

    const reset = await applyRoomCommand(stub, {
      type: "RESET_TO_LOBBY",
      credential: created.hostToken
    });

    expect(reset.room.lifecycle).toBe("lobby");
    expect(reset.room.game.phase).toBe("setup");
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([]);

    guestConnection.socket.close();
  });

  it("deletes private generated items when kicking a guest", async () => {
    const stub = roomStub(KICK_PRIVATE_ITEM_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created kick cleanup room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateGeneratedItemStorageKey(started.room.game.item.round_id)
    ]);

    const guestClosed = nextSocketClose(guestConnection.socket);
    const kicked = await applyRoomCommand(stub, {
      type: "KICK_GUEST",
      credential: created.hostToken
    });

    expect(kicked.room.lifecycle).toBe("lobby");
    expect(kicked.room.seats.guest.occupied).toBe(false);
    expect(kicked.room.game.phase).toBe("setup");
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([]);
    await expect(guestClosed).resolves.toBeUndefined();
  });

  it("deletes private generated items when replacing a corrupt room", async () => {
    const stub = roomStub(REPLACE_PRIVATE_ITEM_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created replacement cleanup room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateGeneratedItemStorageKey(started.room.game.item.round_id)
    ]);

    await corruptRoomEnvelope(stub);

    const replaceResponse = await stub.fetch(GAME_ROOM_SMOKE_URL, {
      body: JSON.stringify({ hostName: "Replacement Host" }),
      method: "POST"
    });
    const replaced = await expectPublicJson<CreateRoomResponse>(replaceResponse);

    expect(replaceResponse.status).toBe(HTTP_CREATED_STATUS);
    expect(replaced.created).toBe(true);

    if (!replaced.created) {
      throw new Error("Expected corrupt room replacement.");
    }

    expect(replaced.room.lifecycle).toBe("lobby");
    expect(replaced.room.revision).toBe(0);
    expect(replaced.room.seats.host.displayName).toBe("Replacement Host");
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([]);

    guestConnection.socket.close();
  });

  it("deletes private generated items when the cleanup alarm sees an invalid room envelope", async () => {
    const stub = roomStub(ALARM_PRIVATE_ITEM_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created alarm cleanup room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateGeneratedItemStorageKey(started.room.game.item.round_id)
    ]);

    await corruptRoomEnvelope(stub);
    await runRoomCleanupAlarm(stub);
    await expect(storedRoomEnvelopeExists(stub)).resolves.toBe(false);
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([]);

    guestConnection.socket.close();
  });

  // B1 (production readiness): a room whose stored envelope cannot be
  // decoded used to return persistence_invalid (500) forever - purging it
  // was previously only wired up on the create-room and cleanup-alarm
  // paths, not the two paths that actually mutate an in-progress game
  // (POST /room/command and POST /room/join). A room could then sit mid-
  // round returning 500 to both players on every single command until
  // whatever deadline its now-orphaned alarm was scheduled against
  // eventually fired, which for a room with no sooner turn-clock or
  // pending-settlement deadline armed could be up to ABANDONED_ROOM_TTL_MS
  // (2 hours) later. These two tests pin that a command (and a join)
  // against an undecodable envelope both purge storage in the same
  // transaction as the 500 they return, so the *next* request against that
  // room object sees "missing" (404, and a fresh POST /room can recreate
  // it) instead of repeating the same 500.
  it("purges an undecodable room envelope when a command is dispatched against it, so the next request sees a fresh room instead of another 500", async () => {
    const stub = roomStub(COMMAND_PURGE_ON_INVALID_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created command-purge room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateGeneratedItemStorageKey(started.room.game.item.round_id)
    ]);

    await corruptRoomEnvelope(stub);

    const firstResponse = await postRoomCommand(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: created.hostToken,
      width: 10
    });
    const firstRejected = await expectPublicJson<RoomErrorResponse>(firstResponse);

    expect(firstResponse.status).toBe(HTTP_INTERNAL_SERVER_ERROR_STATUS);
    expect(firstRejected.error.code).toBe("persistence_invalid");
    await expect(storedRoomEnvelopeExists(stub)).resolves.toBe(false);
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([]);

    // The bad envelope is gone now, so this is no longer "invalid" - it is
    // simply a room that does not exist, exactly like never having created
    // one at all.
    const secondResponse = await postRoomCommand(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: created.hostToken,
      width: 10
    });
    const secondRejected = await expectPublicJson<RoomErrorResponse>(secondResponse);

    expect(secondResponse.status).toBe(HTTP_NOT_FOUND_STATUS);
    expect(secondRejected.error.code).toBe("room_not_found");

    guestConnection.socket.close();
  });

  // Persistence v4 cutover regression (decision D2): a room persisted by the
  // previous build as a version-3 envelope must fail decode with
  // persistence_version_unsupported and then purge on first touch, exactly
  // like an undecodable envelope - the room reads back as never-created
  // instead of 500ing forever.
  it("purges a planted version-3 envelope on first touch (v4 hard-cutover regression)", async () => {
    const stub = roomStub(COMMAND_PURGE_ON_INVALID_ROOM_NAME + "-v3");
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created v3-cutover room.");
    }

    const joined = await joinRoom(stub, "Guest");

    expect(joined.room.seats.guest.occupied).toBe(true);

    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    expect(started.room.game.phase).toBe("proposingWidth");

    // Plant a v3 envelope: same current shape, tagged with the retired

    // Plant a v3 envelope: same current shape, tagged with the retired
    // version. The strict allowlists no longer carry a migration chain, so
    // this is rejected by version alone.
    await runInDurableObject(stub, async (_instance, state) => {
      const envelope = (await state.storage.get<Record<string, unknown>>(TEST_ROOM_STORAGE_KEY)) as {
        version?: unknown;
      };

      if (envelope === undefined) {
        throw new Error("Expected a stored room envelope to downgrade.");
      }

      await state.storage.put(TEST_ROOM_STORAGE_KEY, { ...envelope, version: 3 });
    });

    const firstResponse = await postRoomCommand(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: created.hostToken,
      width: 10
    });
    const firstRejected = await expectPublicJson<RoomErrorResponse>(firstResponse);

    expect(firstResponse.status).toBe(HTTP_INTERNAL_SERVER_ERROR_STATUS);
    expect(firstRejected.error.code).toBe("persistence_version_unsupported");
    await expect(storedRoomEnvelopeExists(stub)).resolves.toBe(false);
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([]);

    const secondResponse = await postRoomCommand(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: created.hostToken,
      width: 10
    });
    const secondRejected = await expectPublicJson<RoomErrorResponse>(secondResponse);

    expect(secondResponse.status).toBe(HTTP_NOT_FOUND_STATUS);
    expect(secondRejected.error.code).toBe("room_not_found");
  });

  it("purges an undecodable room envelope when a join is attempted against it, so the next request sees a fresh room instead of another 500", async () => {
    const stub = roomStub(JOIN_PURGE_ON_INVALID_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created join-purge room.");
    }

    await corruptRoomEnvelope(stub);

    const firstResponse = await stub.fetch(ROOM_JOIN_URL, {
      body: JSON.stringify({ guestName: "Guest" }),
      method: "POST"
    });
    const firstRejected = await expectPublicJson<RoomErrorResponse>(firstResponse);

    expect(firstResponse.status).toBe(HTTP_INTERNAL_SERVER_ERROR_STATUS);
    expect(firstRejected.error.code).toBe("persistence_invalid");
    await expect(storedRoomEnvelopeExists(stub)).resolves.toBe(false);

    const secondResponse = await stub.fetch(ROOM_JOIN_URL, {
      body: JSON.stringify({ guestName: "Guest" }),
      method: "POST"
    });
    const secondRejected = await expectPublicJson<RoomErrorResponse>(secondResponse);

    expect(secondResponse.status).toBe(HTTP_NOT_FOUND_STATUS);
    expect(secondRejected.error.code).toBe("room_not_found");
  });

  it("deletes stale private generated items when the cleanup alarm sees no room envelope", async () => {
    const stub = roomStub(ALARM_MISSING_PRIVATE_ITEM_ROOM_NAME);
    const staleKey = await putStalePrivateGeneratedItem(stub, "missing-room");

    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([staleKey]);
    await runRoomCleanupAlarm(stub);
    await expect(storedRoomEnvelopeExists(stub)).resolves.toBe(false);
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([]);
    await expect(storedRoomAlarm(stub)).resolves.toBeNull();
  });

  it("deletes expired room envelopes and private generated items during cleanup alarms", async () => {
    const stub = roomStub(ALARM_EXPIRED_PRIVATE_ITEM_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created expired alarm room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateGeneratedItemStorageKey(started.room.game.item.round_id)
    ]);

    await expireStoredRoomEnvelope(stub);
    await runRoomCleanupAlarm(stub);
    await expect(storedRoomEnvelopeExists(stub)).resolves.toBe(false);
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([]);

    guestConnection.socket.close();
  });

  it("reschedules valid room cleanup alarms without deleting private generated items", async () => {
    const stub = roomStub(ALARM_VALID_PRIVATE_ITEM_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created valid alarm room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    // This test is specifically about the TTL-only reschedule path, not the
    // F-08 liveness sweep - close the still-open guest socket (opened above
    // only so START_ROOM's presence gate would pass) so the alarm this test
    // asserts on below is not also folding in a liveness deadline.
    await closeSocketAndWaitOffline(stub, guestConnection.socket, created.hostToken, {
      A: false,
      B: false
    });

    const privateItemKey = privateGeneratedItemStorageKey(
      started.room.game.item.round_id
    );
    // The room is in proposingWidth, which now carries its own F-05 turn
    // deadline - and that deadline (60s out) is far nearer than the
    // two-hour TTL, so a reschedule must arm the alarm there, not at TTL.
    const expectedAlarm = started.room.game.turnDeadlineMs;

    expect(expectedAlarm).toBeLessThan(await storedRoomExpiresAt(stub));

    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateItemKey
    ]);
    await setStoredRoomAlarm(stub, Date.now() - 1);
    await runRoomCleanupAlarm(stub);
    await expect(storedRoomEnvelopeExists(stub)).resolves.toBe(true);
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateItemKey
    ]);
    await expect(storedRoomAlarm(stub)).resolves.toBe(expectedAlarm);
  });




  it("upgrades the public room socket route and sends the initial snapshot", async () => {
    const stub = roomStub(SOCKET_INITIAL_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created socket room.");
    }

    const rejected = await fetchPublicRoomSocket(created.room.id);

    expect(rejected.status).toBe(HTTP_BAD_REQUEST_STATUS);
    expect(rejected.webSocket).toBeNull();

    const connection = await openPublicRoomSocket(created.room.id, created.hostToken);

    expect(connection.initial).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(created.room, { A: true, B: false })
    });

    connection.socket.close();
  });

  it("broadcasts HTTP joins and WebSocket START_ROOM commands to connected sockets", async () => {
    const stub = roomStub(SOCKET_COMMAND_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created WebSocket command room.");
    }

    const hostConnection = await openRoomSocket(stub, created.hostToken);

    expect(hostConnection.initial).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(created.room, { A: true, B: false })
    });

    const hostJoin = nextSocketMessage<RoomSnapshotSocketMessage>(hostConnection.socket);
    const joined = await joinRoom(stub, "Guest");

    await expect(hostJoin).resolves.toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: joined.room
    });

    const hostGuestConnect = nextSocketMessage<RoomSnapshotSocketMessage>(hostConnection.socket);
    const guestConnection = await openRoomSocket(stub, joined.guestToken);

    expect(guestConnection.initial).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(joined.room, { A: true, B: true })
    });
    await expect(hostGuestConnect).resolves.toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(joined.room, { A: true, B: true })
    });

    const hostStarted = nextSocketMessage<RoomSnapshotSocketMessage>(hostConnection.socket);
    const guestStarted = nextSocketMessage<RoomSnapshotSocketMessage>(guestConnection.socket);

    hostConnection.socket.send(JSON.stringify(withTestCommandId({
      type: "START_ROOM",
      credential: created.hostToken
    })));

    const hostStartedMessage = await hostStarted;
    const guestStartedMessage = await guestStarted;

    expect(hostStartedMessage).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: {
        lifecycle: "active",
        game: {
          phase: "proposingWidth"
        },
        revision: 3
      }
    });
    expect(guestStartedMessage).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: {
        lifecycle: "active",
        game: {
          phase: "proposingWidth"
        },
        revision: 3
      }
    });
    expectRoomPresence(hostStartedMessage.room, { A: true, B: true });
    expectRoomPresence(guestStartedMessage.room, { A: true, B: true });
    expect(JSON.stringify(hostStartedMessage)).not.toContain("true_value");
    expect(JSON.stringify(guestStartedMessage)).not.toContain("true_value");

    const persisted = await accessRoom(roomStub(SOCKET_COMMAND_ROOM_NAME), created.hostToken);

    expect(persisted.room.lifecycle).toBe("active");
    expect(persisted.room.revision).toBe(3);

    hostConnection.socket.close();
    guestConnection.socket.close();
  });

  it("evicts a prior host socket for the same seat when a new host socket connects", async () => {
    const stub = roomStub(HOST_SOCKET_EVICTION_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created host eviction room.");
    }

    const firstConnection = await openRoomSocket(stub, created.hostToken);
    const firstClosed = nextSocketCloseCode(firstConnection.socket);
    const secondConnection = await openRoomSocket(stub, created.hostToken);

    // The client-side RoomSocketSupervisor treats 1008 as the one
    // non-retryable "you were superseded" code (see
    // isRetryableRoomSocketCloseCode in room-socket-supervisor.ts). Any
    // other code here would make the evicted tab reconnect and evict the
    // new socket right back, fighting forever.
    await expect(firstClosed).resolves.toEqual({
      code: 1008,
      reason: "Room seat opened a new socket."
    });
    expect(secondConnection.initial).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(created.room, { A: true, B: false })
    });

    const liveSocketReadyStates = await runInDurableObject(stub, (_instance, state) =>
      state.getWebSockets().map((socket) => socket.readyState)
    );

    expect(liveSocketReadyStates).toEqual([WebSocket.OPEN]);

    secondConnection.socket.close();
  });

  // F-04: presence gating was dropped entirely, so a WebSocket START_ROOM
  // now succeeds (broadcasting a fresh ROOM_SNAPSHOT) even while the joined
  // guest has no live socket.
  it("sends ROOM_SNAPSHOT for WebSocket START_ROOM even when a joined guest is offline (F-04)", async () => {
    const stub = roomStub(SOCKET_START_OFFLINE_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created socket offline-start room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const hostConnection = await openRoomSocket(stub, created.hostToken);

    expect(hostConnection.initial).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(joined.room, { A: true, B: false })
    });

    const nextMessage = nextSocketMessage<RoomSocketMessage>(hostConnection.socket);

    hostConnection.socket.send(JSON.stringify(withTestCommandId({
      type: "START_ROOM",
      credential: created.hostToken
    })));

    const message = await nextMessage;

    expect(message.type).toBe("ROOM_SNAPSHOT");

    if (message.type !== "ROOM_SNAPSHOT") {
      throw new Error("Expected a ROOM_SNAPSHOT message.");
    }
    expect(message.room.lifecycle).toBe("active");

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room.lifecycle).toBe("active");
    expect(persisted.room.seats.guest.occupied).toBe(true);
    expectRoomPresence(persisted.room, { A: true, B: false });

    hostConnection.socket.close();
  });

  it("closes stale guest sockets and frees the guest slot on kick and reset", async () => {
    const stub = roomStub("worker-room-stale-guest");
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created stale guest room.");
    }

    const firstGuest = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, firstGuest.guestToken);

    expect(guestConnection.initial).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(firstGuest.room, { A: false, B: true })
    });

    const guestClosed = nextSocketClose(guestConnection.socket);
    const kickResponse = await postRoomCommand(stub, {
      type: "KICK_GUEST",
      credential: created.hostToken
    });
    const kicked = await expectPublicJson<CommandRoomResponse>(kickResponse);

    expect(kickResponse.status).toBe(HTTP_OK_STATUS);
    expect(kicked.room.seats.guest.occupied).toBe(false);
    expectRoomPresence(kicked.room, { A: false, B: false });

    const staleAccessResponse = await stub.fetch(`${GAME_ROOM_SMOKE_URL}/access`, {
      body: JSON.stringify({ credential: firstGuest.guestToken }),
      method: "POST"
    });
    const staleAccess = await expectPublicJson<RoomErrorResponse>(staleAccessResponse);

    expect(staleAccessResponse.status).toBe(HTTP_FORBIDDEN_STATUS);
    expect(staleAccess.error.code).toBe("stale_guest");

    const secondGuest = await joinRoom(stub, "Katherine");

    expect(secondGuest.guestToken.secret).not.toBe(firstGuest.guestToken.secret);
    expect(secondGuest.room.seats.guest).toMatchObject({
      occupied: true,
      displayName: "Katherine"
    });
    expectRoomPresence(secondGuest.room, { A: false, B: false });

    // F-04: presence gating was dropped entirely, so starting with the
    // replacement guest still offline now succeeds (the turn shot clock
    // handles the absence instead of a player_offline rejection).
    const replacementStartResponse = await postRoomCommand(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });
    const replacementStart = await expectPublicJsonWithoutTrueValue<CommandRoomResponse>(
      replacementStartResponse
    );

    expect(replacementStartResponse.status).toBe(HTTP_OK_STATUS);
    expect(replacementStart.room.lifecycle).toBe("active");

    const afterReplacementStart = await accessRoom(stub, created.hostToken);

    expect(afterReplacementStart.room.lifecycle).toBe("active");
    expectRoomPresence(afterReplacementStart.room, { A: false, B: false });
    await expect(guestClosed).resolves.toBeUndefined();

    const resetResponse = await postRoomCommand(stub, {
      type: "RESET_TO_LOBBY",
      credential: created.hostToken
    });
    const reset = await expectPublicJson<CommandRoomResponse>(resetResponse);

    expect(resetResponse.status).toBe(HTTP_OK_STATUS);
    expect(reset.room.lifecycle).toBe("lobby");
    expect(reset.room.seats.guest.occupied).toBe(false);
    expect(reset.room.game.phase).toBe("setup");
    expect(reset.room.game.players.B.name).toBe("Guest");

    const thirdGuest = await joinRoom(stub, "Linus");

    expect(thirdGuest.room.seats.guest).toMatchObject({
      occupied: true,
      displayName: "Linus"
    });
  });

  it("closes guest sockets on reset and rejects stale guest socket upgrades after replacement", async () => {
    const stub = roomStub(RESET_STALE_SOCKET_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created reset stale socket room.");
    }

    const firstGuest = await joinRoom(stub, "Guest");
    const firstGuestConnection = await openRoomSocket(stub, firstGuest.guestToken);

    expectRoomPresence(firstGuestConnection.initial.room, { A: false, B: true });

    const firstGuestClosed = nextSocketClose(firstGuestConnection.socket);
    const resetResponse = await postRoomCommand(stub, {
      type: "RESET_TO_LOBBY",
      credential: created.hostToken
    });
    const reset = await expectPublicJson<CommandRoomResponse>(resetResponse);

    expect(resetResponse.status).toBe(HTTP_OK_STATUS);
    expect(reset.room.seats.guest.occupied).toBe(false);
    expectRoomPresence(reset.room, { A: false, B: false });
    await expect(firstGuestClosed).resolves.toBeUndefined();

    const secondGuest = await joinRoom(stub, "Katherine");

    expect(secondGuest.guestToken.secret).not.toBe(firstGuest.guestToken.secret);
    expectRoomPresence(secondGuest.room, { A: false, B: false });

    const staleSocketResponse = await fetchRoomSocket(stub, firstGuest.guestToken);
    const staleSocket = await expectPublicJson<RoomErrorResponse>(staleSocketResponse);

    expect(staleSocketResponse.status).toBe(HTTP_FORBIDDEN_STATUS);
    expect(staleSocketResponse.webSocket).toBeNull();
    expect(staleSocket.error.code).toBe("stale_guest");

    const secondGuestConnection = await openRoomSocket(stub, secondGuest.guestToken);

    expectRoomPresence(secondGuestConnection.initial.room, { A: false, B: true });

    secondGuestConnection.socket.close();
  });

  it("reports an occupied guest seat as offline after the guest socket closes", async () => {
    const stub = roomStub(SOCKET_PRESENCE_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created presence room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const hostConnection = await openRoomSocket(stub, created.hostToken);

    expect(hostConnection.initial).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(joined.room, { A: true, B: false })
    });

    const guestConnected = nextSocketMessage<RoomSnapshotSocketMessage>(hostConnection.socket);
    const guestConnection = await openRoomSocket(stub, joined.guestToken);

    expect(guestConnection.initial).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(joined.room, { A: true, B: true })
    });
    await expect(guestConnected).resolves.toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(joined.room, { A: true, B: true })
    });

    const guestDisconnected = nextSocketMessage<RoomSnapshotSocketMessage>(hostConnection.socket);

    guestConnection.socket.close();

    await expect(guestDisconnected).resolves.toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(joined.room, { A: true, B: false })
    });

    const accessed = await accessRoom(stub, created.hostToken);

    expect(accessed.room.seats.guest.occupied).toBe(true);
    expect(accessed.room.revision).toBe(joined.room.revision);
    expectRoomPresence(accessed.room, { A: true, B: false });

    hostConnection.socket.close();
  });

  // F-04: presence gating was dropped entirely (the F-05 turn shot clock
  // now handles an absent opponent instead), so both a non-final and the
  // final round advance succeed while Player B's socket is offline - only
  // the presence badge on the snapshot reflects the disconnect.
  it("advances both non-final and final rounds while Player B's socket is offline (F-04)", async () => {
    const stub = roomStub(ADVANCE_PRESENCE_ROOM_NAME);
    const created = await createRoom(stub, "Host", { totalRounds: 2 });

    if (!created.created) {
      throw new Error("Expected a newly created advance presence room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);

    expectRoomPresence(guestConnection.initial.room, { A: false, B: true });

    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    expect(started.room.game.phase).toBe("proposingWidth");
    expect(started.room.game.roundNumber).toBe(1);
    expectRoomPresence(started.room, { A: false, B: true });

    const firstSettlement = await settleCurrentRound(
      stub,
      started.room,
      created.hostToken,
      joined.guestToken
    );

    expect(firstSettlement.game.phase).toBe("settlement");
    expect(firstSettlement.game.roundNumber).toBe(1);

    guestConnection.socket.close();

    await waitForRoomPresence(stub, created.hostToken, { A: false, B: false });

    const advanced = await applyRoomCommandWithoutTrueValue(stub, {
      type: "ADVANCE_ROUND",
      credential: created.hostToken
    });

    expect(advanced.room.game.phase).toBe("proposingWidth");
    expect(advanced.room.game.roundNumber).toBe(2);
    expectRoomPresence(advanced.room, { A: false, B: false });

    const finalSettlement = await settleCurrentRound(
      stub,
      advanced.room,
      created.hostToken,
      joined.guestToken
    );

    expect(finalSettlement.game.phase).toBe("settlement");
    expect(finalSettlement.game.roundNumber).toBe(2);

    const finished = await applyRoomCommand(stub, {
      type: "ADVANCE_ROUND",
      credential: created.hostToken
    });

    expect(finished.room.lifecycle).toBe("finished");
    expect(finished.room.game.phase).toBe("gameOver");
    expectRoomPresence(finished.room, { A: false, B: false });
  });

  // F-04: presence gating was dropped entirely, so a WebSocket ADVANCE_ROUND
  // now succeeds (broadcasting a fresh ROOM_SNAPSHOT) even after Player B
  // disconnects before a non-final advance.
  it("sends ROOM_SNAPSHOT for WebSocket ADVANCE_ROUND even after Player B disconnects before a non-final advance (F-04)", async () => {
    const stub = roomStub(SOCKET_ADVANCE_OFFLINE_ROOM_NAME);
    const created = await createRoom(stub, "Host", { totalRounds: 2 });

    if (!created.created) {
      throw new Error("Expected a newly created socket advance-offline room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);

    expectRoomPresence(guestConnection.initial.room, { A: false, B: true });

    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });
    const firstSettlement = await settleCurrentRound(
      stub,
      started.room,
      created.hostToken,
      joined.guestToken
    );

    expect(firstSettlement.game.phase).toBe("settlement");
    expect(firstSettlement.game.roundNumber).toBe(1);

    const hostConnection = await openRoomSocket(stub, created.hostToken);

    expect(hostConnection.initial).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(firstSettlement, { A: true, B: true })
    });

    const guestDisconnected = nextSocketMessage<RoomSnapshotSocketMessage>(hostConnection.socket);

    guestConnection.socket.close();

    await expect(guestDisconnected).resolves.toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(firstSettlement, { A: true, B: false })
    });

    const nextMessage = nextSocketMessage<RoomSocketMessage>(hostConnection.socket);

    hostConnection.socket.send(JSON.stringify(withTestCommandId({
      type: "ADVANCE_ROUND",
      credential: created.hostToken
    })));

    const message = await nextMessage;

    expect(message.type).toBe("ROOM_SNAPSHOT");

    if (message.type !== "ROOM_SNAPSHOT") {
      throw new Error("Expected a ROOM_SNAPSHOT message.");
    }
    expect(message.room.game.phase).toBe("proposingWidth");

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room.game.phase).toBe("proposingWidth");
    expect(persisted.room.game.roundNumber).toBe(2);
    expectRoomPresence(persisted.room, { A: true, B: false });

    hostConnection.socket.close();
  });

  it("sends ROOM_ERROR for malformed WebSocket commands without mutating the room", async () => {
    const stub = roomStub(SOCKET_ERROR_ROOM_NAME);
    const created = await createRoom(stub, "Host");
    const joined = await joinRoom(stub, "Guest");

    if (!created.created) {
      throw new Error("Expected a newly created socket error room.");
    }

    const connection = await openRoomSocket(stub, created.hostToken);

    expect(connection.initial).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(joined.room, { A: true, B: false })
    });

    const errorMessage = nextSocketMessage<RoomSocketMessage>(connection.socket);

    connection.socket.send("{");

    await expect(errorMessage).resolves.toMatchObject({
      type: "ROOM_ERROR",
      error: {
        code: "invalid_request"
      }
    });

    const persisted = await accessRoom(roomStub(SOCKET_ERROR_ROOM_NAME), joined.guestToken);

    expect(persisted.room).toEqual(roomWithPresence(joined.room, { A: true, B: false }));
    expect(persisted.room).not.toEqual(created.room);

    connection.socket.close();
  });

  it("evicts churned guest sockets so presence never leaks a phantom seat", async () => {
    const stub = roomStub(GUEST_SOCKET_CHURN_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created guest socket churn room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const hostConnection = await openRoomSocket(stub, created.hostToken);

    expect(hostConnection.initial).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(joined.room, { A: true, B: false })
    });

    const CHURN_ATTEMPTS = 20;
    let lastGuestConnection: RoomSocketConnection | null = null;
    let firstGuestClosed: Promise<{ code: number; reason: string }> | null = null;

    for (let attempt = 0; attempt < CHURN_ATTEMPTS; attempt += 1) {
      // Deliberately do not close the previous guest socket before opening
      // the next one. Without per-seat eviction, these would pile up as
      // zombie sockets that still count toward presence for seat B.
      lastGuestConnection = await openRoomSocket(stub, joined.guestToken);

      if (attempt === 0) {
        // Capture the very first guest socket's close code: it is evicted
        // by attempt 1 below, and that eviction must use the same
        // non-retryable 1008 code as the host-eviction test above, or a
        // churning guest client would reconnect-loop against itself.
        firstGuestClosed = nextSocketCloseCode(lastGuestConnection.socket);
      }

      expectRoomPresence(lastGuestConnection.initial.room, { A: true, B: true });
    }

    if (lastGuestConnection === null || firstGuestClosed === null) {
      throw new Error("Expected at least one churned guest connection.");
    }

    await expect(firstGuestClosed).resolves.toEqual({
      code: 1008,
      reason: "Room seat opened a new socket."
    });

    const seatKeys = await runInDurableObject(stub, (_instance, state) =>
      state.getWebSockets().map((socket) => {
        const attachment = socket.deserializeAttachment() as {
          role: string;
          tokenHash: string;
        };

        return `${attachment.role}:${attachment.tokenHash}`;
      })
    );

    // At most one live socket per (role, tokenHash): two seats, two sockets,
    // no duplicates, regardless of how many times the guest reconnected.
    expect(seatKeys.sort()).toHaveLength(2);
    expect(new Set(seatKeys).size).toBe(2);

    const stillConnected = await accessRoom(stub, created.hostToken);

    expectRoomPresence(stillConnected.room, { A: true, B: true });
    // Presence-only broadcasts (every churned connect/evict) must not
    // increment the room revision; only real room mutations do.
    expect(stillConnected.room.revision).toBe(joined.room.revision);

    lastGuestConnection.socket.close();

    const afterGuestClose = await waitForRoomPresence(stub, created.hostToken, {
      A: true,
      B: false
    });

    expectRoomPresence(afterGuestClose.room, { A: true, B: false });
    expect(afterGuestClose.room.revision).toBe(joined.room.revision);

    hostConnection.socket.close();
  });

  it("registers a tt-ping/tt-pong WebSocket auto-response pair that bypasses the room command handler", async () => {
    const stub = roomStub(PING_PONG_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created ping-pong room.");
    }

    const registeredPair = await runInDurableObject(stub, (_instance, state) => {
      const pair = state.getWebSocketAutoResponse();

      return pair === null ? null : { request: pair.request, response: pair.response };
    });

    expect(registeredPair).toEqual({ request: "tt-ping", response: "tt-pong" });

    const connection = await openRoomSocket(stub, created.hostToken);
    const pong = nextRawSocketMessage(connection.socket);

    connection.socket.send("tt-ping");

    // The edge auto-responder must reply with the raw "tt-pong" string
    // directly. If it fell through to webSocketMessage instead, that
    // handler would try to JSON-decode "tt-ping" as a command and reply
    // with a JSON ROOM_ERROR message instead of the raw pong text.
    await expect(pong).resolves.toBe("tt-pong");

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room.revision).toBe(created.room.revision);

    connection.socket.close();
  });

  it("F-08 liveness sweep closes a socket that has gone stale, leaves a live one connected, and rebroadcasts presence for the closed one", async () => {
    const stub = roomStub(LIVENESS_SWEEP_STALE_VS_LIVE_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created liveness-sweep room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const hostConnection = await openRoomSocket(stub, created.hostToken);
    const guestConnection = await openRoomSocket(stub, joined.guestToken);

    await withPatchedAutoResponseTimestamp(
      (ws) => {
        // The guest's last signal was well past the stale threshold; the
        // host's is left `null`, falling back to its (just-now) acceptance
        // time - i.e. a live socket that simply has not been pinged yet,
        // which must NOT be swept.
        return socketAttachmentRole(ws) === "guest"
          ? new Date(Date.now() - ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS - 1_000)
          : null;
      },
      async () => {
        const guestClosed = nextSocketCloseCode(guestConnection.socket);
        const hostSawPresenceUpdate = nextSocketMessage<RoomSnapshotSocketMessage>(
          hostConnection.socket
        );

        await runRoomCleanupAlarm(stub);

        const closeInfo = await guestClosed;

        // Property (a): the stale socket was closed, the live one was not.
        expect(closeInfo.code).toBe(ROOM_SOCKET_LIVENESS_SWEEP_CLOSE_CODE);
        expect(hostConnection.socket.readyState).toBe(WebSocket.OPEN);

        // Property (c): the close code the sweep chose is one the client
        // reconnect supervisor actually retries against (see
        // isRetryableRoomSocketCloseCode / ROOM_SOCKET_LIVENESS_SWEEP_CLOSE_CODE).
        expect(isRetryableRoomSocketCloseCode(closeInfo.code)).toBe(true);

        // Presence is derived, not pushed by the sweep itself: closing a
        // hibernatable socket always fires webSocketClose(), which is what
        // actually rebroadcasts this snapshot to the remaining host socket.
        const presenceUpdate = await hostSawPresenceUpdate;

        expectRoomPresence(presenceUpdate.room, { A: true, B: false });
      }
    );

    hostConnection.socket.close();
  });

  it("F-08 liveness sweep closes a socket exactly at the staleness boundary, not only strictly past it", async () => {
    const stub = roomStub(LIVENESS_SWEEP_EXACT_BOUNDARY_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created liveness-sweep exact-boundary room.");
    }

    const connection = await openRoomSocket(stub, created.hostToken);
    const fixedNowMs = Date.now();

    // Pins nowMs - lastSeenMs to exactly ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS
    // via runSweepStaleSocketsDirect (bypassing alarm()'s own Date.now() call,
    // which would race this fixed value). sweepStaleSockets compares with
    // `>=`; a mutation to `>` leaves a socket exactly at the boundary open
    // forever, which the "well past threshold" test above (padded by a full
    // second) cannot distinguish from correct behavior.
    await withPatchedAutoResponseTimestamp(
      () => new Date(fixedNowMs - ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS),
      async () => {
        const closed = nextSocketCloseCode(connection.socket);

        await runSweepStaleSocketsDirect(stub, fixedNowMs);

        const closeInfo = await closed;

        expect(closeInfo.code).toBe(ROOM_SOCKET_LIVENESS_SWEEP_CLOSE_CODE);
      }
    );
  });

  it("does not force-close a pre-deploy socket lacking acceptedAtMs when an unrelated broadcast touches the room", async () => {
    const stub = roomStub(LIVENESS_LEGACY_ATTACHMENT_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created legacy-attachment room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const hostConnection = await openRoomSocket(stub, created.hostToken);
    const guestConnection = await openRoomSocket(stub, joined.guestToken);

    // Simulate a socket that was already connected and hibernating at the
    // moment a deploy added `acceptedAtMs` to RoomSocketAttachment: strip it
    // from the guest's live attachment directly, exactly as the review that
    // found this gap reproduced it (acceptRoomSocket itself always writes
    // acceptedAtMs today, so this shape cannot be produced any other way).
    await stripAcceptedAtMsFromLiveAttachment(stub, "guest");

    // Registered before the trigger below: the client-side close event for
    // an eviction that happens as a synchronous side effect of the reconnect
    // below can fire before a listener attached afterward would ever see it
    // - see the pre-existing host-eviction test for the same ordering
    // requirement.
    const hostEvicted = nextSocketCloseCode(hostConnection.socket);
    const guestSawRebroadcast = nextSocketMessage<RoomSnapshotSocketMessage>(
      guestConnection.socket
    );

    // An ordinary, unrelated action - the host reconnecting - is enough to
    // trigger broadcastRoomSnapshot for every other socket in the room,
    // including the legacy-attachment guest. Before this fix,
    // socketCanReceiveRoomSnapshot parsed that attachment as null
    // (acceptedAtMs was required by parseRoomSocketAttachment), so this
    // broadcast alone force-closed the guest with 1008 - the one code the
    // client's reconnect supervisor treats as terminal
    // (isRetryableRoomSocketCloseCode) - even though the guest did nothing
    // and was never removed from the room.
    const reconnectedHost = await openRoomSocket(stub, created.hostToken);

    // The prior host socket is evicted by its own seat opening a new one -
    // expected, unrelated seat-eviction behavior - so drain that close
    // rather than asserting on it here.
    await expect(hostEvicted).resolves.toMatchObject({ code: 1008 });

    const rebroadcast = await guestSawRebroadcast;

    expect(rebroadcast.type).toBe("ROOM_SNAPSHOT");
    expect(guestConnection.socket.readyState).toBe(WebSocket.OPEN);

    // Confirm directly against the Durable Object's own live-socket list -
    // not just the client's local readyState - that the server still
    // considers the guest connected. A server-side eviction (the pre-fix
    // behavior) closes the socket from the DO's side with code 1008 before
    // the client even sees the frame; checking the DO's own bookkeeping
    // catches that even if client-side readyState were to lag.
    const guestSocketReadyState = await runInDurableObject(stub, (_instance, state) =>
      state.getWebSockets().find((ws) => socketAttachmentRole(ws) === "guest")?.readyState ??
        null
    );

    expect(guestSocketReadyState).toBe(WebSocket.OPEN);

    guestConnection.socket.close();
    reconnectedHost.socket.close();
  });

  it("does not sweep-close a pre-deploy socket lacking acceptedAtMs before its first ping has ever been answered", async () => {
    const stub = roomStub(LIVENESS_LEGACY_ATTACHMENT_SWEEP_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created legacy-attachment sweep room.");
    }

    const connection = await openRoomSocket(stub, created.hostToken);

    // Same legacy shape as the broadcast-compatibility test above, but this
    // one exercises the sweep's own fallback chain directly.
    // readSocketAutoResponseTimestamp is left untouched (still `null`, as it
    // genuinely would be for a socket that has never answered a real
    // "tt-ping"), so socketLastSeenMs must fall all the way through to
    // `nowMs` - not to `attachment.acceptedAtMs` (absent here) and not to
    // some other default - to read this socket as "just seen" rather than
    // stale since epoch.
    await stripAcceptedAtMsFromLiveAttachment(stub, "host");

    const closed = nextSocketCloseCode(connection.socket);
    let sweepClosed = false;

    closed.then(() => {
      sweepClosed = true;
    }).catch(() => {});

    await runSweepStaleSocketsDirect(stub, Date.now());

    // A mutation that falls back to epoch 0 instead of `nowMs` computes an
    // enormous, already-elapsed "time since last seen" here and closes the
    // socket immediately; give the sweep a moment to have done so before
    // asserting it did not.
    await delay(50);

    expect(sweepClosed).toBe(false);
    expect(connection.socket.readyState).toBe(WebSocket.OPEN);

    connection.socket.close();
  });

  it("eventually sweep-closes a pre-deploy socket lacking acceptedAtMs once its memoized first-seen time ages out, surviving many sweeps before then", async () => {
    const stub = roomStub(LIVENESS_LEGACY_ATTACHMENT_LONG_RUN_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created legacy-attachment long-run room.");
    }

    const connection = await openRoomSocket(stub, created.hostToken);

    await stripAcceptedAtMsFromLiveAttachment(stub, "host");

    const closed = nextSocketCloseCode(connection.socket);
    let sweepClosed = false;

    closed.then(() => {
      sweepClosed = true;
    }).catch(() => {});

    const t0 = Date.now();

    // First sweep hits the memoization branch (no auto-response yet, no
    // acceptedAtMs) and must not close the socket - it grants the same one
    // full fresh threshold window a legacy socket always got. Asserted
    // separately from the loop below so a mutation that over-corrects FIX 1
    // by closing legacy sockets immediately fails here, distinctly from a
    // mutation that never closes them at all.
    await runSweepStaleSocketsDirect(stub, t0);
    await delay(50);

    expect(sweepClosed).toBe(false);
    expect(connection.socket.readyState).toBe(WebSocket.OPEN);

    // The bug this reproduces: socketLastSeenMs's third fallback used to be
    // a bare `?? nowMs`, recomputed fresh on every call rather than
    // memoized anywhere. For a socket that never completes a single
    // ping-pong, that made `nowMs - lastSeenMs` evaluate to exactly `0` on
    // every single sweep, forever - the socket was permanently immune, not
    // merely long-lived. A mutation that deletes the serializeAttachment
    // write-back in socketLastSeenMs reproduces exactly that: this loop
    // would run to completion with the socket still OPEN.
    //
    // This mirrors the reproduction that caught it: repeated
    // sweepStaleSockets calls with nowMs advancing by a large multiple of
    // the staleness threshold each time, spanning several simulated hours.
    // With the fix, `acceptedAtMs` was memoized as `t0` above, so the
    // socket ages out normally once that fixed point falls more than one
    // threshold window behind - it must not survive all 19 remaining
    // iterations here.
    for (let i = 1; i < 20; i += 1) {
      await runSweepStaleSocketsDirect(stub, t0 + i * ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS * 10);
      await delay(5);

      if (sweepClosed) {
        break;
      }
    }

    expect(sweepClosed).toBe(true);
    expect(connection.socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("lets a legacy socket lacking acceptedAtMs transition off the memoized fallback once it receives one real auto-response, becoming sweepable relative to that instead", async () => {
    const stub = roomStub(LIVENESS_LEGACY_ATTACHMENT_REAL_PING_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created legacy-attachment real-ping room.");
    }

    const connection = await openRoomSocket(stub, created.hostToken);

    await stripAcceptedAtMsFromLiveAttachment(stub, "host");

    const t0 = Date.now();

    // First sweep hits the memoization branch (no auto-response yet, no
    // acceptedAtMs): acceptedAtMs is written back as t0.
    await runSweepStaleSocketsDirect(stub, t0);
    expect(connection.socket.readyState).toBe(WebSocket.OPEN);

    // Now the socket receives one real "tt-ping" auto-response, well after
    // t0 - simulated the same way the pre-existing sweep tests simulate a
    // real edge auto-response, since getWebSocketAutoResponseTimestamp
    // cannot be produced from test code any other way.
    const t1 = t0 + ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS - 1_000;

    await withPatchedAutoResponseTimestamp(
      (ws) => (socketAttachmentRole(ws) === "host" ? new Date(t1) : null),
      async () => {
        const closed = nextSocketCloseCode(connection.socket);
        let sweepClosed = false;

        closed.then(() => {
          sweepClosed = true;
        }).catch(() => {});

        // Sweeping just past the *old* (memoized-acceptedAtMs) boundary
        // must not close the socket now that a real auto-response exists:
        // socketLastSeenMs prefers the auto-response timestamp over the
        // memoized fallback, so the effective deadline moved out to
        // t1 + threshold. A mutation that kept using the memoized
        // acceptedAtMs even after a real auto-response arrived would close
        // the socket here.
        await runSweepStaleSocketsDirect(stub, t0 + ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS + 500);
        await delay(50);

        expect(sweepClosed).toBe(false);
        expect(connection.socket.readyState).toBe(WebSocket.OPEN);

        // Sweeping past the *new* boundary (relative to t1, the real
        // auto-response) does close it - proving the socket is now
        // ordinarily sweepable off the auto-response signal, not stuck
        // re-memoizing forever.
        await runSweepStaleSocketsDirect(stub, t1 + ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS + 1_000);

        const closeInfo = await closed;

        expect(closeInfo.code).toBe(ROOM_SOCKET_LIVENESS_SWEEP_CLOSE_CODE);
      }
    );
  });

  it("folds a connected socket's liveness deadline into the alarm ahead of a much later TTL, then reverts to the TTL once the socket disconnects", async () => {
    const stub = roomStub(LIVENESS_SWEEP_ALARM_MULTIPLEX_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created liveness-multiplex room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const ttlDeadline = await storedRoomExpiresAt(stub);
    const beforeConnectMs = Date.now();
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const afterConnectMs = Date.now();

    // acceptRoomSocket's rearmAlarmForLiveSockets must fold this brand-new
    // socket's liveness deadline into the alarm slot immediately - a
    // mutation that skips that call, or one that drops the liveness term
    // from scheduleNextAlarm's Math.min entirely, would leave this pinned
    // at the (much later) TTL deadline instead. Pinning the value to
    // roughly acceptedAtMs + ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS (rather than
    // just asserting "sooner than TTL") also catches a broken acceptedAtMs
    // fallback - e.g. defaulting an un-pinged socket's last-seen time to
    // epoch 0 would still be sooner than TTL, but would not land in this
    // window.
    const armedAfterConnect = await storedRoomAlarm(stub);

    expect(armedAfterConnect).not.toBeNull();
    expect(armedAfterConnect as number).toBeLessThan(ttlDeadline);
    expect(armedAfterConnect as number).toBeGreaterThanOrEqual(
      beforeConnectMs + ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS
    );
    expect(armedAfterConnect as number).toBeLessThanOrEqual(
      afterConnectMs + ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS
    );

    await closeSocketAndWaitOffline(stub, guestConnection.socket, created.hostToken, {
      A: false,
      B: false
    });

    // Force a tick even though the (nearer, liveness-derived) alarm is not
    // literally due yet - the same "no-op reschedule" branch workerd's own
    // scheduler would eventually reach on its own. Property (b): with no
    // sockets left to watch, the TTL deadline must resurface exactly - not
    // stay pinned at the stale liveness value, and not be replaced by
    // anything else. A mutation that drops the TTL term from the Math.min
    // (rather than only adding the liveness term to it) fails here.
    await runRoomCleanupAlarm(stub);

    await expect(storedRoomAlarm(stub)).resolves.toBe(ttlDeadline);
  });

  it("resolves a due pending settlement effect and sweeps a stale socket in the same alarm tick, dropping neither", async () => {
    const stub = roomStub(LIVENESS_SWEEP_WITH_PENDING_EFFECT_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created liveness-with-pending-effect room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    if (started.room.game.phase !== "proposingWidth") {
      throw new Error("Expected generated item to be ready.");
    }

    const marketMakerToken = tokenForPlayer(
      started.room.game.roles.marketMaker,
      created.hostToken,
      joined.guestToken
    );
    const traderToken = tokenForPlayer(
      started.room.game.roles.trader,
      created.hostToken,
      joined.guestToken
    );

    await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_INITIAL_WIDTH",
      credential: marketMakerToken,
      width: 100
    });
    await applyRoomCommandWithoutTrueValue(stub, {
      type: "TRADE_ON_WIDTH",
      credential: traderToken
    });
    const quoted = await applyRoomCommandWithoutTrueValue(stub, {
      type: "SUBMIT_MARKET_QUOTE",
      credential: marketMakerToken,
      quote: { bid: 3400, ask: 3500 }
    });

    expect(quoted.room.game.phase).toBe("choosingSide");

    // forceStuckSettling leaves a due pending settle-effect marker (F-02)
    // for this room - the guest socket opened above (needed for
    // START_ROOM's presence gate) is still connected throughout.
    await forceStuckSettling(stub, traderToken, "BUY");
    await expect(readPendingRoomEffect(stub)).resolves.not.toBeNull();

    await withPatchedAutoResponseTimestamp(
      (ws) =>
        socketAttachmentRole(ws) === "guest"
          ? new Date(Date.now() - ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS - 1_000)
          : null,
      async () => {
        const guestClosed = nextSocketCloseCode(guestConnection.socket);

        await runRoomCleanupAlarm(stub);

        const closeInfo = await guestClosed;

        expect(closeInfo.code).toBe(ROOM_SOCKET_LIVENESS_SWEEP_CLOSE_CODE);
      }
    );

    // Neither concern lost the other in the same tick: the pending
    // settlement effect actually resolved...
    const resumed = await accessRoom(stub, created.hostToken);

    expect(resumed.room.game.phase).toBe("settlement");
    await expect(readPendingRoomEffect(stub)).resolves.toBeNull();
  });
});

function roomStub(roomName: string) {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomName));
}

/**
 * Enables the WORKER_TEST_MODE gate (see testExpireTurnSoon in
 * src/worker/index.ts) for exactly the duration of `run`, then restores it.
 * vitest.worker.config.ts deliberately does NOT set this var globally: the
 * suite's default posture should mirror production (unset), so a test that
 * wants the gate open has to say so explicitly, and "unset" stays the
 * meaningful default for the 404 test above.
 */
async function withWorkerTestModeEnabled<T>(
  stub: GameRoomStub,
  run: () => Promise<T>
): Promise<T> {
  const previous = await setDurableObjectTestModeEnv(stub, "1");

  try {
    return await run();
  } finally {
    await setDurableObjectTestModeEnv(stub, previous);
  }
}

async function setDurableObjectTestModeEnv(
  stub: GameRoomStub,
  next: string | undefined
): Promise<string | undefined> {
  return runInDurableObject(stub, (instance) => {
    const mutableEnv = (instance as unknown as { env: { WORKER_TEST_MODE?: string } }).env;
    const previous = mutableEnv.WORKER_TEST_MODE;

    mutableEnv.WORKER_TEST_MODE = next;

    return previous;
  });
}







async function privateGeneratedItemKeys(stub: GameRoomStub): Promise<string[]> {
  return runInDurableObject(stub, async (_instance, state) => {
    const items = await state.storage.list<unknown>({
      prefix: privateGeneratedItemStoragePrefix()
    });

    return [...items.keys()].sort();
  });
}

function noPrivateItemKeys(): string[] {
  return [];
}

async function deleteStoredPrivateGeneratedItem(
  stub: GameRoomStub,
  key: string
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.delete(key);
  });
}

async function corruptStoredPrivateGeneratedItem(
  stub: GameRoomStub,
  key: string
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put(key, {
      kind: "trader-titan.test-corrupt-private-item"
    });
  });
}


/**
 * Reproduces the F-02 trapdoor directly: EXECUTE_TRADE's choosingSide -> settling
 * transition (and, after the structural F-02 fix, its pending-effect marker -
 * both committed together in one transaction, matching applyDecodedRoomCommand)
 * is committed to storage, but the automatic settlement effect that normally
 * follows it (applyAutomaticRoomEffects -> receiveStoredSettlement) never runs,
 * exactly as if the isolate had been evicted or the request abandoned between
 * the commit and the effect. The stored private item is left untouched,
 * matching a real abandonment (settlement was never attempted, not that it
 * failed).
 */
async function forceStuckSettling(
  stub: GameRoomStub,
  traderCredential: RoomCapabilityToken,
  side: TradeSide
): Promise<RoomState> {
  return runInDurableObject(stub, async (_instance, state) => {
    const nowMs = Date.now();
    const loaded = loadPersistenceEnvelope(
      await state.storage.get<unknown>(TEST_ROOM_STORAGE_KEY),
      nowMs
    );

    if (!loaded.ok) {
      throw new Error(`Expected loadable room envelope: ${loaded.error.code}`);
    }

    const result = dispatchRoomCommand(
      loaded.room,
      {
        type: "EXECUTE_TRADE",
        credential: traderCredential,
        commandId: "test-command-force-stuck-settling",
        side,
        nowMs
      },
      {
        verifyToken: () => true
      }
    );

    if (!result.ok) {
      throw new Error(`Expected EXECUTE_TRADE to transition to settling: ${result.error.code}`);
    }

    if (result.room.game.phase !== "settling") {
      throw new Error("Expected settling phase after forced EXECUTE_TRADE.");
    }

    await state.storage.put(
      TEST_ROOM_STORAGE_KEY,
      JSON.parse(JSON.stringify(toPersistenceEnvelope(result.room, nowMs))) as unknown
    );
    await state.storage.put(TEST_PENDING_EFFECT_STORAGE_KEY, {
      kind: "settle",
      roundId: result.room.game.item.round_id,
      attempts: 0,
      notBeforeMs: nowMs
    });

    // Deliberately leave the *scheduled* DO alarm at the room's TTL deadline
    // rather than the pending effect's (earlier, already-due) notBeforeMs.
    // workerd honors real alarm scheduling in this harness - an overdue
    // alarm can fire opportunistically the next time the object is touched,
    // which would resolve settlement out from under a test before it gets a
    // chance to assert the still-stuck fixture. Tests that want to exercise
    // the pending effect must do so explicitly via runRoomCleanupAlarm().
    await state.storage.setAlarm(roomExpiresAtMs(result.room));

    return result.room;
  });
}

/**
 * F-05 analogue of forceStuckSettling: directly patches the persisted
 * room's turnDeadlineMs into the past (production code has no way to stamp
 * a past deadline, since it always computes nowMs + a positive duration),
 * so a test can exercise the alarm's due-turn-clock path without waiting
 * out a real 30-60s duration. Requires the room to already be in one of
 * the four turn-clocked phases. Like forceStuckSettling, the *scheduled* DO
 * alarm is deliberately left at the room's TTL rather than the forced past
 * deadline, so it does not fire opportunistically before a test explicitly
 * ticks it via runRoomCleanupAlarm().
 */
async function forcePastTurnDeadline(stub: GameRoomStub): Promise<RoomState> {
  return runInDurableObject(stub, async (_instance, state) => {
    const nowMs = Date.now();
    const loaded = loadPersistenceEnvelope(
      await state.storage.get<unknown>(TEST_ROOM_STORAGE_KEY),
      nowMs
    );

    if (!loaded.ok) {
      throw new Error(`Expected loadable room envelope: ${loaded.error.code}`);
    }

    if (
      loaded.room.game.phase !== "proposingWidth" &&
      loaded.room.game.phase !== "negotiatingWidth" &&
      loaded.room.game.phase !== "configuringMarket" &&
      loaded.room.game.phase !== "choosingSide"
    ) {
      throw new Error(`Expected a turn-clocked phase, got ${loaded.room.game.phase}.`);
    }

    const patchedRoom: RoomState = {
      ...loaded.room,
      game: { ...loaded.room.game, turnDeadlineMs: nowMs - 1 }
    };

    await state.storage.put(
      TEST_ROOM_STORAGE_KEY,
      JSON.parse(JSON.stringify(toPersistenceEnvelope(patchedRoom, nowMs))) as unknown
    );
    await state.storage.setAlarm(roomExpiresAtMs(patchedRoom));

    return patchedRoom;
  });
}

async function runDueTurnExpiryDirect(
  stub: GameRoomStub,
  room: RoomState,
  nowMs: number
): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as unknown as {
        runDueTurnExpiry(room: RoomState, nowMs: number): Promise<void>;
      }
    ).runDueTurnExpiry(room, nowMs);
  });
}

/**
 * Reads the private, internal RoomState straight out of storage - unlike
 * CommandRoomResponse.room (a PublicRoomSnapshot), this carries host/guest
 * seat token hashes and is what runDueTurnExpiryDirect / forceStuckSettling
 * expect, since production only ever passes internal RoomState objects
 * between these methods, never redacted public snapshots.
 */
async function loadInternalRoomState(stub: GameRoomStub): Promise<RoomState> {
  return runInDurableObject(stub, async (_instance, state) => {
    const loaded = loadPersistenceEnvelope(
      await state.storage.get<unknown>(TEST_ROOM_STORAGE_KEY),
      Date.now()
    );

    if (!loaded.ok) {
      throw new Error(`Expected loadable room envelope: ${loaded.error.code}`);
    }

    return loaded.room;
  });
}

type TestPendingRoomEffect = Readonly<{
  kind: "settle";
  roundId: string;
  attempts: number;
  notBeforeMs: number;
}>;

async function readPendingRoomEffect(
  stub: GameRoomStub
): Promise<TestPendingRoomEffect | null> {
  return runInDurableObject(stub, async (_instance, state) => {
    const value = await state.storage.get<unknown>(TEST_PENDING_EFFECT_STORAGE_KEY);

    return (value as TestPendingRoomEffect | undefined) ?? null;
  });
}

async function writePendingRoomEffectForTest(
  stub: GameRoomStub,
  effect: TestPendingRoomEffect
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put(TEST_PENDING_EFFECT_STORAGE_KEY, effect);
  });
}

async function corruptRoomEnvelope(stub: GameRoomStub): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put(TEST_ROOM_STORAGE_KEY, {
      kind: "trader-titan.test-corrupt-room"
    });
  });
}

async function storedRoomEnvelopeExists(stub: GameRoomStub): Promise<boolean> {
  return runInDurableObject(stub, async (_instance, state) => {
    return (await state.storage.get(TEST_ROOM_STORAGE_KEY)) !== undefined;
  });
}

async function runRoomCleanupAlarm(stub: GameRoomStub): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    await (instance as { alarm(): Promise<void> }).alarm();
  });
}

/**
 * Invokes the private sweepStaleSockets(nowMs) directly, bypassing alarm()'s
 * own `currentUnixTimeMs()` call. This is what makes it possible to pin the
 * `nowMs - lastSeenMs >= ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS` comparison
 * at an *exact* boundary in a test: going through alarm() would race real
 * wall-clock time between when a test computes its expected "last seen"
 * timestamp and when alarm() independently samples `Date.now()` for nowMs,
 * which is fine for the existing "well past threshold" tests (they pad by a
 * full second) but not precise enough to prove the comparison is `>=`
 * rather than `>` right at the boundary.
 */
async function runSweepStaleSocketsDirect(
  stub: GameRoomStub,
  nowMs: number
): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { sweepStaleSockets(nowMs: number): void }).sweepStaleSockets(
      nowMs
    );
  });
}

/**
 * Reproduces a socket accepted by pre-deploy code, before RoomSocketAttachment
 * carried `acceptedAtMs` at all: rewrites the live, hibernation-serialized
 * attachment for the socket with the given `role` to drop the field entirely
 * (not set to `undefined` - simply never written, exactly as
 * `server.serializeAttachment()` left it before the field existed).
 * acceptRoomSocket always writes `acceptedAtMs` today, so this is the only
 * way to produce this shape in a test - it has to be done directly against
 * the live socket via `state.getWebSockets()`, matching how the review that
 * found this gap reproduced it.
 */
async function stripAcceptedAtMsFromLiveAttachment(
  stub: GameRoomStub,
  role: "host" | "guest"
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    for (const socket of state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as {
        kind?: unknown;
        roomId?: unknown;
        role?: unknown;
        tokenHash?: unknown;
      } | null;

      if (attachment === null || attachment.role !== role) {
        continue;
      }

      socket.serializeAttachment({
        kind: attachment.kind,
        roomId: attachment.roomId,
        role: attachment.role,
        tokenHash: attachment.tokenHash
      });
    }
  });
}

/**
 * Substitutes a synthetic "last auto-response" clock for GameRoomDurableObject's
 * private readSocketAutoResponseTimestamp for the duration of `run`, then
 * restores the original. This is the one piece of F-08's liveness sweep
 * that cannot be driven deterministically any other way:
 * getWebSocketAutoResponseTimestamp is produced entirely inside workerd's
 * edge auto-responder in response to a real "tt-ping" frame, and waiting
 * out ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS (60s) in real time is not a
 * viable test.
 *
 * This works because @cloudflare/vitest-pool-workers runs this test file
 * inside the same workerd isolate as the worker under test (see
 * runInDurableObject's own direct-private-method-call pattern elsewhere in
 * this file) - `GameRoomDurableObject` imported here is the exact class
 * object whose instances handle real `stub.fetch()`/alarm() calls, not a
 * separate copy, so patching its prototype here is visible to those calls.
 */
async function withPatchedAutoResponseTimestamp<T>(
  timestampFor: (ws: WebSocket) => Date | null,
  run: () => Promise<T>
): Promise<T> {
  const proto = GameRoomDurableObject.prototype as unknown as {
    readSocketAutoResponseTimestamp: (ws: WebSocket) => Date | null;
  };
  const original = proto.readSocketAutoResponseTimestamp;

  proto.readSocketAutoResponseTimestamp = timestampFor;

  try {
    return await run();
  } finally {
    proto.readSocketAutoResponseTimestamp = original;
  }
}

function socketAttachmentRole(ws: WebSocket): "host" | "guest" | null {
  const attachment = ws.deserializeAttachment() as { role?: unknown } | null;

  return attachment?.role === "host" || attachment?.role === "guest"
    ? attachment.role
    : null;
}

/**
 * Invokes the DO's private runDueSettleEffect directly, bypassing alarm()'s
 * outer transaction. alarm() freezes a single `nowMs` for its whole
 * invocation, so a room that alarm()'s outer transaction found loadable
 * cannot flip to "expired" for a later transaction within that same
 * invocation unless the underlying storage genuinely changed out from under
 * it (e.g. a concurrent write racing the two transactions) - the exact
 * narrow race this helper reproduces deterministically by expiring storage
 * first and then entering the method with the room/marker snapshot alarm()
 * would have captured before that expiry.
 */
async function runDueSettleEffectDirect(
  stub: GameRoomStub,
  room: RoomState,
  pendingEffect: TestPendingRoomEffect,
  nowMs: number
): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as unknown as {
        runDueSettleEffect(
          room: RoomState,
          pendingEffect: TestPendingRoomEffect,
          nowMs: number
        ): Promise<void>;
      }
    ).runDueSettleEffect(room, pendingEffect, nowMs);
  });
}

async function putStalePrivateGeneratedItem(
  stub: GameRoomStub,
  suffix: string
): Promise<string> {
  const key = `${privateGeneratedItemStoragePrefix()}${suffix}`;

  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put(key, { stale: true });
    await state.storage.setAlarm(Date.now() - 1);
  });

  return key;
}

async function readCommandDedupeEntries(stub: GameRoomStub): Promise<unknown[]> {
  return runInDurableObject(stub, async (_instance, state) => {
    const value = await state.storage.get<unknown>(TEST_COMMAND_DEDUPE_STORAGE_KEY);

    return Array.isArray(value) ? value : [];
  });
}

async function storedRoomAlarm(stub: GameRoomStub): Promise<number | null> {
  return runInDurableObject(stub, async (_instance, state) => {
    return (await state.storage.getAlarm()) ?? null;
  });
}

async function setStoredRoomAlarm(
  stub: GameRoomStub,
  scheduledTimeMs: number
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.setAlarm(scheduledTimeMs);
  });
}

async function storedRoomExpiresAt(stub: GameRoomStub): Promise<number> {
  return runInDurableObject(stub, async (_instance, state) => {
    const loaded = loadPersistenceEnvelope(
      await state.storage.get<unknown>(TEST_ROOM_STORAGE_KEY),
      Date.now()
    );

    if (!loaded.ok) {
      throw new Error(`Expected loadable room envelope: ${loaded.error.code}`);
    }

    return roomExpiresAtMs(loaded.room);
  });
}

async function expireStoredRoomEnvelope(stub: GameRoomStub): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const loaded = loadPersistenceEnvelope(
      await state.storage.get<unknown>(TEST_ROOM_STORAGE_KEY),
      Date.now()
    );

    if (!loaded.ok) {
      throw new Error(`Expected loadable room envelope: ${loaded.error.code}`);
    }

    const expiredAtMs = 1;
    const expiredRoom = roomWithStorageTimestamps(loaded.room, expiredAtMs);

    await state.storage.put(
      TEST_ROOM_STORAGE_KEY,
      JSON.parse(JSON.stringify(toPersistenceEnvelope(expiredRoom, expiredAtMs))) as unknown
    );
    await state.storage.setAlarm(Date.now() - 1);
  });
}

/**
 * Same content mutation as expireStoredRoomEnvelope (rewrites the stored
 * room so any future loadStoredRoomEnvelope/loadPersistenceEnvelope call
 * sees it as expired), but deliberately leaves the DO's actually-scheduled
 * alarm untouched instead of arming an overdue one. Some tests need the
 * room to *read back* as expired without triggering workerd's opportunistic
 * overdue-alarm firing in this harness (see forceStuckSettling's comment on
 * the same hazard) - e.g. when isolating a direct call to a private
 * effect-resume method rather than going through the real alarm().
 */
async function expireStoredRoomEnvelopeWithoutArmingAlarm(stub: GameRoomStub): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const loaded = loadPersistenceEnvelope(
      await state.storage.get<unknown>(TEST_ROOM_STORAGE_KEY),
      Date.now()
    );

    if (!loaded.ok) {
      throw new Error(`Expected loadable room envelope: ${loaded.error.code}`);
    }

    const expiredAtMs = 1;
    const expiredRoom = roomWithStorageTimestamps(loaded.room, expiredAtMs);

    await state.storage.put(
      TEST_ROOM_STORAGE_KEY,
      JSON.parse(JSON.stringify(toPersistenceEnvelope(expiredRoom, expiredAtMs))) as unknown
    );
  });
}

function roomWithStorageTimestamps(
  room: RoomState,
  timestampMs: number
): RoomState {
  return {
    ...room,
    host: {
      ...room.host,
      joinedAtMs: timestampMs
    },
    guest: room.guest === null
      ? null
      : {
        ...room.guest,
        joinedAtMs: timestampMs
      },
    createdAtMs: timestampMs,
    updatedAtMs: timestampMs
  };
}

async function createRoom(
  stub: GameRoomStub,
  hostName: string,
  config?: CreateRoomConfig
): Promise<CreateRoomResponse> {
  const response = await stub.fetch(GAME_ROOM_SMOKE_URL, {
    body: JSON.stringify({
      hostName,
      ...(config === undefined ? {} : { config })
    }),
    method: "POST"
  });

  expect(response.status).toBe(HTTP_CREATED_STATUS);

  return expectPublicJson<CreateRoomResponse>(response);
}

async function joinRoom(
  stub: GameRoomStub,
  guestName: string
): Promise<JoinRoomResponse> {
  const response = await stub.fetch(ROOM_JOIN_URL, {
    body: JSON.stringify({ guestName }),
    method: "POST"
  });

  expect(response.status).toBe(HTTP_OK_STATUS);

  return expectPublicJson<JoinRoomResponse>(response);
}

async function accessRoom(
  stub: GameRoomStub,
  credential: RoomCapabilityToken
): Promise<AccessRoomResponse> {
  const response = await stub.fetch(`${GAME_ROOM_SMOKE_URL}/access`, {
    body: JSON.stringify({ credential }),
    method: "POST"
  });

  expect(response.status).toBe(HTTP_OK_STATUS);

  return expectPublicJson<AccessRoomResponse>(response);
}

async function accessPublicRoom(
  roomId: string,
  credential: RoomCapabilityToken
): Promise<Response> {
  const request = new Request(`${PUBLIC_ROOMS_URL}/${roomId}/access`, {
    body: JSON.stringify({ credential }),
    method: "POST"
  }) as WorkerFetchRequest;
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);

  await waitOnExecutionContext(ctx);

  return response;
}

async function fetchPublicWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request as WorkerFetchRequest, env, ctx);

  await waitOnExecutionContext(ctx);

  return response;
}

async function postPublicRoomCreate(
  hostName: string,
  cfConnectingIp: string
): Promise<Response> {
  return fetchPublicWorker(new Request(PUBLIC_ROOMS_URL, {
    body: JSON.stringify({ hostName }),
    headers: {
      "cf-connecting-ip": cfConnectingIp,
      "content-type": "application/json"
    },
    method: "POST"
  }));
}

type PresencePlayers = Readonly<{
  A: boolean;
  B: boolean;
}>;

function roomWithPresence(
  room: PublicRoomSnapshot,
  players: PresencePlayers
): PublicRoomSnapshot {
  return {
    ...room,
    presence: { players }
  };
}

function expectRoomPresence(
  room: PublicRoomSnapshot,
  players: PresencePlayers
): void {
  expect(room.presence).toEqual({ players });
}

async function waitForRoomPresence(
  stub: GameRoomStub,
  credential: RoomCapabilityToken,
  players: PresencePlayers
): Promise<AccessRoomResponse> {
  const deadline = Date.now() + SOCKET_MESSAGE_TIMEOUT_MS;
  let latest: AccessRoomResponse | null = null;

  while (Date.now() < deadline) {
    latest = await accessRoom(stub, credential);

    if (
      latest.room.presence.players.A === players.A &&
      latest.room.presence.players.B === players.B
    ) {
      return latest;
    }

    await delay(10);
  }

  if (latest !== null) {
    expectRoomPresence(latest.room, players);
  }

  throw new Error("Timed out waiting for room presence.");
}

/**
 * Closes a room socket and waits for the DO's live-socket-derived presence
 * to actually reflect it being gone, rather than just the client-side close
 * event. F-08's liveness sweep folds a deadline computed from
 * ctx.getWebSockets() into the single alarm slot (see
 * nextLivenessSweepDeadline/scheduleNextAlarm in src/worker/index.ts), so
 * any test asserting an exact storedRoomAlarm() value must first be sure a
 * socket it opened earlier is no longer counted - a bare `.close()` starts
 * the closing handshake but does not synchronously guarantee
 * ctx.getWebSockets() has already dropped it.
 */
async function closeSocketAndWaitOffline(
  stub: GameRoomStub,
  socket: WebSocket,
  hostToken: RoomCapabilityToken,
  players: PresencePlayers
): Promise<void> {
  socket.close();
  await waitForRoomPresence(stub, hostToken, players);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let testCommandIdSequence = 0;

/**
 * Most tests only care about the command's domain effect, not about
 * commandId itself, so this fills one in when the caller didn't set one.
 * Tests that exercise commandId directly (decode validation, replay
 * dedupe) pass an explicit commandId, which this leaves untouched.
 */
function withTestCommandId(command: unknown): unknown {
  if (
    typeof command !== "object" ||
    command === null ||
    Array.isArray(command) ||
    "commandId" in command
  ) {
    return command;
  }

  testCommandIdSequence += 1;

  return { ...command, commandId: `test-command-${testCommandIdSequence}` };
}

async function postRoomCommand(
  stub: GameRoomStub,
  command: unknown
): Promise<Response> {
  return stub.fetch(ROOM_COMMAND_URL, {
    body: JSON.stringify(withTestCommandId(command)),
    method: "POST"
  });
}

async function applyRoomCommand(
  stub: GameRoomStub,
  command: unknown
): Promise<CommandRoomResponse> {
  const response = await postRoomCommand(stub, command);

  expect(response.status).toBe(HTTP_OK_STATUS);

  return expectPublicJson<CommandRoomResponse>(response);
}

async function applyRoomCommandWithoutTrueValue(
  stub: GameRoomStub,
  command: unknown
): Promise<CommandRoomResponse> {
  const response = await postRoomCommand(stub, command);

  expect(response.status).toBe(HTTP_OK_STATUS);

  return expectPublicJsonWithoutTrueValue<CommandRoomResponse>(response);
}

/**
 * Builds a fresh room up through choosingSide with a caller-controlled
 * quote, for the F-06 forced-worst-side-settlement tests: they each need a
 * specific bid/ask against the static deck's fixed round-1 Chaos Quant
 * true_value (42) to steer which side ends up worse for the trader. Width is
 * derived from the quote itself so the two always agree.
 */
async function readyChoosingSide(
  stub: GameRoomStub,
  quote: { bid: number; ask: number }
): Promise<{
  hostToken: RoomCapabilityToken;
  guestToken: RoomCapabilityToken;
  quoted: CommandRoomResponse;
}> {
  const created = await createRoom(stub, "Host");

  if (!created.created) {
    throw new Error("Expected a newly created room.");
  }

  const joined = await joinRoom(stub, "Guest");
  const started = await applyRoomCommandWithoutTrueValue(stub, {
    type: "START_ROOM",
    credential: created.hostToken
  });

  if (started.room.game.phase !== "proposingWidth") {
    throw new Error("Expected generated item to be ready.");
  }

  const width = await applyRoomCommandWithoutTrueValue(stub, {
    type: "SUBMIT_INITIAL_WIDTH",
    credential: created.hostToken,
    width: quote.ask - quote.bid
  });

  if (width.room.game.phase !== "negotiatingWidth") {
    throw new Error("Expected negotiatingWidth phase.");
  }

  const configuring = await applyRoomCommandWithoutTrueValue(stub, {
    type: "TRADE_ON_WIDTH",
    credential: joined.guestToken
  });

  if (configuring.room.game.phase !== "configuringMarket") {
    throw new Error("Expected configuringMarket phase.");
  }

  const quoted = await applyRoomCommandWithoutTrueValue(stub, {
    type: "SUBMIT_MARKET_QUOTE",
    credential: created.hostToken,
    quote
  });

  if (quoted.room.game.phase !== "choosingSide") {
    throw new Error("Expected choosingSide phase.");
  }

  return { hostToken: created.hostToken, guestToken: joined.guestToken, quoted };
}

async function settleCurrentRound(
  stub: GameRoomStub,
  room: PublicRoomSnapshot,
  hostToken: RoomCapabilityToken,
  guestToken: RoomCapabilityToken
): Promise<PublicRoomSnapshot> {
  if (room.lifecycle !== "active" || room.game.phase !== "proposingWidth") {
    throw new Error("Expected a room ready for width proposal.");
  }

  const marketMakerToken = tokenForPlayer(
    room.game.roles.marketMaker,
    hostToken,
    guestToken
  );
  const traderToken = tokenForPlayer(
    room.game.roles.trader,
    hostToken,
    guestToken
  );

  const width = await applyRoomCommandWithoutTrueValue(stub, {
    type: "SUBMIT_INITIAL_WIDTH",
    credential: marketMakerToken,
    width: 100
  });

  expect(width.room.game.phase).toBe("negotiatingWidth");

  const configuring = await applyRoomCommandWithoutTrueValue(stub, {
    type: "TRADE_ON_WIDTH",
    credential: traderToken
  });

  expect(configuring.room.game.phase).toBe("configuringMarket");

  const quoted = await applyRoomCommandWithoutTrueValue(stub, {
    type: "SUBMIT_MARKET_QUOTE",
    credential: marketMakerToken,
    quote: {
      bid: 3500,
      ask: 3600
    }
  });

  expect(quoted.room.game.phase).toBe("choosingSide");

  const settled = await applyRoomCommand(stub, {
    type: "EXECUTE_TRADE",
    credential: traderToken,
    side: "BUY"
  });

  expect(settled.room.game.phase).toBe("settlement");

  return settled.room;
}

function tokenForPlayer(
  playerId: "A" | "B",
  hostToken: RoomCapabilityToken,
  guestToken: RoomCapabilityToken
): RoomCapabilityToken {
  return playerId === "A" ? hostToken : guestToken;
}

type CreateRoomConfig = Readonly<{
  mode?: string;
  totalRounds?: number;
}>;



async function postPublicCustomAmazonItemBody(roomId: string, body: unknown): Promise<Response> {
  return fetchPublicWorker(new Request(`${PUBLIC_ROOMS_URL}/${roomId}/custom-amazon-item`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  }));
}

async function fetchPublicRoomSocket(
  roomId: string,
  credential?: RoomCapabilityToken
): Promise<Response> {
  const request = new Request(
    `${PUBLIC_ROOMS_URL}/${roomId}/socket`,
    {
      headers: {
        ...socketHeadersForCredential(credential),
        upgrade: "websocket"
      }
    }
  ) as WorkerFetchRequest;
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);

  await waitOnExecutionContext(ctx);

  return response;
}

async function fetchRoomSocket(
  stub: GameRoomStub,
  credential?: RoomCapabilityToken
): Promise<Response> {
  return stub.fetch(ROOM_SOCKET_URL, {
    headers: {
      ...socketHeadersForCredential(credential),
      upgrade: "websocket"
    }
  });
}

async function openPublicRoomSocket(
  roomId: string,
  credential: RoomCapabilityToken
): Promise<RoomSocketConnection> {
  const response = await fetchPublicRoomSocket(roomId, credential);
  return acceptSocketResponse(response);
}

async function openRoomSocket(
  stub: GameRoomStub,
  credential: RoomCapabilityToken
): Promise<RoomSocketConnection> {
  const response = await stub.fetch(ROOM_SOCKET_URL, {
    headers: {
      ...socketHeadersForCredential(credential),
      upgrade: "websocket"
    }
  });

  return acceptSocketResponse(response);
}

function socketHeadersForCredential(
  credential: RoomCapabilityToken | undefined
): Record<string, string> {
  if (credential === undefined) {
    return {};
  }

  return {
    "sec-websocket-protocol": [
      "tt-room-v1",
      `tt-role-${credential.role}`,
      `tt-secret-${credential.secret}`
    ].join(", ")
  };
}

async function acceptSocketResponse(response: Response): Promise<RoomSocketConnection> {
  expect(response.status).toBe(HTTP_SWITCHING_PROTOCOLS_STATUS);
  expect(response.webSocket).not.toBeNull();

  if (response.webSocket === null) {
    throw new Error("Expected room WebSocket response.");
  }

  const initialMessage = nextSocketMessage<RoomSnapshotSocketMessage>(response.webSocket);

  response.webSocket.accept();

  return {
    socket: response.webSocket,
    initial: await initialMessage
  };
}

function nextSocketMessage<T>(socket: WebSocket): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage as EventListener);

      if (typeof event.data !== "string") {
        reject(new Error("Expected room socket message data to be a string."));

        return;
      }

      try {
        resolve(JSON.parse(event.data) as T);
      } catch (error) {
        reject(error);
      }
    };

    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage as EventListener);
      reject(new Error("Timed out waiting for room socket message."));
    }, SOCKET_MESSAGE_TIMEOUT_MS);

    socket.addEventListener("message", onMessage as EventListener);
  });
}

/**
 * Collects the next `count` JSON socket messages in order, for a single
 * alarm invocation that can synchronously broadcast more than once (e.g.
 * F-06's choosingSide timeout: one broadcast for the settling transition,
 * a second once receiveStoredSettlement resolves it). A single listener is
 * registered up front and kept attached across all `count` messages -
 * unlike chaining separate nextSocketMessage() calls, which would only
 * attach the second listener *after* awaiting the first, by which point a
 * synchronous second send has already happened with nothing attached to
 * receive it.
 */
function nextSocketMessages<T>(socket: WebSocket, count: number): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const collected: T[] = [];
    const onMessage = (event: MessageEvent): void => {
      if (typeof event.data !== "string") {
        clearTimeout(timeout);
        socket.removeEventListener("message", onMessage as EventListener);
        reject(new Error("Expected room socket message data to be a string."));

        return;
      }

      try {
        collected.push(JSON.parse(event.data) as T);
      } catch (error) {
        clearTimeout(timeout);
        socket.removeEventListener("message", onMessage as EventListener);
        reject(error);

        return;
      }

      if (collected.length >= count) {
        clearTimeout(timeout);
        socket.removeEventListener("message", onMessage as EventListener);
        resolve(collected);
      }
    };

    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage as EventListener);
      reject(
        new Error(
          `Timed out waiting for ${count} room socket messages (got ${collected.length}).`
        )
      );
    }, SOCKET_MESSAGE_TIMEOUT_MS);

    socket.addEventListener("message", onMessage as EventListener);
  });
}

/**
 * Waits for the next raw text socket message without JSON-decoding it, for
 * asserting on non-JSON protocol frames such as the "tt-pong" auto-response.
 */
function nextRawSocketMessage(socket: WebSocket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage as EventListener);

      if (typeof event.data !== "string") {
        reject(new Error("Expected room socket message data to be a string."));

        return;
      }

      resolve(event.data);
    };

    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage as EventListener);
      reject(new Error("Timed out waiting for raw room socket message."));
    }, SOCKET_MESSAGE_TIMEOUT_MS);

    socket.addEventListener("message", onMessage as EventListener);
  });
}

function nextSocketClose(socket: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("close", onClose as EventListener);
      reject(new Error("Timed out waiting for room socket close."));
    }, SOCKET_MESSAGE_TIMEOUT_MS);
    const onClose = (): void => {
      clearTimeout(timeout);
      socket.removeEventListener("close", onClose as EventListener);
      resolve();
    };

    socket.addEventListener("close", onClose as EventListener);
  });
}

/**
 * Like `nextSocketClose`, but surfaces the close code/reason instead of
 * discarding them. The reconnect supervisor's entire "do not loop forever
 * evicting yourself" guarantee (see `room-socket-supervisor.ts`) hinges on
 * the server evicting a superseded socket with exactly code 1008 — that is
 * the one non-retryable code the client treats as terminal instead of
 * scheduling a reconnect. `nextSocketClose` alone would pass this test even
 * if `closeSocketQuietly`'s primary `socket.close(1008, reason)` call
 * silently threw and fell back to a codeless `socket.close()`, so callers
 * that care about eviction specifically should assert on the code here.
 */
function nextSocketCloseCode(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("close", onClose as EventListener);
      reject(new Error("Timed out waiting for room socket close."));
    }, SOCKET_MESSAGE_TIMEOUT_MS);
    const onClose = (event: CloseEvent): void => {
      clearTimeout(timeout);
      socket.removeEventListener("close", onClose as EventListener);
      resolve({ code: event.code, reason: event.reason });
    };

    socket.addEventListener("close", onClose as EventListener);
  });
}

async function expectPublicJson<T = unknown>(response: Response): Promise<T> {
  const text = await response.text();

  expectPublicPayload(text);

  return JSON.parse(text) as T;
}

async function expectPublicJsonWithoutTrueValue<T = unknown>(
  response: Response
): Promise<T> {
  const text = await response.text();

  expectPublicPayload(text);
  expect(text).not.toContain("true_value");

  return JSON.parse(text) as T;
}

async function expectPublicJsonWithoutPrivateItemMetadata<T = unknown>(
  response: Response
): Promise<T> {
  const text = await response.text();

  expectPublicPayload(text);
  expect(text).not.toContain("true_value");
  expect(text).not.toContain("scraped_items");
  expect(text).not.toContain("amazon_url");

  return JSON.parse(text) as T;
}

function expectPublicPayload(text: string): void {
  expect(text).not.toContain("tokenHash");
  expect(text).not.toContain("persistedAtMs");
  expect(text).not.toContain("expiresAtMs");
  expect(text).not.toContain("trader-titan.room");
}
