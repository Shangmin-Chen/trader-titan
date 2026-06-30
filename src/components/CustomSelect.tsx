"use client";

import React, { useState, useRef, useEffect } from "react";

export type CustomSelectOption = {
  value: string;
  label: string;
};

export type CustomSelectProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  id?: string;
  name?: string;
  ariaDescribedby?: string;
  ariaInvalid?: boolean;
  disabled?: boolean;
};

export function CustomSelect({
  label,
  value,
  onChange,
  options,
  id,
  name,
  ariaDescribedby,
  ariaInvalid,
  disabled = false,
}: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);

  // Typeahead buffer + reset timer.
  const typeaheadRef = useRef("");
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable base id so listbox/option ids are valid even when `id` is omitted,
  // without altering the public prop contract.
  const reactId = React.useId();
  const baseId = id ?? reactId;
  const labelId = `${baseId}-label`;
  const valueId = `${baseId}-value`;
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const selectedOption = options.find((opt) => opt.value === value) || options[0];
  const activeDescendantId =
    isOpen && focusedIndex >= 0 && focusedIndex < options.length
      ? optionId(focusedIndex)
      : undefined;

  const selectedIndex = () => options.findIndex((opt) => opt.value === value);

  const openListbox = () => {
    setIsOpen(true);
    setFocusedIndex(selectedIndex());
  };

  const closeListbox = (returnFocus = true) => {
    setIsOpen(false);
    setFocusedIndex(-1);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  };

  // Close listbox on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setFocusedIndex(-1);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Clear the typeahead timer on unmount.
  useEffect(() => {
    return () => {
      if (typeaheadTimerRef.current) {
        clearTimeout(typeaheadTimerRef.current);
      }
    };
  }, []);

  const runTypeahead = (char: string) => {
    typeaheadRef.current += char.toLowerCase();
    if (typeaheadTimerRef.current) {
      clearTimeout(typeaheadTimerRef.current);
    }
    typeaheadTimerRef.current = setTimeout(() => {
      typeaheadRef.current = "";
    }, 500);

    const query = typeaheadRef.current;
    const matchIndex = options.findIndex((opt) =>
      opt.label.toLowerCase().startsWith(query),
    );
    if (matchIndex >= 0) {
      if (!isOpen) {
        setIsOpen(true);
      }
      setFocusedIndex(matchIndex);
    }
  };

  // Handle keyboard navigation for the combobox trigger.
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!isOpen) {
          openListbox();
        } else {
          setFocusedIndex((prev) =>
            prev < 0 ? 0 : (prev + 1) % options.length,
          );
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!isOpen) {
          openListbox();
        } else {
          setFocusedIndex((prev) =>
            prev < 0
              ? options.length - 1
              : (prev - 1 + options.length) % options.length,
          );
        }
        break;
      case "Home":
        if (isOpen) {
          event.preventDefault();
          setFocusedIndex(0);
        }
        break;
      case "End":
        if (isOpen) {
          event.preventDefault();
          setFocusedIndex(options.length - 1);
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (isOpen) {
          if (focusedIndex >= 0 && focusedIndex < options.length) {
            onChange(options[focusedIndex].value);
          }
          closeListbox();
        } else {
          openListbox();
        }
        break;
      case "Escape":
        if (isOpen) {
          event.preventDefault();
          closeListbox();
        }
        break;
      case "Tab":
        if (isOpen) {
          // Let focus move naturally; just collapse the popup.
          setIsOpen(false);
          setFocusedIndex(-1);
        }
        break;
      default:
        if (
          event.key.length === 1 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          event.preventDefault();
          runTypeahead(event.key);
        }
        break;
    }
  };

  const handleOptionClick = (val: string) => {
    onChange(val);
    closeListbox();
  };

  // Adjust scroll position of focused item
  useEffect(() => {
    if (isOpen && focusedIndex >= 0 && listboxRef.current) {
      const listItems = listboxRef.current.children;
      const focusedItem = listItems[focusedIndex] as HTMLElement;
      if (focusedItem) {
        focusedItem.scrollIntoView({ block: "nearest" });
      }
    }
  }, [focusedIndex, isOpen]);

  return (
    <div className="form-field form-field--custom-select" ref={containerRef}>
      {/* Label — not associated with the native select via htmlFor; AT labeling
          is handled by aria-labelledby on the combobox trigger. */}
      <label id={labelId} className="form-field__label">
        {label}
      </label>

      <div style={{ position: "relative" }}>
        {/* Visually hidden native select element for Playwright e2e tests & native forms */}
        <select
          id={`${baseId}-native`}
          name={name}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-describedby={ariaDescribedby}
          aria-invalid={ariaInvalid}
          className="sr-only"
          tabIndex={-1}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        {/* Custom Visual Select Button */}
        <button
          ref={triggerRef}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-activedescendant={activeDescendantId}
          aria-labelledby={`${labelId} ${valueId}`}
          aria-describedby={ariaDescribedby}
          aria-invalid={ariaInvalid}
          disabled={disabled}
          onKeyDown={handleKeyDown}
          onClick={() => {
            if (disabled) return;
            if (isOpen) {
              setIsOpen(false);
              setFocusedIndex(-1);
            } else {
              openListbox();
            }
          }}
          className="custom-select__trigger"
          data-focused={isOpen ? "true" : "false"}
        >
          <span id={valueId} className="custom-select__value">
            {selectedOption?.label}
          </span>
          <svg
            className="custom-select__arrow"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* Custom Dropdown Popover */}
        {isOpen && (
          <div className="custom-select__popover-wrapper">
            <div className="custom-select__popover">
              <ul
                id={listboxId}
                role="listbox"
                ref={listboxRef}
                className="custom-select__listbox"
                aria-label={label}
              >
                {options.map((opt, idx) => {
                  const isSelected = opt.value === value;
                  const isFocused = idx === focusedIndex;
                  return (
                    <li
                      key={opt.value}
                      id={optionId(idx)}
                      role="option"
                      aria-selected={isSelected}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleOptionClick(opt.value)}
                      className="custom-select__item"
                      data-selected={isSelected ? "true" : "false"}
                      data-focused={isFocused ? "true" : "false"}
                    >
                      {opt.label}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
