import {
  formatSignedNumber,
  type Player,
  type PlayerId,
  type Roles,
  type Scores,
} from "../lib/game";
import styles from "./Scoreboard.module.css";

export type ScoreboardProps = {
  players: Record<PlayerId, Player>;
  roles: Roles;
  roundNumber: number;
  scores: Scores;
  totalRounds: number;
};

/**
 * Returns the id of the player who is strictly ahead, or `null` when the
 * scores are tied. Kept as a small named helper so the render stays clean.
 */
function getLeaderId(scores: Scores): PlayerId | null {
  if (scores.A > scores.B) return "A";
  if (scores.B > scores.A) return "B";
  return null;
}

// Render order is significant: globals.css colours players via
// `.scoreboard__scores .scoreboard__player:nth-child(1|2)`, so "A" must stay
// the first child and "B" the second.
const PLAYER_ORDER = ["A", "B"] as const;

export function Scoreboard({
  players,
  roles,
  roundNumber,
  scores,
  totalRounds,
}: ScoreboardProps) {
  const leaderId = getLeaderId(scores);

  return (
    <aside className="scoreboard" data-testid="scoreboard">
      <header className="scoreboard__header">
        <h2 className="scoreboard__title">Scoreboard</h2>
        <p
          className="scoreboard__round"
          aria-label={`Round ${roundNumber} of ${totalRounds}`}
        >
          Round {roundNumber} of {totalRounds}
        </p>
      </header>

      <dl className={`scoreboard__scores ${styles.scoresTwoUp}`}>
        {PLAYER_ORDER.map((playerId) => {
          const isLeading = leaderId === playerId;
          const player = players[playerId];
          return (
            <div
              className={`scoreboard__player ${styles.playerCompact}${
                isLeading ? " scoreboard__player--leading" : ""
              }`}
              key={playerId}
            >
              <dt>
                {player.name}
                {isLeading ? (
                  <span
                    className="scoreboard__leader-badge"
                    aria-label={`${player.name} is in the lead`}
                  >
                    Leader
                  </span>
                ) : null}
              </dt>
              <dd>{formatSignedNumber(scores[playerId])}</dd>
            </div>
          );
        })}
      </dl>

      <dl className="scoreboard__roles">
        <div className="scoreboard__role">
          <dt>Market maker</dt>
          <dd>{players[roles.marketMaker].name}</dd>
        </div>
        <div className="scoreboard__role">
          <dt>Trader</dt>
          <dd>{players[roles.trader].name}</dd>
        </div>
      </dl>
    </aside>
  );
}
