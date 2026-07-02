import type { GeneratedItem, SettledGeneratedItem } from "../game/types";
import {
  createLobbyRoom,
  executeTrade,
  joinRoom,
  receiveRoomItem,
  startRoom,
  submitInitialWidth,
  submitMarketQuote,
  tradeOnWidth,
} from "./commands";
import { dispatchRoomCommand, dispatchSystemRoomEvent } from "./dispatcher";
import { parseRoomId, type RoomId } from "./ids";
import {
  parseClientRoomCommand,
  type ClientRoomCommand,
  type SystemRoomEvent,
} from "./protocol";
import {
  parseCapabilityToken,
  parseTokenHash,
  type PresentedCapabilityToken,
  type RoomCapabilityToken,
  type TokenHash,
  type TokenVerifier,
} from "./tokens";
import type { RoomCommandResult, RoomPresence, RoomState, UnixTimeMs } from "./types";

const NOW_MS = 40_000;
const ROOM_ID_VALUE = "room_dispatch_0001";
const HOST_SECRET = "host_secret_dispatch_0001";
const GUEST_SECRET = "guest_secret_dispatch_0001";
const LIVE_PRESENCE = {
  players: {
    A: true,
    B: true,
  },
} satisfies RoomPresence;
const GUEST_OFFLINE_PRESENCE = {
  players: {
    A: true,
    B: false,
  },
} satisfies RoomPresence;

const item: GeneratedItem = {
  round_id: "round-dispatch-1",
  item_title: "Meters in a kilometer",
  category: "Fermi Math & Geometry",
  context_clue: "Metric unit conversion.",
};

describe("room dispatcher", () => {
  it("dispatches decoded join, configure, and start commands", () => {
    const { room, hostToken, guestToken } = lobbyRoom();
    const guestTokenHash = hashFor(guestToken);
    const joined = expectOk(
      dispatchRoomCommand(
        room,
        mustClientCommand(
          {
            type: "JOIN_ROOM",
            guestName: "Grace",
            guestTokenHash,
          },
          NOW_MS + 1,
        ),
        dispatchContext(LIVE_PRESENCE),
      ),
    );
    const configured = expectOk(
      dispatchRoomCommand(
        joined,
        mustClientCommand(
          {
            type: "CONFIGURE_ROOM",
            credential: present(hostToken),
            config: { totalRounds: 1 },
          },
          NOW_MS + 2,
        ),
        dispatchContext(LIVE_PRESENCE),
      ),
    );
    const started = expectOk(
      dispatchRoomCommand(
        configured,
        mustClientCommand(
          {
            type: "START_ROOM",
            credential: present(hostToken),
          },
          NOW_MS + 3,
        ),
        dispatchContext(LIVE_PRESENCE),
      ),
    );

    expect(joined.guest?.displayName).toBe("Grace");
    expect(joined.guest?.tokenHash).toBe(guestTokenHash);
    expect(configured.config.totalRounds).toBe(1);
    expect(started.lifecycle).toBe("active");
    expect(started.game.phase).toBe("generatingItem");
    expect(started.revision).toBe(room.revision + 3);
  });

  it("preserves room state when dispatch receives wrong credentials", () => {
    const { room, guestToken } = joinedRoom();
    const result = dispatchRoomCommand(
      room,
      mustClientCommand(
        {
          type: "CONFIGURE_ROOM",
          credential: present(guestToken),
          config: { totalRounds: 2 },
        },
        NOW_MS + 2,
      ),
      dispatchContext(LIVE_PRESENCE),
    );

    expect(result.ok).toBe(false);

    if (result.ok) {
      throw new Error("Expected dispatch failure.");
    }

    expect(result.room).toBe(room);
    expect(result.error).toEqual({
      code: "host_control_denied",
      message: "Only the host can perform this room command.",
    });
  });

  it("rejects start dispatch when Player B is offline in command context", () => {
    const { room, hostToken } = joinedRoom();
    const result = dispatchRoomCommand(
      room,
      mustClientCommand(
        {
          type: "START_ROOM",
          credential: present(hostToken),
        },
        NOW_MS + 2,
      ),
      dispatchContext(GUEST_OFFLINE_PRESENCE),
    );

    expect(result).toEqual({
      ok: false,
      room,
      error: {
        code: "player_offline",
        message: "Player B must be connected before the room can continue.",
      },
    });
  });

  it("ignores runtime settlement fields and computes settlement server-side", () => {
    const { room } = settlingRoom();
    const event = {
      type: "SETTLEMENT_RECEIVED",
      item: settledItemFor(room.game, 1_200),
      nowMs: NOW_MS + 10,
      settlement: {
        traderPnL: 9_999,
        marketMakerPnL: -9_999,
      },
    } as SystemRoomEvent & Readonly<{ settlement: Record<string, number> }>;
    const settled = expectOk(dispatchSystemRoomEvent(room, event));

    expect(settled.game.phase).toBe("settlement");

    if (settled.game.phase !== "settlement") {
      throw new Error("Expected settlement phase.");
    }

    expect(settled.game.settlement.traderPnL).toBe(100);
    expect(settled.game.settlement.marketMakerPnL).toBe(-100);
    expect(settled.game.scores).toEqual({ A: -100, B: 100 });
  });

  it("dispatches retry item generation after an item failure", () => {
    const { room, hostToken } = activeRoom();
    const failed = expectOk(
      dispatchSystemRoomEvent(room, {
        type: "ITEM_FAILED",
        error: "Provider timed out.",
        nowMs: NOW_MS + 3,
      }),
    );
    const retried = expectOk(
      dispatchRoomCommand(
        failed,
        mustClientCommand(
          {
            type: "RETRY_ITEM_GENERATION",
            credential: present(hostToken),
          },
          NOW_MS + 4,
        ),
        dispatchContext(LIVE_PRESENCE),
      ),
    );

    expect(retried.game.phase).toBe("generatingItem");
    expect(retried.game.lastError).toBeUndefined();
    expect(retried.revision).toBe(failed.revision + 1);
  });
});

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
    submitMarketQuote(configuring, { bid: 900, ask: 1_100 }, {
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
        presence: LIVE_PRESENCE,
        verifyToken,
        nowMs: NOW_MS + 2,
      }),
    ),
    hostToken,
    guestToken,
  };
}

function joinedRoom(): {
  room: RoomState;
  hostToken: RoomCapabilityToken;
  guestToken: RoomCapabilityToken;
} {
  const { room, hostToken, guestToken } = lobbyRoom();
  const joined = expectOk(
    joinRoom(room, {
      guestName: "Grace",
      guestTokenHash: hashFor(guestToken),
      nowMs: NOW_MS + 1,
    }),
  );

  return { room: joined, hostToken, guestToken };
}

function lobbyRoom(): {
  room: RoomState;
  hostToken: RoomCapabilityToken;
  guestToken: RoomCapabilityToken;
} {
  const roomId = mustRoomId(ROOM_ID_VALUE);
  const hostToken = mustToken("host", HOST_SECRET, roomId);
  const guestToken = mustToken("guest", GUEST_SECRET, roomId);
  const room = createLobbyRoom({
    id: roomId,
    hostName: "Ada",
    hostTokenHash: hashFor(hostToken),
    nowMs: NOW_MS,
  });

  return { room, hostToken, guestToken };
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

function mustClientCommand(value: unknown, nowMs: UnixTimeMs): ClientRoomCommand {
  const result = parseClientRoomCommand(value, nowMs);

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.command;
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

function dispatchContext(presence: RoomPresence) {
  return {
    presence,
    verifyToken,
  };
}

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
