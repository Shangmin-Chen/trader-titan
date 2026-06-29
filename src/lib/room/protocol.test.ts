import {
  parseClientRoomCommand,
  parseSystemRoomEvent,
  type SystemRoomEvent,
} from "./protocol";

type SettlementReceivedEvent = Extract<
  SystemRoomEvent,
  { type: "SETTLEMENT_RECEIVED" }
>;
type ExpectFalse<T extends false> = T;
type SettlementFieldIsPresent = "settlement" extends keyof SettlementReceivedEvent
  ? true
  : false;
type SettlementFieldMustBeAbsent = ExpectFalse<SettlementFieldIsPresent>;

const NOW_MS = 30_000;
const credential = {
  roomId: "room_protocol_0001",
  role: "host",
  secret: "host_secret_protocol_0001",
};
const settledItem = {
  round_id: "round-protocol-1",
  item_title: "Seconds in an hour",
  category: "Fermi Math & Geometry",
  context_clue: "60 minutes times 60 seconds.",
  true_value: 3_600,
};

describe("room protocol", () => {
  it("rejects malformed client command payloads before dispatch", () => {
    const cases = [
      {
        value: null,
        code: "message_not_object",
      },
      {
        value: { type: 42 },
        code: "message_type_invalid",
      },
      {
        value: { type: "UNKNOWN_ROOM_COMMAND" },
        code: "message_type_unknown",
      },
      {
        value: {
          type: "JOIN_ROOM",
          guestTokenHash: "bad",
          guestName: "Grace",
        },
        code: "guest_token_hash_invalid",
      },
      {
        value: {
          type: "CONFIGURE_ROOM",
          credential,
          config: { totalRounds: "3" },
        },
        code: "config_invalid",
      },
      {
        value: {
          type: "SUBMIT_INITIAL_WIDTH",
          credential,
          width: 0,
        },
        code: "width_invalid",
      },
      {
        value: {
          type: "SUBMIT_MARKET_QUOTE",
          credential,
          quote: { bid: 10, ask: 5 },
        },
        code: "quote_invalid",
      },
      {
        value: {
          type: "EXECUTE_TRADE",
          credential,
          side: "HOLD",
        },
        code: "trade_side_invalid",
      },
    ] as const;

    for (const testCase of cases) {
      const result = parseClientRoomCommand(testCase.value, NOW_MS);

      expect(result.ok).toBe(false);

      if (result.ok) {
        throw new Error("Expected command parse failure.");
      }

      expect(result.error.code).toBe(testCase.code);
    }
  });

  it("does not expose caller-supplied settlement data in system events", () => {
    const event: SettlementReceivedEvent = {
      type: "SETTLEMENT_RECEIVED",
      item: settledItem,
      nowMs: 1,
    };
    const typeCheck: SettlementFieldMustBeAbsent = false;

    expect("settlement" in event).toBe(false);
    expect(typeCheck).toBe(false);
  });

  it("rejects caller-supplied settlement data at the runtime boundary", () => {
    const result = parseSystemRoomEvent(
      {
        type: "SETTLEMENT_RECEIVED",
        item: settledItem,
        settlement: {
          traderPnL: 9_999,
          marketMakerPnL: -9_999,
        },
      },
      NOW_MS,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "settlement_not_allowed",
        message: "Settlement is computed by the room command layer and cannot be supplied by callers.",
        path: "settlement",
      },
    });
  });
});
