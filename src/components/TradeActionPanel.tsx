"use client";

import {
  formatQuote,
  type Player,
  type PlayerId,
  type Quote,
  type Roles,
} from "../lib/game";

export type TradeActionPanelProps = {
  disabled?: boolean;
  onBuy: () => void;
  onSell: () => void;
  players: Record<PlayerId, Player>;
  quote: Quote;
  roles: Roles;
};

export function TradeActionPanel({
  disabled = false,
  onBuy,
  onSell,
  players,
  quote,
  roles,
}: TradeActionPanelProps) {
  return (
    <section className="trading-panel" data-testid="trade-action-panel">
      <header className="trading-panel__header">
        <h2 className="trading-panel__title">Choose trade</h2>
        <p className="trading-panel__quote">Quote: {formatQuote(quote)}</p>
      </header>

      <dl className="trading-panel__roles">
        <div className="trading-panel__role">
          <dt>Market maker</dt>
          <dd>{players[roles.marketMaker].name}</dd>
        </div>
        <div className="trading-panel__role">
          <dt>Trader</dt>
          <dd>{players[roles.trader].name}</dd>
        </div>
      </dl>

      <div className="trading-panel__actions" aria-label="Trading actions">
        <button
          className="trading-panel__button trading-panel__button--buy"
          disabled={disabled}
          onClick={onBuy}
          type="button"
        >
          Buy
        </button>
        <button
          className="trading-panel__button trading-panel__button--sell"
          disabled={disabled}
          onClick={onSell}
          type="button"
        >
          Sell
        </button>
      </div>
    </section>
  );
}
