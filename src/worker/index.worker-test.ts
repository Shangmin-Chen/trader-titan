/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "./index";
import {
  privateGeneratedItemStorageKey,
  privateGeneratedItemStoragePrefix
} from "./private-generated-items";
import {
  SMOKE_HEADER_NAME,
  SMOKE_HEADER_VALUE
} from "./testing/open-next-worker";
import { applySettlementToScores } from "../lib/game";
import type { GameMode, ProviderGeneratedItem, TradeSide } from "../lib/game";
import {
  ROOM_CREATION_RATE_LIMIT_MAX_REQUESTS,
  ROOM_CUSTOM_AMAZON_RATE_LIMIT_MAX_REQUESTS
} from "../api/request-guards";
import {
  dispatchRoomCommand,
  dispatchSystemRoomEvent,
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
const STUCK_SETTLING_NO_DOUBLE_SETTLE_ROOM_NAME = "worker-room-stuck-settling-no-double-settle";
const STUCK_SETTLING_MID_ALARM_EXPIRY_ROOM_NAME = "worker-room-stuck-settling-mid-alarm-expiry";
const RETRY_SUCCESS_ROOM_NAME = "worker-room-retry-success";
const RETRY_FAILURE_ROOM_NAME = "worker-room-retry-failure";
const RETRY_UNAUTHORIZED_ROOM_NAME = "worker-room-retry-unauthorized";
const CUSTOM_AMAZON_RETRY_ROOM_NAME = "worker-room-custom-amazon-retry";
const RESET_PRIVATE_ITEM_ROOM_NAME = "worker-room-reset-private-item";
const KICK_PRIVATE_ITEM_ROOM_NAME = "worker-room-kick-private-item";
const REPLACE_PRIVATE_ITEM_ROOM_NAME = "worker-room-replace-private-item";
const ALARM_PRIVATE_ITEM_ROOM_NAME = "worker-room-alarm-private-item";
const ALARM_MISSING_PRIVATE_ITEM_ROOM_NAME = "worker-room-alarm-missing-private-item";
const ALARM_EXPIRED_PRIVATE_ITEM_ROOM_NAME = "worker-room-alarm-expired-private-item";
const ALARM_VALID_PRIVATE_ITEM_ROOM_NAME = "worker-room-alarm-valid-private-item";
const CUSTOM_AMAZON_ROOM_NAME = "worker-room-custom-amazon";
const STALE_CUSTOM_AMAZON_ROOM_NAME = "worker-room-stale-custom-amazon";
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
const TIGHTEN_REPLAY_SAME_ID_ROOM_NAME = "worker-room-tighten-replay-same-id";
const TIGHTEN_REPLAY_DIFFERENT_ID_ROOM_NAME = "worker-room-tighten-replay-different-id";
const KICKED_GUEST_REPLAY_ROOM_NAME = "worker-room-kicked-guest-replay";
const GAME_ROOM_SMOKE_URL = "https://trader-titan.worker.test/room";
const ROOM_COMMAND_URL = `${GAME_ROOM_SMOKE_URL}/command`;
const ROOM_JOIN_URL = `${GAME_ROOM_SMOKE_URL}/join`;
const ROOM_CUSTOM_AMAZON_ITEM_URL = `${GAME_ROOM_SMOKE_URL}/custom-amazon-item`;
const ROOM_SOCKET_URL = `${GAME_ROOM_SMOKE_URL}/socket`;
const PUBLIC_ROOMS_URL = "https://trader-titan.worker.test/api/rooms";
const TEST_ROOM_STORAGE_KEY = "room:persistence:v1";
const TEST_PENDING_EFFECT_STORAGE_KEY = "room:pending-effect:v1";
// Mirrors PENDING_SETTLE_EFFECT_MAX_ATTEMPTS in src/worker/index.ts.
const TEST_PENDING_SETTLE_EFFECT_MAX_ATTEMPTS = 5;
const HTTP_BAD_REQUEST_STATUS = 400;
const HTTP_FORBIDDEN_STATUS = 403;
const HTTP_CREATED_STATUS = 201;
const HTTP_OK_STATUS = 200;
const HTTP_SWITCHING_PROTOCOLS_STATUS = 101;
const HTTP_CONFLICT_STATUS = 409;
const HTTP_GONE_STATUS = 410;
const HTTP_TOO_MANY_REQUESTS_STATUS = 429;
const SOCKET_MESSAGE_TIMEOUT_MS = 1_000;
const WORKER_SMOKE_PATH = "/worker-smoke";
const WORKER_SMOKE_URL = `https://trader-titan.worker.test${WORKER_SMOKE_PATH}`;
const LEGACY_GENERATE_ITEM_URL = "https://trader-titan.worker.test/api/generate-item";
type WorkerFetchRequest = Parameters<typeof worker.fetch>[0];
type GameRoomStub = ReturnType<typeof roomStub>;
type TestPendingItemGeneration = Readonly<{
  roomId: PublicRoomSnapshot["id"];
  revision: number;
  roundNumber: number;
  mode: GameMode;
  customAmazonQuery: boolean;
}>;
type TestStoredRoomCommandResult =
  | Readonly<{ ok: true; room: RoomState }>
  | Readonly<{
      ok: false;
      status: number;
      error: Readonly<{
        code: string;
        message: string;
      }>;
    }>;
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

type CustomAmazonItemResponse = Readonly<{
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
      })
    ]) {
      const response = await fetchPublicWorker(request);
      const rejected = await expectPublicJson<RoomErrorResponse>(response);

      expect(response.status).toBe(HTTP_FORBIDDEN_STATUS);
      expect(rejected.error.code).toBe("origin_not_allowed");
    }

    const customResponse = await fetchPublicWorker(new Request(
      `${PUBLIC_ROOMS_URL}/room-cross-origin/custom-amazon-item`,
      {
        body: JSON.stringify({ query: "wireless mouse" }),
        headers,
        method: "POST"
      }
    ));
    const customRejected = await expectPublicJson<RoomErrorResponse>(customResponse);

    expect(customResponse.status).toBe(HTTP_FORBIDDEN_STATUS);
    expect(customRejected.error.code).toBe("origin_not_allowed");

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

  it("rate limits public custom Amazon item submissions per Cloudflare client IP", async () => {
    const limitedIp = "198.51.100.20";

    for (let requestIndex = 0; requestIndex < ROOM_CUSTOM_AMAZON_RATE_LIMIT_MAX_REQUESTS; requestIndex += 1) {
      const response = await postPublicCustomAmazonItemBody(
        "room-custom-rate-limit",
        {},
        limitedIp
      );

      expect(response.status).not.toBe(HTTP_TOO_MANY_REQUESTS_STATUS);
    }

    const limitedResponse = await postPublicCustomAmazonItemBody(
      "room-custom-rate-limit",
      {},
      limitedIp
    );
    const limited = await expectPublicJson<RoomErrorResponse>(limitedResponse);

    expect(limitedResponse.status).toBe(HTTP_TOO_MANY_REQUESTS_STATUS);
    expect(limited.error.code).toBe("rate_limited");

    const otherIpResponse = await postPublicCustomAmazonItemBody(
      "room-custom-rate-limit",
      {},
      "198.51.100.21"
    );

    expect(otherIpResponse.status).not.toBe(HTTP_TOO_MANY_REQUESTS_STATUS);
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
      context_clue: "An hour contains 60 minutes, each with 60 seconds.",
      item_title: "Seconds in an hour"
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

    // aiGenerated rooms keep round-1 roles unswapped: A is marketMaker, B is trader.
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

  it("rejects HTTP START_ROOM when a joined guest has no live socket", async () => {
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
    const rejected = await expectPublicJson<RoomErrorResponse>(startResponse);

    expect(startResponse.status).toBe(HTTP_CONFLICT_STATUS);
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: "player_offline"
      }
    });

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room.lifecycle).toBe("lobby");
    expect(persisted.room.game.phase).toBe("setup");
    expect(persisted.room.revision).toBe(joined.room.revision);
    expect(persisted.room.seats.guest.occupied).toBe(true);
    expectRoomPresence(persisted.room, { A: false, B: false });
  });

  it("auto-generates an item when retrying a failed non-custom generation", async () => {
    const stub = roomStub(RETRY_SUCCESS_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created retry success room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);

    expectRoomPresence(guestConnection.initial.room, { A: false, B: true });

    const failed = await withMissingGeminiItemProvider(stub, () =>
      applyRoomCommandWithoutTrueValue(stub, {
        type: "START_ROOM",
        credential: created.hostToken
      })
    );

    expect(failed.room.lifecycle).toBe("active");
    expect(failed.room.game.phase).toBe("error");

    if (failed.room.game.phase !== "error") {
      throw new Error("Expected initial provider failure.");
    }

    expect(failed.room.game.previousPhase).toBe("generatingItem");
    expect(failed.room.game.error).toBe("Item generation is not configured.");

    const failedLog = failed.room.game.log;
    const retried = await applyRoomCommandWithoutTrueValue(stub, {
      type: "RETRY_ITEM_GENERATION",
      credential: created.hostToken
    });

    expect(retried.room.lifecycle).toBe("active");
    expect(retried.room.game.phase).toBe("proposingWidth");
    expect(retried.room.revision).toBe(failed.room.revision + 2);
    expect(retried.room.game.scores).toEqual(failed.room.game.scores);
    expect(retried.room.game.roles).toEqual(failed.room.game.roles);
    expect(retried.room.game.log.slice(0, failedLog.length)).toEqual(failedLog);
    expect(retried.room.game.log[failedLog.length]?.message).toBe(
      "Retrying item generation for round 1."
    );

    if (retried.room.game.phase !== "proposingWidth") {
      throw new Error("Expected retried item to be ready.");
    }

    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateGeneratedItemStorageKey(retried.room.game.item.round_id)
    ]);

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room).toEqual(retried.room);

    guestConnection.socket.close();
  });

  it("records an error when retry provider generation fails without resetting room context", async () => {
    const stub = roomStub(RETRY_FAILURE_ROOM_NAME);
    const created = await createRoom(stub, "Host", { totalRounds: 2 });

    if (!created.created) {
      throw new Error("Expected a newly created retry failure room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
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

    const failedAdvance = await withMissingGeminiItemProvider(stub, () =>
      applyRoomCommandWithoutTrueValue(stub, {
        type: "ADVANCE_ROUND",
        credential: created.hostToken
      })
    );

    expect(failedAdvance.room.lifecycle).toBe("active");
    expect(failedAdvance.room.game.phase).toBe("error");

    if (failedAdvance.room.game.phase !== "error") {
      throw new Error("Expected advance provider failure.");
    }

    expect(failedAdvance.room.game.previousPhase).toBe("generatingItem");
    expect(failedAdvance.room.game.roundNumber).toBe(2);

    const failedScores = failedAdvance.room.game.scores;
    const failedRoles = failedAdvance.room.game.roles;
    const failedPlayers = failedAdvance.room.game.players;
    const failedLog = failedAdvance.room.game.log;
    const retryFailure = await withMissingGeminiItemProvider(stub, () =>
      applyRoomCommandWithoutTrueValue(stub, {
        type: "RETRY_ITEM_GENERATION",
        credential: created.hostToken
      })
    );

    expect(retryFailure.room.lifecycle).toBe("active");
    expect(retryFailure.room.game.phase).toBe("error");
    expect(retryFailure.room.revision).toBe(failedAdvance.room.revision + 2);

    if (retryFailure.room.game.phase !== "error") {
      throw new Error("Expected retry provider failure.");
    }

    expect(retryFailure.room.game.previousPhase).toBe("generatingItem");
    expect(retryFailure.room.game.error).toBe("Item generation is not configured.");
    expect(retryFailure.room.game.roundNumber).toBe(2);
    expect(retryFailure.room.game.totalRounds).toBe(2);
    expect(retryFailure.room.game.scores).toEqual(failedScores);
    expect(retryFailure.room.game.roles).toEqual(failedRoles);
    expect(retryFailure.room.game.players).toEqual(failedPlayers);
    expect(retryFailure.room.game.log.slice(0, failedLog.length)).toEqual(failedLog);
    expect(retryFailure.room.game.log[failedLog.length]?.message).toBe(
      "Retrying item generation for round 2."
    );
    expect(retryFailure.room.game.log.at(-1)?.message).toBe(
      "Item generation failed: Item generation is not configured."
    );

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room).toEqual(retryFailure.room);

    guestConnection.socket.close();
  });

  it("rejects guest item-generation retries over HTTP and WebSocket without generating an item", async () => {
    const stub = roomStub(RETRY_UNAUTHORIZED_ROOM_NAME);
    const created = await createRoom(stub, "Host");

    if (!created.created) {
      throw new Error("Expected a newly created unauthorized retry room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const failed = await withMissingGeminiItemProvider(stub, () =>
      applyRoomCommandWithoutTrueValue(stub, {
        type: "START_ROOM",
        credential: created.hostToken
      })
    );

    expect(failed.room.lifecycle).toBe("active");
    expect(failed.room.game.phase).toBe("error");

    if (failed.room.game.phase !== "error") {
      throw new Error("Expected initial item generation failure.");
    }

    expect(failed.room.game.previousPhase).toBe("generatingItem");
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([]);

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

    expect(persisted.room.revision).toBe(failed.room.revision);
    expect(persisted.room.game).toEqual(failed.room.game);
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([]);

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

    expect(settled.room.game.item.true_value).toBe(3600);
    expect(settled.room.game.settlement.trueValue).toBe(3600);
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
    // round 2 must not touch this. Quote away from the deterministic
    // provider's fixed true_value (3600) so round 1's PnL is non-zero and
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

    // The alarm slot must not spin: after exhaustion, only TTL remains
    // scheduled, and a further alarm tick is a stable no-op.
    const alarmAfterExhaustion = await storedRoomAlarm(stub);

    expect(alarmAfterExhaustion).toBe(await storedRoomExpiresAt(stub));

    await runRoomCleanupAlarm(stub);

    const afterSecondTick = await accessRoom(stub, created.hostToken);

    expect(afterSecondTick.room.revision).toBe(afterExhaustion.room.revision);

    guestConnection.socket.close();
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

    const privateItemKey = privateGeneratedItemStorageKey(
      started.room.game.item.round_id
    );
    const expectedAlarm = await storedRoomExpiresAt(stub);

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

    guestConnection.socket.close();
  });

  it("generates custom Amazon items from the current trader and rejects the wrong player", async () => {
    const stub = roomStub(CUSTOM_AMAZON_ROOM_NAME);
    const created = await createRoom(stub, "Host", {
      mode: "Amazon",
      customAmazonQuery: true,
      totalRounds: 1
    });

    if (!created.created) {
      throw new Error("Expected a newly created custom Amazon room.");
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
    expect(started.room.game.phase).toBe("generatingItem");
    expect(started.room.game.roles.trader).toBe("A");
    expect(started.room.revision).toBe(2);

    const wrongPlayerResponse = await postPublicCustomAmazonItem(
      CUSTOM_AMAZON_ROOM_NAME,
      joined.guestToken,
      "wireless mouse"
    );
    const wrongPlayer = await expectPublicJson<RoomErrorResponse>(wrongPlayerResponse);

    expect(wrongPlayerResponse.status).toBe(HTTP_FORBIDDEN_STATUS);
    expect(wrongPlayer.error.code).toBe("wrong_active_role");

    const customResponse = await postPublicCustomAmazonItem(
      CUSTOM_AMAZON_ROOM_NAME,
      created.hostToken,
      "wireless mouse"
    );
    const custom = await expectPublicJsonWithoutTrueValue<CustomAmazonItemResponse>(customResponse);

    expect(customResponse.status).toBe(HTTP_OK_STATUS);
    expect(custom.room.game.phase).toBe("proposingWidth");

    if (custom.room.game.phase !== "proposingWidth") {
      throw new Error("Expected custom Amazon item to be ready.");
    }

    expect(custom.room.game.item).toMatchObject({
      category: "Amazon",
      context_clue: "Amazon price for \"wireless mouse\"",
      item_title: "wireless mouse"
    });
    expect("true_value" in custom.room.game.item).toBe(false);
    expect("scraped_items" in custom.room.game.item).toBe(false);
    expect("amazon_url" in custom.room.game.item).toBe(false);

    const settledRoom = await settleCurrentRound(
      stub,
      custom.room,
      created.hostToken,
      joined.guestToken
    );

    expect(settledRoom.game.phase).toBe("settlement");

    if (settledRoom.game.phase !== "settlement") {
      throw new Error("Expected custom Amazon item to settle.");
    }

    expect(settledRoom.game.item.true_value).toBe(99.99);
    expect(settledRoom.game.item.scraped_items).toEqual([
      { title: "wireless mouse", price: 99.99 }
    ]);
    expect(settledRoom.game.item.amazon_url).toBe(
      "https://www.amazon.com/s?k=wireless%20mouse"
    );
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([]);

    guestConnection.socket.close();
  });

  it("rejects stale in-flight custom Amazon completion after the guest loses access", async () => {
    const stub = roomStub(STALE_CUSTOM_AMAZON_ROOM_NAME);
    const created = await createRoom(stub, "Host", {
      mode: "Amazon",
      customAmazonQuery: true,
      totalRounds: 2
    });

    if (!created.created) {
      throw new Error("Expected a newly created stale custom Amazon room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    expect(started.room.game.phase).toBe("generatingItem");
    expect(started.room.game.roles.trader).toBe("A");

    const roundOneResponse = await postRoomCustomAmazonItem(
      stub,
      created.hostToken,
      "round one mouse"
    );
    const roundOne = await expectPublicJsonWithoutTrueValue<CustomAmazonItemResponse>(
      roundOneResponse
    );

    expect(roundOneResponse.status).toBe(HTTP_OK_STATUS);

    if (roundOne.room.game.phase !== "proposingWidth") {
      throw new Error("Expected round one custom Amazon item.");
    }

    const settledRoundOne = await settleCurrentRound(
      stub,
      roundOne.room,
      created.hostToken,
      joined.guestToken
    );

    expect(settledRoundOne.game.phase).toBe("settlement");

    const roundTwo = await applyRoomCommandWithoutTrueValue(stub, {
      type: "ADVANCE_ROUND",
      credential: created.hostToken
    });

    expect(roundTwo.room.game.phase).toBe("generatingItem");
    expect(roundTwo.room.game.roundNumber).toBe(2);
    expect(roundTwo.room.game.roles.trader).toBe("B");

    const staleTarget = customAmazonGenerationTargetFor(roundTwo.room);
    const guestClosed = nextSocketClose(guestConnection.socket);
    const kicked = await applyRoomCommand(stub, {
      type: "KICK_GUEST",
      credential: created.hostToken
    });

    expect(kicked.room.lifecycle).toBe("lobby");
    expect(kicked.room.seats.guest.occupied).toBe(false);
    await expect(guestClosed).resolves.toBeUndefined();

    const staleCompletion = await receiveGeneratedProviderItemForTest(
      stub,
      staleTarget,
      {
        item_title: "round two mouse",
        category: "Amazon",
        context_clue: "Amazon price for \"round two mouse\"",
        true_value: 88.88,
        scraped_items: [{ title: "round two mouse", price: 88.88 }],
        amazon_url: "https://www.amazon.com/s?k=round%20two%20mouse"
      },
      joined.guestToken
    );

    expect(staleCompletion.ok).toBe(false);

    if (staleCompletion.ok) {
      throw new Error("Expected stale custom Amazon completion to fail.");
    }

    expect(staleCompletion.status).toBe(HTTP_CONFLICT_STATUS);
    expect(staleCompletion.error).toEqual({
      code: "invalid_game_phase",
      message: "Custom Amazon generation is no longer pending."
    });
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([]);

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room).toEqual(kicked.room);
  });

  it("waits for custom Amazon item submission after retrying a custom-query generation error", async () => {
    const stub = roomStub(CUSTOM_AMAZON_RETRY_ROOM_NAME);
    const created = await createRoom(stub, "Host", {
      mode: "Amazon",
      customAmazonQuery: true,
      totalRounds: 1
    });

    if (!created.created) {
      throw new Error("Expected a newly created custom Amazon retry room.");
    }

    const joined = await joinRoom(stub, "Guest");
    const guestConnection = await openRoomSocket(stub, joined.guestToken);
    const started = await applyRoomCommandWithoutTrueValue(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });

    expect(started.room.game.phase).toBe("generatingItem");
    expect(started.room.game.mode).toBe("Amazon");
    expect(started.room.game.customAmazonQuery).toBe(true);
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([]);

    await recordTestItemGenerationFailure(stub, "Custom lookup timed out.");

    const failed = await accessRoom(stub, created.hostToken);

    expect(failed.room.game.phase).toBe("error");

    if (failed.room.game.phase !== "error") {
      throw new Error("Expected custom Amazon item generation failure.");
    }

    expect(failed.room.game.previousPhase).toBe("generatingItem");
    expect(failed.room.game.mode).toBe("Amazon");
    expect(failed.room.game.customAmazonQuery).toBe(true);

    const retried = await applyRoomCommandWithoutTrueValue(stub, {
      type: "RETRY_ITEM_GENERATION",
      credential: created.hostToken
    });

    expect(retried.room.lifecycle).toBe("active");
    expect(retried.room.game.phase).toBe("generatingItem");
    expect(retried.room.game.mode).toBe("Amazon");
    expect(retried.room.game.customAmazonQuery).toBe(true);
    expect(retried.room.revision).toBe(failed.room.revision + 1);
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([]);

    const customResponse = await postRoomCustomAmazonItem(
      stub,
      created.hostToken,
      "wireless mouse"
    );
    const custom = await expectPublicJsonWithoutTrueValue<CustomAmazonItemResponse>(customResponse);

    expect(customResponse.status).toBe(HTTP_OK_STATUS);
    expect(custom.room.game.phase).toBe("proposingWidth");

    if (custom.room.game.phase !== "proposingWidth") {
      throw new Error("Expected custom Amazon retry item to be ready.");
    }

    expect(custom.room.game.item).toMatchObject({
      category: "Amazon",
      context_clue: "Amazon price for \"wireless mouse\"",
      item_title: "wireless mouse"
    });
    expect("true_value" in custom.room.game.item).toBe(false);
    await expect(privateGeneratedItemKeys(stub)).resolves.toEqual([
      privateGeneratedItemStorageKey(custom.room.game.item.round_id)
    ]);

    guestConnection.socket.close();
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

  it("sends ROOM_ERROR for WebSocket START_ROOM when a joined guest is offline", async () => {
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

    const errorMessage = nextSocketMessage<RoomSocketMessage>(hostConnection.socket);

    hostConnection.socket.send(JSON.stringify(withTestCommandId({
      type: "START_ROOM",
      credential: created.hostToken
    })));

    await expect(errorMessage).resolves.toMatchObject({
      type: "ROOM_ERROR",
      error: {
        code: "player_offline"
      }
    });

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room.lifecycle).toBe("lobby");
    expect(persisted.room.game.phase).toBe("setup");
    expect(persisted.room.revision).toBe(joined.room.revision);
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

    const replacementStartResponse = await postRoomCommand(stub, {
      type: "START_ROOM",
      credential: created.hostToken
    });
    const replacementStart = await expectPublicJson<RoomErrorResponse>(replacementStartResponse);

    expect(replacementStartResponse.status).toBe(HTTP_CONFLICT_STATUS);
    expect(replacementStart.error.code).toBe("player_offline");

    const afterReplacementStart = await accessRoom(stub, created.hostToken);

    expect(afterReplacementStart.room.lifecycle).toBe("lobby");
    expect(afterReplacementStart.room.game.phase).toBe("setup");
    expect(afterReplacementStart.room.revision).toBe(secondGuest.room.revision);
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

  it("uses guest socket presence for non-final and final round advancement", async () => {
    const stub = roomStub(ADVANCE_PRESENCE_ROOM_NAME);
    const created = await createRoom(stub, "Host", { totalRounds: 2 });

    if (!created.created) {
      throw new Error("Expected a newly created advance presence room.");
    }

    const joined = await joinRoom(stub, "Guest");
    let guestConnection = await openRoomSocket(stub, joined.guestToken);

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

    const rejectedAdvanceResponse = await postRoomCommand(stub, {
      type: "ADVANCE_ROUND",
      credential: created.hostToken
    });
    const rejectedAdvance = await expectPublicJson<RoomErrorResponse>(rejectedAdvanceResponse);

    expect(rejectedAdvanceResponse.status).toBe(HTTP_CONFLICT_STATUS);
    expect(rejectedAdvance.error.code).toBe("player_offline");

    const afterRejectedAdvance = await accessRoom(stub, created.hostToken);

    expect(afterRejectedAdvance.room.game.phase).toBe("settlement");
    expect(afterRejectedAdvance.room.revision).toBe(firstSettlement.revision);
    expectRoomPresence(afterRejectedAdvance.room, { A: false, B: false });

    guestConnection = await openRoomSocket(stub, joined.guestToken);

    expect(guestConnection.initial).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(firstSettlement, { A: false, B: true })
    });

    const advanced = await applyRoomCommandWithoutTrueValue(stub, {
      type: "ADVANCE_ROUND",
      credential: created.hostToken
    });

    expect(advanced.room.game.phase).toBe("proposingWidth");
    expect(advanced.room.game.roundNumber).toBe(2);
    expectRoomPresence(advanced.room, { A: false, B: true });

    const finalSettlement = await settleCurrentRound(
      stub,
      advanced.room,
      created.hostToken,
      joined.guestToken
    );

    expect(finalSettlement.game.phase).toBe("settlement");
    expect(finalSettlement.game.roundNumber).toBe(2);

    guestConnection.socket.close();

    await waitForRoomPresence(stub, created.hostToken, { A: false, B: false });

    const finished = await applyRoomCommand(stub, {
      type: "ADVANCE_ROUND",
      credential: created.hostToken
    });

    expect(finished.room.lifecycle).toBe("finished");
    expect(finished.room.game.phase).toBe("gameOver");
    expectRoomPresence(finished.room, { A: false, B: false });
  });

  it("sends ROOM_ERROR for WebSocket ADVANCE_ROUND when Player B disconnects before a non-final advance", async () => {
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

    const errorMessage = nextSocketMessage<RoomSocketMessage>(hostConnection.socket);

    hostConnection.socket.send(JSON.stringify(withTestCommandId({
      type: "ADVANCE_ROUND",
      credential: created.hostToken
    })));

    await expect(errorMessage).resolves.toMatchObject({
      type: "ROOM_ERROR",
      error: {
        code: "player_offline"
      }
    });

    const persisted = await accessRoom(stub, created.hostToken);

    expect(persisted.room.game.phase).toBe("settlement");
    expect(persisted.room.revision).toBe(firstSettlement.revision);
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
});

function roomStub(roomName: string) {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomName));
}

type MutableWorkerItemProviderEnv = {
  GEMINI_API_KEY?: string;
  WORKER_ITEM_PROVIDER?: "deterministic" | "gemini";
};

type WorkerItemProviderEnvSnapshot = Readonly<{
  geminiApiKey: MutableWorkerItemProviderEnv["GEMINI_API_KEY"];
  workerItemProvider: MutableWorkerItemProviderEnv["WORKER_ITEM_PROVIDER"];
}>;

async function withMissingGeminiItemProvider<T>(
  stub: GameRoomStub,
  run: () => Promise<T>
): Promise<T> {
  const previous = await setDurableObjectItemProviderEnv(stub, {
    geminiApiKey: undefined,
    workerItemProvider: "gemini"
  });

  try {
    return await run();
  } finally {
    await setDurableObjectItemProviderEnv(stub, previous);
  }
}

async function setDurableObjectItemProviderEnv(
  stub: GameRoomStub,
  next: WorkerItemProviderEnvSnapshot
): Promise<WorkerItemProviderEnvSnapshot> {
  return runInDurableObject(stub, (instance) => {
    const mutableEnv = (instance as unknown as { env: MutableWorkerItemProviderEnv }).env;
    const previous = {
      geminiApiKey: mutableEnv.GEMINI_API_KEY,
      workerItemProvider: mutableEnv.WORKER_ITEM_PROVIDER
    };

    mutableEnv.GEMINI_API_KEY = next.geminiApiKey;
    mutableEnv.WORKER_ITEM_PROVIDER = next.workerItemProvider;

    return previous;
  });
}

function customAmazonGenerationTargetFor(
  room: PublicRoomSnapshot
): TestPendingItemGeneration {
  if (room.lifecycle !== "active" || room.game.phase !== "generatingItem") {
    throw new Error("Expected a pending custom Amazon generation room.");
  }

  return {
    roomId: room.id,
    revision: room.revision,
    roundNumber: room.game.roundNumber,
    mode: room.game.mode,
    customAmazonQuery: room.game.customAmazonQuery === true
  };
}

async function receiveGeneratedProviderItemForTest(
  stub: GameRoomStub,
  target: TestPendingItemGeneration,
  providerItem: ProviderGeneratedItem,
  credential: RoomCapabilityToken
): Promise<TestStoredRoomCommandResult> {
  return runInDurableObject(stub, async (instance) => {
    return (instance as unknown as {
      receiveGeneratedProviderItem(
        target: TestPendingItemGeneration,
        providerItem: ProviderGeneratedItem,
        nowMs: number,
        credential: RoomCapabilityToken,
        verifyToken: () => boolean
      ): Promise<TestStoredRoomCommandResult>;
    }).receiveGeneratedProviderItem(
      target,
      providerItem,
      Date.now(),
      credential,
      () => true
    );
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

async function recordTestItemGenerationFailure(
  stub: GameRoomStub,
  error: string
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const nowMs = Date.now();
    const loaded = loadPersistenceEnvelope(
      await state.storage.get<unknown>(TEST_ROOM_STORAGE_KEY),
      nowMs
    );

    if (!loaded.ok) {
      throw new Error(`Expected loadable room envelope: ${loaded.error.code}`);
    }

    const result = dispatchSystemRoomEvent(
      loaded.room,
      {
        type: "ITEM_FAILED",
        error,
        nowMs
      }
    );

    if (!result.ok) {
      throw new Error(`Expected item generation failure to apply: ${result.error.code}`);
    }

    await state.storage.put(
      TEST_ROOM_STORAGE_KEY,
      JSON.parse(JSON.stringify(toPersistenceEnvelope(result.room, nowMs))) as unknown
    );
    await state.storage.setAlarm(roomExpiresAtMs(result.room));
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
        presence: { players: { A: true, B: true } },
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
  // Player-entered queries are the product default, but most worker flows
  // here assume server-generated items (no query wait, unswapped roles), so
  // default test rooms to aiGenerated unless a test opts into custom queries.
  const effectiveConfig: CreateRoomConfig = {
    ...(config?.customAmazonQuery === true ? {} : { aiGenerated: true }),
    ...config
  };
  const response = await stub.fetch(GAME_ROOM_SMOKE_URL, {
    body: JSON.stringify({
      hostName,
      config: effectiveConfig
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
  customAmazonQuery?: boolean;
  aiGenerated?: boolean;
}>;

async function postRoomCustomAmazonItem(
  stub: GameRoomStub,
  credential: RoomCapabilityToken,
  query: string
): Promise<Response> {
  return stub.fetch(ROOM_CUSTOM_AMAZON_ITEM_URL, {
    body: JSON.stringify({ credential, query }),
    method: "POST"
  });
}

async function postPublicCustomAmazonItem(
  roomId: string,
  credential: RoomCapabilityToken,
  query: string
): Promise<Response> {
  return postPublicCustomAmazonItemBody(roomId, { credential, query });
}

async function postPublicCustomAmazonItemBody(
  roomId: string,
  body: unknown,
  cfConnectingIp?: string
): Promise<Response> {
  return fetchPublicWorker(new Request(`${PUBLIC_ROOMS_URL}/${roomId}/custom-amazon-item`, {
    body: JSON.stringify(body),
    headers: {
      ...(cfConnectingIp === undefined ? {} : { "cf-connecting-ip": cfConnectingIp }),
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
