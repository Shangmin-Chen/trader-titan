import {
  CHOOSING_SIDE_TURN_DURATION_MS,
  CONFIGURING_MARKET_TURN_DURATION_MS,
  NEGOTIATING_WIDTH_TURN_DURATION_MS,
  PROPOSING_WIDTH_FORFEIT_PENALTY,
  PROPOSING_WIDTH_TURN_DURATION_MS,
  type GeneratedItem,
  type SettledGeneratedItem,
} from "../game/types";
import {
  advanceRoomRound,
  configureRoom,
  createLobbyRoom,
  executeTrade,
  expireRoomTurn,
  failRoomItem,
  joinRoom,
  kickGuest,
  parseCapabilityToken,
  parseRoomId,
  parseTokenHash,
  receiveRoomItem,
  receiveRoomSettlement,
  resetRoomToLobby,
  retryRoomItemGeneration,
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

  // F-04: presence gating was dropped entirely (the turn shot clock now
  // handles an absent opponent instead). These pin the inverse of the old
  // "rejects ... while Player B is offline" behavior so a regression that
  // re-adds gating here is caught.
  it("allows starting a joined room while Player B is offline", () => {
    const { room, hostToken } = joinedRoom();
    const result = startRoom(room, {
      credential: present(hostToken),
      verifyToken,
      nowMs: NOW_MS + 2,
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.room.lifecycle).toBe("active");
    expect(result.room.game.phase).toBe("generatingItem");
  });

  it("allows non-final round advance while Player B is offline", () => {
    const { room, hostToken } = settlingRoom();
    const settled = expectOk(
      receiveRoomSettlement(room, settledItemFor(room.game, 1_200), NOW_MS + 10),
    );
    const result = advanceRoomRound(settled, {
      credential: present(hostToken),
      verifyToken,
      nowMs: NOW_MS + 11,
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.room.game.phase).toBe("generatingItem");
    expect(result.room.game.roundNumber).toBe(2);
  });

  it("allows final round advance to game over while Player B is offline", () => {
    const { room, hostToken } = settlingRoom(1);
    const settled = expectOk(
      receiveRoomSettlement(room, settledItemFor(room.game, 1_200), NOW_MS + 10),
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
  });

  it("keeps Player B as round 2 market maker after advancing", () => {
    const { room, hostToken } = settlingRoom();
    const settled = expectOk(
      receiveRoomSettlement(room, settledItemFor(room.game, 1_200), NOW_MS + 10),
    );
    const round2 = expectOk(
      advanceRoomRound(settled, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 11,
      }),
    );

    expect(round2.game.phase).toBe("generatingItem");
    expect(round2.game.roundNumber).toBe(2);
    expect(round2.game.roles).toEqual({ marketMaker: "B", trader: "A" });
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
        message: "Rounds can only advance after settlement or a round forfeit.",
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

  it("lets the host retry a failed item generation without changing game context", () => {
    const { room, hostToken } = activeRoom();
    const failed = expectOk(failRoomItem(room, "Provider timed out.", NOW_MS + 3));
    const retried = expectOk(
      retryRoomItemGeneration(failed, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 4,
      }),
    );

    expect(retried.lifecycle).toBe("active");
    expect(retried.revision).toBe(failed.revision + 1);
    expect(retried.game.phase).toBe("generatingItem");
    expect(retried.game.mode).toBe(failed.game.mode);
    expect(retried.game.customAmazonQuery).toBe(failed.game.customAmazonQuery);
    expect(retried.game.players).toEqual(failed.game.players);
    expect(retried.game.scores).toEqual(failed.game.scores);
    expect(retried.game.roles).toEqual(failed.game.roles);
    expect(retried.game.roundNumber).toBe(failed.game.roundNumber);
    expect(retried.game.totalRounds).toBe(failed.game.totalRounds);
    expect(retried.game.lastError).toBeUndefined();
    expect("error" in retried.game).toBe(false);
    expect("previousPhase" in retried.game).toBe(false);
    expect(retried.game.log.slice(0, -1)).toEqual(failed.game.log);
  });

  it("rejects item generation retries for guests and wrong phases without mutating", () => {
    const { room, hostToken, guestToken } = activeRoom();
    const failed = expectOk(failRoomItem(room, "Provider timed out.", NOW_MS + 3));
    const guestRetry = retryRoomItemGeneration(failed, {
      credential: present(guestToken),
      verifyToken,
      nowMs: NOW_MS + 4,
    });
    const wrongPhaseRetry = retryRoomItemGeneration(room, {
      credential: present(hostToken),
      verifyToken,
      nowMs: NOW_MS + 5,
    });

    expect(guestRetry).toEqual({
      ok: false,
      room: failed,
      error: {
        code: "host_control_denied",
        message: "Only the host can perform this room command.",
      },
    });
    expect(wrongPhaseRetry).toEqual({
      ok: false,
      room,
      error: {
        code: "invalid_game_phase",
        message: "Item generation or settlement can only be retried after a failure.",
      },
    });
  });

  it("lets the host retry a stuck settlement without mutating the room or the private item", () => {
    // The room command layer does not resolve the settlement itself; it
    // leaves the room exactly as EXECUTE_TRADE committed it (same item,
    // quote, pendingSide) and reports success so the Worker layer can
    // re-run the settlement effect for the current round. See the
    // worker-level F-02 recovery test for the full end-to-end path.
    const { room, hostToken } = settlingRoom();
    const retried = retryRoomItemGeneration(room, {
      credential: present(hostToken),
      verifyToken,
      nowMs: NOW_MS + 9,
    });

    expect(retried).toEqual({ ok: true, room });
  });

  it("rejects guest recovery of a stuck settlement without mutating the room", () => {
    const { room, guestToken } = settlingRoom();
    const guestRetry = retryRoomItemGeneration(room, {
      credential: present(guestToken),
      verifyToken,
      nowMs: NOW_MS + 9,
    });

    expect(guestRetry).toEqual({
      ok: false,
      room,
      error: {
        code: "host_control_denied",
        message: "Only the host can perform this room command.",
      },
    });
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

  it("stamps a server-authoritative absolute deadline on each actionable phase, never a client-supplied one", () => {
    const { room, hostToken, guestToken } = activeRoom();
    const withItem = expectOk(receiveRoomItem(room, item, NOW_MS + 4));

    if (withItem.game.phase !== "proposingWidth") {
      throw new Error("Expected proposingWidth phase.");
    }
    expect(withItem.game.turnDeadlineMs).toBe(NOW_MS + 4 + PROPOSING_WIDTH_TURN_DURATION_MS);

    const opened = expectOk(
      submitInitialWidth(withItem, 500, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 5,
      }),
    );
    if (opened.game.phase !== "negotiatingWidth") {
      throw new Error("Expected negotiatingWidth phase.");
    }
    expect(opened.game.turnDeadlineMs).toBe(NOW_MS + 5 + NEGOTIATING_WIDTH_TURN_DURATION_MS);

    const tightened = expectOk(
      tightenWidth(opened, 200, {
        credential: present(guestToken),
        verifyToken,
        nowMs: NOW_MS + 6,
      }),
    );
    if (tightened.game.phase !== "negotiatingWidth") {
      throw new Error("Expected negotiatingWidth phase.");
    }
    // Each successful TIGHTEN_WIDTH hands the decision to a (possibly new)
    // active trader, so the clock refreshes rather than counting down from
    // the original proposal.
    expect(tightened.game.turnDeadlineMs).toBe(NOW_MS + 6 + NEGOTIATING_WIDTH_TURN_DURATION_MS);

    const configuring = expectOk(
      tradeOnWidth(tightened, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 7,
      }),
    );
    if (configuring.game.phase !== "configuringMarket") {
      throw new Error("Expected configuringMarket phase.");
    }
    expect(configuring.game.turnDeadlineMs).toBe(NOW_MS + 7 + CONFIGURING_MARKET_TURN_DURATION_MS);

    const choosing = expectOk(
      submitMarketQuote(configuring, { bid: 900, ask: 1100 }, {
        credential: present(guestToken),
        verifyToken,
        nowMs: NOW_MS + 8,
      }),
    );
    if (choosing.game.phase !== "choosingSide") {
      throw new Error("Expected choosingSide phase.");
    }
    expect(choosing.game.turnDeadlineMs).toBe(NOW_MS + 8 + CHOOSING_SIDE_TURN_DURATION_MS);
  });

  it("forfeits the round and applies the zero-sum penalty when the turn clock expires", () => {
    const { room, hostToken } = activeRoom();
    const withItem = expectOk(receiveRoomItem(room, item, NOW_MS + 4));
    const opened = expectOk(
      submitInitialWidth(withItem, 500, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 5,
      }),
    );
    // SUBMIT_INITIAL_WIDTH does not swap roles, so round 1's default trader
    // (B) is the one negotiatingWidth is waiting on here.
    expect(opened.game.roles).toEqual({ marketMaker: "A", trader: "B" });

    const expired = expireRoomTurn(opened, NOW_MS + 6);

    expect(expired.ok).toBe(true);

    if (!expired.ok) {
      throw new Error(expired.error.message);
    }
    expect(expired.room.game.phase).toBe("roundForfeited");

    if (expired.room.game.phase !== "roundForfeited") {
      throw new Error("Expected roundForfeited phase.");
    }
    expect(expired.room.game.forfeit).toMatchObject({
      roundNumber: 1,
      phase: "negotiatingWidth",
      forfeitedBy: "B",
      awardedTo: "A",
      penalty: 500,
    });
    expect(expired.room.game.scores).toEqual({ A: 500, B: -500 });
  });

  it("forfeits proposingWidth using the named fallback penalty (no spread width exists yet)", () => {
    const { room } = activeRoom();
    const withItem = expectOk(receiveRoomItem(room, item, NOW_MS + 4));

    expect(withItem.game.phase).toBe("proposingWidth");
    expect(withItem.game.roles).toEqual({ marketMaker: "A", trader: "B" });

    const expired = expireRoomTurn(withItem, NOW_MS + 5);

    expect(expired.ok).toBe(true);

    if (!expired.ok) {
      throw new Error(expired.error.message);
    }
    expect(expired.room.game.phase).toBe("roundForfeited");

    if (expired.room.game.phase !== "roundForfeited") {
      throw new Error("Expected roundForfeited phase.");
    }
    expect(expired.room.game.forfeit).toMatchObject({
      phase: "proposingWidth",
      forfeitedBy: "A",
      awardedTo: "B",
      penalty: PROPOSING_WIDTH_FORFEIT_PENALTY,
    });
    expect(expired.room.game.scores).toEqual({
      A: -PROPOSING_WIDTH_FORFEIT_PENALTY,
      B: PROPOSING_WIDTH_FORFEIT_PENALTY,
    });
  });

  it("rejects turn expiry outside the four actionable phases without mutating the room", () => {
    const { room } = activeRoom();
    const { room: settling } = settlingRoom();

    const rejectedInGeneratingItem = expireRoomTurn(room, NOW_MS + 4);
    const rejectedInSettling = expireRoomTurn(settling, NOW_MS + 9);

    expect(rejectedInGeneratingItem).toEqual({
      ok: false,
      room,
      error: {
        code: "invalid_game_phase",
        message: "Turn expiry can only apply while a player is on the clock.",
      },
    });
    expect(rejectedInSettling).toEqual({
      ok: false,
      room: settling,
      error: {
        code: "invalid_game_phase",
        message: "Turn expiry can only apply while a player is on the clock.",
      },
    });
  });

  it("advances from a round forfeit exactly like advancing from settlement", () => {
    const { room, hostToken } = activeRoom(1);
    const withItem = expectOk(receiveRoomItem(room, item, NOW_MS + 4));
    const expired = expectOk(expireRoomTurn(withItem, NOW_MS + 5));

    expect(expired.game.phase).toBe("roundForfeited");

    const finished = expectOk(
      advanceRoomRound(expired, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 6,
      }),
    );

    expect(finished.lifecycle).toBe("finished");
    expect(finished.game.phase).toBe("gameOver");
  });
});

function activeRoom(totalRounds?: number): {
  room: RoomState;
  hostToken: RoomCapabilityToken;
  guestToken: RoomCapabilityToken;
} {
  const { room, hostToken, guestToken } = joinedRoom();
  const configured =
    totalRounds === undefined
      ? room
      : expectOk(
          configureRoom(room, {
            credential: present(hostToken),
            verifyToken,
            nowMs: NOW_MS + 1,
            config: { totalRounds },
          }),
        );

  return {
    room: expectOk(
      startRoom(configured, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 2,
      }),
    ),
    hostToken,
    guestToken,
  };
}

function settlingRoom(totalRounds?: number): {
  room: RoomState & { game: Extract<RoomState["game"], { phase: "settling" }> };
  hostToken: RoomCapabilityToken;
  guestToken: RoomCapabilityToken;
} {
  const { room, hostToken, guestToken } = activeRoom(totalRounds);
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
