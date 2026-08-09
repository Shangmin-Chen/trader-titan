import {
  CHOOSING_SIDE_TURN_DURATION_MS,
  CONFIGURING_MARKET_TURN_DURATION_MS,
  NEGOTIATING_WIDTH_TURN_DURATION_MS,
  PROPOSING_WIDTH_TURN_DURATION_MS,
} from "../game/types";
import {
  ABANDONED_ROOM_TTL_MS,
  FINISHED_ROOM_TTL_MS,
  ROOM_PERSISTENCE_VERSION,
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

    // Neither the current version (2) nor the one known-migratable legacy
    // version (1, see ROOM_PERSISTENCE_LEGACY_VERSION) - a future version
    // this build predates.
    expect(loadPersistenceEnvelope({ ...envelope, version: 3 }, envelope.expiresAtMs - 1)).toEqual({
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
 * B1: production storage is full of version-1 envelopes (predating F-05's
 * turnDeadlineMs and F-06's pendingTrade/forcedByTimeout) that the strict
 * v2 allowlists above would otherwise reject outright the moment
 * ROOM_PERSISTENCE_VERSION became 2. These tests build exactly the
 * old-shaped records a pre-this-branch build actually wrote (by stripping
 * the new fields back off a real command-produced RoomState) and assert
 * loadPersistenceEnvelope still decodes them - migrating each one forward -
 * rather than trusting the migration logic by reading it.
 */
describe("legacy (version-1) envelope migration", () => {
  it("migrates a version-1 proposingWidth envelope by stamping a fresh turnDeadlineMs (F-05)", () => {
    const fixtures = legacyMigrationFixtures();
    const readAtMs = NOW_MS + 500;

    const loaded = loadPersistenceEnvelope(
      legacyEnvelopeWithoutTurnDeadline(fixtures.proposingWidth, NOW_MS + 100),
      readAtMs,
    );

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      throw new Error("Expected legacy proposingWidth envelope to decode.");
    }
    if (loaded.room.game.phase !== "proposingWidth") {
      throw new Error("Expected proposingWidth phase.");
    }

    expect(loaded.room.game.turnDeadlineMs).toBe(readAtMs + PROPOSING_WIDTH_TURN_DURATION_MS);
    expect(loaded.room.game).toEqual({
      ...fixtures.proposingWidth.game,
      turnDeadlineMs: readAtMs + PROPOSING_WIDTH_TURN_DURATION_MS,
    });
  });

  it("migrates a version-1 negotiatingWidth envelope by stamping a fresh turnDeadlineMs (F-05)", () => {
    const fixtures = legacyMigrationFixtures();
    const readAtMs = NOW_MS + 500;

    const loaded = loadPersistenceEnvelope(
      legacyEnvelopeWithoutTurnDeadline(fixtures.negotiatingWidth, NOW_MS + 100),
      readAtMs,
    );

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      throw new Error("Expected legacy negotiatingWidth envelope to decode.");
    }
    if (loaded.room.game.phase !== "negotiatingWidth") {
      throw new Error("Expected negotiatingWidth phase.");
    }

    expect(loaded.room.game.turnDeadlineMs).toBe(readAtMs + NEGOTIATING_WIDTH_TURN_DURATION_MS);
    expect(loaded.room.game).toEqual({
      ...fixtures.negotiatingWidth.game,
      turnDeadlineMs: readAtMs + NEGOTIATING_WIDTH_TURN_DURATION_MS,
    });
  });

  it("migrates a version-1 configuringMarket envelope by stamping a fresh turnDeadlineMs (F-05)", () => {
    const fixtures = legacyMigrationFixtures();
    const readAtMs = NOW_MS + 500;

    const loaded = loadPersistenceEnvelope(
      legacyEnvelopeWithoutTurnDeadline(fixtures.configuringMarket, NOW_MS + 100),
      readAtMs,
    );

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      throw new Error("Expected legacy configuringMarket envelope to decode.");
    }
    if (loaded.room.game.phase !== "configuringMarket") {
      throw new Error("Expected configuringMarket phase.");
    }

    expect(loaded.room.game.turnDeadlineMs).toBe(readAtMs + CONFIGURING_MARKET_TURN_DURATION_MS);
    expect(loaded.room.game).toEqual({
      ...fixtures.configuringMarket.game,
      turnDeadlineMs: readAtMs + CONFIGURING_MARKET_TURN_DURATION_MS,
    });
  });

  it("migrates a version-1 choosingSide envelope by stamping a fresh turnDeadlineMs (F-05)", () => {
    const fixtures = legacyMigrationFixtures();
    const readAtMs = NOW_MS + 500;

    const loaded = loadPersistenceEnvelope(
      legacyEnvelopeWithoutTurnDeadline(fixtures.choosingSide, NOW_MS + 100),
      readAtMs,
    );

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      throw new Error("Expected legacy choosingSide envelope to decode.");
    }
    if (loaded.room.game.phase !== "choosingSide") {
      throw new Error("Expected choosingSide phase.");
    }

    expect(loaded.room.game.turnDeadlineMs).toBe(readAtMs + CHOOSING_SIDE_TURN_DURATION_MS);
    expect(loaded.room.game).toEqual({
      ...fixtures.choosingSide.game,
      turnDeadlineMs: readAtMs + CHOOSING_SIDE_TURN_DURATION_MS,
    });
  });

  it("migrates a version-1 settling envelope's pendingSide into a chosen pendingTrade (F-06)", () => {
    const { room, hostToken, guestToken } = joinedRoom();
    const settling = settlingRoomChosen(room, hostToken, guestToken);

    if (settling.game.phase !== "settling") {
      throw new Error("Expected settling phase.");
    }
    expect(settling.game.pendingTrade).toEqual({ kind: "chosen", side: "BUY" });

    const readAtMs = NOW_MS + 500;
    const loaded = loadPersistenceEnvelope(
      legacyEnvelopeWithPendingSide(settling, NOW_MS + 100),
      readAtMs,
    );

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      throw new Error("Expected legacy settling envelope to decode.");
    }
    if (loaded.room.game.phase !== "settling") {
      throw new Error("Expected settling phase.");
    }

    expect(loaded.room.game.pendingTrade).toEqual({ kind: "chosen", side: "BUY" });
    expect(loaded.room.game).toEqual(settling.game);
  });

  it("migrates a version-1 settlement's missing forcedByTimeout to false (F-06)", () => {
    const { room, hostToken, guestToken } = joinedRoom();
    const settling = settlingRoomChosen(room, hostToken, guestToken);

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
    // Confirms the fixture itself is the F-06-aware, not-forced case this
    // migration is specifically about - a version-1 settlement can never
    // have forcedByTimeout: true (F-06 did not exist yet), so defaulting to
    // false is only ever reproducing what pre-F-06 code already computed.
    expect(settled.game.settlement.forcedByTimeout).toBe(false);

    const readAtMs = NOW_MS + 500;
    const loaded = loadPersistenceEnvelope(
      legacyEnvelopeWithoutForcedByTimeout(settled, NOW_MS + 100),
      readAtMs,
    );

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      throw new Error("Expected legacy settlement envelope to decode.");
    }
    if (loaded.room.game.phase !== "settlement") {
      throw new Error("Expected settlement phase.");
    }

    expect(loaded.room.game.settlement.forcedByTimeout).toBe(false);
    expect(loaded.room.game).toEqual(settled.game);
  });

  it("re-persists a migrated legacy envelope as version 2 and round-trips it through the strict allowlist", () => {
    const { room, hostToken, guestToken } = joinedRoom();
    const settling = settlingRoomChosen(room, hostToken, guestToken);

    if (settling.game.phase !== "settling") {
      throw new Error("Expected settling phase.");
    }

    const readAtMs = NOW_MS + 500;
    const loaded = loadPersistenceEnvelope(
      legacyEnvelopeWithPendingSide(settling, NOW_MS + 100),
      readAtMs,
    );

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      throw new Error("Expected legacy settling envelope to decode.");
    }

    const rePersisted = toPersistenceEnvelope(loaded.room, readAtMs + 1);

    // The next persist must write the current version, not silently keep
    // carrying the room forward as a version-1 envelope forever.
    expect(rePersisted.version).toBe(ROOM_PERSISTENCE_VERSION);
    expect(rePersisted.version).toBe(2);

    // And that rewritten envelope must satisfy the strict, non-legacy path -
    // no lingering leniency once a room has been through one write.
    expect(loadPersistenceEnvelope(rePersisted, readAtMs + 2)).toEqual({
      ok: true,
      room: loaded.room,
    });
  });

  it("still rejects a version-1 envelope that is genuinely corrupt, not just old-shaped", () => {
    const fixtures = legacyMigrationFixtures();
    const legacy = legacyEnvelopeWithoutTurnDeadline(fixtures.proposingWidth, NOW_MS + 100) as {
      room: { game: Record<string, unknown> };
    };
    // Corrupt in a way migration has no branch for: drop the item entirely
    // rather than merely lacking the new turnDeadlineMs field.
    delete legacy.room.game.item;

    expect(loadPersistenceEnvelope(legacy, NOW_MS + 500)).toEqual({
      ok: false,
      error: {
        code: "persistence_invalid",
        message: "Room persistence envelope is invalid.",
      },
    });
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

/**
 * One joined-and-started room walked through all four F-05 turn-clocked
 * phases, so each B1 migration test below can build its own legacy
 * (turnDeadlineMs-free) envelope from a real command-produced RoomState
 * rather than a hand-authored fixture that might drift from what the
 * command layer actually produces.
 */
function legacyMigrationFixtures(): {
  proposingWidth: RoomState;
  negotiatingWidth: RoomState;
  configuringMarket: RoomState;
  choosingSide: RoomState;
} {
  const { room, hostToken, guestToken } = joinedRoom();
  const started = expectOk(
    startRoom(room, { credential: present(hostToken), verifyToken, nowMs: NOW_MS + 2 }),
  );
  const item = {
    round_id: "round-legacy-migration",
    item_title: "Widget",
    category: "Chaos Quant",
    context_clue: "A test item.",
  };
  const proposingWidth = normalizeForPersistence(
    expectOk(receiveRoomItem(started, item, NOW_MS + 3)),
  );
  const negotiatingWidth = normalizeForPersistence(
    expectOk(
      submitInitialWidth(proposingWidth, 200, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 4,
      }),
    ),
  );
  const configuringMarket = normalizeForPersistence(
    expectOk(
      tradeOnWidth(negotiatingWidth, {
        credential: present(guestToken),
        verifyToken,
        nowMs: NOW_MS + 5,
      }),
    ),
  );
  const choosingSide = normalizeForPersistence(
    expectOk(
      submitMarketQuote(configuringMarket, { bid: 3500, ask: 3700 }, {
        credential: present(hostToken),
        verifyToken,
        nowMs: NOW_MS + 6,
      }),
    ),
  );

  return { proposingWidth, negotiatingWidth, configuringMarket, choosingSide };
}

/**
 * Builds a raw (non-typed) envelope matching exactly what a pre-this-branch
 * build would have persisted for `room`: the same room, tagged version 1,
 * with turnDeadlineMs stripped back off its game state. `persistedAtMs` only
 * needs to predate the test's read time; it plays no role in the migration
 * itself (see withFreshTurnDeadline in persistence.ts, which stamps off the
 * *reader's* current time, not this).
 */
function legacyEnvelopeWithoutTurnDeadline(room: RoomState, persistedAtMs: number): unknown {
  const envelope = toPersistenceEnvelope(room, persistedAtMs);
  const legacyGame: Record<string, unknown> = { ...envelope.room.game };
  delete legacyGame.turnDeadlineMs;

  return {
    ...envelope,
    version: 1,
    room: { ...envelope.room, game: legacyGame },
  };
}

/**
 * Builds a raw version-1 "settling" envelope the way pre-F-06 code actually
 * wrote one: `pendingSide: TradeSide` instead of today's
 * `pendingTrade: PendingTradeDecision`. Only meaningful for a `settlingRoom*`
 * fixture whose pendingTrade is `{ kind: "chosen", ... }` - F-06's
 * `timeoutForcedWorstSide` has no legacy representation at all (see
 * withMigratedPendingTrade in persistence.ts), so this throws rather than
 * silently producing a nonsensical fixture if ever called on one.
 */
function legacyEnvelopeWithPendingSide(room: RoomState, persistedAtMs: number): unknown {
  const envelope = toPersistenceEnvelope(room, persistedAtMs);
  const legacyGame: Record<string, unknown> = { ...envelope.room.game };
  const pendingTrade = legacyGame.pendingTrade;

  if (
    !pendingTrade ||
    typeof pendingTrade !== "object" ||
    (pendingTrade as { kind?: unknown }).kind !== "chosen"
  ) {
    throw new Error("legacyEnvelopeWithPendingSide requires a chosen pendingTrade fixture.");
  }

  delete legacyGame.pendingTrade;
  legacyGame.pendingSide = (pendingTrade as { side: unknown }).side;

  return {
    ...envelope,
    version: 1,
    room: { ...envelope.room, game: legacyGame },
  };
}

/**
 * Builds a raw version-1 "settlement" envelope the way pre-F-06 code
 * actually wrote one: RoundSettlement without a `forcedByTimeout` key at
 * all, rather than today's always-present boolean.
 */
function legacyEnvelopeWithoutForcedByTimeout(room: RoomState, persistedAtMs: number): unknown {
  const envelope = toPersistenceEnvelope(room, persistedAtMs);
  const legacyGame: Record<string, unknown> = { ...envelope.room.game };
  const legacySettlement: Record<string, unknown> = {
    ...(legacyGame.settlement as Record<string, unknown>),
  };
  delete legacySettlement.forcedByTimeout;
  legacyGame.settlement = legacySettlement;

  return {
    ...envelope,
    version: 1,
    room: { ...envelope.room, game: legacyGame },
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

function settledRoomWithAmazonMetadata(): RoomState {
  const { room, hostToken, guestToken } = joinedRoom();
  const started = expectOk(
    startRoom(room, {
      credential: present(hostToken),
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
