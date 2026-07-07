import type { GeneratedItem } from "../game/types";
import {
  createLobbyRoom,
  joinRoom,
  kickGuest,
  parseCapabilityToken,
  parseRoomId,
  parseTokenHash,
  receiveRoomItem,
  startRoom,
  submitInitialWidth,
  authorizeRoomAccess,
  authorizeRoomAction,
  type PresentedCapabilityToken,
  type RoomCapabilityToken,
  type RoomCommandResult,
  type RoomId,
  type RoomPresence,
  type RoomState,
  type TokenHash,
  type TokenVerifier,
} from "./index";

const NOW_MS = 10_000;
const ROOM_ID_VALUE = "room_auth_0001";
const OTHER_ROOM_ID_VALUE = "room_auth_0002";
const HOST_SECRET = "host_secret_000000000001";
const GUEST_SECRET = "guest_secret_000000000001";
const STALE_GUEST_SECRET = "guest_secret_000000000002";
const LIVE_PRESENCE = {
  players: {
    A: true,
    B: true,
  },
} satisfies RoomPresence;

const item: GeneratedItem = {
  round_id: "round-auth-1",
  item_title: "Seconds in a day",
  category: "Fermi Math & Geometry",
  context_clue: "There are 24 hours in a day.",
};

describe("room authorization", () => {
  it("rejects invalid ids and malformed tokens before authorization", () => {
    const badRoom = parseRoomId("bad room id");
    const shortToken = parseCapabilityToken({
      roomId: ROOM_ID_VALUE,
      role: "host",
      secret: "short",
    });
    const spectatorToken = parseCapabilityToken({
      roomId: ROOM_ID_VALUE,
      role: "spectator",
      secret: HOST_SECRET,
    });

    expect(badRoom.ok).toBe(false);
    expect(shortToken.ok).toBe(false);
    expect(spectatorToken).toEqual({
      ok: false,
      error: {
        code: "spectator_access_denied",
        message: "Spectator access is not supported.",
      },
    });
  });

  it("rejects missing tokens, wrong-room tokens, and spectator access", () => {
    const { room, hostToken } = joinedRoom();
    const otherRoomToken = mustToken("host", HOST_SECRET, mustRoomId(OTHER_ROOM_ID_VALUE));

    expect(authorizeRoomAccess(room, null, verifyToken)).toEqual({
      ok: false,
      error: {
        code: "missing_token",
        message: "Capability token is required.",
      },
    });
    expect(authorizeRoomAccess(room, present(otherRoomToken), verifyToken)).toEqual({
      ok: false,
      error: {
        code: "wrong_room",
        message: "Capability token belongs to a different room.",
      },
    });
    expect(
      authorizeRoomAccess(
        room,
        { roomId: hostToken.roomId, role: "spectator", secret: hostToken.secret },
        verifyToken,
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "spectator_access_denied",
        message: "Spectator access is not supported.",
      },
    });
  });

  it("denies guest host-controls and host commands for the wrong active player", () => {
    const { room, hostToken, guestToken } = activeNegotiationRoom();

    const guestHostControl = authorizeRoomAction(
      room,
      present(guestToken),
      { type: "hostControl" },
      verifyToken,
    );
    const hostAsGuestTrader = authorizeRoomAction(
      room,
      present(hostToken),
      { type: "activePlayer", playerId: "B" },
      verifyToken,
    );

    expect(guestHostControl).toEqual({
      ok: false,
      error: {
        code: "host_control_denied",
        message: "Only the host can perform this room command.",
      },
    });
    expect(hostAsGuestTrader).toEqual({
      ok: false,
      error: {
        code: "wrong_active_role",
        message: "This command requires Player B.",
      },
    });
  });

  it("rejects stale guest capabilities after a kick", () => {
    const { room, hostToken, guestToken } = joinedRoom();
    const kicked = expectOk(
      kickGuest(room, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 1,
      }),
    );

    expect(kicked.guest).toBeNull();
    expect(authorizeRoomAccess(kicked, present(guestToken), verifyToken)).toEqual({
      ok: false,
      error: {
        code: "stale_guest",
        message: "Guest capability is stale or the guest slot is empty.",
      },
    });
  });

  it("rejects replaced guest capabilities after the slot is rejoined", () => {
    const { room, hostToken, guestToken } = joinedRoom();
    const kicked = expectOk(
      kickGuest(room, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 1,
      }),
    );
    const staleToken = mustToken("guest", STALE_GUEST_SECRET, kicked.id);
    const rejoined = expectOk(
      joinRoom(kicked, {
        guestName: "New Grace",
        guestTokenHash: hashFor(staleToken),
        nowMs: NOW_MS + 2,
      }),
    );

    expect(authorizeRoomAccess(rejoined, present(guestToken), verifyToken)).toEqual({
      ok: false,
      error: {
        code: "stale_guest",
        message: "Guest capability is stale or has been replaced.",
      },
    });
    expect(authorizeRoomAccess(rejoined, present(staleToken), verifyToken).ok).toBe(true);
  });
});

function activeNegotiationRoom(): {
  room: RoomState;
  hostToken: RoomCapabilityToken;
  guestToken: RoomCapabilityToken;
} {
  const { room, hostToken, guestToken } = joinedRoom();
  const started = expectOk(
    startRoom(room, {
      credential: present(hostToken),
      presence: LIVE_PRESENCE,
      verifyToken,
      nowMs: NOW_MS + 1,
    }),
  );
  const withItem = expectOk(receiveRoomItem(started, item, NOW_MS + 2));

  return {
    room: expectOk(
      submitInitialWidth(withItem, 500, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 3,
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
