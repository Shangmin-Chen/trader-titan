import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const ROOM_ROOT = resolve(process.cwd(), "src/lib/room");
const ROOM_SOURCE_FILES = [
  "authorization.ts",
  "commands.ts",
  "dispatcher.ts",
  "ids.ts",
  "index.ts",
  "persistence.ts",
  "protocol.ts",
  "snapshot.ts",
  "tokens.ts",
  "types.ts",
];
const IMPORT_SPECIFIER_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
const FORBIDDEN_IMPORTS = [
  /^next(?:\/|$)/,
  /^node:/,
  /^(fs|crypto|process)$/,
  /\/api(?:\/|$)/,
  /\/app(?:\/|$)/,
  /\/worker(?:\/|$)/,
];
const FORBIDDEN_SOURCE_PATTERNS = [/process\.env/, /\bfetch\s*\(/];

describe("room domain import boundaries", () => {
  it("stays independent of framework, API, Worker, and environment concerns", () => {
    const violations = ROOM_SOURCE_FILES.flatMap((file) => {
      const absoluteFile = resolve(ROOM_ROOT, file);
      const source = readFileSync(absoluteFile, "utf8");
      const importViolations = readImportSpecifiers(source)
        .filter((specifier) => FORBIDDEN_IMPORTS.some((pattern) => pattern.test(specifier)))
        .map((specifier) => `${basename(file)} imports ${specifier}`);
      const sourceViolations = FORBIDDEN_SOURCE_PATTERNS
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${basename(file)} matches ${pattern}`);

      return [...importViolations, ...sourceViolations];
    });

    expect(violations).toEqual([]);
  });
});

function readImportSpecifiers(source: string): string[] {
  return Array.from(source.matchAll(IMPORT_SPECIFIER_PATTERN), (match) => match[1]);
}
