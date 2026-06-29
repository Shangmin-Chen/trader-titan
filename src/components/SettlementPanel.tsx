import {
  formatNumber,
  formatSignedNumber,
  formatTradeSide,
  type Player,
  type PlayerId,
  type RoundSettlement,
} from "../lib/game";

export type SettlementPanelProps = {
  disabled?: boolean;
  isFinalRound?: boolean;
  onContinue: () => void;
  players: Record<PlayerId, Player>;
  settlement: RoundSettlement;
};

export function SettlementPanel({
  disabled = false,
  isFinalRound = false,
  onContinue,
  players,
  settlement,
}: SettlementPanelProps) {
  const trader = players[settlement.trader];
  const marketMaker = players[settlement.marketMaker];

  return (
    <section className="settlement-panel" data-testid="settlement-panel">
      <header className="settlement-panel__header">
        <p className="settlement-panel__round">Round {settlement.roundNumber}</p>
        <h2 className="settlement-panel__title">Settlement</h2>
      </header>

      <dl className="settlement-panel__details">
        <div className="settlement-panel__detail">
          <dt>Item</dt>
          <dd>{settlement.itemTitle}</dd>
        </div>
        <div className="settlement-panel__detail">
          <dt>True value</dt>
          <dd>{formatNumber(settlement.trueValue)}</dd>
        </div>
        <div className="settlement-panel__detail">
          <dt>Transaction</dt>
          <dd>
            {formatTradeSide(settlement.side)} at{" "}
            {formatNumber(settlement.transactionPrice)}
          </dd>
        </div>
        <div className="settlement-panel__detail">
          <dt>{trader.name} trader PnL</dt>
          <dd>{formatSignedNumber(settlement.traderPnL)}</dd>
        </div>
        <div className="settlement-panel__detail">
          <dt>{marketMaker.name} market maker PnL</dt>
          <dd>{formatSignedNumber(settlement.marketMakerPnL)}</dd>
        </div>
      </dl>

      <button
        className="settlement-panel__continue"
        disabled={disabled}
        onClick={onContinue}
        type="button"
      >
        {isFinalRound ? "End game" : "Next round"}
      </button>
    </section>
  );
}
