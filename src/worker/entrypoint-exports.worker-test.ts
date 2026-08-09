/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";

import * as workerEntrypoint from "./index";

/**
 * workerd's own boot-time contract for an entrypoint module (the wrangler
 * `main`, src/worker/index.ts): every named export must be either the
 * default `ExportedHandler` or a class usable as a Durable Object / service
 * binding. A plain value export (e.g. `export const FOO = 1`) is rejected
 * at *service startup* with "Incorrect type for map entry ...: the
 * provided value is not of type 'function or ExportedHandler'" - a boot
 * failure, not a type error or a thrown exception, so it does not surface
 * through typecheck, lint, or any test suite that merely imports the module
 * (including this pool's own vitest.worker.config.ts, which loads
 * src/worker/index.ts as a plain ES module rather than starting it as a
 * workerd service the way `wrangler dev`/deploy do).
 *
 * This test encodes workerd's export-type rule directly via reflection so a
 * regression like that one fails fast in `npm run worker-test` instead of
 * only surfacing when something actually boots the built Worker (see
 * PR_BODY.md for the incident this guards against). It intentionally does
 * NOT attempt to boot the module as a service itself - there is no cheap
 * way to do that from within this pool (see PR_BODY.md); this is the
 * structural check that was actually feasible.
 */
const KNOWN_GOOD_NAMED_EXPORTS = new Set(["GameRoomDurableObject"]);

describe("Worker entrypoint export contract (workerd boot safety)", () => {
  it("exports only the default handler and the known Durable Object class(es)", () => {
    const exportedKeys = new Set(Object.keys(workerEntrypoint));

    expect(exportedKeys).toEqual(new Set(["default", ...KNOWN_GOOD_NAMED_EXPORTS]));
  });

  it("the default export is an ExportedHandler-shaped object (has a fetch method)", () => {
    const defaultExport: unknown = workerEntrypoint.default;

    expect(typeof defaultExport).toBe("object");
    expect(defaultExport).not.toBeNull();
    expect(typeof (defaultExport as { fetch?: unknown }).fetch).toBe("function");
  });

  it("every non-default named export is a function/class, the only other shape workerd accepts", () => {
    const namedExportKeys = Object.keys(workerEntrypoint).filter((key) => key !== "default");

    expect(namedExportKeys.length).toBeGreaterThan(0);

    for (const key of namedExportKeys) {
      const value = (workerEntrypoint as Record<string, unknown>)[key];

      // This is workerd's actual rule (see module docstring above): a named
      // top-level export must be a function/class - a class counts because
      // `typeof SomeClass === "function"`. `export const FOO = 1` (typeof
      // "number") or `export const FOO = {}` (typeof "object") are exactly
      // the shapes workerd's "Incorrect type for map entry" error rejects.
      expect(typeof value, `named export "${key}" must be a function/class`).toBe("function");
    }
  });
});
