import type { GameState, GeneratedItem, SettledGeneratedItem } from "../game/types";
import {
  createLobbyRoom,
  executeTrade,
  joinRoom,
  parseCapabilityToken,
  parseRoomId,
  parseTokenHash,
  receiveRoomItem,
  receiveRoomSettlement,
  startRoom,
  submitInitialWidth,
  submitMarketQuote,
  toPublicRoomSnapshot,
  tradeOnWidth,
  type PresentedCapabilityToken,
  type RoomCapabilityToken,
  type RoomCommandResult,
  type RoomId,
  type RoomState,
  type TokenHash,
  type TokenVerifier,
} from "./index";

const NOW_MS = 30_000;
const ROOM_ID_VALUE = "room_snapshot_0001";
const HOST_SECRET = "host_secret_200000000001";
const GUEST_SECRET = "guest_secret_200000000001";

const item: GeneratedItem = {
  round_id: "round-snapshot-1",
  item_title: "Liters in a cubic meter",
  category: "Fermi Math & Geometry",
  context_clue: "Metric volume conversion.",
};

describe("room snapshots", () => {
  it("omits raw tokens, token hashes, and persistence fields", () => {
    const { room, hostToken, guestToken } = joinedRoom();
    const snapshotJson = JSON.stringify(toPublicRoomSnapshot(room));

    expect(snapshotJson).not.toContain(hostToken.secret);
    expect(snapshotJson).not.toContain(guestToken.secret);
    expect(snapshotJson).not.toContain(hashFor(hostToken));
    expect(snapshotJson).not.toContain(hashFor(guestToken));
    expect(snapshotJson).not.toContain("tokenHash");
    expect(snapshotJson).not.toContain("persistedAtMs");
    expect(snapshotJson).not.toContain("expiresAtMs");
  });

  it("redacts hidden true_value before settlement even if the game object is polluted", () => {
    const { room, hostToken, guestToken } = startedRoom();
    const withItem = expectOk(receiveRoomItem(room, item, NOW_MS + 3));
    const opened = expectOk(
      submitInitialWidth(withItem, 500, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 4,
      }),
    );
    const configuring = expectOk(
      tradeOnWidth(opened, {
        credential: present(guestToken),
        verifyToken,
        nowMs: NOW_MS + 5,
      }),
    );
    const pollutedGame = {
      ...configuring.game,
      item: {
        ...item,
        true_value: 1_000,
      },
    } as unknown as GameState;
    const pollutedRoom: RoomState = {
      ...configuring,
      game: pollutedGame,
    };
    const snapshotJson = JSON.stringify(toPublicRoomSnapshot(pollutedRoom));

    expect(snapshotJson).not.toContain("true_value");
    expect(snapshotJson).not.toContain("1000");
  });

  it("reveals true_value only after settlement", () => {
    const { room, hostToken, guestToken } = startedRoom();
    const withItem = expectOk(receiveRoomItem(room, item, NOW_MS + 3));
    const opened = expectOk(
      submitInitialWidth(withItem, 200, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 4,
      }),
    );
    const configuring = expectOk(
      tradeOnWidth(opened, {
        credential: present(guestToken),
        verifyToken,
        nowMs: NOW_MS + 5,
      }),
    );
    const choosing = expectOk(
      submitMarketQuote(configuring, { bid: 900, ask: 1100 }, {
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

    if (settling.game.phase !== "settling") {
      throw new Error("Expected settling phase.");
    }

    const settledItem = settledItemFor(settling.game, 1_250);
    const settled = expectOk(
      receiveRoomSettlement(
        settling,
        settledItem,
        NOW_MS + 8,
      ),
    );
    const snapshot = toPublicRoomSnapshot(settled);

    expect(snapshot.game.phase).toBe("settlement");

    if (snapshot.game.phase !== "settlement") {
      throw new Error("Expected settlement snapshot.");
    }

    expect(snapshot.game.item.true_value).toBe(1_250);
  });
});

function startedRoom(): {
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
