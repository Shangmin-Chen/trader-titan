"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

export type Politeness = "polite" | "assertive";

export type LiveAnnouncerContextValue = {
  /**
   * Announce a message to assistive technology via a visually-hidden
   * aria-live region. Defaults to "polite". Use "assertive" for errors
   * or other time-sensitive interruptions.
   */
  announce: (message: string, politeness?: Politeness) => void;
};

const LiveAnnouncerContext = createContext<LiveAnnouncerContextValue | null>(null);

export type LiveAnnouncerProviderProps = {
  children: React.ReactNode;
};

/**
 * Provides a single pair of visually-hidden aria-live regions (one polite,
 * one assertive) for the whole app. Consume via {@link useAnnouncer}.
 *
 * Turn changes, errors, and settlement results route through this so screen
 * reader users hear status updates without a visible UI change.
 */
export function LiveAnnouncerProvider({ children }: LiveAnnouncerProviderProps) {
  const [politeMessage, setPoliteMessage] = useState("");
  const [assertiveMessage, setAssertiveMessage] = useState("");

  // Toggle a zero-width space so repeated identical messages still trigger a
  // DOM mutation (and therefore a re-announcement) for assistive tech.
  const toggleRef = useRef(false);

  const announce = useCallback(
    (message: string, politeness: Politeness = "polite") => {
      if (!message) {
        return;
      }
      toggleRef.current = !toggleRef.current;
      const decorated = toggleRef.current ? message : `${message}​`;
      if (politeness === "assertive") {
        setAssertiveMessage(decorated);
      } else {
        setPoliteMessage(decorated);
      }
    },
    [],
  );

  const value = useMemo<LiveAnnouncerContextValue>(() => ({ announce }), [announce]);

  return (
    <LiveAnnouncerContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="announcer"
        data-testid="announcer-polite"
      >
        {politeMessage}
      </div>
      <div
        aria-live="assertive"
        aria-atomic="true"
        role="alert"
        className="announcer"
        data-testid="announcer-assertive"
      >
        {assertiveMessage}
      </div>
    </LiveAnnouncerContext.Provider>
  );
}

/**
 * Access the {@link announce} function from the nearest
 * {@link LiveAnnouncerProvider}. Throws if no provider is mounted so misuse
 * is caught early rather than silently dropping announcements.
 */
export function useAnnouncer(): LiveAnnouncerContextValue {
  const context = useContext(LiveAnnouncerContext);
  if (!context) {
    throw new Error("useAnnouncer must be used within a LiveAnnouncerProvider");
  }
  return context;
}
