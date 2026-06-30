"use client";

import { useId, useState } from "react";

import type { RoundLogEntry } from "../lib/game";

import styles from "./ActionLog.module.css";

export type ActionLogProps = {
  entries: RoundLogEntry[];
  emptyMessage?: string;
};

function describeEntry(entry: RoundLogEntry): string {
  return `Round ${entry.roundNumber}, ${entry.phase}: ${entry.message}`;
}

export function ActionLog({
  entries,
  emptyMessage = "No actions yet.",
}: ActionLogProps) {
  // On mobile the panel renders as a collapsible disclosure; it stays
  // expanded by default and is forced open on desktop via module CSS.
  const [expanded, setExpanded] = useState(true);
  const bodyId = useId();

  const hasEntries = entries.length > 0;
  // Log entries are appended oldest -> newest, so the newest is the last one.
  // Announce ONLY the newest entry to avoid flooding screen readers.
  const latest = hasEntries ? entries[entries.length - 1] : null;

  return (
    <section className="action-log" data-testid="action-log">
      <h2 className={`action-log__title ${styles.title}`} aria-hidden="true">Action log</h2>

      <button
        type="button"
        className={`collapsible-region__toggle ${styles.toggle}`}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((open) => !open)}
      >
        <span>Action log{hasEntries ? ` (${entries.length})` : ""}</span>
        <span aria-hidden="true" className={styles.chevron}>
          {expanded ? "▾" : "▸"}
        </span>
      </button>

      <div
        id={bodyId}
        className={`collapsible-region__body ${styles.body}`}
      >
        {hasEntries ? (
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
      </div>

      {/* Polite live region: announces only the newest entry, kept separate
          from the visible list so the whole list is never re-read.
          Positioned after the body so it does not break the adjacent-sibling
          selector `.collapsible-region__toggle[aria-expanded="false"] + .collapsible-region__body`. */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {latest ? describeEntry(latest) : ""}
      </div>
    </section>
  );
}
