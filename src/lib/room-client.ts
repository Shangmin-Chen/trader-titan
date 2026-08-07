import {
  parseCapabilityToken,
  type ClientRoomCommand,
  type PresentedCapabilityToken,
  type PublicRoomInvitePreview,
  type PublicRoomSnapshot,
  type RoomCapabilityToken,
  type RoomGameConfig,
  type RoomId,
} from "./room";

const PUBLIC_ROOMS_PATH = "/api/rooms";
const ROOM_SESSION_STORAGE_PREFIX = "trader-titan.room-session.v1";

// Mirrors the literal strings the edge WebSocket auto-response pair matches
// in `src/worker/index.ts` (`ROOM_SOCKET_PING_MESSAGE` / `_PONG_MESSAGE`).
// The edge replies to a raw "tt-ping" text frame with a raw "tt-pong" text
// frame without waking the hibernating Durable Object, so both sides must
// agree on the exact bytes; there is no shared module between the worker
// and client bundles, so — like the `"tt-room-v1"` protocol literal in
// `roomSocketProtocols` below — it is duplicated deliberately rather than
// cross-importing worker code into the client bundle.
export const ROOM_SOCKET_PING_MESSAGE = "tt-ping";
export const ROOM_SOCKET_PONG_MESSAGE = "tt-pong";
/**
 * Default abort timeout for every room HTTP call (both reads and command
 * POSTs), used whenever a caller does not supply its own `signal`.
 *
 * Room commands are not uniformly cheap: `START_ROOM` (round 1) and
 * `RETRY_ITEM_GENERATION` synchronously pregenerate every round's item
 * before the worker responds (see `applyAutomaticRoomEffects` /
 * `pregenerateAllItems` in `src/worker/index.ts`). When AI generation is
 * enabled that path makes a single batched Gemini call and then, in Amazon
 * mode, an additional sequential price-lookup fetch per round — real
 * network latency stacked on top of an LLM call, not a fixed-cost request.
 * 30s comfortably covers that common case while still turning a truly
 * hung connection (which would otherwise hang forever, see F-06) into a
 * bounded, recoverable failure.
 */
const DEFAULT_ROOM_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Longer timeout bound for the two commands whose synchronous worker-side
 * work is not a fixed cost: `START_ROOM` (round 1) and
 * `RETRY_ITEM_GENERATION`. In AI-generated Amazon mode, `pregenerateAllItems`
 * (`src/worker/index.ts`) makes one batched Gemini call and then, still
 * inside the same request, an *uncapped, sequential* Amazon price-lookup
 * fetch per round — up to `MAX_ROUNDS` (99) of them, each with no
 * server-side timeout of its own. A host who legitimately picks a
 * double-digit round count in that mode can genuinely take well past 30s
 * to get a real (non-hung) response; `DEFAULT_ROOM_REQUEST_TIMEOUT_MS`
 * would report that as a client-side timeout even though the server is
 * still working, which is a false positive, not a recovered hang.
 *
 * 120s is not a guarantee for every possible round count — nothing short
 * of bounding each Amazon lookup server-side (or moving generation off the
 * synchronous request path) fully closes that gap, and both are out of
 * scope for a client-side timeout fix — but it comfortably covers the
 * common multi-round case instead of the same 30s budget as a
 * single-field command like `TIGHTEN_WIDTH`.
 */
export const ITEM_GENERATION_REQUEST_TIMEOUT_MS = 120_000;

type JsonObject = Record<string, unknown>;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type WebSocketConstructor = new (
  url: string | URL,
  protocols?: string | string[],
) => WebSocket;
type LocationLike = Pick<Location, "origin" | "protocol" | "host">;
type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export type RoomClientCommand = Exclude<ClientRoomCommand, { type: "JOIN_ROOM" }>;

export type CreateRoomRequest = Readonly<{
  hostName: string;
  config?: Partial<RoomGameConfig>;
}>;

export type JoinRoomRequest = Readonly<{
  guestName: string;
}>;

export type AccessRoomRequest = Readonly<{
  credential: PresentedCapabilityToken;
}>;

export type CustomAmazonItemRequest = Readonly<{
  credential: PresentedCapabilityToken;
  query: string;
}>;

export type CreateRoomResponse =
  | Readonly<{
      ok: true;
      created: true;
      room: PublicRoomSnapshot;
      hostToken: RoomCapabilityToken;
    }>
  | Readonly<{
      ok: true;
      created: false;
      room: PublicRoomInvitePreview;
    }>;

export type GetRoomPreviewResponse = Readonly<{
  ok: true;
  room: PublicRoomInvitePreview;
}>;

export type AccessRoomResponse = Readonly<{
  ok: true;
  room: PublicRoomSnapshot;
}>;

export type JoinRoomResponse = Readonly<{
  ok: true;
  room: PublicRoomSnapshot;
  guestToken: RoomCapabilityToken;
}>;

export type CommandRoomResponse = Readonly<{
  ok: true;
  room: PublicRoomSnapshot;
}>;

export type RoomClientErrorPayload = Readonly<{
  ok: false;
  error: Readonly<{
    code: string;
    message: string;
  }>;
}>;

export type RoomSocketMessage =
  | Readonly<{
      type: "ROOM_SNAPSHOT";
      room: PublicRoomSnapshot;
    }>
  | Readonly<{
      type: "ROOM_ERROR";
      error: RoomClientErrorPayload["error"];
    }>;

export type RoomSession = Readonly<{
  roomId: RoomId;
  role: RoomCapabilityToken["role"];
  token: RoomCapabilityToken;
}>;

export type RoomClientOptions = Readonly<{
  baseUrl?: string | URL;
  fetchImpl?: FetchLike;
  /**
   * Overrides the default request timeout signal. When omitted, every room
   * HTTP call aborts on its own after `DEFAULT_ROOM_REQUEST_TIMEOUT_MS`.
   * Pass this to use a longer/shorter bound, or to wire up caller-driven
   * cancellation (e.g. an in-flight request abandoned by the UI).
   */
  signal?: AbortSignal;
}>;

export type RoomSocketOptions = Readonly<{
  baseUrl?: string | URL;
  location?: LocationLike;
  token: PresentedCapabilityToken;
  WebSocketImpl?: WebSocketConstructor;
}>;

export class RoomClientRequestError extends Error {
  readonly error: RoomClientErrorPayload["error"];
  readonly status: number;

  constructor(status: number, error: RoomClientErrorPayload["error"]) {
    super(error.message);
    this.name = "RoomClientRequestError";
    this.status = status;
    this.error = error;
  }
}

/**
 * Thrown when a room HTTP call never got a response — the request was
 * aborted, either by the default `DEFAULT_ROOM_REQUEST_TIMEOUT_MS` bound or
 * by a caller-supplied `signal`. Distinct from `RoomClientRequestError`
 * (the server responded, and said no) so callers can word the two
 * differently: this one means "we don't know what happened," not "that
 * command was rejected."
 */
export class RoomClientTimeoutError extends Error {
  constructor() {
    super("The server didn't respond. Check your connection and try again.");
    this.name = "RoomClientTimeoutError";
  }
}

export async function createRoom(
  request: CreateRoomRequest,
  options: RoomClientOptions = {},
): Promise<CreateRoomResponse> {
  return postRoomJson(PUBLIC_ROOMS_PATH, request, options);
}

export async function getRoomPreview(
  roomId: string,
  options: RoomClientOptions = {},
): Promise<GetRoomPreviewResponse> {
  return readRoomJson(roomPath(roomId), options);
}

export async function accessRoom(
  roomId: string,
  request: AccessRoomRequest,
  options: RoomClientOptions = {},
): Promise<AccessRoomResponse> {
  return postRoomJson(`${roomPath(roomId)}/access`, request, options);
}

export async function joinRoom(
  roomId: string,
  request: JoinRoomRequest,
  options: RoomClientOptions = {},
): Promise<JoinRoomResponse> {
  return postRoomJson(`${roomPath(roomId)}/join`, request, options);
}

export async function sendRoomCommand(
  roomId: string,
  command: RoomClientCommand,
  options: RoomClientOptions = {},
): Promise<CommandRoomResponse> {
  return postRoomJson(`${roomPath(roomId)}/command`, command, options);
}

export async function submitCustomAmazonItem(
  roomId: string,
  request: CustomAmazonItemRequest,
  options: RoomClientOptions = {},
): Promise<CommandRoomResponse> {
  return postRoomJson(`${roomPath(roomId)}/custom-amazon-item`, request, options);
}

export function openRoomSocket(
  roomId: string,
  options: RoomSocketOptions,
): WebSocket {
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;

  return new WebSocketImpl(
    roomSocketUrl(roomId, options),
    roomSocketProtocols(options.token),
  );
}

export function roomSocketUrl(
  roomId: string,
  options: Pick<RoomSocketOptions, "baseUrl" | "location" | "token">,
): string {
  const base = resolveRoomBaseUrl(options.baseUrl, options.location);
  const url = new URL(`${roomPath(roomId)}/socket`, base);

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.toString();
}

export function roomSocketProtocols(token: PresentedCapabilityToken): string[] {
  return [
    "tt-room-v1",
    `tt-role-${token.role}`,
    `tt-secret-${token.secret}`,
  ];
}

export function roomSessionFromToken(token: RoomCapabilityToken): RoomSession {
  return {
    roomId: token.roomId,
    role: token.role,
    token,
  };
}

export function saveRoomSession(
  storage: StorageLike,
  session: RoomSession,
): void {
  storage.setItem(sessionStorageKey(session.roomId), JSON.stringify(session));
}

export function loadRoomSession(
  storage: StorageLike,
  roomId: string,
): RoomSession | null {
  const raw = storage.getItem(sessionStorageKey(roomId));

  if (raw === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!isRecord(parsed) || parsed.roomId !== roomId || !isRecord(parsed.token)) {
      return null;
    }

    const token = parseCapabilityToken(parsed.token);

    if (!token.ok || token.token.roomId !== roomId || parsed.role !== token.token.role) {
      return null;
    }

    return roomSessionFromToken(token.token);
  } catch {
    return null;
  }
}

export function clearRoomSession(storage: StorageLike, roomId: string): void {
  storage.removeItem(sessionStorageKey(roomId));
}

function roomPath(roomId: string): string {
  return `${PUBLIC_ROOMS_PATH}/${encodeURIComponent(roomId)}`;
}

async function readRoomJson<T>(
  path: string,
  options: RoomClientOptions,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchRoomResponse(
    fetchImpl,
    resolveRoomHttpUrl(path, options.baseUrl),
    { signal: requestTimeoutSignal(options) },
  );

  return decodeRoomResponse<T>(response);
}

async function postRoomJson<T>(
  path: string,
  body: unknown,
  options: RoomClientOptions,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchRoomResponse(
    fetchImpl,
    resolveRoomHttpUrl(path, options.baseUrl),
    {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
      signal: requestTimeoutSignal(options),
    },
  );

  return decodeRoomResponse<T>(response);
}

function requestTimeoutSignal(options: RoomClientOptions): AbortSignal {
  return options.signal ?? AbortSignal.timeout(DEFAULT_ROOM_REQUEST_TIMEOUT_MS);
}

/**
 * Runs `fetchImpl` and converts an aborted request into a typed
 * `RoomClientTimeoutError`. An abort rejects before a `Response` ever
 * exists, so it has to be handled here — `decodeRoomResponse` below
 * assumes it was handed a real `Response`.
 */
async function fetchRoomResponse(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (caughtError) {
    if (isAbortLikeError(caughtError)) {
      throw new RoomClientTimeoutError();
    }

    throw caughtError;
  }
}

function isAbortLikeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

async function decodeRoomResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new RoomClientRequestError(response.status, errorPayloadFromBody(body));
  }

  return body as T;
}

function resolveRoomHttpUrl(path: string, baseUrl: string | URL | undefined): string {
  if (baseUrl === undefined) {
    return path;
  }

  return new URL(path, baseUrl).toString();
}

function resolveRoomBaseUrl(
  baseUrl: string | URL | undefined,
  locationLike: LocationLike | undefined,
): string | URL {
  if (baseUrl !== undefined) {
    return baseUrl;
  }

  const location = locationLike ?? globalThis.location;

  return `${location.protocol}//${location.host}`;
}

function sessionStorageKey(roomId: string): string {
  return `${ROOM_SESSION_STORAGE_PREFIX}:${roomId}`;
}

function errorPayloadFromBody(body: unknown): RoomClientErrorPayload["error"] {
  if (
    isRecord(body) &&
    isRecord(body.error) &&
    typeof body.error.code === "string" &&
    typeof body.error.message === "string"
  ) {
    return {
      code: body.error.code,
      message: body.error.message,
    };
  }

  return {
    code: "request_failed",
    message: "Room request failed.",
  };
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
