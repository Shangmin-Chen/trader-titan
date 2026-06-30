"use client";

import React, { useId } from "react";

export type StepperInputProps = {
  /** Visible label text; associated with the native input via htmlFor/id. */
  label: string;
  /** Controlled string value — identical contract to a raw number input. */
  value: string;
  /** Emits string values identical to a raw input's onChange. */
  onChange: (value: string) => void;
  /** Optional id for the native input. Auto-generated when omitted. */
  id?: string;
  /** Form field name forwarded to the native input. */
  name?: string;
  /** Minimum value; clamps the +/- buttons. */
  min?: number;
  /** Maximum value; clamps the +/- buttons. */
  max?: number;
  /** Increment/decrement amount for the +/- buttons. Defaults to 1. */
  step?: number;
  /** inputMode forwarded to the native input. Defaults to "decimal". */
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  /** Optional preset values rendered as quick-select chips. */
  quickValues?: number[];
  ariaDescribedby?: string;
  ariaInvalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
};

/**
 * A labelled number input augmented with +/- buttons and optional quick-value
 * chips. The native <input> stays present and labelled, and every change
 * (typing, stepping, or chip selection) emits the SAME string onChange values
 * a raw input would — so downstream `getByLabel` lookups and numeric parsing
 * are unchanged. It is a drop-in for a controlled labelled number input.
 */
export function StepperInput({
  label,
  value,
  onChange,
  id,
  name,
  min,
  max,
  step = 1,
  inputMode = "decimal",
  quickValues,
  ariaDescribedby,
  ariaInvalid,
  disabled = false,
  placeholder,
}: StepperInputProps) {
  const generatedId = useId();
  const inputId = id ?? `${generatedId}-stepper`;

  function clamp(next: number): number {
    let result = next;
    if (typeof min === "number") {
      result = Math.max(min, result);
    }
    if (typeof max === "number") {
      result = Math.min(max, result);
    }
    return result;
  }

  function adjust(direction: 1 | -1) {
    if (disabled) {
      return;
    }
    const parsed = Number.parseFloat(value);
    const base = Number.isFinite(parsed)
      ? parsed
      : typeof min === "number"
        ? min
        : 0;
    const next = clamp(base + direction * step);
    // Emit a plain numeric string, matching what a native input would hold.
    onChange(String(next));
  }

  return (
    <div className="form-field">
      <label className="form-field__label" htmlFor={inputId}>
        {label}
      </label>

      <div className="stepper-input">
        <button
          type="button"
          className="stepper-input__button"
          onClick={() => adjust(-1)}
          disabled={disabled}
          aria-label={`Decrease ${label}`}
          tabIndex={-1}
        >
          −
        </button>

        <input
          id={inputId}
          name={name}
          className="stepper-input__field"
          type="number"
          inputMode={inputMode}
          value={value}
          min={min}
          max={max}
          step={step}
          placeholder={placeholder}
          disabled={disabled}
          aria-describedby={ariaDescribedby}
          aria-invalid={ariaInvalid}
          onChange={(event) => onChange(event.target.value)}
        />

        <button
          type="button"
          className="stepper-input__button"
          onClick={() => adjust(1)}
          disabled={disabled}
          aria-label={`Increase ${label}`}
          tabIndex={-1}
        >
          +
        </button>
      </div>

      {quickValues && quickValues.length > 0 ? (
        <div className="quick-chip-group" role="group" aria-label={`${label} presets`}>
          {quickValues.map((quick) => {
            const quickString = String(quick);
            const isActive = value === quickString;
            return (
              <button
                key={quickString}
                type="button"
                className="quick-chip"
                aria-pressed={isActive}
                disabled={disabled}
                onClick={() => onChange(quickString)}
              >
                {quickString}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
