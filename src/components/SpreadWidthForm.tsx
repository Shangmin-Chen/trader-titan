"use client";

import { useId, useState, type FormEvent } from "react";
import {
  parseNumericInput,
  validateSpreadWidth,
  validateTightenedWidth,
  type ValidationResult,
} from "../lib/game";
import { StepperInput } from "./StepperInput";

export type SpreadWidthFormProps = {
  currentWidth?: number;
  disabled?: boolean;
  label?: string;
  onSubmit: (width: number) => void;
  submitLabel: string;
};

export function SpreadWidthForm({
  currentWidth,
  disabled = false,
  label = "Spread width",
  onSubmit,
  submitLabel,
}: SpreadWidthFormProps) {
  const formId = useId();
  const [widthInput, setWidthInput] = useState("");
  const [validation, setValidation] = useState<ValidationResult>({ ok: true });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const width = parseNumericInput(widthInput) ?? Number.NaN;
    const nextValidation =
      currentWidth === undefined
        ? validateSpreadWidth(width)
        : validateTightenedWidth(currentWidth, width);
    setValidation(nextValidation);

    if (nextValidation.ok) {
      onSubmit(width);
      setWidthInput("");
    }
  }

  const errorId = `${formId}-width-error`;

  return (
    <form
      className="spread-width-form"
      data-testid="spread-width-form"
      noValidate
      onSubmit={handleSubmit}
    >
      <fieldset className="spread-width-form__fieldset" disabled={disabled}>
        <StepperInput
          label={label}
          value={widthInput}
          onChange={setWidthInput}
          id={`${formId}-width`}
          name="spreadWidth"
          min={1}
          step={1}
          inputMode="decimal"
          quickValues={[50, 100, 200, 500]}
          ariaDescribedby={validation.ok ? undefined : errorId}
          ariaInvalid={!validation.ok}
          disabled={disabled}
        />

        {!validation.ok ? (
          <p className="spread-width-form__error" id={errorId} role="alert">
            {validation.error}
          </p>
        ) : null}

        <button className="spread-width-form__submit" type="submit">
          {submitLabel}
        </button>
      </fieldset>
    </form>
  );
}
