import {
  formatNumber,
  formatSignedNumber,
  formatTradeSide,
  type Player,
  type PlayerId,
  type RoundSettlement,
} from "../lib/game";
import styles from "./SettlementPanel.module.css";

export type SettlementPanelProps = {
  disabled?: boolean;
  isFinalRound?: boolean;
  onContinue: () => void;
  players: Record<PlayerId, Player>;
  settlement: RoundSettlement;
};

type Outcome = "win" | "loss" | "even";

function outcomeOf(value: number): Outcome {
  if (value > 0) {
    return "win";
  }
  if (value < 0) {
    return "loss";
  }
  return "even";
}

const OUTCOME_ICON: Record<Outcome, string> = {
  win: "▲",
  loss: "▼",
  even: "—",
};

const OUTCOME_WORD: Record<Outcome, string> = {
  win: "Profit",
  loss: "Loss",
  even: "Break even",
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

  const traderOutcome = outcomeOf(settlement.traderPnL);
  const marketMakerOutcome = outcomeOf(settlement.marketMakerPnL);

  return (
    <section className="settlement-panel" data-testid="settlement-panel">
      <header className="settlement-panel__header">
        <p className="settlement-panel__round">Round {settlement.roundNumber}</p>
        <h2 className="settlement-panel__title">Settlement</h2>
      </header>

      <div
        className={styles.result}
        data-outcome={traderOutcome}
        data-testid="settlement-result"
        role="status"
      >
        <span className={styles.resultIcon} aria-hidden="true">
          {OUTCOME_ICON[traderOutcome]}
        </span>
        <div className={styles.resultBody}>
          <p className={styles.resultLabel}>{trader.name} trader result</p>
          <p className={styles.resultValue}>
            <span className={styles.resultWord}>
              {OUTCOME_WORD[traderOutcome]}
            </span>
            <span className={styles.resultAmount}>
              {formatSignedNumber(settlement.traderPnL)}
            </span>
          </p>
        </div>
      </div>

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
          <dd>
            <span className={styles.pnlArrow} aria-hidden="true">
              {OUTCOME_ICON[traderOutcome]}
            </span>
            {formatSignedNumber(settlement.traderPnL)}
          </dd>
        </div>
        <div className="settlement-panel__detail">
          <dt>{marketMaker.name} market maker PnL</dt>
          <dd>
            <span className={styles.pnlArrow} aria-hidden="true">
              {OUTCOME_ICON[marketMakerOutcome]}
            </span>
            {formatSignedNumber(settlement.marketMakerPnL)}
          </dd>
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
