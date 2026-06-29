"use client";

import {
  formatNumber,
  type Player,
  type PlayerId,
  type Roles,
} from "../lib/game";
import { SpreadWidthForm } from "./SpreadWidthForm";

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
  return (
    <section className="trading-panel" data-testid="width-negotiation-panel">
      <header className="trading-panel__header">
        <h2 className="trading-panel__title">Width negotiation</h2>
        <p className="trading-panel__quote">
          Current width: {formatNumber(spreadWidth)}
        </p>
      </header>

      <dl className="trading-panel__roles">
        <div className="trading-panel__role">
          <dt>Width owner</dt>
          <dd>{players[roles.marketMaker].name}</dd>
        </div>
        <div className="trading-panel__role">
          <dt>Decision</dt>
          <dd>{players[roles.trader].name}</dd>
        </div>
      </dl>

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

      <SpreadWidthForm
        currentWidth={spreadWidth}
        disabled={disabled}
        label="Tighter width"
        onSubmit={onTighten}
        submitLabel="Tighten width"
      />
    </section>
  );
}
