import { useId } from "react";
import {
  formatNumber,
  type Player,
  type PlayerId,
  type RoundForfeit,
} from "../lib/game";
import styles from "./SettlementPanel.module.css";

export type RoundForfeitPanelProps = {
  disabled?: boolean;
  disabledReason?: string;
  forfeit: RoundForfeit;
  isFinalRound?: boolean;
  onContinue: () => void;
  players: Record<PlayerId, Player>;
};

/**
 * F-05: shown when a round ended because a player's shot clock ran out
 * instead of through a trade. Mirrors SettlementPanel's result-card shape
 * (reusing its module CSS) so a forfeited round reads as the same kind of
 * round-ending moment as a settled one, not a separate error state.
 */
export function RoundForfeitPanel({
  disabled = false,
  disabledReason,
  forfeit,
  isFinalRound = false,
  onContinue,
  players,
}: RoundForfeitPanelProps) {
  const disabledReasonBaseId = useId();
  const forfeitedByPlayer = players[forfeit.forfeitedBy];
  const awardedToPlayer = players[forfeit.awardedTo];
  const disabledReasonId =
    disabledReason === undefined
      ? undefined
      : `${disabledReasonBaseId}-disabled-reason`;

  return (
    <section className="settlement-panel" data-testid="round-forfeit-panel">
      <header className="settlement-panel__header">
        <p className="settlement-panel__round">Round {forfeit.roundNumber}</p>
        <h2 className="settlement-panel__title">Round forfeited</h2>
      </header>

      <div
        className={styles.result}
        data-outcome="loss"
        data-testid="round-forfeit-result"
        role="status"
      >
        <span className={styles.resultIcon} aria-hidden="true">
          ▼
        </span>
        <div className={styles.resultBody}>
          <p className={styles.resultLabel}>{forfeitedByPlayer.name} ran out of time</p>
          <p className={styles.resultValue}>
            <span className={styles.resultWord}>Forfeit</span>
            <span className={styles.resultAmount}>-{formatNumber(forfeit.penalty)}</span>
          </p>
        </div>
      </div>

      <dl className="settlement-panel__details">
        <div className="settlement-panel__detail">
          <dt>Item</dt>
          <dd>{forfeit.itemTitle}</dd>
        </div>
        <div className="settlement-panel__detail">
          <dt>Timed out during</dt>
          <dd>{forfeit.phase}</dd>
        </div>
        <div className="settlement-panel__detail">
          <dt>Penalty</dt>
          <dd>
            {formatNumber(forfeit.penalty)} awarded to {awardedToPlayer.name}
          </dd>
        </div>
      </dl>

      <button
        aria-describedby={disabledReasonId}
        className="settlement-panel__continue"
        disabled={disabled}
        onClick={onContinue}
        type="button"
      >
        {isFinalRound ? "End game" : "Next round"}
      </button>
      {disabledReason ? (
        <p
          className="settlement-panel__disabled-reason"
          id={disabledReasonId}
          role="status"
        >
          {disabledReason}
        </p>
      ) : null}
    </section>
  );
}
