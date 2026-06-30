import "@testing-library/jest-dom/vitest";

// jsdom does not implement scrollIntoView; stub it so components that call it
// during focus management (e.g. CustomSelect's listbox scroll effect) don't
// throw TypeError in the test environment.
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
