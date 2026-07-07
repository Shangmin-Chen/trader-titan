import {
  ABANDONED_ROOM_TTL_MS,
  FINISHED_ROOM_TTL_MS,
  createLobbyRoom,
  executeTrade,
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
  type RoomPresence,
  type RoomState,
  type TokenHash,
} from "./index";

const NOW_MS = 40_000;
const ROOM_ID_VALUE = "room_persist_0001";
const HOST_SECRET = "host_secret_300000000001";
const GUEST_SECRET = "guest_secret_300000000001";
const LIVE_PRESENCE = {
  players: {
    A: true,
    B: true,
  },
} satisfies RoomPresence;

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

    expect(loadPersistenceEnvelope({ ...envelope, version: 2 }, envelope.expiresAtMs - 1)).toEqual({
      ok: false,
      error: {
        code: "persistence_version_unsupported",
        message: "Room persistence version is not supported.",
      },
    });
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
        presence: LIVE_PRESENCE,
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

  it("rejects malformed settled Amazon metadata in persistence envelopes", () => {
    const settled = settledRoomWithAmazonMetadata();
    const envelope = toPersistenceEnvelope(settled, NOW_MS + 12);

    expect(settled.game.phase).toBe("settlement");

    if (settled.game.phase !== "settlement") {
      throw new Error("Expected settled room fixture.");
    }

    for (const itemPatch of [
      { scraped_items: "not an array" },
      { scraped_items: [{ title: "Bad Listing", price: "12.34" }] },
      { scraped_items: [{ title: "Bad Listing", price: 12.34, extra: true }] },
      { amazon_url: 42 },
    ]) {
      expect(loadPersistenceEnvelope(
        {
          ...envelope,
          room: {
            ...settled,
            game: {
              ...settled.game,
              item: {
                ...settled.game.item,
                ...itemPatch,
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
    }
  });
});

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
    // Server-generated items (no player-entered query), so round-1 roles
    // stay marketMaker=A / trader=B as these command flows assume.
    config: { aiGenerated: true },
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

function settledRoomWithAmazonMetadata(): RoomState {
  const { room, hostToken, guestToken } = joinedRoom();
  const started = expectOk(
    startRoom(room, {
      credential: present(hostToken),
      presence: LIVE_PRESENCE,
      verifyToken,
      nowMs: NOW_MS + 2,
    }),
  );
  const item = {
    round_id: "round-amazon-metadata",
    item_title: "Vintage Calculator",
    category: "Amazon",
    context_clue: "Amazon price for \"Vintage Calculator\"",
  };
  const withItem = expectOk(receiveRoomItem(started, item, NOW_MS + 3));
  const width = expectOk(
    submitInitialWidth(withItem, 100, {
      credential: present(hostToken),
      verifyToken,
      nowMs: NOW_MS + 4,
    }),
  );
  const configuring = expectOk(
    tradeOnWidth(width, {
      credential: present(guestToken),
      verifyToken,
      nowMs: NOW_MS + 5,
    }),
  );
  const choosing = expectOk(
    submitMarketQuote(configuring, { bid: 300, ask: 400 }, {
      credential: present(hostToken),
      verifyToken,
      nowMs: NOW_MS + 6,
    }),
  );
  const settling = expectOk(
    executeTrade(choosing, "BUY", {
      credential: present(guestToken),
      verifyToken,
      nowMs: NOW_MS + 7,
    }),
  );

  return expectOk(
    receiveRoomSettlement(
      settling,
      {
        ...item,
        true_value: 349.99,
        scraped_items: [{ title: "Vintage Calculator", price: 349.99 }],
        amazon_url: "https://www.amazon.com/s?k=Vintage%20Calculator",
      },
      NOW_MS + 8,
    ),
  );
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
