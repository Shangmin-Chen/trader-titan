import { render, screen, fireEvent } from "@testing-library/react";
import React, { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { StepperInput } from "./StepperInput";

// Controlled wrapper so the component can receive updated props after onChange.
function Controlled({
  initialValue = "5",
  onChange,
  ...rest
}: Partial<React.ComponentProps<typeof StepperInput>> & {
  initialValue?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const handleChange = (v: string) => {
    setValue(v);
    onChange?.(v);
  };
  return (
    <StepperInput
      label="Amount"
      value={value}
      onChange={handleChange}
      {...rest}
    />
  );
}

describe("StepperInput", () => {
  it("(a) label is associated to native input via htmlFor/id", () => {
    render(<Controlled />);
    // getByLabelText uses htmlFor -> id association
    const input = screen.getByLabelText("Amount");
    expect(input.tagName.toLowerCase()).toBe("input");
    expect(input).toHaveAttribute("id");
    const label = screen.getByText("Amount");
    expect(label).toHaveAttribute("for", input.id);
  });

  it("(b) typing emits onChange with the raw string", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const input = screen.getByLabelText("Amount");
    fireEvent.change(input, { target: { value: "42" } });
    expect(onChange).toHaveBeenCalledWith("42");
  });

  it("(c) + button increments and - button decrements", () => {
    const onChange = vi.fn();
    render(<Controlled initialValue="5" onChange={onChange} />);
    const incBtn = screen.getByRole("button", { name: "Increase Amount" });
    const decBtn = screen.getByRole("button", { name: "Decrease Amount" });

    fireEvent.click(incBtn);
    expect(onChange).toHaveBeenLastCalledWith("6");

    fireEvent.click(decBtn);
    // After increment the value is "6"; decrement should emit "5"
    expect(onChange).toHaveBeenLastCalledWith("5");
  });

  it("(d) quick chip emits the chip value", () => {
    const onChange = vi.fn();
    render(
      <Controlled
        initialValue="5"
        quickValues={[10, 25, 50]}
        onChange={onChange}
      />
    );
    const chip = screen.getByRole("button", { name: "25" });
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith("25");
  });

  it("(e) ariaInvalid threads through to the native input", () => {
    render(<Controlled ariaInvalid={true} />);
    const input = screen.getByLabelText("Amount");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("(f) disabled prop disables the input and all buttons", () => {
    render(
      <Controlled
        disabled={true}
        quickValues={[10, 25]}
      />
    );
    const input = screen.getByLabelText("Amount");
    expect(input).toBeDisabled();

    const buttons = screen.getAllByRole("button");
    for (const btn of buttons) {
      expect(btn).toBeDisabled();
    }
  });

  // T7 ──────────────────────────────────────────────────────────────────────
  it("T7: + click at max value emits clamped value (same as max)", () => {
    const onChange = vi.fn();
    render(<Controlled initialValue="10" max={10} onChange={onChange} />);
    const incBtn = screen.getByRole("button", { name: "Increase Amount" });
    fireEvent.click(incBtn);
    expect(onChange).toHaveBeenCalledWith("10");
  });

  // T8 ──────────────────────────────────────────────────────────────────────
  it("T8: + click with empty value falls back to min, then adds step", () => {
    const onChange = vi.fn();
    render(<Controlled initialValue="" min={50} step={1} onChange={onChange} />);
    const incBtn = screen.getByRole("button", { name: "Increase Amount" });
    fireEvent.click(incBtn);
    expect(onChange).toHaveBeenCalledWith("51");
  });

  // T9 ──────────────────────────────────────────────────────────────────────
  it("T9: quick chip aria-pressed reflects active value", () => {
    render(
      <Controlled initialValue="100" quickValues={[50, 100, 200]} />,
    );
    const chip100 = screen.getByRole("button", { name: "100" });
    const chip50 = screen.getByRole("button", { name: "50" });
    expect(chip100).toHaveAttribute("aria-pressed", "true");
    expect(chip50).toHaveAttribute("aria-pressed", "false");
  });

  // T34 ─────────────────────────────────────────────────────────────────────
  it("T34: - button at min value clamps to min, does not go below", () => {
    const onChange = vi.fn();
    render(<Controlled initialValue="1" min={1} onChange={onChange} />);
    const decBtn = screen.getByRole("button", { name: "Decrease Amount" });
    fireEvent.click(decBtn);
    // clamp(1 + (-1) * 1) = clamp(0) = Math.max(1, 0) = 1
    expect(onChange).toHaveBeenCalledWith("1");
  });
});
