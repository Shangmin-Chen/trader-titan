import {
  accessRoom,
  clearRoomSession,
  createRoom,
  getRoomPreview,
  joinRoom,
  loadRoomSession,
  openRoomSocket,
  roomSessionFromToken,
  roomSocketProtocols,
  roomSocketUrl,
  saveRoomSession,
  sendRoomCommand,
} from "./room-client";
import {
  parseCapabilityToken,
  parseRoomId,
  type PublicRoomSnapshot,
  type RoomCapabilityToken,
} from "./room";

const ROOM_ID = "room-client-test";
const ROOM_ID_VALUE = parseTestRoomId(ROOM_ID);
const HOST_TOKEN: RoomCapabilityToken = parseTestToken(ROOM_ID);
const SNAPSHOT = {
  id: ROOM_ID_VALUE,
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
      occupied: false,
      role: "guest",
      playerId: "B",
      displayName: null,
    },
  },
  game: {
    phase: "setup",
    mode: "Chaos Quant",
    players: {
      A: { id: "A", name: "Ada" },
      B: { id: "B", name: "Guest" },
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

describe("room client", () => {
  it("uses preview, access, create, join, and command public room routes", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      Response.json({
        ok: true,
        created: true,
        room: SNAPSHOT,
        hostToken: HOST_TOKEN,
        input: String(input),
        method: init?.method,
      }),
    );

    await getRoomPreview(ROOM_ID, { baseUrl: "https://example.test", fetchImpl });
    await accessRoom(
      ROOM_ID,
      { credential: HOST_TOKEN },
      { baseUrl: "https://example.test", fetchImpl },
    );
    await createRoom({ hostName: "Ada" }, { baseUrl: "https://example.test", fetchImpl });
    await joinRoom(ROOM_ID, { guestName: "Grace" }, { baseUrl: "https://example.test", fetchImpl });
    await sendRoomCommand(
      ROOM_ID,
      { type: "START_ROOM", credential: HOST_TOKEN, nowMs: 1 },
      { baseUrl: "https://example.test", fetchImpl },
    );

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      `https://example.test/api/rooms/${ROOM_ID}`,
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `https://example.test/api/rooms/${ROOM_ID}/access`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "https://example.test/api/rooms",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      `https://example.test/api/rooms/${ROOM_ID}/join`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      5,
      `https://example.test/api/rooms/${ROOM_ID}/command`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws typed request errors for room API failures", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          ok: false,
          error: {
            code: "guest_slot_full",
            message: "The guest slot is already occupied.",
          },
        },
        { status: 409 },
      ),
    );

    await expect(joinRoom(ROOM_ID, { guestName: "Grace" }, { fetchImpl })).rejects.toMatchObject({
      error: {
        code: "guest_slot_full",
      },
      status: 409,
    });
  });

  it("builds websocket URLs from explicit base URLs or browser location", () => {
    expect(roomSocketUrl(ROOM_ID, { baseUrl: "https://example.test", token: HOST_TOKEN })).toBe(
      `wss://example.test/api/rooms/${ROOM_ID}/socket`,
    );
    expect(
      roomSocketUrl(ROOM_ID, {
        location: {
          origin: "http://localhost:8787",
          protocol: "http:",
          host: "localhost:8787",
        },
        token: HOST_TOKEN,
      }),
    ).toBe(`ws://localhost:8787/api/rooms/${ROOM_ID}/socket`);
    expect(roomSocketProtocols(HOST_TOKEN)).toEqual([
      "tt-room-v1",
      "tt-role-host",
      `tt-secret-${"a".repeat(64)}`,
    ]);
  });

  it("opens websocket connections with auth protocols instead of query params", () => {
    const created: Array<Readonly<{ url: string | URL; protocols?: string | string[] }>> = [];
    class RecordingWebSocket extends EventTarget {
      constructor(url: string | URL, protocols?: string | string[]) {
        super();
        created.push({ url, protocols });
      }
    }

    const socket = openRoomSocket(ROOM_ID, {
      baseUrl: "https://example.test",
      token: HOST_TOKEN,
      WebSocketImpl: RecordingWebSocket as unknown as typeof WebSocket,
    });

    expect(socket).toBeInstanceOf(RecordingWebSocket);
    expect(created).toEqual([
      {
        url: `wss://example.test/api/rooms/${ROOM_ID}/socket`,
        protocols: roomSocketProtocols(HOST_TOKEN),
      },
    ]);
  });

  it("persists only valid same-room capability sessions", () => {
    const storage = new MapStorage();
    const session = roomSessionFromToken(HOST_TOKEN);

    saveRoomSession(storage, session);

    expect(loadRoomSession(storage, ROOM_ID)).toEqual(session);
    expect(loadRoomSession(storage, "other-room")).toBeNull();

    storage.setItem(
      "trader-titan.room-session.v1:bad-room",
      JSON.stringify({
        roomId: "bad-room",
        role: "host",
        token: { ...HOST_TOKEN, roomId: "different-room" },
      }),
    );

    expect(loadRoomSession(storage, "bad-room")).toBeNull();

    clearRoomSession(storage, ROOM_ID);

    expect(loadRoomSession(storage, ROOM_ID)).toBeNull();
  });
});

class MapStorage implements Storage {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function parseTestRoomId(roomId: string) {
  const parsed = parseRoomId(roomId);

  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }

  return parsed.roomId;
}

function parseTestToken(roomId: string): RoomCapabilityToken {
  const parsed = parseCapabilityToken({
    role: "host",
    roomId,
    secret: "a".repeat(64),
  });

  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }

  return parsed.token;
}
