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
  const response = await fetchImpl(resolveRoomHttpUrl(path, options.baseUrl));

  return decodeRoomResponse<T>(response);
}

async function postRoomJson<T>(
  path: string,
  body: unknown,
  options: RoomClientOptions,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(resolveRoomHttpUrl(path, options.baseUrl), {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  return decodeRoomResponse<T>(response);
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
