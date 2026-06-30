"use client";

import {
  formatNumber,
  formatQuote,
  type Player,
  type PlayerId,
  type Quote,
  type Roles,
} from "../lib/game";
import styles from "./TradeActionPanel.module.css";

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
  const traderName = players[roles.trader].name;
  const askLabel = formatNumber(quote.ask);
  const bidLabel = formatNumber(quote.bid);

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
          <dd>{traderName}</dd>
        </div>
      </dl>

      {/* Prominent live quote board: makes the two tradable prices unmistakable */}
      <div className={styles.quoteBoard} aria-label="Live quote">
        <div className={`${styles.quoteSide} ${styles.quoteSideSell}`}>
          <span className={styles.quoteLabel}>Bid · you sell</span>
          <span className={styles.quoteValue}>{bidLabel}</span>
        </div>
        <div className={`${styles.quoteSide} ${styles.quoteSideBuy}`}>
          <span className={styles.quoteLabel}>Ask · you buy</span>
          <span className={styles.quoteValue}>{askLabel}</span>
        </div>
      </div>

      {/* Hidden descriptions tie each button to its quote side for assistive tech */}
      <span id="trade-action-buy-desc" className={styles.srOnly}>
        Buy at the ask price of {askLabel}.
      </span>
      <span id="trade-action-sell-desc" className={styles.srOnly}>
        Sell at the bid price of {bidLabel}.
      </span>

      {disabled ? (
        <p className={styles.turnNotice} role="status">
          Waiting for <strong>{traderName}</strong> to choose Buy or Sell.
        </p>
      ) : null}

      <div
        className={`trading-panel__actions ${styles.actions} sticky-action-bar`}
        aria-label="Trading actions"
      >
        <button
          aria-describedby="trade-action-sell-desc"
          className={`trading-panel__button trading-panel__button--sell ${styles.button} ${styles.buttonSell}`}
          disabled={disabled}
          onClick={onSell}
          type="button"
        >
          <span aria-hidden="true" className={styles.icon}>
            <svg viewBox="0 0 24 24" fill="none" width="22" height="22">
              <path
                d="M12 5v14M12 19l-6-6M12 19l6-6"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className={styles.label}>Sell</span>
          <span aria-hidden="true" className={styles.price}>
            @ {bidLabel}
          </span>
        </button>
        <button
          aria-describedby="trade-action-buy-desc"
          className={`trading-panel__button trading-panel__button--buy ${styles.button} ${styles.buttonBuy}`}
          disabled={disabled}
          onClick={onBuy}
          type="button"
        >
          <span aria-hidden="true" className={styles.icon}>
            <svg viewBox="0 0 24 24" fill="none" width="22" height="22">
              <path
                d="M12 19V5M12 5l-6 6M12 5l6 6"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className={styles.label}>Buy</span>
          <span aria-hidden="true" className={styles.price}>
            @ {askLabel}
          </span>
        </button>
      </div>
    </section>
  );
}
