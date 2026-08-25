import {
  ABANDONED_ROOM_TTL_MS,
  FINISHED_ROOM_TTL_MS,
  createLobbyRoom,
  executeTrade,
  expireRoomTurn,
  failRoomSettlement,
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
import { SETTLEMENT_FAILURE_EPISODE_CAP } from "../game/types";

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

    // Only the current version (4) is supported: the v1→v3 migration chain
    // was deleted with the v4 hard cutover, so every older envelope fails
    // decode and the room self-heals as never-created. A future version this
    // build predates is likewise rejected.
    for (const badVersion of [5, 3, 2, 1, 0, -1]) {
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

  // F-07: a `generatingItem` phase - which a fresh round always passes
  // through on its way to a new `choosingSide`/`settling` (see NEXT_ROUND
  // and START_GAME in reducer.ts) - structurally has no
  // settlementFailureCount field of its own. This is what makes "a new
  // round cannot inherit a stale count" true even across a storage
  // round-trip, not just in memory: a persisted envelope that somehow
  // carried one forward for this phase must be rejected outright rather
  // than silently accepted and later read back by a phase that does have
  // the field.
  it("rejects a stray settlementFailureCount smuggled onto a generatingItem phase", () => {
    const { room, hostToken } = joinedRoom();
    // normalizeForPersistence: without this, `active.game.lastError` is an
    // own key with value `undefined` (the reducer sets it explicitly - see
    // that helper's doc comment), which real storage silently drops but a
    // raw in-memory object does not - and hasOnlyKeys would then reject the
    // envelope for that unrelated reason regardless of the mutation this
    // test exists to catch.
    const active = normalizeForPersistence(
      expectOk(
        startRoom(room, {
          credential: present(hostToken),
          verifyToken,
          nowMs: NOW_MS + 2,
        }),
      ),
    );

    expect(active.game.phase).toBe("generatingItem");

    const envelope = toPersistenceEnvelope(active, NOW_MS + 3);

    expect(loadPersistenceEnvelope(
      {
        ...envelope,
        room: {
          ...active,
          game: {
            ...active.game,
            settlementFailureCount: 1,
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

  it("round-trips a settling room with a trader-chosen pendingTrade", () => {
    const { room, hostToken, guestToken } = joinedRoom();
    const settling = settlingRoomChosen(room, hostToken, guestToken);
    const envelope = toPersistenceEnvelope(settling, NOW_MS + 12);

    expect(settling.game.phase).toBe("settling");
    expect(loadPersistenceEnvelope(envelope, envelope.expiresAtMs - 1)).toEqual({
      ok: true,
      room: settling,
    });
  });

  it("round-trips a settling room with an F-06 timeout-forced pendingTrade", () => {
    const { room, hostToken, guestToken } = joinedRoom();
    const settling = settlingRoomForcedByTimeout(room, hostToken, guestToken);
    const envelope = toPersistenceEnvelope(settling, NOW_MS + 12);

    expect(settling.game.phase).toBe("settling");

    if (settling.game.phase !== "settling") {
      throw new Error("Expected settling phase.");
    }
    expect(settling.game.pendingTrade).toEqual({ kind: "timeoutForcedWorstSide" });
    expect(loadPersistenceEnvelope(envelope, envelope.expiresAtMs - 1)).toEqual({
      ok: true,
      room: settling,
    });
  });

  it("rejects a settling room whose pendingTrade carries an unexpected shape", () => {
    const { room, hostToken, guestToken } = joinedRoom();
    const settling = settlingRoomChosen(room, hostToken, guestToken);
    const envelope = toPersistenceEnvelope(settling, NOW_MS + 12);

    for (const badPendingTrade of [
      // "chosen" with an invalid side.
      { kind: "chosen", side: "HOLD" },
      // "chosen" carrying a stray extra field.
      { kind: "chosen", side: "BUY", forced: false },
      // "timeoutForcedWorstSide" must not also carry a side.
      { kind: "timeoutForcedWorstSide", side: "BUY" },
      // Unknown kind entirely.
      { kind: "cancelled" },
    ]) {
      expect(loadPersistenceEnvelope(
        {
          ...envelope,
          room: {
            ...settling,
            game: {
              ...settling.game,
              pendingTrade: badPendingTrade,
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

  describe("F-07 settlement-failure episode counter", () => {
    it("round-trips a settling room's settlementFailureCount", () => {
      const { room, hostToken, guestToken } = joinedRoom();
      const settling = settlingRoomChosen(room, hostToken, guestToken);

      expect(settling.game.settlementFailureCount).toBe(0);

      const envelope = toPersistenceEnvelope(settling, NOW_MS + 12);

      expect(loadPersistenceEnvelope(envelope, envelope.expiresAtMs - 1)).toEqual({
        ok: true,
        room: settling,
      });
    });

    it("rejects a settling room missing settlementFailureCount", () => {
      const { room, hostToken, guestToken } = joinedRoom();
      const settling = settlingRoomChosen(room, hostToken, guestToken);
      const envelope = toPersistenceEnvelope(settling, NOW_MS + 12);

      expect(loadPersistenceEnvelope(
        {
          ...envelope,
          room: {
            ...settling,
            game: omitKey(settling.game, "settlementFailureCount"),
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

    it("rejects a settling room whose settlementFailureCount is out of the valid [0, cap) range", () => {
      const { room, hostToken, guestToken } = joinedRoom();
      const settling = settlingRoomChosen(room, hostToken, guestToken);
      const envelope = toPersistenceEnvelope(settling, NOW_MS + 12);

      for (const badCount of [
        -1,
        1.5,
        SETTLEMENT_FAILURE_EPISODE_CAP,
        SETTLEMENT_FAILURE_EPISODE_CAP + 1,
        "1",
        null,
      ]) {
        expect(loadPersistenceEnvelope(
          {
            ...envelope,
            room: {
              ...settling,
              game: { ...settling.game, settlementFailureCount: badCount },
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

    it("round-trips a locked choosingSide with its paired lockedPendingTrade and settlementFailureCount", () => {
      const { room, hostToken, guestToken } = joinedRoom();
      const settling = settlingRoomChosen(room, hostToken, guestToken);
      const failed = normalizeForPersistence(
        expectOk(failRoomSettlement(settling, "Settlement failed.", NOW_MS + 13)),
      );

      expect(failed.game.phase).toBe("choosingSide");

      if (failed.game.phase !== "choosingSide") {
        throw new Error("Expected locked choosingSide phase.");
      }

      expect(failed.game.lockedPendingTrade).toEqual({ kind: "chosen", side: "BUY" });
      expect(failed.game.settlementFailureCount).toBe(1);

      const envelope = toPersistenceEnvelope(failed, NOW_MS + 14);

      expect(loadPersistenceEnvelope(envelope, envelope.expiresAtMs - 1)).toEqual({
        ok: true,
        room: failed,
      });
    });

    it("rejects a locked choosingSide carrying only one of lockedPendingTrade/settlementFailureCount", () => {
      const { room, hostToken, guestToken } = joinedRoom();
      const settling = settlingRoomChosen(room, hostToken, guestToken);
      const failed = normalizeForPersistence(
        expectOk(failRoomSettlement(settling, "Settlement failed.", NOW_MS + 13)),
      );

      if (failed.game.phase !== "choosingSide") {
        throw new Error("Expected locked choosingSide phase.");
      }

      const envelope = toPersistenceEnvelope(failed, NOW_MS + 14);

      for (const badGame of [
        omitKey(failed.game, "settlementFailureCount"),
        omitKey(failed.game, "lockedPendingTrade"),
      ]) {
        expect(loadPersistenceEnvelope(
          {
            ...envelope,
            room: {
              ...failed,
              game: badGame,
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
