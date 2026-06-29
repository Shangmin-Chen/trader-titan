import type { GeneratedItem, SettledGeneratedItem } from "../game/types";
import {
  advanceRoomRound,
  configureRoom,
  createLobbyRoom,
  executeTrade,
  joinRoom,
  kickGuest,
  parseCapabilityToken,
  parseRoomId,
  parseTokenHash,
  receiveRoomItem,
  receiveRoomSettlement,
  resetRoomToLobby,
  startRoom,
  submitInitialWidth,
  submitMarketQuote,
  tightenWidth,
  tradeOnWidth,
  type PresentedCapabilityToken,
  type RoomCapabilityToken,
  type RoomCommandResult,
  type RoomId,
  type RoomState,
  type TokenHash,
  type TokenVerifier,
} from "./index";

const NOW_MS = 20_000;
const ROOM_ID_VALUE = "room_commands_0001";
const HOST_SECRET = "host_secret_100000000001";
const GUEST_SECRET = "guest_secret_100000000001";
const NEXT_GUEST_SECRET = "guest_secret_100000000002";

const item: GeneratedItem = {
  round_id: "round-commands-1",
  item_title: "Meters in a kilometer",
  category: "Fermi Math & Geometry",
  context_clue: "Metric unit conversion.",
};

describe("room commands", () => {
  it("supports a deterministic happy path from lobby through a finished one-round game", () => {
    const { room, hostToken, guestToken } = joinedRoom();
    const configured = expectOk(
      configureRoom(room, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 2,
        config: { totalRounds: 1 },
      }),
    );
    const started = expectOk(
      startRoom(configured, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 3,
      }),
    );
    const withItem = expectOk(receiveRoomItem(started, item, NOW_MS + 4));
    const opened = expectOk(
      submitInitialWidth(withItem, 500, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 5,
      }),
    );
    const tightened = expectOk(
      tightenWidth(opened, 200, {
        credential: present(guestToken),
        verifyToken,
        nowMs: NOW_MS + 6,
      }),
    );
    const configuring = expectOk(
      tradeOnWidth(tightened, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 7,
      }),
    );
    const choosing = expectOk(
      submitMarketQuote(configuring, { bid: 900, ask: 1100 }, {
        credential: present(guestToken),
        verifyToken,
        nowMs: NOW_MS + 8,
      }),
    );
    const settling = expectOk(
      executeTrade(choosing, "BUY", {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 9,
      }),
    );

    if (settling.game.phase !== "settling") {
      throw new Error("Expected settling phase.");
    }

    const settledItem = settledItemFor(settling.game, 1_200);
    const settled = expectOk(
      receiveRoomSettlement(
        settling,
        settledItem,
        NOW_MS + 10,
      ),
    );
    const finished = expectOk(
      advanceRoomRound(settled, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 11,
      }),
    );

    expect(finished.lifecycle).toBe("finished");
    expect(finished.game.phase).toBe("gameOver");
    expect(finished.game.scores.A + finished.game.scores.B).toBe(0);
  });

  it("computes settlement server-side from the active settling room", () => {
    const { room } = settlingRoom();
    const settled = expectOk(
      receiveRoomSettlement(room, settledItemFor(room.game, 1_200), NOW_MS + 10),
    );

    expect(settled.game.phase).toBe("settlement");

    if (settled.game.phase !== "settlement") {
      throw new Error("Expected settlement phase.");
    }

    expect(settled.game.settlement).toMatchObject({
      roundNumber: room.game.roundNumber,
      itemTitle: item.item_title,
      side: "BUY",
      transactionPrice: 1_100,
      trueValue: 1_200,
      trader: "B",
      marketMaker: "A",
      traderPnL: 100,
      marketMakerPnL: -100,
    });
    expect(settled.game.scores).toEqual({ A: -100, B: 100 });
  });

  it("rejects system events in the wrong active phase without mutating the room", () => {
    const { room, hostToken } = activeRoom();
    const itemFailure = receiveRoomSettlement(
      room,
      {
        ...item,
        true_value: 1_200,
      },
      NOW_MS + 10,
    );
    const earlyAdvance = advanceRoomRound(room, {
      credential: present(hostToken),
      verifyToken,
      nowMs: NOW_MS + 11,
    });

    expect(itemFailure).toEqual({
      ok: false,
      room,
      error: {
        code: "invalid_game_phase",
        message: "Settlements can only be received while the room is settling.",
      },
    });
    expect(earlyAdvance).toEqual({
      ok: false,
      room,
      error: {
        code: "invalid_game_phase",
        message: "Rounds can only advance after settlement.",
      },
    });
  });

  it("keeps a mismatched settlement item in settling without scoring the round", () => {
    const { room } = settlingRoom();
    const mismatchedItem: SettledGeneratedItem = {
      ...item,
      round_id: "different-round",
      true_value: 1_200,
    };
    const result = expectOk(receiveRoomSettlement(room, mismatchedItem, NOW_MS + 10));

    expect(result.game.phase).toBe("settling");
    expect(result.game.scores).toEqual(room.game.scores);
    expect(result.game.lastError).toBe("Settlement did not match the active round.");
    expect(result.revision).toBe(room.revision + 1);
  });

  it("rejects a full guest slot until the host kicks the guest", () => {
    const { room, hostToken } = joinedRoom();
    const nextGuestToken = mustToken("guest", NEXT_GUEST_SECRET, room.id);
    const fullJoin = joinRoom(room, {
      guestName: "Katherine",
      guestTokenHash: hashFor(nextGuestToken),
      nowMs: NOW_MS + 2,
    });

    expect(fullJoin).toEqual({
      ok: false,
      room,
      error: {
        code: "guest_slot_full",
        message: "The guest slot is already occupied.",
      },
    });

    const kicked = expectOk(
      kickGuest(room, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 3,
      }),
    );
    const rejoined = expectOk(
      joinRoom(kicked, {
        guestName: "Katherine",
        guestTokenHash: hashFor(nextGuestToken),
        nowMs: NOW_MS + 4,
      }),
    );

    expect(kicked.guest).toBeNull();
    expect(rejoined.guest?.displayName).toBe("Katherine");
    expect(rejoined.lifecycle).toBe("lobby");
  });

  it("resets an active room back to lobby while freeing the guest slot", () => {
    const { room, hostToken } = activeRoom();
    const reset = expectOk(
      resetRoomToLobby(room, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 5,
      }),
    );

    expect(reset.lifecycle).toBe("lobby");
    expect(reset.guest).toBeNull();
    expect(reset.game.phase).toBe("setup");
    expect(reset.game.players.B.name).toBe("Guest");
    expect(reset.game.roundNumber).toBe(0);
  });

  it("denies unauthorized commands without mutating the room", () => {
    const { room, hostToken, guestToken } = joinedRoom();
    const guestConfigure = configureRoom(room, {
      credential: present(guestToken),
      verifyToken,
      nowMs: NOW_MS + 2,
      config: { totalRounds: 2 },
    });
    const started = expectOk(
      startRoom(room, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 3,
      }),
    );
    const withItem = expectOk(receiveRoomItem(started, item, NOW_MS + 4));
    const opened = expectOk(
      submitInitialWidth(withItem, 500, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 5,
      }),
    );
    const wrongActiveRole = tightenWidth(opened, 200, {
      credential: present(hostToken),
      verifyToken,
      nowMs: NOW_MS + 6,
    });

    expect(guestConfigure).toEqual({
      ok: false,
      room,
      error: {
        code: "host_control_denied",
        message: "Only the host can perform this room command.",
      },
    });
    expect(wrongActiveRole).toEqual({
      ok: false,
      room: opened,
      error: {
        code: "wrong_active_role",
        message: "This command requires Player B.",
      },
    });
  });
});

function activeRoom(): {
  room: RoomState;
  hostToken: RoomCapabilityToken;
  guestToken: RoomCapabilityToken;
} {
  const { room, hostToken, guestToken } = joinedRoom();

  return {
    room: expectOk(
      startRoom(room, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 2,
      }),
    ),
    hostToken,
    guestToken,
  };
}

function settlingRoom(): {
  room: RoomState & { game: Extract<RoomState["game"], { phase: "settling" }> };
  hostToken: RoomCapabilityToken;
  guestToken: RoomCapabilityToken;
} {
  const { room, hostToken, guestToken } = activeRoom();
  const withItem = expectOk(receiveRoomItem(room, item, NOW_MS + 4));
  const opened = expectOk(
    submitInitialWidth(withItem, 200, {
      credential: present(hostToken),
      verifyToken,
      nowMs: NOW_MS + 5,
    }),
  );
  const configuring = expectOk(
    tradeOnWidth(opened, {
      credential: present(guestToken),
      verifyToken,
      nowMs: NOW_MS + 6,
    }),
  );
  const choosing = expectOk(
    submitMarketQuote(configuring, { bid: 900, ask: 1100 }, {
      credential: present(hostToken),
      verifyToken,
      nowMs: NOW_MS + 7,
    }),
  );
  const settling = expectOk(
    executeTrade(choosing, "BUY", {
      credential: present(guestToken),
      verifyToken,
      nowMs: NOW_MS + 8,
    }),
  );

  if (settling.game.phase !== "settling") {
    throw new Error("Expected settling phase.");
  }

  return {
    room: settling as RoomState & { game: Extract<RoomState["game"], { phase: "settling" }> },
    hostToken,
    guestToken,
  };
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

function settledItemFor(
  state: Extract<RoomState["game"], { phase: "settling" }>,
  trueValue: number,
): SettledGeneratedItem {
  return {
    ...state.item,
    true_value: trueValue,
  };
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

const verifyToken: TokenVerifier = (token, expectedHash) => hashFor(token) === expectedHash;

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
