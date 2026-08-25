import {
  ABANDONED_ROOM_TTL_MS,
  FINISHED_ROOM_TTL_MS,
  createLobbyRoom,
  executeTrade,
  expireRoomTurn,
  isRoomExpired,
  joinRoom,
  loadPersistenceEnvelope,
  parseCapabilityToken,
  parseRoomId,
  parseTokenHash,
  receiveRoomItem,
  receiveRoomSettlement,
  roomExpiresAtMs,
  startRoom,
  submitInitialWidth,
  submitMarketQuote,
  toPersistenceEnvelope,
  tradeOnWidth,
  type PresentedCapabilityToken,
  type RoomCapabilityToken,
  type RoomCommandResult,
  type RoomId,
  type RoomState,
  type TokenHash,
} from "./index";

const NOW_MS = 40_000;
const ROOM_ID_VALUE = "room_persist_0001";
const HOST_SECRET = "host_secret_300000000001";
const GUEST_SECRET = "guest_secret_300000000001";

describe("room persistence", () => {
  it("round-trips private persistence envelopes without public snapshot assumptions", () => {
    const { room, hostToken, guestToken } = joinedRoom();
    const envelope = toPersistenceEnvelope(room, NOW_MS + 2);
    const loaded = loadPersistenceEnvelope(envelope, envelope.expiresAtMs - 1);

    expect(envelope.room.host.tokenHash).toBe(hashFor(hostToken));
    expect(envelope.room.guest?.tokenHash).toBe(hashFor(guestToken));
    expect(loaded).toEqual({ ok: true, room });
  });

  it("round-trips host-only lobby persistence before a guest joins", () => {
    const roomId = mustRoomId("room_persist_empty");
    const hostToken = mustToken("host", HOST_SECRET, roomId);
    const room = createLobbyRoom({
      id: roomId,
      hostName: "Ada",
      hostTokenHash: hashFor(hostToken),
      nowMs: NOW_MS,
    });
    const envelope = toPersistenceEnvelope(room, NOW_MS + 2);

    expect(loadPersistenceEnvelope(envelope, envelope.expiresAtMs - 1)).toEqual({
      ok: true,
      room,
    });
  });

  it("expires abandoned rooms at the two-hour boundary", () => {
    const { room } = joinedRoom();
    const expectedExpiry = room.updatedAtMs + ABANDONED_ROOM_TTL_MS;

    expect(roomExpiresAtMs(room)).toBe(expectedExpiry);
    expect(isRoomExpired(room, expectedExpiry - 1)).toBe(false);
    expect(isRoomExpired(room, expectedExpiry)).toBe(true);
  });

  it("expires finished rooms at the fifteen-minute boundary", () => {
    const { room } = joinedRoom();
    const finishedRoom: RoomState = {
      ...room,
      lifecycle: "finished",
      updatedAtMs: NOW_MS + 10,
    };
    const expectedExpiry = finishedRoom.updatedAtMs + FINISHED_ROOM_TTL_MS;

    expect(roomExpiresAtMs(finishedRoom)).toBe(expectedExpiry);
    expect(isRoomExpired(finishedRoom, expectedExpiry - 1)).toBe(false);
    expect(isRoomExpired(finishedRoom, expectedExpiry)).toBe(true);
  });

  it("rejects expired persistence envelopes", () => {
    const { room } = joinedRoom();
    const envelope = toPersistenceEnvelope(room, NOW_MS + 2);

    expect(loadPersistenceEnvelope(envelope, envelope.expiresAtMs)).toEqual({
      ok: false,
      error: {
        code: "persistence_expired",
        message: "Room persistence envelope has expired.",
      },
    });
  });

  it("rejects persistence envelopes whose expiry does not match the room lifecycle", () => {
    const { room } = joinedRoom();
    const envelope = toPersistenceEnvelope(room, NOW_MS + 2);

    expect(loadPersistenceEnvelope(
      {
        ...envelope,
        expiresAtMs: envelope.expiresAtMs + 1,
      },
      envelope.expiresAtMs - 1,
    )).toEqual({
      ok: false,
      error: {
        code: "persistence_invalid",
        message: "Room persistence envelope is invalid.",
      },
    });
  });

  it("rejects unsupported persistence versions", () => {
    const { room } = joinedRoom();
    const envelope = toPersistenceEnvelope(room, NOW_MS + 2);

    // Only the current version (5) is supported: the v1→v3 migration chain
    // was deleted with the v4 hard cutover, and v5 dropped the persistable
    // provider-failure phases/keys, so every older envelope fails decode
    // and the room self-heals as never-created. A future version this build
    // predates is likewise rejected.
    for (const badVersion of [6, 4, 3, 2, 1, 0, -1]) {
      expect(loadPersistenceEnvelope({ ...envelope, version: badVersion }, envelope.expiresAtMs - 1)).toEqual({
        ok: false,
        error: {
          code: "persistence_version_unsupported",
          message: "Room persistence version is not supported.",
        },
      });
    }
  });

  it("rejects malformed persistence envelopes without returning private room state", () => {
    const { room } = joinedRoom();
    const envelope = toPersistenceEnvelope(room, NOW_MS + 2);

    expect(loadPersistenceEnvelope({ ...envelope, kind: "wrong.kind" }, envelope.expiresAtMs - 1)).toEqual({
      ok: false,
      error: {
        code: "persistence_invalid",
        message: "Room persistence envelope is invalid.",
      },
    });
    expect(loadPersistenceEnvelope(
      {
        ...envelope,
        room: {
          ...room,
          id: "not valid",
        },
      },
      envelope.expiresAtMs - 1,
    )).toEqual({
      ok: false,
      error: {
        code: "persistence_invalid",
        message: "Room persistence envelope is invalid.",
      },
    });
  });

  it("rejects persisted game states with unexpected private phase fields", () => {
    const { room, hostToken } = joinedRoom();
    const active = expectOk(
      startRoom(room, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 2,
      }),
    );
    const envelope = toPersistenceEnvelope(active, NOW_MS + 3);

    expect(loadPersistenceEnvelope(
      {
        ...envelope,
        room: {
          ...active,
          game: {
            ...active.game,
            item: {
              true_value: 1_000,
            },
          },
        },
      },
      envelope.expiresAtMs - 1,
    )).toEqual({
      ok: false,
      error: {
        code: "persistence_invalid",
        message: "Room persistence envelope is invalid.",
      },
    });
  });

  // Phase 3 (synchronous settlement) + v5 cutover: `generatingItem`,
  // `settling`, and `error` are no longer persistable phases at all. A
  // committed room never carries them, so a planted envelope that does is
  // rejected outright - and, being un-decodable, purges on first touch
  // (see the worker-level cutover regression for the end-to-end purge).
  it("rejects transient-only generatingItem and settling phases, and the retired error phase", () => {
    const { room, hostToken, guestToken } = joinedRoom();
    const settling = settlingRoomChosen(room, hostToken, guestToken);
    const settlingEnvelope = toPersistenceEnvelope(settling, NOW_MS + 12);

    expect(settling.game.phase).toBe("settling");

    expect(loadPersistenceEnvelope(settlingEnvelope, settlingEnvelope.expiresAtMs - 1)).toEqual({
      ok: false,
      error: {
        code: "persistence_invalid",
        message: "Room persistence envelope is invalid.",
      },
    });

    const started = startRoom(room, {
      credential: present(hostToken),
      verifyToken,
      nowMs: NOW_MS + 2,
    });

    if (!started.ok) {
      throw new Error(started.error.message);
    }

    const generatingEnvelope = toPersistenceEnvelope(
      normalizeForPersistence(started.room),
      NOW_MS + 3,
    );

    expect(started.room.game.phase).toBe("generatingItem");
    expect(loadPersistenceEnvelope(generatingEnvelope, generatingEnvelope.expiresAtMs - 1)).toEqual({
      ok: false,
      error: {
        code: "persistence_invalid",
        message: "Room persistence envelope is invalid.",
      },
    });

    const errorGame = {
      ...normalizeForPersistence(started.room).game,
      phase: "error",
      error: "stale failure",
      previousPhase: "generatingItem",
    };
    const errorEnvelope = toPersistenceEnvelope(
      { ...started.room, game: errorGame },
      NOW_MS + 4,
    );

    expect(loadPersistenceEnvelope(errorEnvelope, errorEnvelope.expiresAtMs - 1)).toEqual({
      ok: false,
      error: {
        code: "persistence_invalid",
        message: "Room persistence envelope is invalid.",
      },
    });
  });

  it("round-trips a forced settlement (F-06) with forcedByTimeout intact", () => {
    const { room, hostToken, guestToken } = joinedRoom();
    const settling = settlingRoomForcedByTimeout(room, hostToken, guestToken);

    if (settling.game.phase !== "settling") {
      throw new Error("Expected settling phase.");
    }

    const settled = normalizeForPersistence(
      expectOk(
        receiveRoomSettlement(
          settling,
          { ...settling.game.item, true_value: 3600 },
          NOW_MS + 9,
        ),
      ),
    );

    expect(settled.game.phase).toBe("settlement");

    if (settled.game.phase !== "settlement") {
      throw new Error("Expected settlement phase.");
    }
    expect(settled.game.settlement.forcedByTimeout).toBe(true);

    const envelope = toPersistenceEnvelope(settled, NOW_MS + 12);

    expect(loadPersistenceEnvelope(envelope, envelope.expiresAtMs - 1)).toEqual({
      ok: true,
      room: settled,
    });
  });

  it("rejects a settlement whose forcedByTimeout is missing or not a boolean", () => {
    const { room, hostToken, guestToken } = joinedRoom();
    const settling = settlingRoomForcedByTimeout(room, hostToken, guestToken);

    if (settling.game.phase !== "settling") {
      throw new Error("Expected settling phase.");
    }

    const settled = normalizeForPersistence(
      expectOk(
        receiveRoomSettlement(
          settling,
          { ...settling.game.item, true_value: 3600 },
          NOW_MS + 9,
        ),
      ),
    );

    if (settled.game.phase !== "settlement") {
      throw new Error("Expected settlement phase.");
    }

    const envelope = toPersistenceEnvelope(settled, NOW_MS + 12);

    const settlementWithoutForcedByTimeout: Record<string, unknown> = {
      ...settled.game.settlement,
    };
    delete settlementWithoutForcedByTimeout.forcedByTimeout;

    for (const badSettlement of [
      // forcedByTimeout entirely missing.
      settlementWithoutForcedByTimeout,
      // forcedByTimeout present but the wrong type.
      { ...settled.game.settlement, forcedByTimeout: "true" },
    ]) {
      expect(loadPersistenceEnvelope(
        {
          ...envelope,
          room: {
            ...settled,
            game: {
              ...settled.game,
              settlement: badSettlement,
            },
          },
        },
        envelope.expiresAtMs - 1,
      )).toEqual({
        ok: false,
        error: {
          code: "persistence_invalid",
          message: "Room persistence envelope is invalid.",
        },
      });
    }
  });
});


/**
 * The reducer explicitly sets `lastError: undefined` on most transitions
 * (an own key with an undefined value), which real Durable Object storage
 * silently drops on write (structured-clone semantics, like JSON) but which
 * survives untouched on an in-memory object. hasOnlyKeys checks the actual
 * own keys, so a raw in-memory round-trip of these states spuriously fails
 * where storage-backed persistence would not. Mirrors how the worker test
 * suite's own forcePastTurnDeadline works around the identical gap
 * (JSON.parse(JSON.stringify(...)) before persisting).
 */
function normalizeForPersistence<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function omitKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const clone: Partial<T> = { ...value };

  delete clone[key];

  return clone as Omit<T, K>;
}

function settlingRoomChosen(
  room: RoomState,
  hostToken: RoomCapabilityToken,
  guestToken: RoomCapabilityToken,
): RoomState & { game: Extract<RoomState["game"], { phase: "settling" }> } {
  const started = expectOk(
    startRoom(room, { credential: present(hostToken), verifyToken, nowMs: NOW_MS + 2 }),
  );
  const item = {
    round_id: "round-persist-settling",
    item_title: "Widget",
    category: "Chaos Quant",
    context_clue: "A test item.",
  };
  const withItem = expectOk(receiveRoomItem(started, item, NOW_MS + 3));
  const width = expectOk(
    submitInitialWidth(withItem, 200, { credential: present(hostToken), verifyToken, nowMs: NOW_MS + 4 }),
  );
  const configuring = expectOk(
    tradeOnWidth(width, { credential: present(guestToken), verifyToken, nowMs: NOW_MS + 5 }),
  );
  const choosing = expectOk(
    submitMarketQuote(configuring, { bid: 3500, ask: 3700 }, {
      credential: present(hostToken),
      verifyToken,
      nowMs: NOW_MS + 6,
    }),
  );
  const settling = normalizeForPersistence(
    expectOk(
      executeTrade(choosing, "BUY", { credential: present(guestToken), verifyToken, nowMs: NOW_MS + 7 }),
    ),
  );

  if (settling.game.phase !== "settling") {
    throw new Error("Expected settling phase.");
  }

  return settling as RoomState & { game: Extract<RoomState["game"], { phase: "settling" }> };
}

function settlingRoomForcedByTimeout(
  room: RoomState,
  hostToken: RoomCapabilityToken,
  guestToken: RoomCapabilityToken,
): RoomState & { game: Extract<RoomState["game"], { phase: "settling" }> } {
  const started = expectOk(
    startRoom(room, { credential: present(hostToken), verifyToken, nowMs: NOW_MS + 2 }),
  );
  const item = {
    round_id: "round-persist-forced-settling",
    item_title: "Widget",
    category: "Chaos Quant",
    context_clue: "A test item.",
  };
  const withItem = expectOk(receiveRoomItem(started, item, NOW_MS + 3));
  const width = expectOk(
    submitInitialWidth(withItem, 200, { credential: present(hostToken), verifyToken, nowMs: NOW_MS + 4 }),
  );
  const configuring = expectOk(
    tradeOnWidth(width, { credential: present(guestToken), verifyToken, nowMs: NOW_MS + 5 }),
  );
  const choosing = expectOk(
    submitMarketQuote(configuring, { bid: 3600, ask: 3800 }, {
      credential: present(hostToken),
      verifyToken,
      nowMs: NOW_MS + 6,
    }),
  );
  const settling = normalizeForPersistence(expectOk(expireRoomTurn(choosing, NOW_MS + 7)));

  if (settling.game.phase !== "settling") {
    throw new Error("Expected settling phase.");
  }

  return settling as RoomState & { game: Extract<RoomState["game"], { phase: "settling" }> };
}






function joinedRoom(): {
  room: RoomState;
  hostToken: RoomCapabilityToken;
  guestToken: RoomCapabilityToken;
} {
  const roomId = mustRoomId(ROOM_ID_VALUE);
  const hostToken = mustToken("host", HOST_SECRET, roomId);
  const guestToken = mustToken("guest", GUEST_SECRET, roomId);
  const lobby = createLobbyRoom({
    id: roomId,
    hostName: "Ada",
    hostTokenHash: hashFor(hostToken),
    nowMs: NOW_MS,
  });
  const joined = expectOk(
    joinRoom(lobby, {
      guestName: "Grace",
      guestTokenHash: hashFor(guestToken),
      nowMs: NOW_MS + 1,
    }),
  );

  return { room: joined, hostToken, guestToken };
}


function mustRoomId(value: string): RoomId {
  const result = parseRoomId(value);

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.roomId;
}

function mustToken(
  role: RoomCapabilityToken["role"],
  secret: string,
  roomId: RoomId,
): RoomCapabilityToken {
  const result = parseCapabilityToken({ roomId, role, secret });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.token;
}

function hashFor(token: RoomCapabilityToken): TokenHash {
  const result = parseTokenHash(`hash:${token.role}:${token.roomId}:${token.secret}`);

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.tokenHash;
}

const verifyToken = (token: RoomCapabilityToken, expectedHash: TokenHash): boolean =>
  hashFor(token) === expectedHash;

function present(token: RoomCapabilityToken): PresentedCapabilityToken {
  return {
    roomId: token.roomId,
    role: token.role,
    secret: token.secret,
  };
}

function expectOk(result: RoomCommandResult): RoomState {
  expect(result.ok).toBe(true);

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.room;
}
