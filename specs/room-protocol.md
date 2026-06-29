# Room Protocol Spec

The room protocol is the boundary between client transports and the pure room domain.

## Principles

- Client messages must be decoded from `unknown` before reaching room commands.
- Every client command carries either a host/guest capability token or an explicit join token hash.
- System events are produced by trusted server-side effects, not by clients.
- Settlement events carry the settled private item only; the room command layer computes the score-affecting settlement.
- Every successful mutation increments the room revision exactly once and broadcasts a public room snapshot.
- Every rejected command returns a typed room-domain error and preserves the previous room state.

## Client Commands

- `JOIN_ROOM`: guest display name and guest token hash.
- `CONFIGURE_ROOM`: host credential and partial config.
- `START_ROOM`: host credential.
- `RESET_TO_LOBBY`: host credential.
- `KICK_GUEST`: host credential.
- `ADVANCE_ROUND`: host credential.
- `SUBMIT_INITIAL_WIDTH`: active player credential and width.
- `TIGHTEN_WIDTH`: active player credential and width.
- `TRADE_ON_WIDTH`: active player credential.
- `SUBMIT_MARKET_QUOTE`: active player credential and quote.
- `EXECUTE_TRADE`: active player credential and side.

## System Events

- `ITEM_RECEIVED`: generated public item.
- `ITEM_FAILED`: safe error message.
- `SETTLEMENT_RECEIVED`: settled private item. No caller-provided settlement is accepted.
- `SETTLEMENT_FAILED`: safe error message.

## Transport Notes

The Durable Object slice should implement one runtime decoder for these messages and one dispatcher that calls the pure room command functions. WebSocket broadcasts should contain public room snapshots, never persistence envelopes.
