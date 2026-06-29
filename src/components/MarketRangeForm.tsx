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

        <div className="market-maker-form__grid">
          <div className="form-field">
            <label className="form-field__label" htmlFor={`${formId}-bid`}>
              Bid
            </label>
            <input
              aria-describedby={validation.ok ? undefined : errorId}
              aria-invalid={!validation.ok}
              className="form-field__control"
              id={`${formId}-bid`}
              inputMode="decimal"
              name="bid"
              onChange={(event) => setFromBid(event.target.value)}
              type="number"
              value={bidInput}
            />
          </div>

          <div className="form-field">
            <label className="form-field__label" htmlFor={`${formId}-ask`}>
              Ask
            </label>
            <input
              aria-describedby={validation.ok ? undefined : errorId}
              aria-invalid={!validation.ok}
              className="form-field__control"
              id={`${formId}-ask`}
              inputMode="decimal"
              name="ask"
              onChange={(event) => setFromAsk(event.target.value)}
              type="number"
              value={askInput}
            />
          </div>
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
