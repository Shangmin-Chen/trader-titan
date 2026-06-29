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

  const selectedOption = options.find((opt) => opt.value === value) || options[0];

  // Close listbox on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Handle keyboard navigation for custom select
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
          setFocusedIndex(options.findIndex((opt) => opt.value === value));
        } else {
          setFocusedIndex((prev) => (prev + 1) % options.length);
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
          setFocusedIndex(options.findIndex((opt) => opt.value === value));
        } else {
          setFocusedIndex((prev) => (prev - 1 + options.length) % options.length);
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (isOpen) {
          if (focusedIndex >= 0 && focusedIndex < options.length) {
            onChange(options[focusedIndex].value);
          }
          setIsOpen(false);
          triggerRef.current?.focus();
        } else {
          setIsOpen(true);
          setFocusedIndex(options.findIndex((opt) => opt.value === value));
        }
        break;
      case "Escape":
        if (isOpen) {
          event.preventDefault();
          setIsOpen(false);
          triggerRef.current?.focus();
        }
        break;
      case "Tab":
        if (isOpen) {
          setIsOpen(false);
        }
        break;
      default:
        break;
    }
  };

  const handleOptionClick = (val: string) => {
    onChange(val);
    setIsOpen(false);
    triggerRef.current?.focus();
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
      {/* Label linked to the visually hidden select element */}
      <label className="form-field__label" htmlFor={id}>
        {label}
      </label>

      <div style={{ position: "relative" }}>
        {/* Visually hidden native select element for Playwright e2e tests & native forms */}
        <select
          id={id}
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
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={`${id}-listbox`}
          disabled={disabled}
          onKeyDown={handleKeyDown}
          onClick={() => {
            if (!disabled) {
              setIsOpen(!isOpen);
              setFocusedIndex(options.findIndex((opt) => opt.value === value));
            }
          }}
          className="custom-select__trigger"
          data-focused={isOpen ? "true" : "false"}
        >
          <span className="custom-select__value">{selectedOption?.label}</span>
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
                id={`${id}-listbox`}
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
                      role="option"
                      aria-selected={isSelected}
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
