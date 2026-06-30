"use client";

import React from "react";

export type PhaseStep = {
  /** Stable identifier (e.g. "width", "negotiate", "market", "trade", "settle"). */
  id: string;
  /** Human-readable label shown in the stepper. */
  label: string;
};

export type PhaseStepperProps = {
  /** Ordered list of steps in the round flow. */
  steps: PhaseStep[];
  /** Id of the step that is currently active. */
  currentStepId: string;
  /** Optional accessible label for the surrounding nav. Defaults to "Round progress". */
  ariaLabel?: string;
};

type StepState = "complete" | "active" | "upcoming";

/**
 * Presentational horizontal progress indicator for the round flow
 * (width → negotiate → market → trade → settle). Purely visual: the active
 * step is marked with aria-current="step" and steps carry a data-state hook
 * for styling. Order in {@link steps} defines completion.
 */
export function PhaseStepper({
  steps,
  currentStepId,
  ariaLabel = "Round progress",
}: PhaseStepperProps) {
  const currentIndex = steps.findIndex((step) => step.id === currentStepId);

  return (
    <nav aria-label={ariaLabel} data-testid="phase-stepper">
      <ol className="phase-stepper">
        {steps.map((step, index) => {
          const state: StepState =
            currentIndex === -1
              ? "upcoming"
              : index < currentIndex
                ? "complete"
                : index === currentIndex
                  ? "active"
                  : "upcoming";
          const isActive = state === "active";

          return (
            <li
              key={step.id}
              className="phase-stepper__step"
              data-state={state}
              data-step-id={step.id}
              aria-current={isActive ? "step" : undefined}
            >
              <span>{step.label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
