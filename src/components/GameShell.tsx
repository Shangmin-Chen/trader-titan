import type { ReactNode } from "react";

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
    <main className="game-shell">
      <header className="game-shell__header">
        <h1 className="game-shell__title">{title}</h1>
        {status ? <div className="game-shell__status">{status}</div> : null}
      </header>

      <div className={layoutClassName}>
        {scoreboard ? <div className="game-shell__sidebar">{scoreboard}</div> : null}
        <div className="game-shell__main">{children}</div>
        {actionLog ? <div className="game-shell__sidebar">{actionLog}</div> : null}
      </div>
    </main>
  );
}
