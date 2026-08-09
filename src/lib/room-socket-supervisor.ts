/**
 * Reconnect + heartbeat supervisor for the room WebSocket.
 *
 * The room socket is a receive-only server→client broadcast channel (game
 * mutations travel over HTTP POST — see `room-client.ts`). Because it is
 * receive-only, a dropped socket does not just lose the *next* update: the
 * server derives player presence from live sockets, so a client that never
 * reconnects is permanently reported as offline, which then blocks
 * `START_ROOM` / non-final `ADVANCE_ROUND` for the other player forever.
 *
 * This module owns the transport lifecycle only — opening, closing,
 * reconnect backoff, and the ping/pong watchdog. It has no knowledge of
 * rooms, sessions, or snapshots; the caller supplies a `connect()` factory
 * and receives raw message payloads via `onMessage`. Keeping it framework-
 * and protocol-agnostic (aside from the heartbeat's ping/pong strings)
 * makes it possible to exercise backoff timing and watchdog behavior with
 * fake timers, independent of React.
 */

import { ROOM_SOCKET_PING_MESSAGE, ROOM_SOCKET_PONG_MESSAGE } from "./room-client";

export type RoomSocketSupervisorStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export type RoomSocketCloseInfo = Readonly<{
  code: number;
  reason: string;
  wasClean: boolean;
}>;

export type BackoffConfig = Readonly<{
  /** Delay before the first retry, in ms. Doubles on each subsequent attempt. */
  baseDelayMs: number;
  /** Upper bound on the (pre-jitter) exponential delay, in ms. */
  maxDelayMs: number;
}>;

export type HeartbeatConfig = Readonly<{
  /** How often to send a ping while the socket is open, in ms. */
  intervalMs: number;
  /** How long to wait for a pong before counting it as missed, in ms. */
  pongTimeoutMs: number;
  /** Consecutive missed pongs before the socket is declared dead. */
  missedPongThreshold: number;
  /** Raw text frame sent as a ping (not JSON — matches the edge auto-responder). */
  pingMessage: string;
  /** Raw text frame expected back as a pong (not JSON). */
  pongMessage: string;
}>;

/**
 * Full jitter, 500ms → 8s ceiling. Full (not equal) jitter matters here:
 * both players in a duel are likely to drop off the same shared network
 * event (e.g. a Wi-Fi blip), and equal jitter would leave them retrying in
 * near-lockstep, repeatedly colliding on the same edge capacity.
 */
export const DEFAULT_RECONNECT_BACKOFF: BackoffConfig = {
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

/**
 * 5s ping interval, 2s pong deadline, 2-miss threshold. Still comfortably
 * under the ~60s idle timeout common to proxies and mobile NAT (that
 * headroom was the old 20s interval's whole justification, and 5s only
 * widens it), while keeping the client's own worst-case dead-socket
 * detection window short enough to self-heal inside the shortest turn
 * clock — see `DEAD_SOCKET_RECOVERY_BUDGET_MS` below for the arithmetic
 * this is sized against, and F-06 in specs/room-domain.md for why
 * choosingSide (30s, the shortest phase) makes that budget urgent: a
 * disconnected trader who cannot detect and recover from their own dead
 * socket before that clock expires settles at whichever side is worse for
 * them, with PnL bounded only by the item's true value, not a flat
 * forfeit.
 *
 * A truly dead socket is caught within `intervalMs +
 * missedPongThreshold * pongTimeoutMs` of going silent (see
 * `handleMissedPong` below, which retries the very next ping immediately
 * on a miss rather than waiting out another full interval — the previous
 * implementation did the latter, which quietly doubled the advertised ~40s
 * worst case to ~60s; the retry-cadence fix is what makes this comment's
 * arithmetic and the code agree).
 *
 * This does not wait on the browser to notice a zombie TCP connection
 * (which can take minutes, or never, on some networks).
 */
export const DEFAULT_ROOM_SOCKET_HEARTBEAT: HeartbeatConfig = {
  intervalMs: 5_000,
  pongTimeoutMs: 2_000,
  missedPongThreshold: 2,
  pingMessage: ROOM_SOCKET_PING_MESSAGE,
  pongMessage: ROOM_SOCKET_PONG_MESSAGE,
};

/**
 * Worst-case time for the watchdog to notice an already-open socket has
 * gone silent (dead Wi-Fi radio, closed laptop lid, network black hole —
 * anything that never delivers a close frame), measured from the instant
 * the connection actually dies:
 *
 *   - Up to a full `intervalMs` can elapse before the next ping is even
 *     attempted, if the connection dies right after the previous
 *     successful pong reset the schedule.
 *   - Each of the `missedPongThreshold` ping attempts that follow then
 *     waits the full `pongTimeoutMs` before being counted as missed and
 *     (below the threshold) retried immediately — see the retry-cadence
 *     note on `DEFAULT_ROOM_SOCKET_HEARTBEAT` above.
 *
 *   worst-case detection = intervalMs + missedPongThreshold * pongTimeoutMs
 *                         = 5_000 + 2 * 2_000 = 9_000ms
 */
export const HEARTBEAT_WORST_CASE_DETECTION_MS =
  DEFAULT_ROOM_SOCKET_HEARTBEAT.intervalMs +
  DEFAULT_ROOM_SOCKET_HEARTBEAT.missedPongThreshold * DEFAULT_ROOM_SOCKET_HEARTBEAT.pongTimeoutMs;

/**
 * Once the watchdog declares the socket dead, `scheduleReconnect` waits a
 * backed-off delay before opening the replacement — see
 * `computeReconnectDelayMs`. For the very first retry (attempt 0) that
 * delay is `random() * min(baseDelayMs, maxDelayMs)`, i.e. strictly less
 * than `baseDelayMs`; used here as the (inclusive) worst-case bound.
 */
export const RECONNECT_BACKOFF_WORST_CASE_MS = DEFAULT_RECONNECT_BACKOFF.baseDelayMs;

/**
 * Not derived from any constant in this module: there is no enforced
 * timeout on the WebSocket handshake itself (browsers do not expose one,
 * and this supervisor does not currently impose its own — see the "remaining
 * risk" note in the PR that added this budget). This is a documented
 * *assumption*, not a guarantee: a generous upper bound on how long a
 * healthy reconnect's TLS + WebSocket upgrade should take, plus the
 * snapshot resync that rides along with it for free (the Durable Object
 * sends the full `ROOM_SNAPSHOT` synchronously as part of accepting the
 * socket — see `server.send(roomSnapshotSocketMessage(...))` in
 * src/worker/index.ts — so resync is not a separate round trip to budget
 * for). If a real-world connect ever hangs well past this on a live-but-
 * degraded network, this budget under-counts that specific case; it does
 * not cover a hung handshake, only a socket that was open and went silent.
 */
export const ASSUMED_SOCKET_OPEN_MS = 3_000;

/**
 * Total worst-case time for a player whose already-open socket just died
 * to self-heal — detect it, back off, reopen, and be resynced — without
 * any user action. This is the number that must fit inside
 * `MIN_TURN_DURATION_MS` (src/lib/game/types.ts) with real margin, not
 * just barely: see turn-clock-recovery-budget.test.ts, which pins the
 * inequality so shortening a turn phase or loosening the heartbeat above
 * fails a named test instead of reaching production silently.
 *
 *   9_000 (detection) + 500 (backoff) + 3_000 (assumed open) = 12_500ms
 */
export const DEAD_SOCKET_RECOVERY_BUDGET_MS =
  HEARTBEAT_WORST_CASE_DETECTION_MS + RECONNECT_BACKOFF_WORST_CASE_MS + ASSUMED_SOCKET_OPEN_MS;

/**
 * A separate, DELIBERATELY-not-derived-from-`intervalMs` constant for a
 * server-side liveness sweep (an open branch's F-08) to consume instead of
 * computing its own threshold as a multiple of the client's ping cadence.
 *
 * Why this exists: F-08 (not in this worktree) currently defines its
 * eviction threshold as `3 × DEFAULT_ROOM_SOCKET_HEARTBEAT.intervalMs`.
 * That was a reasonable derivation when intervalMs was 20s (a 60s
 * threshold) — comfortably above the ~60s a backgrounded tab's timers can
 * go throttled by the browser (Chrome and others cap background timers to
 * roughly one firing per minute), so a merely-backgrounded-but-alive tab
 * would not get evicted. Tightening intervalMs to 5s to close the
 * dead-socket-detection gap this file's `DEAD_SOCKET_RECOVERY_BUDGET_MS`
 * exists to close would, under that `3×` formula, shrink the server's
 * eviction threshold to 15s — well inside a single throttled background
 * interval — and start evicting live-but-backgrounded tabs, converting an
 * accidental disconnect into a *guaranteed* one on every tab switch.
 *
 * The two concerns are sized for different jobs (how fast can *this*
 * client notice its *own* socket died, vs. how long should the server
 * tolerate silence from a tab it cannot ask to hurry up) and should not
 * share one constant. This value keeps the previous, already-reasoned-
 * about 60s server-side tolerance; F-08 should read this constant instead
 * of deriving `3 × intervalMs`.
 */
export const SERVER_PRESENCE_LIVENESS_TIMEOUT_MS = 60_000;

/** Close code the watchdog uses when it force-closes a non-responsive socket. */
export const HEARTBEAT_TIMEOUT_CLOSE_CODE = 4000;

/**
 * Deliberate, non-retryable close codes:
 *  - 1000: intentional teardown (effect cleanup, session change) — the
 *    caller is the one who closed the socket and does not want it back.
 *  - 1008: the server evicted this socket for policy reasons — either this
 *    seat opened a new socket elsewhere (so reconnecting here would just
 *    evict that new socket right back, and two tabs would fight forever),
 *    or the seat itself was vacated (kicked guest, lobby reset). Retrying
 *    against a room you've been removed from is exactly the request-storm
 *    failure mode this supervisor exists to avoid, so 1008 is terminal.
 * Every other code (network drop, no close frame, server error, the
 * watchdog's own HEARTBEAT_TIMEOUT_CLOSE_CODE) is treated as transient and
 * retried with unbounded, backed-off attempts.
 */
export function isRetryableRoomSocketCloseCode(code: number): boolean {
  return code !== 1000 && code !== 1008;
}

/**
 * attempt=0 is the first retry. Delay is `random() * min(maxDelayMs, base * 2^attempt)`
 * — full jitter, so the range starts at 0, not `baseDelayMs`.
 */
export function computeReconnectDelayMs(
  attempt: number,
  backoff: BackoffConfig = DEFAULT_RECONNECT_BACKOFF,
  randomFn: () => number = Math.random,
): number {
  const exponential = backoff.baseDelayMs * 2 ** Math.max(0, attempt);
  const ceiling = Math.min(exponential, backoff.maxDelayMs);

  return Math.floor(randomFn() * ceiling);
}

type TimerHandle = ReturnType<typeof setTimeout>;
type TimeoutScheduler = (handler: () => void, delayMs: number) => TimerHandle;
type TimeoutCanceller = (handle: TimerHandle) => void;

export type RoomSocketSupervisorOptions = Readonly<{
  /** Opens a brand-new socket for the current room/session. Called once per attempt. */
  connect: () => WebSocket;
  /** Called for every message that is not a recognized heartbeat pong frame. */
  onMessage: (data: unknown) => void;
  onOpen?: () => void;
  onStatusChange?: (status: RoomSocketSupervisorStatus) => void;
  /** Decides whether a given close should be retried. Defaults to {@link isRetryableRoomSocketCloseCode}. */
  isRetryableClose?: (info: RoomSocketCloseInfo) => boolean;
  /** Called exactly once, when a close is judged non-retryable and the supervisor stops for good. */
  onGiveUp?: (info: RoomSocketCloseInfo) => void;
  backoff?: Partial<BackoffConfig>;
  /** Pass `false` to disable the heartbeat watchdog entirely (e.g. in tests). */
  heartbeat?: Partial<HeartbeatConfig> | false;
  randomFn?: () => number;
  setTimeoutFn?: TimeoutScheduler;
  clearTimeoutFn?: TimeoutCanceller;
}>;

/**
 * Owns exactly one live socket at a time. A close either schedules a single
 * future reconnect attempt (never more than one pending timer) or gives up
 * for good — it never opens a second socket while one is already open or
 * connecting, so it cannot race itself into two concurrent live sockets.
 */
export class RoomSocketSupervisor {
  private readonly connect: () => WebSocket;
  private readonly onMessageCallback: (data: unknown) => void;
  private readonly onOpenCallback?: () => void;
  private readonly onStatusChangeCallback?: (status: RoomSocketSupervisorStatus) => void;
  private readonly isRetryableClose: (info: RoomSocketCloseInfo) => boolean;
  private readonly onGiveUpCallback?: (info: RoomSocketCloseInfo) => void;
  private readonly backoff: BackoffConfig;
  private readonly heartbeat: HeartbeatConfig | null;
  private readonly randomFn: () => number;
  private readonly scheduleTimeout: TimeoutScheduler;
  private readonly cancelTimeout: TimeoutCanceller;

  private socket: WebSocket | null = null;
  private generation = 0;
  private attempt = 0;
  private disposed = false;
  private started = false;
  private reconnectTimer: TimerHandle | null = null;
  private pingTimer: TimerHandle | null = null;
  private pongDeadlineTimer: TimerHandle | null = null;
  private missedPongs = 0;
  private lastStatus: RoomSocketSupervisorStatus | null = null;

  constructor(options: RoomSocketSupervisorOptions) {
    this.connect = options.connect;
    this.onMessageCallback = options.onMessage;
    this.onOpenCallback = options.onOpen;
    this.onStatusChangeCallback = options.onStatusChange;
    this.isRetryableClose = options.isRetryableClose ?? ((info) => isRetryableRoomSocketCloseCode(info.code));
    this.onGiveUpCallback = options.onGiveUp;
    this.backoff = { ...DEFAULT_RECONNECT_BACKOFF, ...options.backoff };
    this.heartbeat =
      options.heartbeat === false
        ? null
        : { ...DEFAULT_ROOM_SOCKET_HEARTBEAT, ...options.heartbeat };
    this.randomFn = options.randomFn ?? Math.random;
    this.scheduleTimeout = options.setTimeoutFn ?? ((handler, delayMs) => setTimeout(handler, delayMs));
    this.cancelTimeout = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }

  /** Number of consecutive failed reconnect attempts since the last successful open. */
  get attemptCount(): number {
    return this.attempt;
  }

  get status(): RoomSocketSupervisorStatus | null {
    return this.lastStatus;
  }

  /** Opens the first socket. No-op if already started or disposed. */
  start(): void {
    if (this.disposed || this.started) {
      return;
    }

    this.started = true;
    this.attempt = 0;
    this.openAttempt("connecting");
  }

  /**
   * Intentional, permanent teardown: clears every pending timer and closes
   * the live socket (if any) with code 1000, which the close handler
   * recognizes as non-retryable via `disposed` — no reconnect is scheduled.
   * Safe to call multiple times (effect cleanup can run more than once in
   * dev-mode double-invoke).
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimers();
    this.closeCurrentSocket(1000, "supervisor disposed");
  }

  /**
   * Closes the current socket (if any) with an application-supplied code,
   * routing through the normal close handler — unlike `dispose()`, this is
   * not necessarily final: if `code` is retryable per `isRetryableClose`,
   * a reconnect is scheduled exactly as it would be for a server- or
   * network-initiated close with the same code. No-op if there is no
   * live/connecting socket.
   */
  close(code?: number, reason?: string): void {
    if (this.disposed || this.socket === null) {
      return;
    }

    this.closeCurrentSocket(code ?? 1000, reason ?? "");
  }

  /**
   * Bypasses the backoff wait and reconnects immediately. Intended for
   * `visibilitychange`→visible and `online` triggers. No-op if disposed, if
   * there is no pending backoff timer (i.e. we are not currently waiting —
   * either already connected/connecting, or permanently given up), so it
   * can never create a second socket alongside a live or in-flight one.
   */
  reconnectNow(): void {
    if (this.disposed || this.reconnectTimer === null || this.socket !== null) {
      return;
    }

    this.cancelTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.openAttempt("reconnecting");
  }

  private openAttempt(status: RoomSocketSupervisorStatus): void {
    this.generation += 1;
    const generation = this.generation;

    this.emitStatus(status);

    const socket = this.connect();
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (generation !== this.generation || this.disposed) {
        return;
      }

      this.attempt = 0;
      this.emitStatus("connected");
      this.startHeartbeat(generation);
      this.onOpenCallback?.();
    });

    socket.addEventListener("message", (event) => {
      if (generation !== this.generation) {
        return;
      }

      if (this.consumeHeartbeatMessage(event.data, generation)) {
        return;
      }

      this.onMessageCallback(event.data);
    });

    socket.addEventListener("close", (event) => {
      if (generation !== this.generation) {
        return;
      }

      this.socket = null;
      this.clearHeartbeatTimers();

      if (this.disposed) {
        return;
      }

      const info: RoomSocketCloseInfo = {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      };

      if (!this.isRetryableClose(info)) {
        this.emitStatus("disconnected");
        this.onGiveUpCallback?.(info);
        return;
      }

      this.scheduleReconnect();
    });

    // The close event carries the actionable code/reason; "error" fires
    // alongside a subsequent close on every runtime we target, so it is
    // intentionally left unhandled here to avoid double-scheduling a retry.
    socket.addEventListener("error", () => {});
  }

  private scheduleReconnect(): void {
    if (this.disposed) {
      return;
    }

    this.emitStatus("reconnecting");

    const delay = computeReconnectDelayMs(this.attempt, this.backoff, this.randomFn);
    this.attempt += 1;

    this.reconnectTimer = this.scheduleTimeout(() => {
      this.reconnectTimer = null;
      this.openAttempt("reconnecting");
    }, delay);
  }

  private startHeartbeat(generation: number): void {
    if (this.heartbeat === null) {
      return;
    }

    this.missedPongs = 0;
    this.schedulePing(generation);
  }

  private schedulePing(generation: number): void {
    if (this.heartbeat === null) {
      return;
    }

    this.pingTimer = this.scheduleTimeout(() => {
      this.pingTimer = null;

      if (generation !== this.generation || this.socket === null) {
        return;
      }

      this.sendPing(generation);
    }, this.heartbeat.intervalMs);
  }

  private sendPing(generation: number): void {
    if (this.heartbeat === null || this.socket === null) {
      return;
    }

    try {
      this.socket.send(this.heartbeat.pingMessage);
    } catch {
      // A send failure here means the socket is already on its way down;
      // the close handler will pick it up and schedule a reconnect.
      return;
    }

    this.pongDeadlineTimer = this.scheduleTimeout(() => {
      this.pongDeadlineTimer = null;

      if (generation !== this.generation) {
        return;
      }

      this.handleMissedPong(generation);
    }, this.heartbeat.pongTimeoutMs);
  }

  private handleMissedPong(generation: number): void {
    if (this.heartbeat === null) {
      return;
    }

    this.missedPongs += 1;

    if (this.missedPongs >= this.heartbeat.missedPongThreshold) {
      // Declare the socket dead ourselves rather than waiting for the
      // browser to notice a zombie TCP connection. This close falls
      // through to the normal (retryable) close handling above, which
      // schedules a reconnect — the watchdog never decides to give up.
      this.closeCurrentSocket(HEARTBEAT_TIMEOUT_CLOSE_CODE, "heartbeat timeout");
      return;
    }

    // Retry immediately, not after another full `intervalMs` wait: this is
    // what makes worst-case detection `intervalMs + missedPongThreshold *
    // pongTimeoutMs` (see `HEARTBEAT_WORST_CASE_DETECTION_MS`) rather than
    // `missedPongThreshold * (intervalMs + pongTimeoutMs)`. Going through
    // `schedulePing` here (as an earlier version of this method did) would
    // add a full extra `intervalMs` of silence per miss before this retry
    // even attempted a ping — for the old 20s/10s config that quietly
    // doubled the ~40s worst case documented on
    // `DEFAULT_ROOM_SOCKET_HEARTBEAT` to ~60s.
    if (this.socket !== null) {
      this.sendPing(generation);
    }
  }

  /**
   * Pong frames are raw, non-JSON text ("tt-pong") — they must be
   * intercepted here, before `onMessage` (and therefore before the
   * caller's JSON parser) ever sees them. Returns true if the frame was a
   * pong and has been fully handled.
   */
  private consumeHeartbeatMessage(data: unknown, generation: number): boolean {
    if (this.heartbeat === null || typeof data !== "string" || data !== this.heartbeat.pongMessage) {
      return false;
    }

    this.missedPongs = 0;

    if (this.pongDeadlineTimer !== null) {
      this.cancelTimeout(this.pongDeadlineTimer);
      this.pongDeadlineTimer = null;
    }

    this.schedulePing(generation);

    return true;
  }

  private closeCurrentSocket(code: number, reason: string): void {
    const socket = this.socket;

    if (socket === null) {
      return;
    }

    try {
      socket.close(code, reason);
    } catch {
      // Already closing/closed — the close handler (if it hasn't already
      // fired) will settle bookkeeping.
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.cancelTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHeartbeatTimers(): void {
    if (this.pingTimer !== null) {
      this.cancelTimeout(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.pongDeadlineTimer !== null) {
      this.cancelTimeout(this.pongDeadlineTimer);
      this.pongDeadlineTimer = null;
    }
  }

  private emitStatus(status: RoomSocketSupervisorStatus): void {
    this.lastStatus = status;
    this.onStatusChangeCallback?.(status);
  }
}
