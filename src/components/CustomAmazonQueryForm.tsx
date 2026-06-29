"use client";

import { useId, useState, type FormEvent } from "react";

export type CustomAmazonQueryFormProps = {
  generatorName: string;
  disabled?: boolean;
  onSubmit: (query: string) => void;
};

export function CustomAmazonQueryForm({
  generatorName,
  disabled = false,
  onSubmit,
}: CustomAmazonQueryFormProps) {
  const formId = useId();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setError("Amazon search query is required.");
      return;
    }

    setError(null);
    onSubmit(trimmed);
  }

  return (
    <form
      className="setup-form"
      data-testid="custom-amazon-query-form"
      noValidate
      onSubmit={handleSubmit}
    >
      <fieldset className="setup-form__fieldset" disabled={disabled}>
        <legend className="setup-form__legend">
          {generatorName}, enter Amazon product query
        </legend>
        <p className="eyebrow" style={{ color: "var(--accent-magenta)", marginBottom: "16px" }}>
          ⚠️ Other player should look away!
        </p>

        <div className="setup-form__grid" style={{ gridTemplateColumns: "1fr" }}>
          <div className="form-field">
            <label className="form-field__label" htmlFor={`${formId}-query`}>
              Search Term / Product Name
            </label>
            <input
              aria-describedby={error ? `${formId}-query-error` : undefined}
              aria-invalid={Boolean(error)}
              className="form-field__control"
              id={`${formId}-query`}
              name="query"
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g., Apple iPad Air, Yodelling Pickled Cucumber, Herman Miller Aeron"
              type="text"
              value={query}
            />
            {error ? (
              <p className="form-field__error" id={`${formId}-query-error`}>
                {error}
              </p>
            ) : null}
          </div>
        </div>

        <button className="setup-form__submit" type="submit" style={{ marginTop: "24px" }}>
          Submit & Scrape Price
        </button>
      </fieldset>
    </form>
  );
}
