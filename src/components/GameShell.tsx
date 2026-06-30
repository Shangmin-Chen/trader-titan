import type { ReactNode } from "react";

import styles from "./GameShell.module.css";

export type GameShellProps = {
  actionLog?: ReactNode;
  children: ReactNode;
  scoreboard?: ReactNode;
  status?: ReactNode;
  title?: string;
};

export function GameShell({
  actionLog,
  children,
  scoreboard,
  status,
  title = "Titan Trader",
}: GameShellProps) {
  const layoutClassName = [
    "game-shell__layout",
    scoreboard && "game-shell__layout--has-scoreboard",
    actionLog && "game-shell__layout--has-action-log",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <main
      id="main-content"
      className="game-shell"
      aria-label={`${title} game`}
    >
      <header className={`game-shell__header ${styles.stickyHeader}`}>
        <h1 className="game-shell__title">{title}</h1>
        {status ? (
          <div
            className="game-shell__status"
          >
            {status}
          </div>
        ) : null}
      </header>

      <div className={layoutClassName}>
        {scoreboard ? (
          <aside
            className="game-shell__sidebar"
            aria-label="Scoreboard"
          >
            {scoreboard}
          </aside>
        ) : null}
        <div className="game-shell__main">{children}</div>
        {actionLog ? (
          <aside
            className="game-shell__sidebar"
            aria-label="Action log"
          >
            {actionLog}
          </aside>
        ) : null}
      </div>
    </main>
  );
}
