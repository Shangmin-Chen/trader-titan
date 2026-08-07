"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ActionLog,
  CopyButton,
  CustomAmazonQueryForm,
  CustomSelect,
  GameShell,
  ItemPanel,
  LiveAnnouncerProvider,
  MarketRangeForm,
  PhaseStepper,
  Scoreboard,
  SettlementPanel,
  SpreadWidthForm,
  TradeActionPanel,
  TurnBanner,
  WidthNegotiationPanel,
  useAnnouncer,
  type PhaseStep,
} from "../components";
import {
  GAME_MODES,
  MAX_ROUNDS,
  formatSignedNumber,
  parseNumericInput,
  validateStartGame,
  type GameMode,
  type PlayerId,
  type Quote,
  type StartGamePayload,
  type TradeSide,
} from "../lib/game";
import type {
  PublicRoomInvitePreview,
  PublicRoomGameState,
  PublicRoomSnapshot,
  RoomGameConfig,
} from "../lib/room";
import {
  accessRoom,
  clearRoomSession,
  createRoom,
  getRoomPreview,
  ITEM_GENERATION_REQUEST_TIMEOUT_MS,
  joinRoom,
  loadRoomSession,
  openRoomSocket,
  roomSessionFromToken,
  RoomClientRequestError,
  saveRoomSession,
  sendRoomCommand,
  submitCustomAmazonItem as submitRoomCustomAmazonItem,
  type RoomClientCommand,
  type RoomClientOptions,
  type RoomSession,
  type RoomSocketMessage,
} from "../lib/room-client";
import {
  RoomSocketSupervisor,
  type RoomSocketSupervisorStatus,
} from "../lib/room-socket-supervisor";
import styles from "./page.module.css";

// ---------------------------------------------------------------------------
// Round-flow phase stepper configuration
// ---------------------------------------------------------------------------

const ROUND_STEPS: PhaseStep[] = [
  { id: "width", label: "Width" },
  { id: "negotiate", label: "Negotiate" },
  { id: "market", label: "Market" },
  { id: "trade", label: "Trade" },
  { id: "settle", label: "Settle" },
];

/**
 * Maps a game phase to the corresponding round-flow step ID.
 * Returns null for phases that are outside the per-round flow
 * (setup, gameOver, unknown).
 */
function phaseToStepId(phase: string): string | null {
  switch (phase) {
    case "generatingItem":
    case "proposingWidth":
      return "width";
    case "negotiatingWidth":
      return "negotiate";
    case "configuringMarket":
      return "market";
    case "choosingSide":
      return "trade";
    case "settling":
    case "settlement":
      return "settle";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";
type LoadStatus = "loading" | "ready";
type CreateRoomFieldErrors = Partial<
  Record<"hostName" | "mode" | "totalRounds", string>
>;
type ClientCommandInput =
  | Readonly<{ type: "START_ROOM" }>
  | Readonly<{ type: "RESET_TO_LOBBY" }>
  | Readonly<{ type: "KICK_GUEST" }>
  | Readonly<{ type: "ADVANCE_ROUND" }>
  | Readonly<{ type: "RETRY_ITEM_GENERATION" }>
  | Readonly<{ type: "SUBMIT_INITIAL_WIDTH"; width: number }>
  | Readonly<{ type: "TIGHTEN_WIDTH"; width: number }>
  | Readonly<{ type: "TRADE_ON_WIDTH" }>
  | Readonly<{ type: "SUBMIT_MARKET_QUOTE"; quote: Quote }>
  | Readonly<{ type: "EXECUTE_TRADE"; side: TradeSide }>;

// Every command `type` string used for the per-command pending-state guard
// and for the disabled-state checks below is drawn from this union rather
// than a bare `string`, so a typo in an `isCommandPending(...)` call site
// (there are ~10 of them) is a compile error instead of a control that
// silently never gets gated.
type ClientCommandType = ClientCommandInput["type"];

// START_ROOM (round 1) and RETRY_ITEM_GENERATION are the only commands
// whose worker-side handling can run real, uncapped network calls
// (batched Gemini + sequential per-round Amazon lookups) synchronously in
// the request path — see ITEM_GENERATION_REQUEST_TIMEOUT_MS in
// room-client.ts for why they get a longer timeout than every other
// command here.
const ITEM_GENERATION_COMMAND_TYPES: ReadonlySet<ClientCommandType> = new Set([
  "START_ROOM",
  "RETRY_ITEM_GENERATION",
]);

// ---------------------------------------------------------------------------
// Root export — wraps the tree in LiveAnnouncerProvider so every descendant
// component (including HomeContent) can call useAnnouncer().
// ---------------------------------------------------------------------------

export default function Home() {
  return (
    <LiveAnnouncerProvider>
      <HomeContent />
    </LiveAnnouncerProvider>
  );
}

// ---------------------------------------------------------------------------
// HomeContent — the real page logic (formerly the Home function body).
// Lives inside LiveAnnouncerProvider so useAnnouncer() is safe to call here.
// ---------------------------------------------------------------------------

function HomeContent() {
  const { announce } = useAnnouncer();

  const [room, setRoomState] = useState<PublicRoomSnapshot | null>(null);
  const [preview, setPreview] = useState<PublicRoomInvitePreview | null>(null);
  const [session, setSession] = useState<RoomSession | null>(null);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  // Which room commands are currently in flight, keyed by command `type`.
  // Per-command (not a single global flag) so a hung command only disables
  // its own control — e.g. a stuck ADVANCE_ROUND must not take down the
  // unrelated "Reset lobby"/"Kick guest" controls in RoomControls. The ref
  // mirrors the state and is the actual source of truth for the
  // double-submit guard in runCommand: reading from state there would risk
  // a stale closure if the same command were submitted twice within the
  // same synchronous tick (e.g. two rapid click events processed before
  // React re-renders), which would defeat the guard. The state copy exists
  // purely to trigger re-renders so the UI reflects pending/idle per
  // control.
  const pendingCommandsRef = useRef<ReadonlySet<ClientCommandType>>(new Set());
  const [pendingCommands, setPendingCommands] = useState<
    ReadonlySet<ClientCommandType>
  >(new Set());
  const [isGeneratingCustomItem, setIsGeneratingCustomItem] = useState(false);
  const roomRef = useRef<PublicRoomSnapshot | null>(null);
  const setCurrentRoom = useCallback((nextRoom: PublicRoomSnapshot | null) => {
    roomRef.current = nextRoom;
    setRoomState(nextRoom);
  }, []);
  const applyCurrentRoomSnapshot = useCallback(
    (
      incoming: PublicRoomSnapshot,
      options?: ApplyPublicRoomSnapshotOptions,
    ): boolean => {
      const result = applyPublicRoomSnapshotMonotonically(
        roomRef.current,
        incoming,
        options,
      );

      if (!result.accepted) {
        return false;
      }

      roomRef.current = result.room;
      setRoomState(result.room);
      setPreview(previewFromSnapshot(result.room));
      return true;
    },
    [],
  );
  const socketRoomId = room?.id ?? null;
  const socketToken = session?.token ?? null;

  // ── Announce errors via the live region (in addition to role="alert") ──
  useEffect(() => {
    if (error) {
      announce(error, "assertive");
    }
  }, [error, announce]);

  // ── Announce game-phase transitions ──
  const prevGamePhaseRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const phase = room?.game?.phase;
    if (phase === prevGamePhaseRef.current) {
      return;
    }
    const prevPhase = prevGamePhaseRef.current;
    prevGamePhaseRef.current = phase;

    // Skip the very first mount — no transition has occurred yet.
    if (prevPhase === undefined) {
      return;
    }

    switch (phase) {
      case "setup":
        announce("Lobby reset");
        break;
      case "generatingItem":
        announce(`Round ${room?.game?.roundNumber ?? ""}: generating item`);
        break;
      case "proposingWidth":
        announce("Market maker is proposing the spread width");
        break;
      case "negotiatingWidth":
        announce("Trader: tighten or trade on the width");
        break;
      case "configuringMarket":
        announce("Market maker is setting the fixed-width market");
        break;
      case "choosingSide":
        announce("Trader: choose buy or sell");
        break;
      case "settling":
        announce("Trade executed — settling the round");
        break;
      case "settlement": {
        const g = room?.game;
        if (g?.phase === "settlement") {
          const traderName = g.players[g.settlement.trader].name;
          const pnl = g.settlement.traderPnL;
          const outcome = pnl > 0 ? "Profit" : pnl < 0 ? "Loss" : "Break even";
          announce(
            `Round ${g.roundNumber} settled. ${traderName} trader: ${outcome} ${formatSignedNumber(pnl)}`,
          );
        } else {
          announce(`Round ${room?.game?.roundNumber ?? ""} settled`);
        }
        break;
      }
      case "gameOver":
        announce("Game over");
        break;
    }
  }, [room, announce]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateRoomFromUrl() {
      const roomId = new URLSearchParams(window.location.search).get("room");

      if (!roomId) {
        setLoadStatus("ready");
        return;
      }

      try {
        const storedSession = loadRoomSession(window.sessionStorage, roomId);

        if (storedSession !== null) {
          try {
            const accessed = await accessRoom(roomId, {
              credential: storedSession.token,
            });

            if (cancelled) {
              return;
            }

            applyCurrentRoomSnapshot(accessed.room, { allowRoomSwitch: true });
            setSession(storedSession);
            setConnectionStatus("connecting");
            setError(null);
            return;
          } catch {
            clearRoomSession(window.sessionStorage, roomId);
          }
        }

        const response = await getRoomPreview(roomId);

        if (cancelled) {
          return;
        }

        setCurrentRoom(null);
        setPreview(response.room);
        setSession(null);
        setConnectionStatus("idle");
        setError(null);
      } catch (caughtError) {
        if (!cancelled) {
          setError(errorMessage(caughtError, "Room could not be loaded."));
        }
      } finally {
        if (!cancelled) {
          setLoadStatus("ready");
        }
      }
    }

    void hydrateRoomFromUrl();

    return () => {
      cancelled = true;
    };
  }, [applyCurrentRoomSnapshot, setCurrentRoom]);

  useEffect(() => {
    if (socketRoomId === null || socketToken === null) {
      return;
    }

    const roomId = socketRoomId;
    const token = socketToken;

    // A close is either retryable (network drop, server error, watchdog
    // timeout — anything that isn't the two deliberate codes below) or
    // terminal. 1008 is the server's "you no longer belong on this socket"
    // signal — either this seat opened a newer socket elsewhere, or the
    // seat itself was vacated (kicked guest, lobby reset). Retrying either
    // case would just hammer a room this session has been removed from (or
    // fight the newer socket for the seat), so it is never retried here;
    // `handleTerminalClose` below runs once to reconcile the stored
    // session instead. See RoomSocketSupervisor's module doc for the full
    // rationale.
    async function reconcileGuestEviction() {
      try {
        await accessRoom(roomId, { credential: token });
        // The stored session is still valid per the server (e.g. this tab
        // lost a same-seat socket race to another tab, or a benign
        // ordering race with the server-side eviction). Nothing to clear;
        // the connection stays terminal until a deliberate session change
        // (reload, rejoin) opens a fresh socket.
        setConnectionStatus("disconnected");
      } catch (caughtError) {
        if (!isStaleGuestError(caughtError)) {
          setConnectionStatus("disconnected");
          return;
        }

        clearRoomSession(window.sessionStorage, roomId);

        try {
          const response = await getRoomPreview(roomId);
          setPreview(response.room);
        } catch {
          setPreview(null);
        }

        setCurrentRoom(null);
        setSession(null);
        setConnectionStatus("idle");
      }
    }

    function handleTerminalClose() {
      if (token.role !== "guest") {
        // Hosts are not evicted by normal room flows; surface the terminal
        // state without attempting a stale-session reconciliation that
        // only applies to guest capability tokens.
        setConnectionStatus("disconnected");
        return;
      }

      void reconcileGuestEviction();
    }

    function handleStatusChange(status: RoomSocketSupervisorStatus) {
      setConnectionStatus(status);
    }

    function handleMessage(data: unknown) {
      const message = parseRoomSocketMessage(data);

      if (message === null) {
        setError("Received an unreadable room update.");
        return;
      }

      if (message.type === "ROOM_SNAPSHOT") {
        const accepted = applyCurrentRoomSnapshot(message.room);

        if (!accepted) {
          return;
        }

        if (token.role === "guest" && message.room.seats.guest.occupied === false) {
          // Defensive: in production the server excludes this socket from
          // receiving a snapshot once the seat is vacated (it is closed
          // with 1008 first — see `socketCanReceiveRoomSnapshot` in the
          // worker), so this path is normally moot. It stays as a
          // belt-and-suspenders self-close for any ordering the server
          // doesn't cover; closing with 1008 here routes through the same
          // non-retryable path as a server-initiated eviction, so
          // `handleTerminalClose` runs exactly once from the resulting
          // close event.
          supervisor.close(1008, "guest seat changed");
          return;
        }

        setError(null);
      } else {
        setError(message.error.message);
      }
    }

    const supervisor = new RoomSocketSupervisor({
      connect: () => openRoomSocket(roomId, { token }),
      onGiveUp: handleTerminalClose,
      onMessage: handleMessage,
      onOpen: () => {
        setError(null);
      },
      onStatusChange: handleStatusChange,
    });

    supervisor.start();

    // A backgrounded tab's socket is very likely already dead by the time
    // the user returns (mobile Safari and most proxies silently drop idle
    // connections well under a minute); reconnect immediately instead of
    // waiting out the backoff. `reconnectNow` is a no-op unless the
    // supervisor is actually mid-backoff, so this cannot create a second
    // live socket.
    function handleVisible() {
      if (document.visibilityState === "visible") {
        supervisor.reconnectNow();
      }
    }

    function handleOnline() {
      supervisor.reconnectNow();
    }

    document.addEventListener("visibilitychange", handleVisible);
    window.addEventListener("online", handleOnline);

    return () => {
      document.removeEventListener("visibilitychange", handleVisible);
      window.removeEventListener("online", handleOnline);
      supervisor.dispose();
    };
  }, [
    socketRoomId,
    socketToken,
    applyCurrentRoomSnapshot,
    setCurrentRoom,
  ]);

  const inviteLink = useMemo(() => {
    if (room === null || typeof window === "undefined") {
      return "";
    }

    return `${window.location.origin}/?room=${encodeURIComponent(room.id)}`;
  }, [room]);

  const actor = session === null ? null : actorPlayerId(session);
  const game = room?.game ?? null;
  const isHost = session?.role === "host";
  const guestSeatOccupied = room?.seats.guest.occupied === true;
  const guestConnected = room?.presence.players.B === true;
  const isCommandPending = useCallback(
    (...types: readonly ClientCommandType[]) =>
      types.some((type) => pendingCommands.has(type)),
    [pendingCommands],
  );
  const isAnyCommandPending = pendingCommands.size > 0;
  const canStartRoom =
    isHost &&
    room?.lifecycle === "lobby" &&
    guestConnected &&
    !isCommandPending("START_ROOM");
  const canResetLobby = isHost && room !== null && !isCommandPending("RESET_TO_LOBBY");
  const canKickGuest = isHost && room !== null && !isCommandPending("KICK_GUEST");

  const runCommand = useCallback(
    async (input: ClientCommandInput) => {
      if (room === null || session === null || pendingCommandsRef.current.has(input.type)) {
        return;
      }

      const activeRoom = room;
      const activeSession = session;

      pendingCommandsRef.current = withPendingCommand(
        pendingCommandsRef.current,
        input.type,
      );
      setPendingCommands(pendingCommandsRef.current);
      setError(null);

      const commandOptions: RoomClientOptions = ITEM_GENERATION_COMMAND_TYPES.has(
        input.type,
      )
        ? { signal: AbortSignal.timeout(ITEM_GENERATION_REQUEST_TIMEOUT_MS) }
        : {};

      try {
        const response = await sendRoomCommand(
          activeRoom.id,
          {
            ...input,
            credential: activeSession.token,
            nowMs: Date.now(),
          } as RoomClientCommand,
          commandOptions,
        );

        applyCurrentRoomSnapshot(response.room);
      } catch (caughtError) {
        setError(errorMessage(caughtError, "Room command failed."));
      } finally {
        pendingCommandsRef.current = withoutPendingCommand(
          pendingCommandsRef.current,
          input.type,
        );
        setPendingCommands(pendingCommandsRef.current);
      }
    },
    [applyCurrentRoomSnapshot, room, session],
  );

  async function handleCreateRoom(config: CreateRoomConfig) {
    setIsCreating(true);
    setError(null);

    try {
      const response = await createRoom({
        hostName: config.hostName,
        config: config.roomConfig,
      });

      if (response.created) {
        applyCurrentRoomSnapshot(response.room, { allowRoomSwitch: true });
        const nextSession = roomSessionFromToken(response.hostToken);
        saveRoomSession(window.sessionStorage, nextSession);
        setSession(nextSession);
        setConnectionStatus("connecting");
        announce("Room created. Share the invite link with player B.");
      } else {
        const storedSession = loadRoomSession(
          window.sessionStorage,
          response.room.id,
        );
        const existingRoomState = await resolveExistingRoomCreateState(
          response.room,
          storedSession,
          async (roomId, session) => {
            const accessed = await accessRoom(roomId, {
              credential: session.token,
            });

            return accessed.room;
          },
        );

        if (existingRoomState.clearStoredSession) {
          clearRoomSession(window.sessionStorage, response.room.id);
        }

        if (existingRoomState.kind === "hydrated") {
          applyCurrentRoomSnapshot(existingRoomState.room, {
            allowRoomSwitch: true,
          });
          setSession(existingRoomState.session);
          setConnectionStatus(existingRoomState.connectionStatus);
          announce("Rejoined your existing room.");
        } else {
          setSession(null);
          setCurrentRoom(null);
          setPreview(existingRoomState.preview);
          setConnectionStatus(existingRoomState.connectionStatus);
          announce("Opened existing room preview.");
        }
      }

      window.history.replaceState(
        null,
        "",
        `/?room=${encodeURIComponent(response.room.id)}`,
      );
    } catch (caughtError) {
      setError(errorMessage(caughtError, "Room could not be created."));
    } finally {
      setIsCreating(false);
    }
  }

  async function handleJoinRoom(guestName: string) {
    const roomId = room?.id ?? preview?.id ?? null;

    if (roomId === null) {
      return;
    }

    setIsJoining(true);
    setError(null);

    try {
      const response = await joinRoom(roomId, { guestName });
      const nextSession = roomSessionFromToken(response.guestToken);
      saveRoomSession(window.sessionStorage, nextSession);
      setSession(nextSession);
      setConnectionStatus("connecting");
      applyCurrentRoomSnapshot(response.room, { allowRoomSwitch: true });
      announce(`Joined room as ${guestName}. Waiting for the host to start the game.`);
    } catch (caughtError) {
      setError(errorMessage(caughtError, "Room could not be joined."));
    } finally {
      setIsJoining(false);
    }
  }

  async function handleCustomAmazonQuerySubmit(query: string) {
    if (room === null || session === null) {
      return;
    }

    setIsGeneratingCustomItem(true);
    setError(null);

    try {
      const response = await submitRoomCustomAmazonItem(room.id, {
        credential: session.token,
        query,
      });

      applyCurrentRoomSnapshot(response.room);
    } catch (caughtError) {
      setError(errorMessage(caughtError, "Failed to submit Amazon query."));
    } finally {
      setIsGeneratingCustomItem(false);
    }
  }

  function handleLeaveLocalSession() {
    if (room !== null) {
      clearRoomSession(window.sessionStorage, room.id);
    }

    setSession(null);
    setCurrentRoom(null);
    setConnectionStatus("idle");
  }

  const status = (
    <div className="status-strip">
      <span className={`phase-chip phase-chip--${game?.phase ?? "setup"}`}>
        {phaseLabel(game?.phase ?? "setup")}
      </span>
      <span>{roomStatusLabel(room, preview, connectionStatus)}</span>
    </div>
  );

  const scoreboard =
    session === null || game === null || game.phase === "setup" ? null : (
      <Scoreboard
        players={game.players}
        roles={game.roles}
        roundNumber={game.roundNumber}
        scores={game.scores}
        totalRounds={game.totalRounds}
      />
    );

  const actionLog =
    session === null || game === null || game.phase === "setup" ? null : (
      <ActionLog entries={game.log} />
    );

  return (
    <GameShell actionLog={actionLog} scoreboard={scoreboard} status={status}>
      {loadStatus === "loading" ? (
        <section className="phase-panel" data-testid="loading-room-panel">
          <p className="eyebrow">Loading</p>
          <h2>Opening room</h2>
          <div className="loading-line" aria-label="Loading" />
        </section>
      ) : null}

      {loadStatus === "ready" && room === null && preview === null ? (
        <CreateRoomPanel
          disabled={isCreating}
          error={error}
          onCreate={(config) => {
            void handleCreateRoom(config);
          }}
        />
      ) : null}

      {loadStatus === "ready" && preview !== null && session === null ? (
        <JoinRoomPanel
          disabled={isJoining}
          error={error}
          room={preview}
          onJoin={(guestName) => {
            void handleJoinRoom(guestName);
          }}
        />
      ) : null}

      {loadStatus === "ready" && room !== null && session !== null && game !== null ? (
        <>
          <RoomControls
            canKickGuest={canKickGuest}
            canResetLobby={canResetLobby}
            canStartRoom={canStartRoom}
            connectionStatus={connectionStatus}
            guestConnected={guestConnected}
            guestSeatOccupied={guestSeatOccupied}
            inviteLink={inviteLink}
            isAnyCommandPending={isAnyCommandPending}
            isHost={isHost}
            room={room}
            session={session}
            onKick={() => {
              void runCommand({ type: "KICK_GUEST" });
            }}
            onLeaveLocalSession={handleLeaveLocalSession}
            onReset={() => {
              void runCommand({ type: "RESET_TO_LOBBY" });
            }}
            onStart={() => {
              void runCommand({ type: "START_ROOM" });
            }}
          />

          {error ? (
            <p className="state-error room-error" role="alert">
              {error}
            </p>
          ) : null}

          <RoomGameView
            actor={actor}
            game={game}
            guestConnected={guestConnected}
            isCommandPending={isCommandPending}
            isGeneratingCustomItem={isGeneratingCustomItem}
            isHost={isHost}
            onAdvanceRound={() => {
              void runCommand({ type: "ADVANCE_ROUND" });
            }}
            onCustomAmazonQuerySubmit={(query) => {
              void handleCustomAmazonQuerySubmit(query);
            }}
            onExecuteTrade={(side) => {
              void runCommand({ type: "EXECUTE_TRADE", side });
            }}
            onReset={() => {
              void runCommand({ type: "RESET_TO_LOBBY" });
            }}
            onRetryItemGeneration={() => {
              void runCommand({ type: "RETRY_ITEM_GENERATION" });
            }}
            onSubmitInitialWidth={(width) => {
              void runCommand({ type: "SUBMIT_INITIAL_WIDTH", width });
            }}
            onSubmitMarketQuote={(quote) => {
              void runCommand({ type: "SUBMIT_MARKET_QUOTE", quote });
            }}
            onTightenWidth={(width) => {
              void runCommand({ type: "TIGHTEN_WIDTH", width });
            }}
            onTradeOnWidth={() => {
              void runCommand({ type: "TRADE_ON_WIDTH" });
            }}
          />
        </>
      ) : null}
    </GameShell>
  );
}

// ---------------------------------------------------------------------------
// CreateRoomPanel
// ---------------------------------------------------------------------------

type CreateRoomConfig = Readonly<{
  hostName: string;
  roomConfig: Partial<RoomGameConfig>;
}>;

type CreateRoomPanelProps = Readonly<{
  disabled: boolean;
  error: string | null;
  onCreate: (config: CreateRoomConfig) => void;
}>;

function CreateRoomPanel({ disabled, error, onCreate }: CreateRoomPanelProps) {
  const formId = useId();
  // Starts empty (with a placeholder) rather than pre-filled with "Host" —
  // a pre-filled real-looking value reads as a fixed label rather than an
  // invitation to type your own name, so people would create rooms still
  // named "Host" without realizing the field was editable.
  const [hostName, setHostName] = useState("");
  const [mode, setMode] = useState<GameMode>(GAME_MODES[0]);
  const [totalRoundsInput, setTotalRoundsInput] = useState("3");
  const [aiGenerated, setAiGenerated] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<CreateRoomFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const totalRounds = useMemo(
    () => parseNumericInput(totalRoundsInput),
    [totalRoundsInput],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const payload = buildStartPayload({
      hostName,
      mode,
      totalRounds,
      aiGenerated,
    });
    const nextErrors = validateCreateRoomFields(hostName, mode, totalRounds);
    setFieldErrors(nextErrors);

    if (payload === null || Object.keys(nextErrors).length > 0) {
      setFormError("Fix the highlighted fields to create a room.");
      return;
    }

    const validation = validateStartGame(payload);

    if (!validation.ok) {
      setFormError(validation.error);
      return;
    }

    setFormError(null);
    onCreate({
      hostName: payload.playerAName,
      roomConfig: {
        mode: payload.mode,
        totalRounds: payload.totalRounds,
        customAmazonQuery: payload.customAmazonQuery,
        aiGenerated: payload.aiGenerated,
      },
    });
  }

  return (
    <form
      className="setup-form"
      data-testid="create-room-form"
      noValidate
      onSubmit={handleSubmit}
    >
      <fieldset className="setup-form__fieldset" disabled={disabled}>
        <legend className="setup-form__legend">Create room</legend>

        <div className="setup-form__grid">
          <div className="form-field">
            <label className="form-field__label" htmlFor={`${formId}-host`}>
              Your name
            </label>
            <input
              aria-describedby={
                fieldErrors.hostName ? `${formId}-host-error` : undefined
              }
              aria-invalid={Boolean(fieldErrors.hostName)}
              autoComplete="name"
              className="form-field__control"
              id={`${formId}-host`}
              name="hostName"
              onChange={(event) => setHostName(event.target.value)}
              placeholder="e.g. Alex"
              type="text"
              value={hostName}
            />
            {fieldErrors.hostName ? (
              <p className="form-field__error" id={`${formId}-host-error`}>
                {fieldErrors.hostName}
              </p>
            ) : null}
          </div>

          <CustomSelect
            ariaDescribedby={
              fieldErrors.mode ? `${formId}-mode-error` : undefined
            }
            ariaInvalid={Boolean(fieldErrors.mode)}
            id={`${formId}-mode`}
            label="Game mode"
            name="mode"
            onChange={(value) => setMode(value as GameMode)}
            options={GAME_MODES.map((gameMode) => ({
              value: gameMode,
              label: gameMode,
            }))}
            value={mode}
          />
          {fieldErrors.mode ? (
            <p className="form-field__error" id={`${formId}-mode-error`}>
              {fieldErrors.mode}
            </p>
          ) : null}

          <div className="form-field">
            <label className="form-field__label" htmlFor={`${formId}-rounds`}>
              Total rounds
            </label>
            <input
              aria-describedby={
                fieldErrors.totalRounds ? `${formId}-rounds-error` : undefined
              }
              aria-invalid={Boolean(fieldErrors.totalRounds)}
              className="form-field__control"
              id={`${formId}-rounds`}
              inputMode="numeric"
              name="totalRounds"
              onChange={(event) =>
                setTotalRoundsInput(sanitizeDigitsOnly(event.target.value))
              }
              pattern="[0-9]*"
              type="text"
              value={totalRoundsInput}
            />
            {fieldErrors.totalRounds ? (
              <p className="form-field__error" id={`${formId}-rounds-error`}>
                {fieldErrors.totalRounds}
              </p>
            ) : null}
          </div>

          <div className="form-field room-checkbox-field">
            <input
              checked={aiGenerated}
              className="form-field__checkbox"
              id={`${formId}-ai-generated`}
              onChange={(event) => setAiGenerated(event.target.checked)}
              type="checkbox"
            />
            <label
              className="form-field__label"
              htmlFor={`${formId}-ai-generated`}
            >
              AI automated generated markets
            </label>
          </div>

        </div>

        {formError || error ? (
          <p className="setup-form__error" role="alert">
            {formError ?? error}
          </p>
        ) : null}

        <button className="setup-form__submit" type="submit">
          Create invite room
        </button>
      </fieldset>
    </form>
  );
}

// ---------------------------------------------------------------------------
// JoinRoomPanel
// ---------------------------------------------------------------------------

type JoinRoomPanelProps = Readonly<{
  disabled: boolean;
  error: string | null;
  room: PublicRoomInvitePreview;
  onJoin: (guestName: string) => void;
}>;

function JoinRoomPanel({ disabled, error, room, onJoin }: JoinRoomPanelProps) {
  const formId = useId();
  const [guestName, setGuestName] = useState("Guest");
  const [formError, setFormError] = useState<string | null>(null);
  const isJoinable = !room.guest.occupied && room.lifecycle === "lobby";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = guestName.trim();

    if (trimmed.length === 0) {
      setFormError("Name is required to join.");
      return;
    }

    setFormError(null);
    onJoin(trimmed);
  }

  if (!isJoinable) {
    return (
      <section className="phase-panel" data-testid="room-unavailable-panel">
        <p className="eyebrow">Room unavailable</p>
        <h2>{room.guest.occupied ? "This room is full" : "Game already started"}</h2>
        <p>Ask the host for a fresh invite after they reset the lobby.</p>
        {error ? (
          <p className="state-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <form
      className="setup-form"
      data-testid="join-room-form"
      noValidate
      onSubmit={handleSubmit}
    >
      <fieldset className="setup-form__fieldset" disabled={disabled}>
        <legend className="setup-form__legend">Join room</legend>
        <p className="room-copy">
          {room.host.displayName} is waiting for player B.
        </p>

        <div className="setup-form__grid setup-form__grid--single">
          <div className="form-field">
            <label className="form-field__label" htmlFor={`${formId}-guest`}>
              Your name
            </label>
            <input
              aria-describedby={formError ? `${formId}-guest-error` : undefined}
              aria-invalid={Boolean(formError)}
              className="form-field__control"
              id={`${formId}-guest`}
              name="guestName"
              onChange={(event) => setGuestName(event.target.value)}
              type="text"
              value={guestName}
            />
            {formError ? (
              <p className="form-field__error" id={`${formId}-guest-error`}>
                {formError}
              </p>
            ) : null}
          </div>
        </div>

        {error ? (
          <p className="setup-form__error" role="alert">
            {error}
          </p>
        ) : null}

        <button className="setup-form__submit" type="submit">
          Join as player B
        </button>
      </fieldset>
    </form>
  );
}

// ---------------------------------------------------------------------------
// RoomControls
// ---------------------------------------------------------------------------

type RoomControlsProps = Readonly<{
  /** Whether the "Kick guest" control's own command (KICK_GUEST) is free to fire. */
  canKickGuest: boolean;
  /** Whether the "Reset lobby" control's own command (RESET_TO_LOBBY) is free to fire. */
  canResetLobby: boolean;
  canStartRoom: boolean;
  connectionStatus: ConnectionStatus;
  /** Whether player B currently has a live room connection. */
  guestConnected: boolean;
  /** Whether the guest seat is occupied, independent of live presence. */
  guestSeatOccupied: boolean;
  inviteLink: string;
  /** Whether ANY room command is currently in flight (any type). */
  isAnyCommandPending: boolean;
  isHost: boolean;
  room: PublicRoomSnapshot;
  session: RoomSession;
  onKick: () => void;
  onLeaveLocalSession: () => void;
  onReset: () => void;
  onStart: () => void;
}>;

function RoomControls({
  canKickGuest,
  canResetLobby,
  canStartRoom,
  connectionStatus,
  guestConnected,
  guestSeatOccupied,
  inviteLink,
  isAnyCommandPending,
  isHost,
  room,
  session,
  onKick,
  onLeaveLocalSession,
  onReset,
  onStart,
}: RoomControlsProps) {
  const startHintId = useId();
  const bodyId = useId();
  const guestLabel = room.seats.guest.occupied
    ? room.seats.guest.displayName
    : "Waiting for player B";
  const localConnectionLabel = connectionStatusLabel(connectionStatus);
  const playerBPresenceState = !guestSeatOccupied
    ? "empty"
    : guestConnected
      ? "connected"
      : "disconnected";
  const playerBPresenceLabel = guestConnected ? "Connected" : "Disconnected";
  const playerBPresenceText = guestSeatOccupied
    ? `Player B: ${playerBPresenceLabel}`
    : "Player B: No guest";
  const startHint = !guestSeatOccupied
    ? "Waiting for player B to join"
    : "Player B is disconnected";

  // Show a hint explaining why Start is disabled for stable guest states.
  // Do not mention the commanding state here; it is transient and not
  // user-actionable.
  const showStartHint =
    isHost &&
    room.lifecycle === "lobby" &&
    !canStartRoom &&
    (!guestSeatOccupied || !guestConnected);

  // Room admin chrome (invite link, reset/kick/forget) is the primary task
  // in the lobby and on the game-over screen, so it starts expanded there.
  // Once a round is actually in progress it's pure clutter ahead of the
  // real gameplay content, so it starts collapsed — the host/guest can
  // still reach it on demand via the toggle below. Re-derived on every
  // lifecycle transition (not on every room update) without an effect, per
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes —
  // a conditional setState during render, guarded by the lifecycle
  // comparison below, intentionally bails out before paint.
  const [expanded, setExpanded] = useState(() => room.lifecycle !== "active");
  const [trackedLifecycle, setTrackedLifecycle] = useState(room.lifecycle);

  if (room.lifecycle !== trackedLifecycle) {
    setTrackedLifecycle(room.lifecycle);
    setExpanded(room.lifecycle !== "active");
  }

  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);

  // Anything inside this section can lose focus to nowhere: the "Start
  // game"/"Reset lobby"/"Kick guest" buttons all get `disabled` the instant
  // they're clicked (the per-command pending guard), and browsers blur a
  // disabled focused control to <body> synchronously. The disclosure
  // auto-collapsing on a lifecycle change (which unmounts "Start game"
  // entirely) does the same thing. Both are indistinguishable from "the
  // user alt-tabbed away" except for one signal: a same-document focus
  // loss reports `relatedTarget === null` *and* the document still has
  // focus — so catch that and land focus somewhere still visible instead
  // of silently stranding keyboard/AT users right after their most
  // consequential action.
  //
  // This has to be a native `addEventListener("focusout", ...)` rather
  // than React's `onBlur` prop: React's synthetic event system does not
  // dispatch onBlur/onFocus for elements that become `disabled` (verified
  // empirically — the native `focusout` DOM event fires with
  // `relatedTarget: null` exactly as expected, but no React-level handler
  // on any ancestor ever receives it), so the synthetic prop is silently a
  // no-op for the most common case this needs to handle.
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) {
      return;
    }

    function handleFocusOut(event: globalThis.FocusEvent) {
      if (event.relatedTarget === null && document.hasFocus()) {
        toggleRef.current?.focus();
      }
    }

    section.addEventListener("focusout", handleFocusOut);
    return () => section.removeEventListener("focusout", handleFocusOut);
  }, []);

  return (
    <section className="room-controls" data-testid="room-controls" ref={sectionRef}>
      <button
        aria-controls={bodyId}
        aria-expanded={expanded}
        className="collapsible-region__toggle"
        onClick={() => setExpanded((open) => !open)}
        ref={toggleRef}
        type="button"
      >
        <span>
          Room settings · This browser: {localConnectionLabel} ·{" "}
          {playerBPresenceText}
        </span>
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </button>

      <div className="collapsible-region__body" id={bodyId}>
        <div className="room-controls__summary">
          <p className="eyebrow">Room {room.id}</p>
          <h2>
            {session.role === "host"
              ? room.seats.host.displayName
              : room.seats.guest.occupied
                ? room.seats.guest.displayName
                : "Player B"}
          </h2>
          <p>
            Host: {room.seats.host.displayName} | Guest: {guestLabel} |{" "}
            This browser: {localConnectionLabel}
          </p>
          <div
            className="room-controls__presence"
            role="status"
            aria-label="Player B presence"
          >
            <span
              className="room-controls__presence-pill"
              data-state={playerBPresenceState}
            >
              {playerBPresenceText}
            </span>
          </div>
        </div>

        {isHost ? (
          <div className="invite-box">
            <p className="form-field__label">Invite link</p>
            <input type="hidden" id="room-invite-link" value={inviteLink} readOnly />
            <CopyButton
              value={inviteLink}
              label="Copy invite link"
              shareTitle="Join my Trader Titan room"
            />
          </div>
        ) : null}

        <div className="room-actions">
          {isHost && room.lifecycle === "lobby" ? (
            <div>
              <button
                aria-describedby={showStartHint ? startHintId : undefined}
                className="primary-button"
                disabled={!canStartRoom}
                onClick={onStart}
                type="button"
              >
                Start game
              </button>
              {showStartHint ? (
                <p className={styles.startHint} id={startHintId}>
                  {startHint}
                </p>
              ) : null}
            </div>
          ) : null}

          {isHost ? (
            <button
              className="secondary-button"
              disabled={!canResetLobby}
              onClick={onReset}
              type="button"
            >
              Reset lobby
            </button>
          ) : null}

          {isHost ? (
            <button
              className="danger-button"
              disabled={!canKickGuest || !room.seats.guest.occupied}
              onClick={onKick}
              type="button"
            >
              Kick guest
            </button>
          ) : null}

          <button
            className="secondary-button"
            disabled={isAnyCommandPending}
            onClick={onLeaveLocalSession}
            type="button"
          >
            Forget this seat
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// RoomGameView
// ---------------------------------------------------------------------------

type RoomGameViewProps = Readonly<{
  actor: PlayerId | null;
  game: PublicRoomGameState;
  guestConnected: boolean;
  /**
   * Reports whether any of the given command types is currently in
   * flight. Each phase below passes only the command type(s) its own
   * control submits, so a pending command never disables a control it
   * didn't come from (e.g. a hung ADVANCE_ROUND doesn't touch controls
   * outside the settlement phase).
   */
  isCommandPending: (...types: ClientCommandType[]) => boolean;
  isGeneratingCustomItem: boolean;
  isHost: boolean;
  onAdvanceRound: () => void;
  onCustomAmazonQuerySubmit: (query: string) => void;
  onExecuteTrade: (side: TradeSide) => void;
  onReset: () => void;
  onRetryItemGeneration: () => void;
  onSubmitInitialWidth: (width: number) => void;
  onSubmitMarketQuote: (quote: Quote) => void;
  onTightenWidth: (width: number) => void;
  onTradeOnWidth: () => void;
}>;

function RoomGameView({
  actor,
  game,
  guestConnected,
  isCommandPending,
  isGeneratingCustomItem,
  isHost,
  onAdvanceRound,
  onCustomAmazonQuerySubmit,
  onExecuteTrade,
  onReset,
  onRetryItemGeneration,
  onSubmitInitialWidth,
  onSubmitMarketQuote,
  onTightenWidth,
  onTradeOnWidth,
}: RoomGameViewProps) {
  // Pre-compute the phase stepper element (null for phases outside the round flow).
  const stepId = phaseToStepId(game.phase);
  const stepper =
    stepId !== null ? (
      <PhaseStepper steps={ROUND_STEPS} currentStepId={stepId} />
    ) : null;

  if (game.phase === "setup") {
    return (
      <section className="phase-panel" data-testid="lobby-panel">
        <p className="eyebrow">Lobby</p>
        <h2>Waiting to start</h2>
        <p>The host can start once player B joins.</p>
      </section>
    );
  }

  if (game.phase === "generatingItem") {
    if (game.customAmazonQuery === true) {
      return (
        <>
          {stepper}
          <CustomAmazonQueryForm
            disabled={isGeneratingCustomItem || actor !== game.roles.trader}
            generatorName={game.players[game.roles.trader].name}
            onSubmit={onCustomAmazonQuerySubmit}
          />
        </>
      );
    }

    return (
      <>
        {stepper}
        <section className="phase-panel" data-testid="generation-panel">
          <p className="eyebrow">Generating item</p>
          <h2>Preparing a quantitative market</h2>
          <p>
            {game.players[game.roles.marketMaker].name} will propose the first
            spread width.
          </p>
          <div className="loading-line" aria-label="Loading" />
        </section>
      </>
    );
  }

  if (game.phase === "proposingWidth") {
    const isYourTurn = actor === game.roles.marketMaker;
    const waitingForName = !isYourTurn
      ? game.players[game.roles.marketMaker].name
      : undefined;

    return (
      <>
        {stepper}
        <TurnBanner isYourTurn={isYourTurn} waitingForName={waitingForName} />
        <div className="play-stack">
          <ItemPanel item={game.item} />
          <section className="phase-panel">
            <p className="eyebrow">Opening width</p>
            <h2>{game.players[game.roles.marketMaker].name}</h2>
            <SpreadWidthForm
              disabled={
                isCommandPending("SUBMIT_INITIAL_WIDTH") ||
                actor !== game.roles.marketMaker
              }
              onSubmit={onSubmitInitialWidth}
              submitLabel="Propose width"
            />
            <LastError game={game} />
          </section>
        </div>
      </>
    );
  }

  if (game.phase === "negotiatingWidth") {
    const isYourTurn = actor === game.roles.trader;
    const waitingForName = !isYourTurn
      ? game.players[game.roles.trader].name
      : undefined;

    return (
      <>
        {stepper}
        <TurnBanner isYourTurn={isYourTurn} waitingForName={waitingForName} />
        <div className="play-stack">
          <ItemPanel item={game.item} />
          <WidthNegotiationPanel
            disabled={
              isCommandPending("TIGHTEN_WIDTH", "TRADE_ON_WIDTH") ||
              actor !== game.roles.trader
            }
            onTighten={onTightenWidth}
            onTrade={onTradeOnWidth}
            players={game.players}
            roles={game.roles}
            spreadWidth={game.spreadWidth}
          />
          <LastError game={game} />
        </div>
      </>
    );
  }

  if (game.phase === "configuringMarket") {
    const isYourTurn = actor === game.roles.marketMaker;
    const waitingForName = !isYourTurn
      ? game.players[game.roles.marketMaker].name
      : undefined;

    return (
      <>
        {stepper}
        <TurnBanner isYourTurn={isYourTurn} waitingForName={waitingForName} />
        <div className="play-stack">
          <ItemPanel item={game.item} />
          <section className="phase-panel">
            <p className="eyebrow">Set fixed-width market</p>
            <h2>{game.players[game.roles.marketMaker].name}</h2>
            <p>
              {game.players[game.roles.trader].name} chose to trade on width{" "}
              {game.spreadWidth}. Set either bid or ask; the other side is
              generated automatically.
            </p>
            <MarketRangeForm
              disabled={
                isCommandPending("SUBMIT_MARKET_QUOTE") ||
                actor !== game.roles.marketMaker
              }
              onSubmit={onSubmitMarketQuote}
              spreadWidth={game.spreadWidth}
            />
            <LastError game={game} />
          </section>
        </div>
      </>
    );
  }

  if (game.phase === "choosingSide") {
    const isYourTurn = actor === game.roles.trader;
    const waitingForName = !isYourTurn
      ? game.players[game.roles.trader].name
      : undefined;

    return (
      <>
        {stepper}
        <TurnBanner isYourTurn={isYourTurn} waitingForName={waitingForName} />
        <div className="play-stack">
          <ItemPanel item={game.item} />
          <TradeActionPanel
            disabled={
              isCommandPending("EXECUTE_TRADE") || actor !== game.roles.trader
            }
            onBuy={() => onExecuteTrade("BUY")}
            onSell={() => onExecuteTrade("SELL")}
            players={game.players}
            quote={game.quote}
            roles={game.roles}
          />
          <LastError game={game} />
        </div>
      </>
    );
  }

  if (game.phase === "settling") {
    const canRetry = canRetryItemGeneration(game, isHost);

    return (
      <>
        {stepper}
        <div className="play-stack">
          <ItemPanel item={game.item} />
          <section className="phase-panel" data-testid="settling-panel">
            <p className="eyebrow">Settling trade</p>
            <h2>
              {game.players[game.roles.trader].name} chose{" "}
              {game.pendingSide === "BUY" ? "Buy" : "Sell"}
            </h2>
            <p>The server is revealing the true value and computing PnL.</p>
            <div className="loading-line" aria-label="Loading" />
            {canRetry ? (
              <div className="room-actions">
                <p>
                  Taking a while? The round may be stuck. Retrying safely
                  re-settles this round from the trade already made - it
                  cannot change the outcome or the score.
                </p>
                <button
                  className="secondary-button"
                  disabled={isCommandPending("RETRY_ITEM_GENERATION")}
                  onClick={onRetryItemGeneration}
                  type="button"
                >
                  Retry settlement
                </button>
              </div>
            ) : null}
          </section>
        </div>
      </>
    );
  }

  if (game.phase === "settlement") {
    const isFinalRound = game.roundNumber >= game.totalRounds;
    const settlementDisabledReason = !isHost
      ? "Only the host can advance rounds."
      : !isFinalRound && !guestConnected
        ? "Player B is disconnected. Waiting for Player B to reconnect before starting the next round."
        : undefined;

    return (
      <>
        {stepper}
        <div className="play-stack">
          <ItemPanel item={game.item} revealTrueValue />
          <SettlementPanel
            disabled={
              isCommandPending("ADVANCE_ROUND") ||
              settlementDisabledReason !== undefined
            }
            disabledReason={settlementDisabledReason}
            isFinalRound={isFinalRound}
            onContinue={onAdvanceRound}
            players={game.players}
            settlement={game.settlement}
          />
        </div>
      </>
    );
  }

  if (game.phase === "gameOver") {
    return (
      <section className="phase-panel" data-testid="game-over-panel">
        <p className="eyebrow">End game</p>
        <h2>
          {game.winner === "Tie"
            ? "Tie game"
            : `${game.players[game.winner].name} wins`}
        </h2>
        <dl className="final-score">
          <div>
            <dt>{game.players.A.name}</dt>
            <dd>{formatSignedNumber(game.scores.A)}</dd>
          </div>
          <div>
            <dt>{game.players.B.name}</dt>
            <dd>{formatSignedNumber(game.scores.B)}</dd>
          </div>
        </dl>
        {isHost ? (
          <button
            className="primary-button"
            disabled={isCommandPending("RESET_TO_LOBBY")}
            onClick={onReset}
            type="button"
          >
            Reset lobby
          </button>
        ) : null}
      </section>
    );
  }

  const canRetry = canRetryItemGeneration(game, isHost);

  return (
    <section className="phase-panel" data-testid="error-panel">
      <p className="eyebrow">Game error</p>
      <h2>Round stopped</h2>
      <p>{game.error}</p>
      {isHost ? (
        <div className="room-actions">
          {canRetry ? (
            <button
              className="primary-button"
              disabled={isCommandPending("RETRY_ITEM_GENERATION")}
              onClick={onRetryItemGeneration}
              type="button"
            >
              Retry generation
            </button>
          ) : null}
          <button
            className={canRetry ? "secondary-button" : "primary-button"}
            disabled={isCommandPending("RESET_TO_LOBBY")}
            onClick={onReset}
            type="button"
          >
            Reset lobby
          </button>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// LastError
// ---------------------------------------------------------------------------

type LastErrorProps = Readonly<{
  game: PublicRoomGameState;
}>;

function LastError({ game }: LastErrorProps) {
  return "lastError" in game && game.lastError ? (
    <p className="state-error" role="alert">
      {game.lastError}
    </p>
  ) : null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function withPendingCommand(
  pending: ReadonlySet<ClientCommandType>,
  type: ClientCommandType,
): ReadonlySet<ClientCommandType> {
  const next = new Set(pending);
  next.add(type);
  return next;
}

function withoutPendingCommand(
  pending: ReadonlySet<ClientCommandType>,
  type: ClientCommandType,
): ReadonlySet<ClientCommandType> {
  const next = new Set(pending);
  next.delete(type);
  return next;
}

type ApplyPublicRoomSnapshotOptions = Readonly<{
  allowRoomSwitch?: boolean;
}>;

type ApplyPublicRoomSnapshotResult = Readonly<{
  accepted: boolean;
  room: PublicRoomSnapshot;
}>;

export function applyPublicRoomSnapshotMonotonically(
  current: PublicRoomSnapshot | null,
  incoming: PublicRoomSnapshot,
  options: ApplyPublicRoomSnapshotOptions = {},
): ApplyPublicRoomSnapshotResult {
  if (current === null) {
    return { accepted: true, room: incoming };
  }

  if (current.id !== incoming.id) {
    return options.allowRoomSwitch === true
      ? { accepted: true, room: incoming }
      : { accepted: false, room: current };
  }

  if (incoming.revision > current.revision) {
    return { accepted: true, room: incoming };
  }

  if (
    incoming.revision === current.revision &&
    hasSamePublicRoomStateExceptPresence(current, incoming)
  ) {
    return { accepted: true, room: incoming };
  }

  return { accepted: false, room: current };
}

function hasSamePublicRoomStateExceptPresence(
  current: PublicRoomSnapshot,
  incoming: PublicRoomSnapshot,
): boolean {
  return publicRoomStateWithoutPresenceJson(current) ===
    publicRoomStateWithoutPresenceJson(incoming);
}

function publicRoomStateWithoutPresenceJson(room: PublicRoomSnapshot): string {
  return JSON.stringify({
    id: room.id,
    lifecycle: room.lifecycle,
    config: room.config,
    seats: room.seats,
    game: room.game,
    createdAtMs: room.createdAtMs,
    updatedAtMs: room.updatedAtMs,
    revision: room.revision,
  });
}

/**
 * F-02 mitigation: also true while the room is durably stuck in `settling`
 * (EXECUTE_TRADE committed the transition, but the settlement effect that
 * should follow it never ran). The host's RETRY_ITEM_GENERATION command
 * covers both cases server-side; this predicate must match that widened
 * guard so the retry control actually appears for a settling failure, not
 * just an item-generation failure. See retryRoomItemGeneration in
 * src/lib/room/commands.ts.
 */
export function canRetryItemGeneration(
  game: PublicRoomGameState,
  isHost: boolean,
): boolean {
  if (!isHost) {
    return false;
  }

  return (
    (game.phase === "error" && game.previousPhase === "generatingItem") ||
    game.phase === "settling"
  );
}

type ExistingRoomCreateStateAccess = (
  roomId: PublicRoomInvitePreview["id"],
  session: RoomSession,
) => Promise<PublicRoomSnapshot>;

type ExistingRoomCreateStateResolution =
  | Readonly<{
      kind: "hydrated";
      room: PublicRoomSnapshot;
      preview: PublicRoomInvitePreview;
      session: RoomSession;
      connectionStatus: "connecting";
      clearStoredSession: false;
    }>
  | Readonly<{
      kind: "preview";
      room: null;
      preview: PublicRoomInvitePreview;
      session: null;
      connectionStatus: "idle";
      clearStoredSession: boolean;
    }>;

export async function resolveExistingRoomCreateState(
  preview: PublicRoomInvitePreview,
  storedSession: RoomSession | null,
  accessStoredSession: ExistingRoomCreateStateAccess,
): Promise<ExistingRoomCreateStateResolution> {
  if (storedSession === null) {
    return previewOnlyExistingRoomState(preview, false);
  }

  try {
    const room = await accessStoredSession(preview.id, storedSession);

    return {
      kind: "hydrated",
      room,
      preview: previewFromSnapshot(room),
      session: storedSession,
      connectionStatus: "connecting",
      clearStoredSession: false,
    };
  } catch (caughtError) {
    if (isStaleOrInvalidRoomAccessError(caughtError)) {
      return previewOnlyExistingRoomState(preview, true);
    }

    throw caughtError;
  }
}

function previewOnlyExistingRoomState(
  preview: PublicRoomInvitePreview,
  clearStoredSession: boolean,
): ExistingRoomCreateStateResolution {
  return {
    kind: "preview",
    room: null,
    preview,
    session: null,
    connectionStatus: "idle",
    clearStoredSession,
  };
}

/**
 * Strips everything except ASCII digits. Used on numeric-only text fields
 * (e.g. "Total rounds") instead of `type="number"`, whose native input
 * still happily accepts "e", "+", "-", and "." as valid keystrokes (they're
 * legal scientific-notation syntax) even though none of those make sense
 * for a round count.
 */
function sanitizeDigitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

function buildStartPayload(input: {
  hostName: string;
  mode: GameMode;
  totalRounds: number | null;
  aiGenerated: boolean;
}): StartGamePayload | null {
  if (input.totalRounds === null) {
    return null;
  }

  // Player-entered queries are the default for every mode; AI pre-generated
  // markets are the explicit opt-out.
  return {
    playerAName: input.hostName,
    playerBName: "Player B",
    mode: input.mode,
    totalRounds: input.totalRounds,
    customAmazonQuery: !input.aiGenerated,
    aiGenerated: input.aiGenerated,
  };
}

function validateCreateRoomFields(
  hostName: string,
  mode: GameMode,
  totalRounds: number | null,
): CreateRoomFieldErrors {
  const errors: CreateRoomFieldErrors = {};

  if (hostName.trim().length === 0) {
    errors.hostName = "Name is required.";
  }

  if (!GAME_MODES.includes(mode)) {
    errors.mode = "Choose a valid game mode.";
  }

  if (
    totalRounds === null ||
    !Number.isInteger(totalRounds) ||
    totalRounds < 1 ||
    totalRounds > MAX_ROUNDS
  ) {
    errors.totalRounds = `Rounds must be a whole number from 1 to ${MAX_ROUNDS}.`;
  }

  return errors;
}

function actorPlayerId(session: RoomSession): PlayerId {
  return session.role === "host" ? "A" : "B";
}

export function parseRoomSocketMessage(data: unknown): RoomSocketMessage | null {
  if (typeof data !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(data) as unknown;

    if (
      isRecord(parsed) &&
      parsed.type === "ROOM_SNAPSHOT" &&
      isRecord(parsed.room) &&
      hasRequiredRoomPresence(parsed.room)
    ) {
      return parsed as RoomSocketMessage;
    }

    if (
      isRecord(parsed) &&
      parsed.type === "ROOM_ERROR" &&
      isRecord(parsed.error) &&
      typeof parsed.error.message === "string"
    ) {
      return parsed as RoomSocketMessage;
    }
  } catch {
    return null;
  }

  return null;
}

function roomStatusLabel(
  room: PublicRoomSnapshot | null,
  preview: PublicRoomInvitePreview | null,
  connectionStatus: ConnectionStatus,
): string {
  if (room === null) {
    if (preview === null) {
      return "Ready";
    }

    return `${preview.lifecycle} | Preview`;
  }

  if (room.game.roundNumber > 0) {
    return `Round ${room.game.roundNumber} | ${connectionStatusLabel(connectionStatus)}`;
  }

  return `${room.lifecycle} | ${connectionStatusLabel(connectionStatus)}`;
}

function previewFromSnapshot(room: PublicRoomSnapshot): PublicRoomInvitePreview {
  return {
    id: room.id,
    lifecycle: room.lifecycle,
    host: {
      displayName: room.seats.host.displayName ?? "Host",
    },
    guest: {
      occupied: room.seats.guest.occupied,
    },
    joinable: room.lifecycle === "lobby" && room.seats.guest.occupied === false,
    createdAtMs: room.createdAtMs,
    updatedAtMs: room.updatedAtMs,
    revision: room.revision,
  };
}

function connectionStatusLabel(status: ConnectionStatus): string {
  switch (status) {
    case "connected":
      return "Live";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting…";
    case "disconnected":
      return "Disconnected";
    default:
      return "Offline";
  }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "generatingItem":
      return "Generating";
    case "proposingWidth":
      return "Proposing width";
    case "negotiatingWidth":
      return "Negotiating width";
    case "configuringMarket":
      return "Setting market";
    case "choosingSide":
      return "Choosing side";
    case "gameOver":
      return "Game over";
    default:
      return phase.charAt(0).toUpperCase() + phase.slice(1);
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isStaleGuestError(error: unknown): boolean {
  return error instanceof RoomClientRequestError && error.error.code === "stale_guest";
}

function isStaleOrInvalidRoomAccessError(error: unknown): boolean {
  if (!(error instanceof RoomClientRequestError)) {
    return false;
  }

  switch (error.error.code) {
    case "invalid_request":
    case "invalid_token":
    case "missing_token":
    case "spectator_access_denied":
    case "stale_guest":
    case "token_mismatch":
    case "wrong_room":
      return true;
    default:
      return false;
  }
}

function hasRequiredRoomPresence(room: Record<string, unknown>): boolean {
  if (!isRecord(room.presence)) {
    return false;
  }

  const { players } = room.presence;

  return (
    isRecord(players) &&
    typeof players.A === "boolean" &&
    typeof players.B === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
