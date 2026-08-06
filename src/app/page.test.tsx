import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseCapabilityToken,
  parseRoomId,
  type CapabilityRole,
  type PublicRoomInvitePreview,
  type PublicRoomSnapshot,
} from "../lib/room";
import {
  accessRoom,
  loadRoomSession,
  openRoomSocket,
  RoomClientRequestError,
  sendRoomCommand,
  type RoomSession,
} from "../lib/room-client";
import Home, {
  applyPublicRoomSnapshotMonotonically,
  canRetryItemGeneration,
  parseRoomSocketMessage,
  resolveExistingRoomCreateState,
} from "./page";

// `Home` (default export) is rendered end-to-end in the "per-command
// pending state" suite below, so every room-client network call it can
// reach needs to be mocked — otherwise it hits `globalThis.fetch`, which
// jsdom doesn't provide. `...actual` keeps the real pure helpers/classes
// (RoomClientRequestError, roomSessionFromToken, etc.) so `instanceof`
// checks inside page.tsx keep working against the same class identity.
vi.mock("../lib/room-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/room-client")>();
  return {
    ...actual,
    accessRoom: vi.fn(),
    createRoom: vi.fn(),
    getRoomPreview: vi.fn(),
    joinRoom: vi.fn(),
    loadRoomSession: vi.fn(),
    openRoomSocket: vi.fn(),
    sendRoomCommand: vi.fn(),
    submitCustomAmazonItem: vi.fn(),
  };
});

const ROOM_A = parseTestRoomId("room-test-a");
const ROOM_B = parseTestRoomId("room-test-b");

const BASE_SNAPSHOT = {
  id: ROOM_A,
  lifecycle: "lobby",
  config: {
    mode: "Chaos Quant",
    totalRounds: 3,
  },
  seats: {
    host: {
      occupied: true,
      role: "host",
      playerId: "A",
      displayName: "Ada",
    },
    guest: {
      occupied: true,
      role: "guest",
      playerId: "B",
      displayName: "Grace",
    },
  },
  presence: {
    players: {
      A: true,
      B: false,
    },
  },
  game: {
    phase: "setup",
    mode: "Chaos Quant",
    players: {
      A: { id: "A", name: "Ada" },
      B: { id: "B", name: "Grace" },
    },
    scores: { A: 0, B: 0 },
    roles: { marketMaker: "A", trader: "B" },
    roundNumber: 0,
    totalRounds: 3,
    log: [],
  },
  createdAtMs: 1,
  updatedAtMs: 1,
  revision: 0,
} satisfies PublicRoomSnapshot;

const BASE_PREVIEW = {
  id: ROOM_A,
  lifecycle: "lobby",
  host: {
    displayName: "Ada",
  },
  guest: {
    occupied: true,
  },
  joinable: false,
  createdAtMs: 1,
  updatedAtMs: 1,
  revision: 0,
} satisfies PublicRoomInvitePreview;

function snapshot(
  overrides: Partial<PublicRoomSnapshot> = {},
): PublicRoomSnapshot {
  return {
    ...BASE_SNAPSHOT,
    ...overrides,
    config: overrides.config ?? BASE_SNAPSHOT.config,
    seats: overrides.seats ?? BASE_SNAPSHOT.seats,
    presence: overrides.presence ?? BASE_SNAPSHOT.presence,
    game: overrides.game ?? BASE_SNAPSHOT.game,
  };
}

function preview(
  overrides: Partial<PublicRoomInvitePreview> = {},
): PublicRoomInvitePreview {
  return {
    ...BASE_PREVIEW,
    ...overrides,
    host: overrides.host ?? BASE_PREVIEW.host,
    guest: overrides.guest ?? BASE_PREVIEW.guest,
  };
}

function session(role: CapabilityRole, roomId = ROOM_A): RoomSession {
  const parsed = parseCapabilityToken({
    roomId,
    role,
    secret: `${role}-session-secret-1234567890`,
  });

  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }

  return {
    roomId,
    role,
    token: parsed.token,
  };
}

function parseTestRoomId(value: string) {
  const result = parseRoomId(value);

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.roomId;
}

describe("public room snapshot monotonic application", () => {
  it("accepts an initial snapshot", () => {
    const incoming = snapshot({ revision: 2 });

    const result = applyPublicRoomSnapshotMonotonically(null, incoming);

    expect(result.accepted).toBe(true);
    expect(result.room).toBe(incoming);
  });

  it("rejects stale lower-revision same-room responses", () => {
    const current = snapshot({ revision: 7 });
    const incoming = snapshot({ revision: 6 });

    const result = applyPublicRoomSnapshotMonotonically(current, incoming);

    expect(result.accepted).toBe(false);
    expect(result.room).toBe(current);
  });

  it("accepts equal-revision presence updates", () => {
    const current = snapshot({
      revision: 4,
      presence: {
        players: {
          A: true,
          B: false,
        },
      },
    });
    const incoming = snapshot({
      revision: 4,
      presence: {
        players: {
          A: true,
          B: true,
        },
      },
    });

    const result = applyPublicRoomSnapshotMonotonically(current, incoming);

    expect(result.accepted).toBe(true);
    expect(result.room).toBe(incoming);
    expect(result.room.presence.players.B).toBe(true);
  });

  it("rejects equal-revision same-room state changes beyond presence", () => {
    const current = snapshot({ revision: 4 });
    const incoming = snapshot({
      revision: 4,
      game: {
        ...BASE_SNAPSHOT.game,
        scores: { A: 12, B: -12 },
      },
      presence: {
        players: {
          A: true,
          B: true,
        },
      },
    });

    const result = applyPublicRoomSnapshotMonotonically(current, incoming);

    expect(result.accepted).toBe(false);
    expect(result.room).toBe(current);
  });

  it("accepts intentional room switches without comparing unrelated revisions", () => {
    const current = snapshot({ id: ROOM_A, revision: 12 });
    const incoming = snapshot({ id: ROOM_B, revision: 0 });

    const result = applyPublicRoomSnapshotMonotonically(current, incoming, {
      allowRoomSwitch: true,
    });

    expect(result.accepted).toBe(true);
    expect(result.room).toBe(incoming);
  });

  it("rejects cross-room snapshots by default", () => {
    const current = snapshot({ id: ROOM_A, revision: 2 });
    const incoming = snapshot({ id: ROOM_B, revision: 99 });

    const result = applyPublicRoomSnapshotMonotonically(current, incoming);

    expect(result.accepted).toBe(false);
    expect(result.room).toBe(current);
  });
});

describe("existing-room create state resolution", () => {
  it("hydrates a stored session by accessing the full room snapshot", async () => {
    const storedSession = session("host");
    const invitePreview = preview();
    const accessedRoom = snapshot({ revision: 4 });
    const accessCalls: Array<Readonly<{ roomId: string; session: RoomSession }>> =
      [];

    const result = await resolveExistingRoomCreateState(
      invitePreview,
      storedSession,
      async (roomId, roomSession) => {
        accessCalls.push({ roomId, session: roomSession });
        return accessedRoom;
      },
    );

    expect(accessCalls).toEqual([{ roomId: ROOM_A, session: storedSession }]);
    expect(result).toEqual({
      kind: "hydrated",
      room: accessedRoom,
      preview: {
        id: ROOM_A,
        lifecycle: "lobby",
        host: {
          displayName: "Ada",
        },
        guest: {
          occupied: true,
        },
        joinable: false,
        createdAtMs: 1,
        updatedAtMs: 1,
        revision: 4,
      },
      session: storedSession,
      connectionStatus: "connecting",
      clearStoredSession: false,
    });
  });

  it("uses preview-only state with a null session when no stored session exists", async () => {
    const invitePreview = preview();
    let accessCalled = false;

    const result = await resolveExistingRoomCreateState(
      invitePreview,
      null,
      async () => {
        accessCalled = true;
        return snapshot();
      },
    );

    expect(accessCalled).toBe(false);
    expect(result).toEqual({
      kind: "preview",
      room: null,
      preview: invitePreview,
      session: null,
      connectionStatus: "idle",
      clearStoredSession: false,
    });
  });

  it("clears stale stored sessions and falls back to preview-only state", async () => {
    const invitePreview = preview();

    const result = await resolveExistingRoomCreateState(
      invitePreview,
      session("guest"),
      async () => {
        throw new RoomClientRequestError(403, {
          code: "stale_guest",
          message: "Guest capability is stale.",
        });
      },
    );

    expect(result).toEqual({
      kind: "preview",
      room: null,
      preview: invitePreview,
      session: null,
      connectionStatus: "idle",
      clearStoredSession: true,
    });
  });

  it("clears invalid stored sessions and falls back to preview-only state", async () => {
    const invitePreview = preview();

    const result = await resolveExistingRoomCreateState(
      invitePreview,
      session("host"),
      async () => {
        throw new RoomClientRequestError(403, {
          code: "token_mismatch",
          message: "Host capability token was rejected.",
        });
      },
    );

    expect(result).toMatchObject({
      kind: "preview",
      room: null,
      preview: invitePreview,
      session: null,
      connectionStatus: "idle",
      clearStoredSession: true,
    });
  });

  it("propagates non-session access failures", async () => {
    const failure = new Error("network failed");

    await expect(
      resolveExistingRoomCreateState(preview(), session("host"), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});

describe("item generation retry affordance", () => {
  it("allows the host to retry only item-generation error states", () => {
    const itemGenerationError = {
      ...BASE_SNAPSHOT.game,
      phase: "error",
      error: "Item generation is not configured.",
      previousPhase: "generatingItem",
      lastError: "Item generation is not configured.",
    } satisfies PublicRoomSnapshot["game"];
    const otherError = {
      ...itemGenerationError,
      previousPhase: "settling",
    } satisfies PublicRoomSnapshot["game"];

    expect(canRetryItemGeneration(itemGenerationError, true)).toBe(true);
    expect(canRetryItemGeneration(itemGenerationError, false)).toBe(false);
    expect(canRetryItemGeneration(otherError, true)).toBe(false);
    expect(canRetryItemGeneration(BASE_SNAPSHOT.game, true)).toBe(false);
  });
});

describe("room socket message parsing", () => {
  it("rejects room snapshots without public presence booleans", () => {
    const snapshot = {
      id: "room-test",
      presence: {
        players: {
          A: true,
          B: true,
        },
      },
    };

    expect(
      parseRoomSocketMessage(JSON.stringify({
        type: "ROOM_SNAPSHOT",
        room: snapshot,
      })),
    ).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: snapshot,
    });

    expect(
      parseRoomSocketMessage(JSON.stringify({
        type: "ROOM_SNAPSHOT",
        room: {
          id: "room-test",
        },
      })),
    ).toBeNull();

    expect(
      parseRoomSocketMessage(JSON.stringify({
        type: "ROOM_SNAPSHOT",
        room: {
          id: "room-test",
          presence: {
            players: {
              A: true,
            },
          },
        },
      })),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F-06: per-command pending state
//
// Regression coverage for the wedge described in F-06: a global
// `isCommanding` boolean meant one hung command (e.g. a stuck
// ADVANCE_ROUND) disabled every control on the page, forever, with no
// error shown. `runCommand` now tracks in-flight commands per command
// `type`, so these tests render the real page end-to-end (network calls
// mocked via the `../lib/room-client` mock above) and assert on actual
// `disabled` state.
// ---------------------------------------------------------------------------

describe("per-command pending state (F-06)", () => {
  const HOST_SESSION = session("host", ROOM_A);

  const SETTLEMENT_SNAPSHOT = {
    ...BASE_SNAPSHOT,
    lifecycle: "active",
    presence: {
      players: { A: true, B: true },
    },
    game: {
      mode: "Chaos Quant",
      players: {
        A: { id: "A", name: "Ada" },
        B: { id: "B", name: "Grace" },
      },
      scores: { A: 5, B: -5 },
      roles: { marketMaker: "A", trader: "B" },
      roundNumber: 1,
      totalRounds: 3,
      log: [],
      phase: "settlement",
      spreadWidth: 4,
      quote: { bid: 10, ask: 14 },
      item: {
        item_title: "Widget",
        category: "Test",
        context_clue: "A useful test item.",
        round_id: "round-1",
        true_value: 12,
      },
      settlement: {
        roundNumber: 1,
        itemTitle: "Widget",
        side: "BUY",
        transactionPrice: 12,
        trueValue: 12,
        trader: "B",
        marketMaker: "A",
        traderPnL: 0,
        marketMakerPnL: 0,
      },
    },
  } satisfies PublicRoomSnapshot;

  // Minimal EventTarget-based stand-in for the real WebSocket the socket
  // effect opens — the tests below never need it to emit anything.
  class FakeRoomSocket extends EventTarget {
    close(): void {
      // no-op
    }
  }

  beforeEach(() => {
    vi.resetAllMocks();

    // GameShell always renders ThemeToggle, which reads
    // `window.matchMedia`; jsdom does not implement it.
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });

    window.history.pushState({}, "", `/?room=${ROOM_A}`);

    vi.mocked(openRoomSocket).mockReturnValue(
      new FakeRoomSocket() as unknown as WebSocket,
    );
    vi.mocked(loadRoomSession).mockReturnValue(HOST_SESSION);
    vi.mocked(accessRoom).mockResolvedValue({
      ok: true,
      room: SETTLEMENT_SNAPSHOT,
    });
  });

  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  async function renderInSettlementPhase() {
    render(<Home />);
    return screen.findByTestId("settlement-panel");
  }

  it("does not let a hung command disable unrelated controls", async () => {
    // ADVANCE_ROUND hangs forever (simulating F-06's unresponsive
    // request); any other command type resolves normally.
    vi.mocked(sendRoomCommand).mockImplementation((_roomId, command) => {
      if (command.type === "ADVANCE_ROUND") {
        return new Promise(() => {});
      }
      return Promise.resolve({ ok: true, room: SETTLEMENT_SNAPSHOT });
    });

    await renderInSettlementPhase();

    const continueButton = screen.getByRole("button", { name: /next round/i });
    const resetButton = screen.getByRole("button", { name: /reset lobby/i });
    const kickButton = screen.getByRole("button", { name: /kick guest/i });

    expect(continueButton).toBeEnabled();
    expect(resetButton).toBeEnabled();
    expect(kickButton).toBeEnabled();

    fireEvent.click(continueButton);

    // The command that hung disables its own control...
    expect(continueButton).toBeDisabled();
    // ...but must not take down controls tied to other commands.
    expect(resetButton).toBeEnabled();
    expect(kickButton).toBeEnabled();

    expect(sendRoomCommand).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendRoomCommand).mock.calls[0]?.[1]).toMatchObject({
      type: "ADVANCE_ROUND",
    });
  });

  it("still blocks a double-submit of the same command", async () => {
    vi.mocked(sendRoomCommand).mockReturnValue(new Promise(() => {}));

    await renderInSettlementPhase();

    const resetButton = screen.getByRole("button", { name: /reset lobby/i });

    fireEvent.click(resetButton);
    fireEvent.click(resetButton);

    expect(resetButton).toBeDisabled();
    // A second click on the same in-flight command must not fire a
    // second request — this is the load-bearing double-submit guard.
    expect(sendRoomCommand).toHaveBeenCalledTimes(1);
  });
});
