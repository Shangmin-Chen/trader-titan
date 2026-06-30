"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

export type CopyButtonProps = {
  /** The text to copy / share (e.g. an invite link). */
  value: string;
  /** Visible label before copying. Defaults to "Copy link". */
  label?: string;
  /** Visible label shown briefly after a successful copy. Defaults to "Copied". */
  copiedLabel?: string;
  /**
   * Optional title used when sharing via the Web Share API (mobile).
   * Falls back to copy-to-clipboard when sharing is unavailable.
   */
  shareTitle?: string;
  /** How long (ms) the "Copied" confirmation stays visible. Defaults to 2000. */
  resetDelayMs?: number;
  /** Optional accessible name override. Defaults to the current label text. */
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
};

type CopyStatus = "idle" | "copied";

/**
 * Best-effort fallback for environments without the async Clipboard API
 * (older browsers, some CI/jsdom contexts). Returns true on success.
 */
function legacyCopy(value: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = typeof document.execCommand === "function" && document.execCommand("copy");
    document.body.removeChild(textarea);
    return Boolean(ok);
  } catch {
    return false;
  }
}

/**
 * Copies (or shares) a value with a transient "Copied" confirmation.
 *
 * Uses navigator.share when available (mobile) and falls back through
 * navigator.clipboard to a legacy text-selection copy. Both browser APIs are
 * feature-detected and guarded so the control is safe to render in CI/jsdom.
 * Keyboard operable and exposes an accessible name at all times.
 */
export function CopyButton({
  value,
  label = "Copy link",
  copiedLabel = "Copied",
  shareTitle,
  resetDelayMs = 2000,
  ariaLabel,
  disabled = false,
  className,
}: CopyButtonProps) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const flagCopied = useCallback(() => {
    setStatus("copied");
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      setStatus("idle");
      timeoutRef.current = null;
    }, resetDelayMs);
  }, [resetDelayMs]);

  const handleActivate = useCallback(async () => {
    if (disabled || !value) {
      return;
    }

    const nav = typeof navigator !== "undefined" ? navigator : undefined;

    // Prefer the native share sheet on capable (mobile) devices.
    if (nav && typeof nav.share === "function") {
      try {
        await nav.share({ title: shareTitle, text: shareTitle, url: value });
        return;
      } catch {
        // User cancelled or share failed — fall through to clipboard copy.
      }
    }

    if (nav?.clipboard && typeof nav.clipboard.writeText === "function") {
      try {
        await nav.clipboard.writeText(value);
        flagCopied();
        return;
      } catch {
        // Permission denied / insecure context — fall through to legacy path.
      }
    }

    if (legacyCopy(value)) {
      flagCopied();
    }
  }, [disabled, value, shareTitle, flagCopied]);

  const isCopied = status === "copied";
  const visibleLabel = isCopied ? copiedLabel : label;
  const accessibleName = ariaLabel ?? visibleLabel;

  return (
    <button
      type="button"
      className={["copy-button", className].filter(Boolean).join(" ")}
      data-copied={isCopied ? "true" : "false"}
      aria-label={accessibleName}
      disabled={disabled}
      onClick={() => {
        void handleActivate();
      }}
    >
      <span aria-hidden="true">{isCopied ? "✓" : "🔗"}</span>
      <span>{visibleLabel}</span>
    </button>
  );
}
