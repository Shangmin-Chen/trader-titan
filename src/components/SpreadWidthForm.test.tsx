import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { SpreadWidthForm } from "./SpreadWidthForm";

describe("SpreadWidthForm", () => {
  it("T21: invalid width (0) → alert visible; onSubmit not called", () => {
    const onSubmit = vi.fn();
    render(<SpreadWidthForm onSubmit={onSubmit} submitLabel="Set width" />);

    const input = screen.getByLabelText("Spread width");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Set width" }));

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("T22: valid width (200) → onSubmit called with 200; input resets to empty; no alert", () => {
    const onSubmit = vi.fn();
    render(<SpreadWidthForm onSubmit={onSubmit} submitLabel="Set width" />);

    const input = screen.getByLabelText("Spread width");
    fireEvent.change(input, { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Set width" }));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith(200);
    // Number input with empty string value reports null via toHaveValue
    expect(input).toHaveValue(null);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("T23: currentWidth=200 tightening mode — same width shows error; tighter width calls onSubmit", () => {
    const onSubmit = vi.fn();
    render(
      <SpreadWidthForm
        onSubmit={onSubmit}
        submitLabel="Tighten"
        currentWidth={200}
      />
    );

    const input = screen.getByLabelText("Spread width");

    // Same width (200 >= 200) must be rejected
    fireEvent.change(input, { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Tighten" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    // Tighter width (100 < 200) must succeed
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Tighten" }));
    expect(onSubmit).toHaveBeenCalledWith(100);
  });
});
