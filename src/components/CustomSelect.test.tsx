import { render, screen, fireEvent, within } from "@testing-library/react";
import React, { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { CustomSelect, type CustomSelectOption } from "./CustomSelect";

const OPTIONS: CustomSelectOption[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
];

// Controlled wrapper that keeps value state so the component re-renders on
// selection and the listbox closes as expected.
function Controlled({
  initialValue = "apple",
  onChange,
  options = OPTIONS,
}: {
  initialValue?: string;
  onChange?: (v: string) => void;
  options?: CustomSelectOption[];
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <CustomSelect
      label="Fruit"
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      options={options}
    />
  );
}

// The custom trigger button has aria-labelledby pointing to both the label
// span ("Fruit") and the value span (e.g. "Apple"), giving an accessible name
// like "Fruit Apple".  The hidden native <select> has no accessible name
// (its label's htmlFor is undefined when no id prop is passed).
// Querying by /Fruit/ therefore resolves to the button uniquely.
function getTrigger() {
  return screen.getByRole("combobox", { name: /Fruit/ });
}

describe("CustomSelect", () => {
  it("(a) trigger button has role=combobox", () => {
    render(<Controlled />);
    const trigger = getTrigger();
    expect(trigger.tagName.toLowerCase()).toBe("button");
    expect(trigger).toHaveAttribute("role", "combobox");
  });

  it("(b) listbox opens on click", () => {
    render(<Controlled />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.click(getTrigger());
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("(c) options have role=option when listbox is open", () => {
    render(<Controlled />);
    fireEvent.click(getTrigger());
    // Scope to the custom listbox so the hidden native <select>'s <option>
    // elements are not counted.
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).getAllByRole("option")).toHaveLength(OPTIONS.length);
  });

  it("(d) Enter selects the focused option and closes the listbox", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const trigger = getTrigger();

    // Open; focusedIndex is set to selectedIndex() == 0 (Apple).
    fireEvent.click(trigger);
    // Move focus down to Banana (index 1).
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    // Commit the selection.
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("banana");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("(d) Space opens the listbox when closed, then selects when open", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const trigger = getTrigger();

    // Space while closed -> opens listbox.
    fireEvent.keyDown(trigger, { key: " " });
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // Space while open -> selects the currently focused option (Apple, index 0).
    fireEvent.keyDown(trigger, { key: " " });
    expect(onChange).toHaveBeenCalledWith("apple");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("(e) Escape closes the listbox without firing onChange", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const trigger = getTrigger();

    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("(f) Home moves focus to first option, End moves focus to last option", () => {
    render(<Controlled />);
    const trigger = getTrigger();

    // Open; focused at index 0 (Apple) because that is the selected value.
    fireEvent.click(trigger);

    // End -> should focus last option (Cherry, index 2).
    // Scope to the custom listbox to avoid the hidden native <select>'s <option>s.
    fireEvent.keyDown(trigger, { key: "End" });
    const listbox = screen.getByRole("listbox");
    const optionsAfterEnd = within(listbox).getAllByRole("option");
    expect(optionsAfterEnd[2]).toHaveAttribute("data-focused", "true");
    expect(optionsAfterEnd[0]).toHaveAttribute("data-focused", "false");

    // Home -> should focus first option (Apple, index 0).
    fireEvent.keyDown(trigger, { key: "Home" });
    const optionsAfterHome = within(listbox).getAllByRole("option");
    expect(optionsAfterHome[0]).toHaveAttribute("data-focused", "true");
    expect(optionsAfterHome[2]).toHaveAttribute("data-focused", "false");
  });

  it("(g) character typeahead focuses the matching option", () => {
    render(<Controlled />);
    const trigger = getTrigger();

    // Open the listbox first.
    fireEvent.click(trigger);

    // Type 'b' — the typeahead should focus 'Banana' (index 1).
    fireEvent.keyDown(trigger, { key: "b" });

    // Scope to the custom listbox to avoid the hidden native <select>'s <option>s.
    const listbox = screen.getByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    expect(options[1]).toHaveAttribute("data-focused", "true");
    expect(options[0]).toHaveAttribute("data-focused", "false");
  });

  it("(h) a visually-hidden native <select class='sr-only'> is always present", () => {
    const { container } = render(<Controlled />);
    const select = container.querySelector("select.sr-only");
    expect(select).toBeInTheDocument();
    // sr-only selects are removed from tab order so they don't confuse AT.
    expect(select).toHaveAttribute("tabindex", "-1");
  });

  it("T32a: aria-expanded is false when closed, true when open, false when closed again", () => {
    render(<Controlled />);
    const trigger = getTrigger();

    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("T32b: disabled=true — trigger is disabled, listbox does not open", () => {
    const onChange = vi.fn();
    render(
      <CustomSelect
        label="Fruit"
        value="apple"
        onChange={onChange}
        options={OPTIONS}
        disabled={true}
      />
    );

    const trigger = screen.getByRole("combobox", { name: /Fruit/ });
    expect(trigger).toBeDisabled();

    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("T32c: Tab key closes open listbox without calling onChange", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const trigger = getTrigger();

    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "Tab" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
