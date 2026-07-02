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
import type { GameMode, ProviderGeneratedItem } from "../lib/game";
import {
  ROOM_CREATION_RATE_LIMIT_MAX_REQUESTS,
  ROOM_CUSTOM_AMAZON_RATE_LIMIT_MAX_REQUESTS
} from "../api/request-guards";
import {
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
const GAME_ROOM_SMOKE_URL = "https://trader-titan.worker.test/room";
const ROOM_COMMAND_URL = `${GAME_ROOM_SMOKE_URL}/command`;
const ROOM_JOIN_URL = `${GAME_ROOM_SMOKE_URL}/join`;
const ROOM_CUSTOM_AMAZON_ITEM_URL = `${GAME_ROOM_SMOKE_URL}/custom-amazon-item`;
const ROOM_SOCKET_URL = `${GAME_ROOM_SMOKE_URL}/socket`;
const PUBLIC_ROOMS_URL = "https://trader-titan.worker.test/api/rooms";
const TEST_ROOM_STORAGE_KEY = "room:persistence:v1";
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

    const startResponse = await stub.fetch(ROOM_COMMAND_URL, {
      body: JSON.stringify({
        type: "START_ROOM",
        credential: created.hostToken
      }),
      method: "POST"
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

    guestConnection.socket.send(JSON.stringify({
      type: "RETRY_ITEM_GENERATION",
      credential: joined.guestToken
    }));

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

    const startResponse = await stub.fetch(ROOM_COMMAND_URL, {
      body: JSON.stringify({
        type: "START_ROOM",
        credential: created.hostToken
      }),
      method: "POST"
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
    const widthResponse = await freshStub.fetch(ROOM_COMMAND_URL, {
      body: JSON.stringify({
        type: "SUBMIT_INITIAL_WIDTH",
        credential: created.hostToken,
        width: 100
      }),
      method: "POST"
    });
    const width = await expectPublicJsonWithoutTrueValue<CommandRoomResponse>(widthResponse);

    expect(widthResponse.status).toBe(HTTP_OK_STATUS);
    expect(width.room.game.phase).toBe("negotiatingWidth");

    const tradeOnWidthResponse = await freshStub.fetch(ROOM_COMMAND_URL, {
      body: JSON.stringify({
        type: "TRADE_ON_WIDTH",
        credential: joined.guestToken
      }),
      method: "POST"
    });
    const tradeOnWidth = await expectPublicJsonWithoutTrueValue<CommandRoomResponse>(tradeOnWidthResponse);

    expect(tradeOnWidthResponse.status).toBe(HTTP_OK_STATUS);
    expect(tradeOnWidth.room.game.phase).toBe("configuringMarket");

    const quoteResponse = await freshStub.fetch(ROOM_COMMAND_URL, {
      body: JSON.stringify({
        type: "SUBMIT_MARKET_QUOTE",
        credential: created.hostToken,
        quote: {
          bid: 3500,
          ask: 3600
        }
      }),
      method: "POST"
    });
    const quoted = await expectPublicJsonWithoutTrueValue<CommandRoomResponse>(quoteResponse);

    expect(quoteResponse.status).toBe(HTTP_OK_STATUS);
    expect(quoted.room.game.phase).toBe("choosingSide");

    const settlementResponse = await freshStub.fetch(ROOM_COMMAND_URL, {
      body: JSON.stringify({
        type: "EXECUTE_TRADE",
        credential: joined.guestToken,
        side: "BUY"
      }),
      method: "POST"
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

    const startResponse = await stub.fetch(ROOM_COMMAND_URL, {
      body: JSON.stringify({
        type: "START_ROOM",
        credential: created.hostToken
      }),
      method: "POST"
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

    const firstConnection = await openRoomSocket(stub, created.hostToken);
    const firstHostConnect = nextSocketMessage<RoomSnapshotSocketMessage>(firstConnection.socket);
    const secondConnection = await openRoomSocket(stub, created.hostToken);

    expect(firstConnection.initial).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(created.room, { A: true, B: false })
    });
    expect(secondConnection.initial).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(created.room, { A: true, B: false })
    });
    await expect(firstHostConnect).resolves.toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(created.room, { A: true, B: false })
    });

    const firstJoin = nextSocketMessage<RoomSnapshotSocketMessage>(firstConnection.socket);
    const secondJoin = nextSocketMessage<RoomSnapshotSocketMessage>(secondConnection.socket);
    const joined = await joinRoom(stub, "Guest");

    await expect(firstJoin).resolves.toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: joined.room
    });
    await expect(secondJoin).resolves.toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: joined.room
    });

    const firstGuestConnect = nextSocketMessage<RoomSnapshotSocketMessage>(firstConnection.socket);
    const secondGuestConnect = nextSocketMessage<RoomSnapshotSocketMessage>(secondConnection.socket);
    const guestConnection = await openRoomSocket(stub, joined.guestToken);

    expect(guestConnection.initial).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(joined.room, { A: true, B: true })
    });
    await expect(firstGuestConnect).resolves.toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(joined.room, { A: true, B: true })
    });
    await expect(secondGuestConnect).resolves.toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: roomWithPresence(joined.room, { A: true, B: true })
    });

    const firstStarted = nextSocketMessage<RoomSnapshotSocketMessage>(firstConnection.socket);
    const secondStarted = nextSocketMessage<RoomSnapshotSocketMessage>(secondConnection.socket);
    const guestStarted = nextSocketMessage<RoomSnapshotSocketMessage>(guestConnection.socket);

    firstConnection.socket.send(JSON.stringify({
      type: "START_ROOM",
      credential: created.hostToken
    }));

    const firstStartedMessage = await firstStarted;
    const secondStartedMessage = await secondStarted;
    const guestStartedMessage = await guestStarted;

    expect(firstStartedMessage).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: {
        lifecycle: "active",
        game: {
          phase: "proposingWidth"
        },
        revision: 3
      }
    });
    expect(secondStartedMessage).toMatchObject({
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
    expectRoomPresence(firstStartedMessage.room, { A: true, B: true });
    expectRoomPresence(secondStartedMessage.room, { A: true, B: true });
    expectRoomPresence(guestStartedMessage.room, { A: true, B: true });
    expect(JSON.stringify(firstStartedMessage)).not.toContain("true_value");
    expect(JSON.stringify(secondStartedMessage)).not.toContain("true_value");
    expect(JSON.stringify(guestStartedMessage)).not.toContain("true_value");

    const persisted = await accessRoom(roomStub(SOCKET_COMMAND_ROOM_NAME), created.hostToken);

    expect(persisted.room.lifecycle).toBe("active");
    expect(persisted.room.revision).toBe(3);

    firstConnection.socket.close();
    secondConnection.socket.close();
    guestConnection.socket.close();
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

    hostConnection.socket.send(JSON.stringify({
      type: "START_ROOM",
      credential: created.hostToken
    }));

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
    const kickResponse = await stub.fetch(ROOM_COMMAND_URL, {
      body: JSON.stringify({
        type: "KICK_GUEST",
        credential: created.hostToken
      }),
      method: "POST"
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

    const resetResponse = await stub.fetch(ROOM_COMMAND_URL, {
      body: JSON.stringify({
        type: "RESET_TO_LOBBY",
        credential: created.hostToken
      }),
      method: "POST"
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
    const resetResponse = await stub.fetch(ROOM_COMMAND_URL, {
      body: JSON.stringify({
        type: "RESET_TO_LOBBY",
        credential: created.hostToken
      }),
      method: "POST"
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

    hostConnection.socket.send(JSON.stringify({
      type: "ADVANCE_ROUND",
      credential: created.hostToken
    }));

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function postRoomCommand(
  stub: GameRoomStub,
  command: unknown
): Promise<Response> {
  return stub.fetch(ROOM_COMMAND_URL, {
    body: JSON.stringify(command),
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
