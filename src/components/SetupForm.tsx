"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import {
  GAME_MODES,
  MAX_ROUNDS,
  parseNumericInput,
  validateStartGame,
  type GameMode,
  type StartGamePayload,
} from "../lib/game";
import { CustomSelect } from "./CustomSelect";

const ROUND_PRESETS = [1, 2, 3, 5, 7, 10] as const;

type SetupFieldErrors = Partial<
  Record<"playerAName" | "playerBName" | "mode" | "totalRounds", string>
>;

export type SetupFormProps = {
  defaultValues?: Partial<StartGamePayload>;
  disabled?: boolean;
  error?: string;
  onStart: (payload: StartGamePayload) => void;
};

export function SetupForm({
  defaultValues,
  disabled = false,
  error,
  onStart,
}: SetupFormProps) {
  const formId = useId();
  const [playerAName, setPlayerAName] = useState(defaultValues?.playerAName ?? "");
  const [playerBName, setPlayerBName] = useState(defaultValues?.playerBName ?? "");
  const [mode, setMode] = useState<GameMode>(
    defaultValues?.mode && GAME_MODES.includes(defaultValues.mode)
      ? defaultValues.mode
      : GAME_MODES[0],
  );
  const [totalRoundsInput, setTotalRoundsInput] = useState(
    String(defaultValues?.totalRounds ?? ROUND_PRESETS[2]),
  );
  const [customAmazonQuery, setCustomAmazonQuery] = useState(defaultValues?.customAmazonQuery ?? false);
  const [fieldErrors, setFieldErrors] = useState<SetupFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const totalRounds = useMemo(
    () => parseNumericInput(totalRoundsInput),
    [totalRoundsInput],
  );

  function buildPayload(): StartGamePayload | null {
    if (totalRounds === null) {
      return null;
    }

    return {
      playerAName,
      playerBName,
      mode,
      totalRounds,
      customAmazonQuery: mode === "Amazon" && customAmazonQuery,
    };
  }

  function validateFields(payload: StartGamePayload | null): SetupFieldErrors {
    const nextErrors: SetupFieldErrors = {};

    if (playerAName.trim().length === 0) {
      nextErrors.playerAName = "Player A name is required.";
    }

    if (playerBName.trim().length === 0) {
      nextErrors.playerBName = "Player B name is required.";
    }

    if (!GAME_MODES.includes(mode)) {
      nextErrors.mode = "Choose a valid game mode.";
    }

    if (
      payload === null ||
      !Number.isInteger(payload.totalRounds) ||
      payload.totalRounds < 1 ||
      payload.totalRounds > MAX_ROUNDS
    ) {
      nextErrors.totalRounds = `Rounds must be a whole number from 1 to ${MAX_ROUNDS}.`;
    }

    return nextErrors;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const payload = buildPayload();
    const nextFieldErrors = validateFields(payload);
    setFieldErrors(nextFieldErrors);

    if (Object.keys(nextFieldErrors).length > 0 || payload === null) {
      setFormError("Fix the highlighted fields to start.");
      return;
    }

    const validation = validateStartGame(payload);

    if (!validation.ok) {
      setFormError(validation.error);
      return;
    }

    setFormError(null);
    onStart(payload);
  }

  return (
    <form
      className="setup-form"
      data-testid="setup-form"
      noValidate
      onSubmit={handleSubmit}
    >
      <fieldset className="setup-form__fieldset" disabled={disabled}>
        <legend className="setup-form__legend">Game setup</legend>

        <div className="setup-form__grid">
          <div className="form-field">
            <label className="form-field__label" htmlFor={`${formId}-player-a`}>
              Player A
            </label>
            <input
              aria-describedby={
                fieldErrors.playerAName ? `${formId}-player-a-error` : undefined
              }
              aria-invalid={Boolean(fieldErrors.playerAName)}
              className="form-field__control"
              id={`${formId}-player-a`}
              name="playerAName"
              onChange={(event) => setPlayerAName(event.target.value)}
              type="text"
              value={playerAName}
            />
            {fieldErrors.playerAName ? (
              <p className="form-field__error" id={`${formId}-player-a-error`}>
                {fieldErrors.playerAName}
              </p>
            ) : null}
          </div>

          <div className="form-field">
            <label className="form-field__label" htmlFor={`${formId}-player-b`}>
              Player B
            </label>
            <input
              aria-describedby={
                fieldErrors.playerBName ? `${formId}-player-b-error` : undefined
              }
              aria-invalid={Boolean(fieldErrors.playerBName)}
              className="form-field__control"
              id={`${formId}-player-b`}
              name="playerBName"
              onChange={(event) => setPlayerBName(event.target.value)}
              type="text"
              value={playerBName}
            />
            {fieldErrors.playerBName ? (
              <p className="form-field__error" id={`${formId}-player-b-error`}>
                {fieldErrors.playerBName}
              </p>
            ) : null}
          </div>

          <CustomSelect
            label="Game mode"
            value={mode}
            onChange={(val) => setMode(val as GameMode)}
            options={GAME_MODES.map((gameMode) => ({
              value: gameMode,
              label: gameMode,
            }))}
            id={`${formId}-mode`}
            name="mode"
            ariaDescribedby={fieldErrors.mode ? `${formId}-mode-error` : undefined}
            ariaInvalid={Boolean(fieldErrors.mode)}
          />
          {fieldErrors.mode ? (
            <p className="form-field__error" id={`${formId}-mode-error`}>
              {fieldErrors.mode}
            </p>
          ) : null}

          {mode === "Amazon" ? (
            <div className="form-field form-field--checkbox" style={{ gridColumn: "span 2", flexDirection: "row", alignItems: "center", gap: "10px" }}>
              <input
                id={`${formId}-custom-amazon`}
                type="checkbox"
                checked={customAmazonQuery}
                onChange={(e) => setCustomAmazonQuery(e.target.checked)}
                className="form-field__checkbox"
                style={{ width: "20px", height: "20px", cursor: "pointer" }}
              />
              <label className="form-field__label" htmlFor={`${formId}-custom-amazon`} style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", height: "100%" }}>
                Player-entered Amazon product query (instead of Gemini)
              </label>
            </div>
          ) : null}

          <CustomSelect
            label="Round preset"
            value={
              ROUND_PRESETS.includes(Number(totalRoundsInput) as (typeof ROUND_PRESETS)[number])
                ? totalRoundsInput
                : ""
            }
            onChange={(val) => setTotalRoundsInput(val)}
            options={[
              { value: "", label: "Custom" },
              ...ROUND_PRESETS.map((roundCount) => ({
                value: String(roundCount),
                label: String(roundCount),
              })),
            ]}
            id={`${formId}-round-preset`}
            name="roundPreset"
          />


          <div className="form-field">
            <label className="form-field__label" htmlFor={`${formId}-rounds`}>
              Total rounds
            </label>
            <input
              aria-describedby={
                fieldErrors.totalRounds ? `${formId}-rounds-error` : undefined
              }
              aria-invalid={Boolean(fieldErrors.totalRounds)}
              className="form-field__control"
              id={`${formId}-rounds`}
              inputMode="numeric"
              min={1}
              max={MAX_ROUNDS}
              name="totalRounds"
              onChange={(event) => setTotalRoundsInput(event.target.value)}
              step={1}
              type="number"
              value={totalRoundsInput}
            />
            {fieldErrors.totalRounds ? (
              <p className="form-field__error" id={`${formId}-rounds-error`}>
                {fieldErrors.totalRounds}
              </p>
            ) : null}
          </div>
        </div>

        {formError || error ? (
          <p className="setup-form__error" role="alert">
            {formError ?? error}
          </p>
        ) : null}

        <button className="setup-form__submit" type="submit">
          Start game
        </button>
      </fieldset>
    </form>
  );
}
