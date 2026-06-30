"use client";

import { useId, useState, type FormEvent } from "react";
import {
  formatNumber,
  parseNumericInput,
  quoteFromAsk,
  quoteFromBid,
  validateQuoteForWidth,
  type Quote,
  type ValidationResult,
} from "../lib/game";
import { StepperInput } from "./StepperInput";
import styles from "./MarketRangeForm.module.css";

export type MarketRangeFormProps = {
  disabled?: boolean;
  onSubmit: (quote: Quote) => void;
  spreadWidth: number;
};

export function MarketRangeForm({
  disabled = false,
  onSubmit,
  spreadWidth,
}: MarketRangeFormProps) {
  const formId = useId();
  const [bidInput, setBidInput] = useState("");
  const [askInput, setAskInput] = useState("");
  const [validation, setValidation] = useState<ValidationResult>({ ok: true });

  function setFromBid(value: string) {
    setBidInput(value);
    const bid = parseNumericInput(value);
    setAskInput(bid === null ? "" : String(quoteFromBid(bid, spreadWidth).ask));
  }

  function setFromAsk(value: string) {
    setAskInput(value);
    const ask = parseNumericInput(value);
    setBidInput(ask === null ? "" : String(quoteFromAsk(ask, spreadWidth).bid));
  }

  function quoteFromInputs(): Quote {
    return {
      bid: parseNumericInput(bidInput) ?? Number.NaN,
      ask: parseNumericInput(askInput) ?? Number.NaN,
    };
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const quote = quoteFromInputs();
    const nextValidation = validateQuoteForWidth(quote, spreadWidth);
    setValidation(nextValidation);

    if (nextValidation.ok) {
      onSubmit(quote);
    }
  }

  const errorId = `${formId}-market-error`;

  return (
    <form
      className="market-maker-form"
      data-testid="market-range-form"
      noValidate
      onSubmit={handleSubmit}
    >
      <fieldset className="market-maker-form__fieldset" disabled={disabled}>
        <legend className="market-maker-form__legend">
          Set {formatNumber(spreadWidth)} wide market
        </legend>

        {/* Spread linkage banner — visual connector showing Bid and Ask share
            a fixed spread width, with a hint that editing one auto-fills the other */}
        <div className={styles.spreadBanner}>
          <div className={styles.spreadBannerRow}>
            <span className={styles.spreadBannerLine} aria-hidden="true" />
            <span className={styles.spreadBannerLabel}>
              Spread width: {formatNumber(spreadWidth)}
            </span>
            <span className={styles.spreadBannerLine} aria-hidden="true" />
          </div>
          <p className={styles.spreadHint}>
            Setting one side auto-fills the other
          </p>
        </div>

        <div className="market-maker-form__grid">
          <StepperInput
            label="Bid"
            id={`${formId}-bid`}
            name="bid"
            value={bidInput}
            onChange={setFromBid}
            inputMode="decimal"
            ariaDescribedby={validation.ok ? undefined : errorId}
            ariaInvalid={!validation.ok}
            disabled={disabled}
          />

          <StepperInput
            label="Ask"
            id={`${formId}-ask`}
            name="ask"
            value={askInput}
            onChange={setFromAsk}
            inputMode="decimal"
            ariaDescribedby={validation.ok ? undefined : errorId}
            ariaInvalid={!validation.ok}
            disabled={disabled}
          />
        </div>

        {!validation.ok ? (
          <p className="market-maker-form__error" id={errorId} role="alert">
            {validation.error}
          </p>
        ) : null}

        <button className="market-maker-form__submit" type="submit">
          Commit market
        </button>
      </fieldset>
    </form>
  );
}
