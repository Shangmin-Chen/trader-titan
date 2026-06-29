import {
  formatSignedNumber,
  type Player,
  type PlayerId,
  type Roles,
  type Scores,
} from "../lib/game";

export type ScoreboardProps = {
  players: Record<PlayerId, Player>;
  roles: Roles;
  roundNumber: number;
  scores: Scores;
  totalRounds: number;
};

export function Scoreboard({
  players,
  roles,
  roundNumber,
  scores,
  totalRounds,
}: ScoreboardProps) {
  return (
    <aside className="scoreboard" data-testid="scoreboard">
      <header className="scoreboard__header">
        <h2 className="scoreboard__title">Scoreboard</h2>
        <p className="scoreboard__round">
          Round {roundNumber} of {totalRounds}
        </p>
      </header>

      <dl className="scoreboard__scores">
        {(() => {
          const leaderId = scores.A > scores.B ? "A" : scores.B > scores.A ? "B" : null;
          return (["A", "B"] as const).map((playerId) => {
            const isLeading = leaderId === playerId;
            return (
              <div
                className={`scoreboard__player ${isLeading ? "scoreboard__player--leading" : ""}`}
                key={playerId}
              >
                <dt>
                  {players[playerId].name}
                  {isLeading ? <span className="scoreboard__leader-badge">Leader</span> : null}
                </dt>
                <dd>{formatSignedNumber(scores[playerId])}</dd>
              </div>
            );
          });
        })()}
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
