import type { RoundLogEntry } from "../lib/game";

export type ActionLogProps = {
  entries: RoundLogEntry[];
  emptyMessage?: string;
};

export function ActionLog({
  entries,
  emptyMessage = "No actions yet.",
}: ActionLogProps) {
  return (
    <section className="action-log" data-testid="action-log">
      <h2 className="action-log__title">Action log</h2>

      {entries.length > 0 ? (
        <ol className="action-log__list">
          {entries.map((entry) => (
            <li className="action-log__item" key={entry.id}>
              <span className="action-log__meta">
                Round {entry.roundNumber} · {entry.phase}
              </span>
              <p className="action-log__message">{entry.message}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="action-log__empty">{emptyMessage}</p>
      )}
    </section>
  );
}
