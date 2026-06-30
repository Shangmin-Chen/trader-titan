"use client";

import {
  formatNumber,
  type Player,
  type PlayerId,
  type Roles,
} from "../lib/game";
import { SpreadWidthForm } from "./SpreadWidthForm";
import styles from "./WidthNegotiationPanel.module.css";

export type WidthNegotiationPanelProps = {
  disabled?: boolean;
  onTighten: (width: number) => void;
  onTrade: () => void;
  players: Record<PlayerId, Player>;
  roles: Roles;
  spreadWidth: number;
};

export function WidthNegotiationPanel({
  disabled = false,
  onTighten,
  onTrade,
  players,
  roles,
  spreadWidth,
}: WidthNegotiationPanelProps) {
  const traderName = players[roles.trader].name;
  const makerName = players[roles.marketMaker].name;
  const formattedWidth = formatNumber(spreadWidth);

  return (
    <section className="trading-panel" data-testid="width-negotiation-panel">
      <header className="trading-panel__header">
        <h2 className="trading-panel__title">Width negotiation</h2>
      </header>

      <div className={styles.widthSpotlight}>
        <span className={styles.widthSpotlightLabel}>Current width</span>
        <span className={styles.widthSpotlightValue}>{formattedWidth}</span>
        <span className={styles.widthSpotlightHint}>
          {makerName} is making the market. {traderName} decides what happens
          next.
        </span>
      </div>

      {disabled ? (
        <p className={styles.waitNotice} role="status">
          Waiting for {traderName} to either trade on the width or tighten it.
        </p>
      ) : (
        <p className={styles.prompt}>{traderName}, choose one path:</p>
      )}

      <div className={styles.pathways}>
        <div className={`${styles.pathway} ${styles.pathwayTrade}`}>
          <h3 className={styles.pathwayTitle}>Trade on width</h3>
          <p className={styles.pathwayCopy}>
            Accept the {formattedWidth}-wide market and trade at it now. This
            locks in the deal at the current width.
          </p>
          <div className="trading-panel__actions">
            <button
              className="trading-panel__button trading-panel__button--buy"
              disabled={disabled}
              onClick={onTrade}
              type="button"
            >
              Trade on width
            </button>
          </div>
        </div>

        <div className={styles.pathwayDivider} aria-hidden="true">
          or
        </div>

        <div className={`${styles.pathway} ${styles.pathwayTighten}`}>
          <h3 className={styles.pathwayTitle}>Tighten width</h3>
          <p className={styles.pathwayCopy}>
            Demand a narrower market. This hands the decision back to{" "}
            <span className={styles.pathwayMaker}>{makerName}</span>, who must
            re-quote inside your tighter width before any trade.
          </p>
          <SpreadWidthForm
            currentWidth={spreadWidth}
            disabled={disabled}
            label="Tighter width"
            onSubmit={onTighten}
            submitLabel="Tighten width"
          />
        </div>
      </div>
    </section>
  );
}
