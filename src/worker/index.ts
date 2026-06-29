import { DurableObject } from "cloudflare:workers";
import openNextWorker from "../../.open-next/worker.js";
import type { GameMode, ProviderGeneratedItem, SettledGeneratedItem } from "../lib/game";
import {
  authorizeRoomAction,
  createLobbyRoom,
  dispatchRoomCommand,
  dispatchSystemRoomEvent,
  loadPersistenceEnvelope,
  parseClientRoomCommand,
  parseCapabilityToken,
  parseRoomId,
  parseRoomGameConfigPatch,
  parseTokenHash,
  roomDomainError,
  toPersistenceEnvelope,
  toPublicRoomInvitePreview,
  toPublicRoomSnapshot,
  type CapabilityRole,
  type ClientRoomCommand,
  type PublicRoomInvitePreview,
  type PresentedCapabilityToken,
  type PublicRoomSnapshot,
  type RoomCapabilityToken,
  type RoomDomainError,
  type RoomGameConfig,
  type RoomId,
  type RoomProtocolDecodeError,
  type RoomState,
  type TokenHash,
  type TokenVerifier,
  type UnixTimeMs
} from "../lib/room";
import {
  createWorkerRoomItemProviders,
  itemGenerationErrorMessage
} from "./item-provider";
import {
  createSettledGeneratedItem,
  loadPrivateGeneratedItemEnvelope,
  privateGeneratedItemStorageKey,
  toGeneratedItem,
  toPrivateGeneratedItemEnvelope
} from "./private-generated-items";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const ROOM_ENDPOINT = "/room";
const ROOM_ACCESS_ENDPOINT = "/room/access";
const ROOM_JOIN_ENDPOINT = "/room/join";
const ROOM_COMMAND_ENDPOINT = "/room/command";
const ROOM_CUSTOM_AMAZON_ITEM_ENDPOINT = "/room/custom-amazon-item";
const ROOM_SOCKET_ENDPOINT = "/room/socket";
const PUBLIC_ROOMS_ENDPOINT = "/api/rooms";
const PUBLIC_CUSTOM_AMAZON_ITEM_ROUTE = "custom-amazon-item";
const LEGACY_NEXT_GAME_API_PATHS = new Set([
  "/api/commit-market",
  "/api/generate-custom-amazon-item",
  "/api/generate-item",
  "/api/settle-round",
]);
const ROOM_STORAGE_KEY = "room:persistence:v1";
const ROOM_SOCKET_MESSAGE_ROOM_SNAPSHOT = "ROOM_SNAPSHOT";
const ROOM_SOCKET_MESSAGE_ROOM_ERROR = "ROOM_ERROR";
const ROOM_SOCKET_PROTOCOL = "tt-room-v1";
const ROOM_SOCKET_ROLE_PROTOCOL_PREFIX = "tt-role-";
const ROOM_SOCKET_SECRET_PROTOCOL_PREFIX = "tt-secret-";
const HTTP_SWITCHING_PROTOCOLS_STATUS = 101;
const ROOM_ID_GENERATION_ATTEMPTS = 3;
const TOKEN_SECRET_BYTE_LENGTH = 32;
const BYTE_HEX_RADIX = 16;
const BYTE_HEX_PAD_LENGTH = 2;
const TOKEN_HASH_ALGORITHM = "SHA-256";
const TOKEN_HASH_PREFIX = "sha256";
const TOKEN_HASH_INPUT_PREFIX = "trader-titan.room-token.v1";
const PRIVATE_ITEM_UNAVAILABLE_MESSAGE = "Private generated item is unavailable for settlement.";
const rejectTokenVerification: TokenVerifier = () => false;

type OpenNextWorker = Required<Pick<ExportedHandler<Cloudflare.Env>, "fetch">>;
type WorkerFetchContext = Parameters<OpenNextWorker["fetch"]>[2];
type WorkerFetchEnv = Parameters<OpenNextWorker["fetch"]>[1];
type WorkerFetchRequest = Parameters<OpenNextWorker["fetch"]>[0];
type JsonRecord = Record<string, unknown>;
type DecodedRoomCommand = Exclude<ClientRoomCommand, { type: "JOIN_ROOM" }>;

type RoomHttpError = Readonly<{
  code: string;
  message: string;
}>;

type RoomErrorResponse = Readonly<{
  ok: false;
  error: RoomHttpError | RoomDomainError;
}>;

type CreateRoomResponse =
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

type GetRoomResponse = Readonly<{
  ok: true;
  room: PublicRoomInvitePreview;
}>;

type AccessRoomResponse = Readonly<{
  ok: true;
  room: PublicRoomSnapshot;
}>;

type JoinRoomResponse = Readonly<{
  ok: true;
  room: PublicRoomSnapshot;
  guestToken: RoomCapabilityToken;
}>;

type CommandRoomResponse = Readonly<{
  ok: true;
  room: PublicRoomSnapshot;
}>;

type CustomAmazonItemResponse = Readonly<{
  ok: true;
  room: PublicRoomSnapshot;
}>;

type CreateRoomBody = Readonly<{
  hostName: string;
  config?: Partial<RoomGameConfig>;
}>;

type JoinRoomBody = Readonly<{
  guestName: string;
}>;

type AccessRoomBody = Readonly<{
  credential: PresentedCapabilityToken;
}>;

type CustomAmazonItemBody = Readonly<{
  credential: PresentedCapabilityToken;
  query: unknown;
}>;

type BodyDecodeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; response: Response }>;

type StoredRoomLoadResult =
  | Readonly<{ ok: true; room: RoomState }>
  | Readonly<{
      ok: false;
      reason: "missing" | "expired" | "invalid";
      error: RoomHttpError | RoomDomainError;
    }>;

type StoredRoomCommandResult =
  | Readonly<{ ok: true; room: RoomState }>
  | Readonly<{ ok: false; status: number; error: RoomHttpError | RoomDomainError }>;

type CreateOrLoadRoomResult =
  | Readonly<{ ok: true; created: true; room: RoomState }>
  | Readonly<{ ok: true; created: false; room: RoomState }>
  | Readonly<{ ok: false; status: number; error: RoomHttpError | RoomDomainError }>;

type PendingItemGeneration = Readonly<{
  roomId: RoomId;
  revision: number;
  roundNumber: number;
  mode: GameMode;
  customAmazonQuery: boolean;
}>;

type RoomSocketAttachment = Readonly<{
  kind: "trader-titan.room-socket.v1";
  roomId: RoomId;
  role: CapabilityRole;
  tokenHash: TokenHash;
}>;

type RoomSocketError = RoomHttpError | RoomDomainError | RoomProtocolDecodeError;

type RoomSocketMessage =
  | Readonly<{
      type: typeof ROOM_SOCKET_MESSAGE_ROOM_SNAPSHOT;
      room: PublicRoomSnapshot;
    }>
  | Readonly<{
      type: typeof ROOM_SOCKET_MESSAGE_ROOM_ERROR;
      error: RoomSocketError;
    }>;

/**
 * Owns the private room state for one Cloudflare Durable Object id.
 *
 * The object persists only the private room persistence envelope and returns
 * public snapshots to clients so transport code cannot leak credential hashes.
 */
export class GameRoomDurableObject extends DurableObject<Cloudflare.Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = normalizePathname(url.pathname);

    if (hasWebSocketUpgrade(request)) {
      if (pathname !== ROOM_SOCKET_ENDPOINT) {
        return errorResponse(
          { code: "not_found", message: "Room WebSocket endpoint was not found." },
          404
        );
      }

      return this.acceptRoomSocket(request);
    }

    if (pathname === ROOM_ENDPOINT && request.method === "POST") {
      return this.createOrLoadRoom(request);
    }

    if (pathname === ROOM_ENDPOINT && request.method === "GET") {
      return this.getRoom();
    }

    if (pathname === ROOM_ACCESS_ENDPOINT && request.method === "POST") {
      return this.accessRoom(request);
    }

    if (pathname === ROOM_JOIN_ENDPOINT && request.method === "POST") {
      return this.joinRoom(request);
    }

    if (pathname === ROOM_COMMAND_ENDPOINT && request.method === "POST") {
      return this.applyRoomCommand(request);
    }

    if (pathname === ROOM_CUSTOM_AMAZON_ITEM_ENDPOINT && request.method === "POST") {
      return this.applyCustomAmazonItem(request);
    }

    if (
      pathname === ROOM_ENDPOINT ||
      pathname === ROOM_ACCESS_ENDPOINT ||
      pathname === ROOM_JOIN_ENDPOINT ||
      pathname === ROOM_COMMAND_ENDPOINT ||
      pathname === ROOM_CUSTOM_AMAZON_ITEM_ENDPOINT ||
      pathname === ROOM_SOCKET_ENDPOINT
    ) {
      return errorResponse(
        { code: "method_not_allowed", message: "HTTP method is not supported for this room endpoint." },
        405
      );
    }

    return errorResponse(
      { code: "not_found", message: "Room endpoint was not found." },
      404
    );
  }

  private async createOrLoadRoom(request: Request): Promise<Response> {
    const body = await decodeCreateRoomBody(request);

    if (!body.ok) {
      return body.response;
    }

    const roomId = this.roomId();

    if (!roomId.ok) {
      return roomId.response;
    }

    const nowMs = currentUnixTimeMs();
    const hostToken = generateCapabilityToken("host", roomId.roomId);
    const hostTokenHash = await hashCapabilityToken(hostToken);
    const result = await this.ctx.storage.transaction(async (transaction) =>
      this.createOrLoadStoredRoom(
        transaction,
        roomId.roomId,
        body.value,
        hostTokenHash,
        nowMs
      )
    );

    if (!result.ok) {
      return errorResponse(result.error, result.status);
    }

    if (!result.created) {
      return jsonResponse<CreateRoomResponse>({
        ok: true,
        created: false,
        room: toPublicRoomInvitePreview(result.room)
      });
    }

    return jsonResponse<CreateRoomResponse>(
      {
        ok: true,
        created: true,
        room: toPublicRoomSnapshot(result.room),
        hostToken
      },
      201
    );
  }

  private async getRoom(): Promise<Response> {
    const nowMs = currentUnixTimeMs();
    const loaded = await this.loadStoredRoom(nowMs);

    if (!loaded.ok) {
      return errorResponse(loaded.error, statusForStoredRoomLoadFailure(loaded));
    }

    return jsonResponse<GetRoomResponse>({
      ok: true,
      room: toPublicRoomInvitePreview(loaded.room)
    });
  }

  private async accessRoom(request: Request): Promise<Response> {
    const decoded = await decodeAccessRoomBody(request);

    if (!decoded.ok) {
      return decoded.response;
    }

    const verifyToken = await buildTokenVerifier(decoded.value.credential);
    const loaded = await this.loadStoredRoom(currentUnixTimeMs());

    if (!loaded.ok) {
      return errorResponse(loaded.error, statusForStoredRoomLoadFailure(loaded));
    }

    const authorized = authorizeRoomAction(
      loaded.room,
      decoded.value.credential,
      { type: "access" },
      verifyToken
    );

    if (!authorized.ok) {
      return errorResponse(authorized.error, statusForDomainError(authorized.error));
    }

    return jsonResponse<AccessRoomResponse>({
      ok: true,
      room: toPublicRoomSnapshot(loaded.room)
    });
  }

  private async joinRoom(request: Request): Promise<Response> {
    const body = await decodeJoinRoomBody(request);

    if (!body.ok) {
      return body.response;
    }

    const roomId = this.roomId();

    if (!roomId.ok) {
      return roomId.response;
    }

    const guestToken = generateCapabilityToken("guest", roomId.roomId);
    const guestTokenHash = await hashCapabilityToken(guestToken);
    const nowMs = currentUnixTimeMs();
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const loaded = loadStoredRoomEnvelope(
        await transaction.get<unknown>(ROOM_STORAGE_KEY),
        nowMs
      );

      if (!loaded.ok) {
        return {
          ok: false,
          status: statusForStoredRoomLoadFailure(loaded),
          error: loaded.error
        } as const;
      }

      const joined = dispatchRoomCommand(
        loaded.room,
        {
          type: "JOIN_ROOM",
          guestName: body.value.guestName,
          guestTokenHash,
          nowMs
        },
        rejectTokenVerification
      );

      if (!joined.ok) {
        return {
          ok: false,
          status: statusForDomainError(joined.error),
          error: joined.error
        } as const;
      }

      await transaction.put(
        ROOM_STORAGE_KEY,
        persistenceEnvelopeForStorage(joined.room, nowMs)
      );

      return {
        ok: true,
        room: joined.room
      } as const;
    });

    if (!result.ok) {
      return errorResponse(result.error, result.status);
    }

    this.broadcastRoomSnapshot(result.room);

    return jsonResponse<JoinRoomResponse>({
      ok: true,
      room: toPublicRoomSnapshot(result.room),
      guestToken
    });
  }

  private async applyRoomCommand(request: Request): Promise<Response> {
    const decoded = await decodeRoomCommandBody(request, currentUnixTimeMs());

    if (!decoded.ok) {
      return decoded.response;
    }

    const verifyToken = await buildTokenVerifier(decoded.value.credential);
    const nowMs = decoded.value.nowMs;
    const result = await this.applyDecodedRoomCommand(
      decoded.value,
      verifyToken,
      nowMs
    );

    if (!result.ok) {
      return errorResponse(result.error, result.status);
    }

    this.broadcastRoomSnapshot(result.room);

    return jsonResponse<CommandRoomResponse>({
      ok: true,
      room: toPublicRoomSnapshot(result.room)
    });
  }

  private async applyCustomAmazonItem(request: Request): Promise<Response> {
    const decoded = await decodeCustomAmazonItemBody(request);

    if (!decoded.ok) {
      return decoded.response;
    }

    const verifyToken = await buildTokenVerifier(decoded.value.credential);
    const nowMs = currentUnixTimeMs();
    const target = await this.loadCustomAmazonGenerationTarget(
      decoded.value.credential,
      verifyToken,
      nowMs
    );

    if (!target.ok) {
      return errorResponse(target.error, target.status);
    }

    const generated = await createWorkerRoomItemProviders({
      env: this.env,
      fetchImpl: (input, init) => fetch(input, init)
    }).generateCustomAmazonItem({ query: decoded.value.query });

    if (!generated.ok) {
      return errorResponse(
        {
          code: generated.error.code,
          message: itemGenerationErrorMessage(generated.error)
        },
        statusForItemGenerationError(generated.error.code)
      );
    }

    const result = await this.receiveGeneratedProviderItem(
      target.target,
      generated.item,
      nowMs,
      decoded.value.credential,
      verifyToken
    );

    if (!result.ok) {
      return errorResponse(result.error, result.status);
    }

    this.broadcastRoomSnapshot(result.room);

    return jsonResponse<CustomAmazonItemResponse>({
      ok: true,
      room: toPublicRoomSnapshot(result.room)
    });
  }

  private async acceptRoomSocket(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return errorResponse(
        { code: "method_not_allowed", message: "Room WebSocket upgrades must use GET." },
        405
      );
    }

    const roomId = this.roomId();

    if (!roomId.ok) {
      return roomId.response;
    }

    const credential = decodeSocketCredential(request, roomId.roomId);

    if (!credential.ok) {
      return credential.response;
    }

    const loaded = await this.loadStoredRoom(currentUnixTimeMs());

    if (!loaded.ok) {
      return errorResponse(loaded.error, statusForStoredRoomLoadFailure(loaded));
    }

    const verifyToken = await buildTokenVerifier(credential.value);
    const authorized = authorizeRoomAction(
      loaded.room,
      credential.value,
      { type: "access" },
      verifyToken
    );

    if (!authorized.ok) {
      return errorResponse(authorized.error, statusForDomainError(authorized.error));
    }

    const credentialToken = parseCapabilityToken(credential.value);

    if (!credentialToken.ok) {
      return errorResponse(
        { code: "invalid_request", message: "Room socket requires a valid player credential." },
        400
      );
    }

    const tokenHash = await hashCapabilityToken(credentialToken.token);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.serializeAttachment({
      kind: "trader-titan.room-socket.v1",
      roomId: roomId.roomId,
      role: credentialToken.token.role,
      tokenHash
    } satisfies RoomSocketAttachment);
    this.ctx.acceptWebSocket(server);
    server.send(roomSnapshotSocketMessage(toPublicRoomSnapshot(loaded.room)));

    return new Response(null, {
      headers: {
        "sec-websocket-protocol": ROOM_SOCKET_PROTOCOL
      },
      status: HTTP_SWITCHING_PROTOCOLS_STATUS,
      webSocket: client
    });
  }

  /**
   * WebSocket events can resume after hibernation, so each message reloads the
   * canonical room envelope before dispatching and persists only successful commands.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      sendSocketError(ws, {
        code: "invalid_request",
        message: "Room WebSocket messages must be JSON text commands."
      });

      return;
    }

    const decoded = decodeRoomCommandText(message, currentUnixTimeMs());

    if (!decoded.ok) {
      sendSocketError(ws, decoded.error);

      return;
    }

    const verifyToken = await buildTokenVerifier(decoded.command.credential);
    const result = await this.applyDecodedRoomCommand(
      decoded.command,
      verifyToken,
      decoded.command.nowMs
    );

    if (!result.ok) {
      sendSocketError(ws, result.error);

      return;
    }

    this.broadcastRoomSnapshot(result.room);
  }

  webSocketClose(): void {}

  webSocketError(): void {}

  private async applyDecodedRoomCommand(
    command: DecodedRoomCommand,
    verifyToken: TokenVerifier,
    nowMs: UnixTimeMs
  ): Promise<StoredRoomCommandResult> {
    const commandResult = await this.ctx.storage.transaction(async (transaction) => {
      const loaded = loadStoredRoomEnvelope(
        await transaction.get<unknown>(ROOM_STORAGE_KEY),
        nowMs
      );

      if (!loaded.ok) {
        return {
          ok: false,
          status: statusForStoredRoomLoadFailure(loaded),
          error: loaded.error
        } as const;
      }

      const commandResult = dispatchRoomCommand(
        loaded.room,
        command,
        verifyToken
      );

      if (!commandResult.ok) {
        return {
          ok: false,
          status: statusForDomainError(commandResult.error),
          error: commandResult.error
        } as const;
      }

      await transaction.put(
        ROOM_STORAGE_KEY,
        persistenceEnvelopeForStorage(commandResult.room, nowMs)
      );

      return {
        ok: true,
        room: commandResult.room
      } as const;
    });

    if (!commandResult.ok) {
      return commandResult;
    }

    return this.applyAutomaticRoomEffects(command, commandResult.room, nowMs);
  }

  private async applyAutomaticRoomEffects(
    command: DecodedRoomCommand,
    room: RoomState,
    nowMs: UnixTimeMs
  ): Promise<StoredRoomCommandResult> {
    if (shouldGenerateItemAfterCommand(command, room)) {
      const provider = createWorkerRoomItemProviders({
        env: this.env,
        fetchImpl: (input, init) => fetch(input, init)
      }).generateItem;
      const generated = await provider({ mode: room.game.mode });

      if (!generated.ok) {
        return this.recordRoomItemFailure(
          generationTargetForRoom(room),
          itemGenerationErrorMessage(generated.error),
          nowMs
        );
      }

      return this.receiveGeneratedProviderItem(
        generationTargetForRoom(room),
        generated.item,
        nowMs
      );
    }

    if (command.type === "EXECUTE_TRADE" && room.lifecycle === "active" && room.game.phase === "settling") {
      return this.receiveStoredSettlement(room, nowMs);
    }

    return {
      ok: true,
      room
    };
  }

  private async loadCustomAmazonGenerationTarget(
    credential: PresentedCapabilityToken,
    verifyToken: TokenVerifier,
    nowMs: UnixTimeMs
  ): Promise<
    | Readonly<{ ok: true; target: PendingItemGeneration }>
    | Readonly<{ ok: false; status: number; error: RoomHttpError | RoomDomainError }>
  > {
    const loaded = await this.loadStoredRoom(nowMs);

    if (!loaded.ok) {
      return {
        ok: false,
        status: statusForStoredRoomLoadFailure(loaded),
        error: loaded.error
      };
    }

    const authorization = authorizeCustomAmazonGeneration(
      loaded.room,
      credential,
      verifyToken
    );

    if (!authorization.ok) {
      return {
        ok: false,
        status: statusForDomainError(authorization.error),
        error: authorization.error
      };
    }

    return {
      ok: true,
      target: authorization.target
    };
  }

  private async receiveGeneratedProviderItem(
    target: PendingItemGeneration,
    providerItem: ProviderGeneratedItem,
    nowMs: UnixTimeMs,
    credential?: PresentedCapabilityToken,
    verifyToken?: TokenVerifier
  ): Promise<StoredRoomCommandResult> {
    const privateItem = createSettledGeneratedItem(generateRoundId(), providerItem);

    return this.ctx.storage.transaction(async (transaction) => {
      const loaded = loadStoredRoomEnvelope(
        await transaction.get<unknown>(ROOM_STORAGE_KEY),
        nowMs
      );

      if (!loaded.ok) {
        return {
          ok: false,
          status: statusForStoredRoomLoadFailure(loaded),
          error: loaded.error
        } as const;
      }

      if (!samePendingGeneration(loaded.room, target)) {
        return {
          ok: true,
          room: loaded.room
        } as const;
      }

      if (credential !== undefined && verifyToken !== undefined) {
        const authorization = authorizeCustomAmazonGeneration(
          loaded.room,
          credential,
          verifyToken
        );

        if (!authorization.ok) {
          return {
            ok: false,
            status: statusForDomainError(authorization.error),
            error: authorization.error
          } as const;
        }
      }

      await transaction.put(
        privateGeneratedItemStorageKey(privateItem.round_id),
        privateGeneratedItemEnvelopeForStorage(privateItem)
      );

      const eventResult = dispatchSystemRoomEvent(
        loaded.room,
        {
          type: "ITEM_RECEIVED",
          item: toGeneratedItem(privateItem),
          nowMs
        }
      );

      if (!eventResult.ok) {
        return {
          ok: false,
          status: statusForDomainError(eventResult.error),
          error: eventResult.error
        } as const;
      }

      await transaction.put(
        ROOM_STORAGE_KEY,
        persistenceEnvelopeForStorage(eventResult.room, nowMs)
      );

      return {
        ok: true,
        room: eventResult.room
      } as const;
    });
  }

  private async recordRoomItemFailure(
    target: PendingItemGeneration,
    message: string,
    nowMs: UnixTimeMs
  ): Promise<StoredRoomCommandResult> {
    return this.ctx.storage.transaction(async (transaction) => {
      const loaded = loadStoredRoomEnvelope(
        await transaction.get<unknown>(ROOM_STORAGE_KEY),
        nowMs
      );

      if (!loaded.ok) {
        return {
          ok: false,
          status: statusForStoredRoomLoadFailure(loaded),
          error: loaded.error
        } as const;
      }

      if (!samePendingGeneration(loaded.room, target)) {
        return {
          ok: true,
          room: loaded.room
        } as const;
      }

      const eventResult = dispatchSystemRoomEvent(
        loaded.room,
        {
          type: "ITEM_FAILED",
          error: message,
          nowMs
        }
      );

      if (!eventResult.ok) {
        return {
          ok: false,
          status: statusForDomainError(eventResult.error),
          error: eventResult.error
        } as const;
      }

      await transaction.put(
        ROOM_STORAGE_KEY,
        persistenceEnvelopeForStorage(eventResult.room, nowMs)
      );

      return {
        ok: true,
        room: eventResult.room
      } as const;
    });
  }

  private async receiveStoredSettlement(
    room: RoomState,
    nowMs: UnixTimeMs
  ): Promise<StoredRoomCommandResult> {
    if (room.lifecycle !== "active" || room.game.phase !== "settling") {
      return {
        ok: true,
        room
      };
    }

    const roundId = room.game.item.round_id;

    return this.ctx.storage.transaction(async (transaction) => {
      const loaded = loadStoredRoomEnvelope(
        await transaction.get<unknown>(ROOM_STORAGE_KEY),
        nowMs
      );

      if (!loaded.ok) {
        return {
          ok: false,
          status: statusForStoredRoomLoadFailure(loaded),
          error: loaded.error
        } as const;
      }

      if (
        loaded.room.lifecycle !== "active" ||
        loaded.room.game.phase !== "settling" ||
        loaded.room.game.item.round_id !== roundId
      ) {
        return {
          ok: true,
          room: loaded.room
        } as const;
      }

      const stored = loadPrivateGeneratedItemEnvelope(
        await transaction.get<unknown>(privateGeneratedItemStorageKey(roundId)),
        roundId
      );

      const eventResult = stored.ok
        ? dispatchSystemRoomEvent(
            loaded.room,
            {
              type: "SETTLEMENT_RECEIVED",
              item: stored.item,
              nowMs
            }
          )
        : dispatchSystemRoomEvent(
            loaded.room,
            {
              type: "SETTLEMENT_FAILED",
              error: PRIVATE_ITEM_UNAVAILABLE_MESSAGE,
              nowMs
            }
          );

      if (!eventResult.ok) {
        return {
          ok: false,
          status: statusForDomainError(eventResult.error),
          error: eventResult.error
        } as const;
      }

      await transaction.put(
        ROOM_STORAGE_KEY,
        persistenceEnvelopeForStorage(eventResult.room, nowMs)
      );

      return {
        ok: true,
        room: eventResult.room
      } as const;
    });
  }

  private broadcastRoomSnapshot(room: RoomState): void {
    const message = roomSnapshotSocketMessage(toPublicRoomSnapshot(room));

    for (const socket of this.ctx.getWebSockets()) {
      if (!socketCanReceiveRoomSnapshot(socket, room)) {
        closeSocketQuietly(socket, "Room seat changed.");
        continue;
      }

      sendSocketMessage(socket, message);
    }
  }

  private async createOrLoadStoredRoom(
    transaction: DurableObjectTransaction,
    roomId: RoomId,
    body: CreateRoomBody,
    hostTokenHash: TokenHash,
    nowMs: UnixTimeMs
  ): Promise<CreateOrLoadRoomResult> {
    const loaded = loadStoredRoomEnvelope(
      await transaction.get<unknown>(ROOM_STORAGE_KEY),
      nowMs
    );

    if (loaded.ok) {
      return {
        ok: true,
        created: false,
        room: loaded.room
      };
    }

    if (loaded.reason === "invalid") {
      return {
        ok: false,
        status: statusForStoredRoomLoadFailure(loaded),
        error: loaded.error
      };
    }

    const room = createLobbyRoom({
      id: roomId,
      hostName: body.hostName,
      hostTokenHash,
      config: body.config,
      nowMs
    });

    await transaction.put(ROOM_STORAGE_KEY, persistenceEnvelopeForStorage(room, nowMs));

    return {
      ok: true,
      created: true,
      room
    };
  }

  private async loadStoredRoom(nowMs: UnixTimeMs): Promise<StoredRoomLoadResult> {
    return loadStoredRoomEnvelope(
      await this.ctx.storage.get<unknown>(ROOM_STORAGE_KEY),
      nowMs
    );
  }

  private roomId():
    | Readonly<{ ok: true; roomId: RoomId }>
    | Readonly<{ ok: false; response: Response }> {
    const parsed = parseRoomId(this.ctx.id.name ?? this.ctx.id.toString());

    if (parsed.ok) {
      return parsed;
    }

    return {
      ok: false,
      response: errorResponse(parsed.error, 400)
    };
  }
}

const worker = {
  fetch(
    request: WorkerFetchRequest,
    env: WorkerFetchEnv,
    ctx: WorkerFetchContext
  ): Response | Promise<Response> {
    const roomResponse = routePublicRoomRequest(request, env);

    if (roomResponse !== null) {
      return roomResponse;
    }

    return getOpenNextWorker().fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Cloudflare.Env>;

export default worker;

function getOpenNextWorker(): OpenNextWorker {
  if (typeof openNextWorker.fetch !== "function") {
    throw new Error("Generated OpenNext worker is missing a fetch handler.");
  }

  return openNextWorker;
}

function routePublicRoomRequest(
  request: WorkerFetchRequest,
  env: WorkerFetchEnv
): Response | Promise<Response> | null {
  const url = new URL(request.url);
  const pathname = normalizePathname(url.pathname);

  if (LEGACY_NEXT_GAME_API_PATHS.has(pathname)) {
    return errorResponse(
      {
        code: "legacy_game_api_disabled",
        message: "This endpoint has moved to Durable Object room routes."
      },
      410
    );
  }

  if (pathname === PUBLIC_ROOMS_ENDPOINT) {
    if (request.method !== "POST") {
      return errorResponse(
        { code: "method_not_allowed", message: "HTTP method is not supported for this room endpoint." },
        405
      );
    }

    return forwardRoomRequest(request, env, generateRoomId(), ROOM_ENDPOINT);
  }

  if (!pathname.startsWith(`${PUBLIC_ROOMS_ENDPOINT}/`)) {
    return null;
  }

  const routeParts = pathname.slice(PUBLIC_ROOMS_ENDPOINT.length + 1).split("/");
  const parsedRoomId = parseRoomId(routeParts[0]);

  if (!parsedRoomId.ok) {
    return errorResponse(parsedRoomId.error, 400);
  }

  if (routeParts.length === 1 && request.method === "GET") {
    return forwardRoomRequest(request, env, parsedRoomId.roomId, ROOM_ENDPOINT);
  }

  if (routeParts.length === 2 && routeParts[1] === "access" && request.method === "POST") {
    return forwardRoomRequest(request, env, parsedRoomId.roomId, ROOM_ACCESS_ENDPOINT);
  }

  if (routeParts.length === 2 && routeParts[1] === "join" && request.method === "POST") {
    return forwardRoomRequest(request, env, parsedRoomId.roomId, ROOM_JOIN_ENDPOINT);
  }

  if (routeParts.length === 2 && routeParts[1] === "command" && request.method === "POST") {
    return forwardRoomRequest(request, env, parsedRoomId.roomId, ROOM_COMMAND_ENDPOINT);
  }

  if (routeParts.length === 2 && routeParts[1] === PUBLIC_CUSTOM_AMAZON_ITEM_ROUTE && request.method === "POST") {
    return forwardRoomRequest(request, env, parsedRoomId.roomId, ROOM_CUSTOM_AMAZON_ITEM_ENDPOINT);
  }

  if (routeParts.length === 2 && routeParts[1] === "socket") {
    if (request.method !== "GET") {
      return errorResponse(
        { code: "method_not_allowed", message: "Room WebSocket upgrades must use GET." },
        405
      );
    }

    if (!hasWebSocketUpgrade(request)) {
      return errorResponse(
        { code: "invalid_request", message: "Room socket route requires a WebSocket upgrade." },
        400
      );
    }

    return forwardRoomRequest(request, env, parsedRoomId.roomId, ROOM_SOCKET_ENDPOINT);
  }

  if (routeParts.length === 1 || routeParts.length === 2) {
    return errorResponse(
      { code: "method_not_allowed", message: "HTTP method is not supported for this room endpoint." },
      405
    );
  }

  return errorResponse(
    { code: "not_found", message: "Room endpoint was not found." },
    404
  );
}

function forwardRoomRequest(
  request: WorkerFetchRequest,
  env: WorkerFetchEnv,
  roomId: RoomId,
  roomPathname: string
): Promise<Response> {
  const roomUrl = new URL(request.url);
  roomUrl.pathname = roomPathname;
  const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomId));

  return stub.fetch(new Request(roomUrl.toString(), request));
}

function generateRoomId(): RoomId {
  for (let attempt = 0; attempt < ROOM_ID_GENERATION_ATTEMPTS; attempt += 1) {
    const parsed = parseRoomId(`room-${crypto.randomUUID()}`);

    if (parsed.ok) {
      return parsed.roomId;
    }
  }

  throw new Error("Generated room id failed validation.");
}

function generateRoundId(): string {
  return crypto.randomUUID();
}

function shouldGenerateItemAfterCommand(
  command: DecodedRoomCommand,
  room: RoomState
): boolean {
  return (command.type === "START_ROOM" || command.type === "ADVANCE_ROUND") &&
    room.lifecycle === "active" &&
    room.game.phase === "generatingItem" &&
    !isCustomAmazonGenerationPending(room);
}

function isCustomAmazonGenerationPending(room: RoomState): boolean {
  return room.lifecycle === "active" &&
    room.game.phase === "generatingItem" &&
    room.game.mode === "Amazon" &&
    room.game.customAmazonQuery === true;
}

function generationTargetForRoom(room: RoomState): PendingItemGeneration {
  if (room.lifecycle !== "active" || room.game.phase !== "generatingItem") {
    throw new Error("Generation target requires an active generating room.");
  }

  return {
    roomId: room.id,
    revision: room.revision,
    roundNumber: room.game.roundNumber,
    mode: room.game.mode,
    customAmazonQuery: room.game.customAmazonQuery === true
  };
}

function samePendingGeneration(
  room: RoomState,
  target: PendingItemGeneration
): boolean {
  return room.id === target.roomId &&
    room.revision === target.revision &&
    room.lifecycle === "active" &&
    room.game.phase === "generatingItem" &&
    room.game.roundNumber === target.roundNumber &&
    room.game.mode === target.mode &&
    (room.game.customAmazonQuery === true) === target.customAmazonQuery;
}

function authorizeCustomAmazonGeneration(
  room: RoomState,
  credential: PresentedCapabilityToken,
  verifyToken: TokenVerifier
):
  | Readonly<{ ok: true; target: PendingItemGeneration }>
  | Readonly<{ ok: false; error: RoomDomainError }> {
  if (!isCustomAmazonGenerationPending(room)) {
    return {
      ok: false,
      error: roomDomainError(
        "invalid_game_phase",
        "Custom Amazon items can only be submitted while the active room is waiting for a custom Amazon query."
      )
    };
  }

  const authorized = authorizeRoomAction(
    room,
    credential,
    { type: "activePlayer", playerId: room.game.roles.trader },
    verifyToken
  );

  return authorized.ok
    ? { ok: true, target: generationTargetForRoom(room) }
    : { ok: false, error: authorized.error };
}

function decodeRoomCommandText(
  text: string,
  nowMs: UnixTimeMs
):
  | Readonly<{ ok: true; command: DecodedRoomCommand }>
  | Readonly<{ ok: false; error: RoomSocketError }> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: "Room WebSocket message must be valid JSON."
      }
    };
  }

  const decoded = parseClientRoomCommand(parsed, nowMs);

  if (!decoded.ok) {
    return {
      ok: false,
      error: decoded.error
    };
  }

  if (decoded.command.type === "JOIN_ROOM") {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: "JOIN_ROOM commands must use POST /room/join."
      }
    };
  }

  return {
    ok: true,
    command: decoded.command
  };
}

function roomSnapshotSocketMessage(room: PublicRoomSnapshot): string {
  return JSON.stringify({
    type: ROOM_SOCKET_MESSAGE_ROOM_SNAPSHOT,
    room
  } satisfies RoomSocketMessage);
}

function roomErrorSocketMessage(error: RoomSocketError): string {
  return JSON.stringify({
    type: ROOM_SOCKET_MESSAGE_ROOM_ERROR,
    error
  } satisfies RoomSocketMessage);
}

function sendSocketError(socket: WebSocket, error: RoomSocketError): void {
  sendSocketMessage(socket, roomErrorSocketMessage(error));
}

function sendSocketMessage(socket: WebSocket, message: string): void {
  try {
    socket.send(message);
  } catch {
    socket.close();
  }
}

function socketCanReceiveRoomSnapshot(socket: WebSocket, room: RoomState): boolean {
  const attachment = parseRoomSocketAttachment(socket.deserializeAttachment());

  if (attachment === null || attachment.roomId !== room.id) {
    return false;
  }

  if (attachment.role === "host") {
    return attachment.tokenHash === room.host.tokenHash;
  }

  return room.guest !== null && attachment.tokenHash === room.guest.tokenHash;
}

function parseRoomSocketAttachment(value: unknown): RoomSocketAttachment | null {
  if (!isRecord(value) || value.kind !== "trader-titan.room-socket.v1") {
    return null;
  }

  const roomId = parseRoomId(value.roomId);
  const tokenHash = parseTokenHash(value.tokenHash);

  if (
    !roomId.ok ||
    !tokenHash.ok ||
    (value.role !== "host" && value.role !== "guest")
  ) {
    return null;
  }

  return {
    kind: "trader-titan.room-socket.v1",
    roomId: roomId.roomId,
    role: value.role,
    tokenHash: tokenHash.tokenHash
  };
}

function closeSocketQuietly(socket: WebSocket, reason: string): void {
  try {
    socket.close(1008, reason);
  } catch {
    try {
      socket.close();
    } catch {}
  }
}

function decodeSocketCredential(
  request: Request,
  roomId: RoomId
): BodyDecodeResult<PresentedCapabilityToken> {
  const protocols = socketProtocolsFromHeader(
    request.headers.get("sec-websocket-protocol")
  );

  if (!protocols.includes(ROOM_SOCKET_PROTOCOL)) {
    return invalidRequest("Room socket requires a valid player credential.");
  }

  const role = decodeSocketProtocolValue(
    protocols,
    ROOM_SOCKET_ROLE_PROTOCOL_PREFIX
  );
  const secret = decodeSocketProtocolValue(
    protocols,
    ROOM_SOCKET_SECRET_PROTOCOL_PREFIX
  );
  const parsed = parseCapabilityToken({
    roomId,
    role,
    secret
  });

  if (!parsed.ok) {
    return invalidRequest("Room socket requires a valid player credential.");
  }

  return {
    ok: true,
    value: {
      roomId: parsed.token.roomId,
      role: parsed.token.role,
      secret: parsed.token.secret
    }
  };
}

function socketProtocolsFromHeader(header: string | null): string[] {
  return header === null
    ? []
    : header.split(",").map((protocol) => protocol.trim()).filter(Boolean);
}

function decodeSocketProtocolValue(
  protocols: string[],
  prefix: string
): string | null {
  const protocol = protocols.find((candidate) => candidate.startsWith(prefix));

  return protocol === undefined ? null : protocol.slice(prefix.length);
}

async function decodeCreateRoomBody(
  request: Request
): Promise<BodyDecodeResult<CreateRoomBody>> {
  const parsed = await readJsonObjectBody(request, true);

  if (!parsed.ok) {
    return parsed;
  }

  const hostName = decodeOptionalDisplayName(parsed.value.hostName, "Host");

  if (!hostName.ok) {
    return hostName;
  }

  const config = decodeOptionalRoomConfigPatch(parsed.value.config);

  if (!config.ok) {
    return config;
  }

  return {
    ok: true,
    value: {
      hostName: hostName.value,
      config: config.value
    }
  };
}

async function decodeJoinRoomBody(
  request: Request
): Promise<BodyDecodeResult<JoinRoomBody>> {
  const parsed = await readJsonObjectBody(request, true);

  if (!parsed.ok) {
    return parsed;
  }

  const guestName = decodeOptionalDisplayName(parsed.value.guestName, "Guest");

  if (!guestName.ok) {
    return guestName;
  }

  return {
    ok: true,
    value: {
      guestName: guestName.value
    }
  };
}

async function decodeRoomCommandBody(
  request: Request,
  nowMs: UnixTimeMs
): Promise<BodyDecodeResult<DecodedRoomCommand>> {
  const parsed = await readJsonObjectBody(request, false);

  if (!parsed.ok) {
    return parsed;
  }

  const decoded = parseClientRoomCommand(parsed.value, nowMs);

  if (!decoded.ok) {
    return invalidProtocolRequest(decoded.error);
  }

  if (decoded.command.type === "JOIN_ROOM") {
    return invalidRequest("JOIN_ROOM commands must use POST /room/join.");
  }

  return {
    ok: true,
    value: decoded.command
  };
}

async function decodeAccessRoomBody(
  request: Request
): Promise<BodyDecodeResult<AccessRoomBody>> {
  const parsed = await readJsonObjectBody(request, false);

  if (!parsed.ok) {
    return parsed;
  }

  const credential = parseCapabilityToken(parsed.value.credential);

  if (!credential.ok) {
    return invalidRequest("Room access requires a valid player credential.");
  }

  return {
    ok: true,
    value: {
      credential: {
        roomId: credential.token.roomId,
        role: credential.token.role,
        secret: credential.token.secret
      }
    }
  };
}

async function decodeCustomAmazonItemBody(
  request: Request
): Promise<BodyDecodeResult<CustomAmazonItemBody>> {
  const parsed = await readJsonObjectBody(request, false);

  if (!parsed.ok) {
    return parsed;
  }

  const credential = parseCapabilityToken(parsed.value.credential);

  if (!credential.ok) {
    return invalidRequest(credential.error.message);
  }

  return {
    ok: true,
    value: {
      credential: {
        roomId: credential.token.roomId,
        role: credential.token.role,
        secret: credential.token.secret
      },
      query: parsed.value.query
    }
  };
}

async function readJsonObjectBody(
  request: Request,
  allowEmpty: boolean
): Promise<BodyDecodeResult<JsonRecord>> {
  const text = await request.text();

  if (text.trim().length === 0) {
    if (allowEmpty) {
      return { ok: true, value: {} };
    }

    return invalidRequest("JSON request body is required.");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return invalidRequest("JSON request body is malformed.");
  }

  if (!isRecord(parsed)) {
    return invalidRequest("JSON request body must be an object.");
  }

  return { ok: true, value: parsed };
}

function decodeOptionalDisplayName(
  value: unknown,
  fallback: string
): BodyDecodeResult<string> {
  if (value === undefined) {
    return { ok: true, value: fallback };
  }

  if (typeof value !== "string") {
    return invalidRequest("Display name must be a string.");
  }

  return { ok: true, value };
}

function decodeOptionalRoomConfigPatch(
  value: unknown
): BodyDecodeResult<Partial<RoomGameConfig> | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  const config = parseRoomGameConfigPatch(value);

  if (!config.ok) {
    return invalidProtocolRequest(config.error);
  }

  return {
    ok: true,
    value: config.config
  };
}

function loadStoredRoomEnvelope(
  envelope: unknown,
  nowMs: UnixTimeMs
): StoredRoomLoadResult {
  if (envelope === undefined) {
    return {
      ok: false,
      reason: "missing",
      error: {
        code: "room_not_found",
        message: "Room has not been created."
      }
    };
  }

  const loaded = loadPersistenceEnvelope(envelope, nowMs);

  if (loaded.ok) {
    return loaded;
  }

  return {
    ok: false,
    reason: loaded.error.code === "persistence_expired" ? "expired" : "invalid",
    error: loaded.error
  };
}

function persistenceEnvelopeForStorage(room: RoomState, nowMs: UnixTimeMs): unknown {
  return JSON.parse(JSON.stringify(toPersistenceEnvelope(room, nowMs))) as unknown;
}

function privateGeneratedItemEnvelopeForStorage(item: SettledGeneratedItem): unknown {
  return JSON.parse(JSON.stringify(toPrivateGeneratedItemEnvelope(item))) as unknown;
}

function generateCapabilityToken(
  role: CapabilityRole,
  roomId: RoomId
): RoomCapabilityToken {
  const secretBytes = new Uint8Array(TOKEN_SECRET_BYTE_LENGTH);
  crypto.getRandomValues(secretBytes);
  const parsed = parseCapabilityToken({
    roomId,
    role,
    secret: bytesToHex(secretBytes)
  });

  if (!parsed.ok) {
    throw new Error(`Generated room capability token failed validation: ${parsed.error.code}`);
  }

  return parsed.token;
}

async function hashCapabilityToken(token: RoomCapabilityToken): Promise<TokenHash> {
  const digest = await crypto.subtle.digest(
    TOKEN_HASH_ALGORITHM,
    new TextEncoder().encode(
      `${TOKEN_HASH_INPUT_PREFIX}:${token.roomId}:${token.role}:${token.secret}`
    )
  );
  const parsed = parseTokenHash(
    `${TOKEN_HASH_PREFIX}:${bytesToHex(new Uint8Array(digest))}`
  );

  if (!parsed.ok) {
    throw new Error(`Generated room capability token hash failed validation: ${parsed.error.code}`);
  }

  return parsed.tokenHash;
}

async function buildTokenVerifier(
  credential: PresentedCapabilityToken
): Promise<TokenVerifier> {
  const parsed = parseCapabilityToken(credential);

  if (!parsed.ok) {
    return () => false;
  }

  const credentialHash = await hashCapabilityToken(parsed.token);

  return (token, expectedHash) =>
    capabilityTokensEqual(token, parsed.token) && expectedHash === credentialHash;
}

function capabilityTokensEqual(
  left: RoomCapabilityToken,
  right: RoomCapabilityToken
): boolean {
  return left.roomId === right.roomId &&
    left.role === right.role &&
    left.secret === right.secret;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(BYTE_HEX_RADIX).padStart(BYTE_HEX_PAD_LENGTH, "0")
  ).join("");
}

function currentUnixTimeMs(): UnixTimeMs {
  return Date.now();
}

function normalizePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

function hasWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest<T>(message: string): BodyDecodeResult<T> {
  return {
    ok: false,
    response: errorResponse(
      {
        code: "invalid_request",
        message
      },
      400
    )
  };
}

function invalidProtocolRequest<T>(
  error: RoomProtocolDecodeError
): BodyDecodeResult<T> {
  return {
    ok: false,
    response: errorResponse(
      {
        code: error.code,
        message: error.message
      },
      400
    )
  };
}

function statusForStoredRoomLoadFailure(
  result: Exclude<StoredRoomLoadResult, { ok: true }>
): number {
  switch (result.reason) {
    case "missing":
      return 404;
    case "expired":
      return 410;
    case "invalid":
      return 500;
    default:
      return assertNever(result.reason);
  }
}

function statusForDomainError(error: RoomDomainError): number {
  switch (error.code) {
    case "missing_token":
      return 401;
    case "invalid_token":
    case "wrong_room":
    case "spectator_access_denied":
    case "token_mismatch":
    case "stale_guest":
    case "host_control_denied":
    case "wrong_active_role":
      return 403;
    case "invalid_config":
      return 400;
    case "persistence_expired":
      return 410;
    case "persistence_invalid":
    case "persistence_version_unsupported":
      return 500;
    case "room_not_in_lobby":
    case "room_not_active":
    case "room_not_finished":
    case "guest_slot_full":
    case "guest_slot_empty":
    case "guest_required":
    case "invalid_game_phase":
      return 409;
    default:
      return assertNever(error.code);
  }
}

function statusForItemGenerationError(code: string): number {
  switch (code) {
    case "invalid_custom_query":
      return 400;
    case "missing_api_key":
      return 500;
    case "amazon_price_unavailable":
    case "invalid_provider_response":
    case "provider_failed":
      return 502;
    default:
      return 502;
  }
}

function jsonResponse<T>(body: T, status = 200): Response {
  return Response.json(body, {
    headers: {
      "content-type": JSON_CONTENT_TYPE
    },
    status
  });
}

function errorResponse(
  error: RoomHttpError | RoomDomainError,
  status: number
): Response {
  return jsonResponse<RoomErrorResponse>(
    {
      ok: false,
      error
    },
    status
  );
}

function assertNever(value: never): never {
  throw new Error(`Unexpected room worker value: ${JSON.stringify(value)}`);
}
