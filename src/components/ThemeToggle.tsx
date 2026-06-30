"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "titan-trader-theme";
const THEME_CHANGE_EVENT = "titan-trader-theme-change";

type Theme = "light" | "dark";

function hasExplicitChoice(): boolean {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark";
  } catch {
    return false;
  }
}

function readTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light"
    : "dark";
}

// useSyncExternalStore (rather than useState+useEffect) is what lets this
// component read theme state that lives outside React — the <html
// data-theme> attribute set by the no-flash bootstrap script in
// layout.tsx — without a server/client hydration mismatch: React renders
// `getServerSnapshot` for SSR and the initial client pass, then swaps to
// the live DOM value in one consistent step.
function subscribe(onStoreChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  const handleSystemChange = (event: MediaQueryListEvent) => {
    // Only follow the OS live once the user hasn't made an explicit choice;
    // an explicit choice always wins until the user toggles again.
    if (!hasExplicitChoice()) {
      document.documentElement.setAttribute(
        "data-theme",
        event.matches ? "dark" : "light",
      );
    }
    onStoreChange();
  };

  media.addEventListener("change", handleSystemChange);
  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange);

  return () => {
    media.removeEventListener("change", handleSystemChange);
    window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange);
  };
}

function getServerSnapshot(): Theme {
  return "dark";
}

/**
 * Light/dark theme toggle. Defaults to the OS-level preference (applied
 * before first paint by the bootstrap script in layout.tsx); clicking sets
 * an explicit, persisted override that takes precedence over the OS
 * preference from then on.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, readTheme, getServerSnapshot);

  const toggleTheme = useCallback(() => {
    const next: Theme = readTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore — the DOM attribute (and this session's UI) still reflects
      // the choice even if persistence fails (e.g. private browsing).
    }
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }, []);

  const label = `Switch to ${theme === "dark" ? "light" : "dark"} mode`;

  return (
    <button
      aria-label={label}
      aria-pressed={theme === "dark"}
      className="theme-toggle"
      data-testid="theme-toggle"
      onClick={toggleTheme}
      title={label}
      type="button"
    >
      <svg
        aria-hidden="true"
        className="theme-toggle__icon theme-toggle__icon--sun"
        fill="none"
        height="18"
        viewBox="0 0 24 24"
        width="18"
      >
        <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="2" />
        <path
          d="M12 2.5v2.25M12 19.25v2.25M4.22 4.22l1.59 1.59M18.19 18.19l1.59 1.59M2.5 12h2.25M19.25 12h2.25M4.22 19.78l1.59-1.59M18.19 5.81l1.59-1.59"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="2"
        />
      </svg>
      <svg
        aria-hidden="true"
        className="theme-toggle__icon theme-toggle__icon--moon"
        fill="none"
        height="18"
        viewBox="0 0 24 24"
        width="18"
      >
        <path
          d="M20.5 14.5a8.5 8.5 0 1 1-9-11 7 7 0 0 0 9 11Z"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </svg>
    </button>
  );
}
