import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RECONNECT_BACKOFF,
  HEARTBEAT_TIMEOUT_CLOSE_CODE,
  RoomSocketSupervisor,
  computeReconnectDelayMs,
  isRetryableRoomSocketCloseCode,
  type RoomSocketCloseInfo,
  type RoomSocketSupervisorOptions,
  type RoomSocketSupervisorStatus,
} from "./room-socket-supervisor";

// ---------------------------------------------------------------------------
// A minimal, fully test-controlled WebSocket stand-in. Unlike a real
// WebSocket, `close()` here only *records* the call — it does not
// synchronously (or asynchronously) fire a close event. Tests drive the
// close event explicitly via `triggerClose()`, which mirrors how a real
// socket's close is always asynchronous relative to the call that caused it
// (network drop, server eviction, or our own `.close()` call) and keeps
// backoff/watchdog assertions deterministic under fake timers.
// ---------------------------------------------------------------------------

class FakeWebSocket extends EventTarget {
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  triggerOpen(): void {
    this.dispatchEvent(new Event("open"));
  }

  triggerMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  triggerClose(code = 1000, reason = "", wasClean = true): void {
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
  }
}

function createHarness(overrides: Partial<RoomSocketSupervisorOptions> = {}) {
  const sockets: FakeWebSocket[] = [];
  const statuses: RoomSocketSupervisorStatus[] = [];
  const messages: unknown[] = [];
  const giveUps: RoomSocketCloseInfo[] = [];

  const supervisor = new RoomSocketSupervisor({
    connect: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    onGiveUp: (info) => giveUps.push(info),
    onMessage: (data) => messages.push(data),
    onStatusChange: (status) => statuses.push(status),
    randomFn: () => 0.5,
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
    ...overrides,
  });

  return { supervisor, sockets, statuses, messages, giveUps };
}

describe("computeReconnectDelayMs", () => {
  it("is 0 at the floor of the jitter range (random() = 0)", () => {
    expect(computeReconnectDelayMs(0, DEFAULT_RECONNECT_BACKOFF, () => 0)).toBe(0);
    expect(computeReconnectDelayMs(5, DEFAULT_RECONNECT_BACKOFF, () => 0)).toBe(0);
  });

  it("scales exponentially with attempt, before the ceiling", () => {
    // attempt 0: base * 2^0 = 500 -> full jitter range [0, 500)
    expect(computeReconnectDelayMs(0, DEFAULT_RECONNECT_BACKOFF, () => 0.999)).toBeLessThan(500);
    expect(computeReconnectDelayMs(0, DEFAULT_RECONNECT_BACKOFF, () => 0.999)).toBeGreaterThan(490);

    // attempt 1: base * 2^1 = 1000
    expect(computeReconnectDelayMs(1, DEFAULT_RECONNECT_BACKOFF, () => 0.999)).toBeGreaterThan(990);
    expect(computeReconnectDelayMs(1, DEFAULT_RECONNECT_BACKOFF, () => 0.999)).toBeLessThan(1000);
  });

  it("never exceeds the 8s ceiling regardless of attempt count", () => {
    const delay = computeReconnectDelayMs(20, DEFAULT_RECONNECT_BACKOFF, () => 0.999999);
    expect(delay).toBeLessThan(8_000);
    expect(delay).toBeGreaterThan(7_900);
  });

  it("uses full jitter, not equal jitter — the low end of the range is 0, not half the ceiling", () => {
    // Equal jitter would floor at ceiling/2; full jitter floors at 0.
    expect(computeReconnectDelayMs(3, DEFAULT_RECONNECT_BACKOFF, () => 0)).toBe(0);
  });
});

describe("isRetryableRoomSocketCloseCode", () => {
  it("treats 1000 (intentional teardown) and 1008 (seat evicted) as terminal", () => {
    expect(isRetryableRoomSocketCloseCode(1000)).toBe(false);
    expect(isRetryableRoomSocketCloseCode(1008)).toBe(false);
  });

  it("treats network drops, server errors, and the heartbeat timeout code as retryable", () => {
    expect(isRetryableRoomSocketCloseCode(1006)).toBe(true);
    expect(isRetryableRoomSocketCloseCode(1011)).toBe(true);
    expect(isRetryableRoomSocketCloseCode(HEARTBEAT_TIMEOUT_CLOSE_CODE)).toBe(true);
  });
});

describe("RoomSocketSupervisor reconnect behavior (T-2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reopens after a drop, applies the caller's snapshot handling on the new socket, and reports connecting -> connected", () => {
    const { supervisor, sockets, statuses } = createHarness({ heartbeat: false });

    supervisor.start();
    expect(statuses).toEqual(["connecting"]);
    expect(sockets).toHaveLength(1);

    sockets[0].triggerOpen();
    expect(statuses).toEqual(["connecting", "connected"]);
  });

  it("schedules a single backed-off reconnect after an unintentional close, and the attempt counter resets after a successful open (T-2)", () => {
    const { supervisor, sockets, statuses, messages } = createHarness({ heartbeat: false });

    supervisor.start();
    sockets[0].triggerOpen();
    expect(supervisor.attemptCount).toBe(0);

    // Network drop: no close code we control, so use 1006 (abnormal closure).
    sockets[0].triggerClose(1006, "", false);
    expect(statuses.at(-1)).toBe("reconnecting");
    expect(supervisor.attemptCount).toBe(1);

    // Backoff delay for attempt 0 is random()*500 = 250ms with the fixed
    // randomFn(0.5) the harness uses. Nothing should reconnect before then.
    vi.advanceTimersByTime(249);
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    // The reconnect applies the server's full snapshot on the new socket —
    // simulate the server sending the missed revision on reopen.
    sockets[1].triggerOpen();
    expect(statuses.at(-1)).toBe("connected");
    expect(supervisor.attemptCount).toBe(0);

    sockets[1].triggerMessage(JSON.stringify({ type: "ROOM_SNAPSHOT", room: { revision: 7 } }));
    expect(messages).toEqual([JSON.stringify({ type: "ROOM_SNAPSHOT", room: { revision: 7 } })]);
  });

  it("backs off further on each consecutive failed attempt (exponential growth)", () => {
    const { supervisor, sockets } = createHarness({ heartbeat: false });

    supervisor.start();
    sockets[0].triggerClose(1006, "", false); // attempt 0 -> delay ~250ms, attemptCount becomes 1
    expect(supervisor.attemptCount).toBe(1);

    vi.advanceTimersByTime(250);
    expect(sockets).toHaveLength(2);

    sockets[1].triggerClose(1006, "", false); // attempt 1 -> delay ~500ms (1000 * 0.5), attemptCount becomes 2
    expect(supervisor.attemptCount).toBe(2);

    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
  });

  it("retries unboundedly — never gives up after repeated drops", () => {
    const { supervisor, sockets, giveUps } = createHarness({ heartbeat: false });

    supervisor.start();

    for (let i = 0; i < 10; i += 1) {
      const socket = sockets.at(-1)!;
      socket.triggerClose(1006, "", false);
      vi.advanceTimersByTime(DEFAULT_RECONNECT_BACKOFF.maxDelayMs);
    }

    expect(sockets).toHaveLength(11);
    expect(giveUps).toHaveLength(0);
  });

  it("does not reconnect after a deliberate 1000 close (session change / unmount)", () => {
    const { supervisor, sockets, statuses } = createHarness({ heartbeat: false });

    supervisor.start();
    sockets[0].triggerOpen();
    sockets[0].triggerClose(1000, "room session changed", true);

    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(statuses.at(-1)).not.toBe("reconnecting");
  });

  it("dispose() closes the live socket with code 1000 and cancels any pending reconnect timer", () => {
    const { supervisor, sockets } = createHarness({ heartbeat: false });

    supervisor.start();
    sockets[0].triggerClose(1006, "", false); // schedules a reconnect

    supervisor.dispose();
    vi.advanceTimersByTime(60_000);

    // Only the original socket exists; disposing before the backoff timer
    // fires must cancel it, not just close a (non-existent) live socket.
    expect(sockets).toHaveLength(1);
  });

  it("dispose() is idempotent (safe to call twice, e.g. React StrictMode double-invoke)", () => {
    const { supervisor, sockets } = createHarness({ heartbeat: false });

    supervisor.start();
    sockets[0].triggerOpen();

    expect(() => {
      supervisor.dispose();
      supervisor.dispose();
    }).not.toThrow();
    expect(sockets[0].closeCalls).toHaveLength(1);
  });

  it("reconnectNow bypasses the backoff wait", () => {
    const { supervisor, sockets } = createHarness({ heartbeat: false });

    supervisor.start();
    sockets[0].triggerClose(1006, "", false);
    expect(sockets).toHaveLength(1);

    supervisor.reconnectNow();
    expect(sockets).toHaveLength(2);

    // The now-cancelled backoff timer must not fire a second, redundant attempt.
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
  });

  it("reconnectNow is a no-op while a socket is already live or connecting — it cannot create a second concurrent socket", () => {
    const { supervisor, sockets } = createHarness({ heartbeat: false });

    supervisor.start();
    supervisor.reconnectNow(); // still connecting, no pending backoff timer
    expect(sockets).toHaveLength(1);

    sockets[0].triggerOpen();
    supervisor.reconnectNow(); // connected, no pending backoff timer
    expect(sockets).toHaveLength(1);
  });
});

describe("RoomSocketSupervisor terminal (1008) close handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not reconnect-loop after a 1008 (seat evicted / opened elsewhere) close", () => {
    const { supervisor, sockets, giveUps, statuses } = createHarness({ heartbeat: false });

    supervisor.start();
    sockets[0].triggerOpen();
    sockets[0].triggerClose(1008, "Room seat changed.", true);

    expect(giveUps).toEqual([{ code: 1008, reason: "Room seat changed.", wasClean: true }]);
    expect(statuses.at(-1)).toBe("disconnected");

    // The critical assertion: no amount of waiting opens another socket
    // against a room this session has been evicted from.
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets).toHaveLength(1);
  });

  it("close() routes a caller-initiated close through the same terminal path as a server-initiated one", () => {
    const { supervisor, sockets, giveUps } = createHarness({ heartbeat: false });

    supervisor.start();
    sockets[0].triggerOpen();

    supervisor.close(1008, "guest seat changed");
    expect(sockets[0].closeCalls).toEqual([{ code: 1008, reason: "guest seat changed" }]);

    sockets[0].triggerClose(1008, "guest seat changed", true);
    expect(giveUps).toHaveLength(1);

    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});

describe("RoomSocketSupervisor heartbeat watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a raw ping on the configured interval", () => {
    const { supervisor, sockets } = createHarness();

    supervisor.start();
    sockets[0].triggerOpen();

    vi.advanceTimersByTime(20_000);
    expect(sockets[0].sent).toEqual(["tt-ping"]);
  });

  it("a received pong resets the missed counter and does not surface an error or reach onMessage", () => {
    const { supervisor, sockets, messages } = createHarness();

    supervisor.start();
    sockets[0].triggerOpen();
    vi.advanceTimersByTime(20_000); // first ping sent

    sockets[0].triggerMessage("tt-pong");

    // The pong must never reach the caller's onMessage (and therefore never
    // its JSON parser / "unreadable room update" error path).
    expect(messages).toEqual([]);
  });

  it("a real JSON message is still delivered to onMessage as normal", () => {
    const { supervisor, sockets, messages } = createHarness();

    supervisor.start();
    sockets[0].triggerOpen();

    const payload = JSON.stringify({ type: "ROOM_SNAPSHOT", room: { revision: 1 } });
    sockets[0].triggerMessage(payload);
    expect(messages).toEqual([payload]);
  });

  it("one missed pong alone does not close the socket", () => {
    const { supervisor, sockets } = createHarness();

    supervisor.start();
    sockets[0].triggerOpen();

    vi.advanceTimersByTime(20_000); // ping #1 sent
    vi.advanceTimersByTime(10_000); // pong deadline #1 elapses, unanswered

    expect(sockets[0].closeCalls).toHaveLength(0);
  });

  it("two consecutive missed pongs close the socket with the heartbeat timeout code, and the supervisor (not the watchdog) reconnects", () => {
    const { supervisor, sockets, statuses } = createHarness();

    supervisor.start();
    sockets[0].triggerOpen();

    vi.advanceTimersByTime(20_000); // ping #1
    vi.advanceTimersByTime(10_000); // missed #1
    vi.advanceTimersByTime(20_000); // ping #2
    vi.advanceTimersByTime(10_000); // missed #2 -> close

    expect(sockets[0].closeCalls).toEqual([{ code: HEARTBEAT_TIMEOUT_CLOSE_CODE, reason: "heartbeat timeout" }]);

    // The watchdog only closes the socket; it never decides to give up —
    // the resulting close event must flow through the normal retryable path.
    sockets[0].triggerClose(HEARTBEAT_TIMEOUT_CLOSE_CODE, "heartbeat timeout", false);
    expect(statuses.at(-1)).toBe("reconnecting");
  });

  it("a pong before the deadline cancels the miss and the next cycle starts fresh (no cumulative miss across cycles)", () => {
    const { supervisor, sockets } = createHarness();

    supervisor.start();
    sockets[0].triggerOpen();

    vi.advanceTimersByTime(20_000); // ping #1
    vi.advanceTimersByTime(5_000);
    sockets[0].triggerMessage("tt-pong"); // answered in time

    vi.advanceTimersByTime(20_000); // ping #2
    vi.advanceTimersByTime(10_000); // missed #1 of this cycle only

    expect(sockets[0].closeCalls).toHaveLength(0);
  });

  it("heartbeat timers are cleared on dispose (no leaked timers across unmount)", () => {
    const { supervisor, sockets } = createHarness();

    supervisor.start();
    sockets[0].triggerOpen();
    supervisor.dispose();

    const pendingBefore = vi.getTimerCount();
    vi.advanceTimersByTime(60_000);
    // No ping should have been sent post-dispose, and no new timers created.
    expect(sockets[0].sent).toEqual([]);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(pendingBefore);
  });
});
