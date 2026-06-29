import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MODULE_ROOT = resolve(process.cwd(), "src/api/item-generation");
const ENTRYPOINT = resolve(MODULE_ROOT, "index.ts");
const IMPORT_SPECIFIER_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
const FORBIDDEN_IMPORTS = [/^next(?:\/|$)/, /^node:/, /^(fs|crypto|process)$/];
const FORBIDDEN_SOURCE_PATTERNS = [/process\.env/, /\bprocess\b/];

describe("item-generation import boundaries", () => {
  it("keeps the provider graph free of Next, Node-only modules, and process env reads", () => {
    const files = collectReachableFiles(ENTRYPOINT);
    const violations = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const importViolations = readImportSpecifiers(source)
        .filter((specifier) => FORBIDDEN_IMPORTS.some((pattern) => pattern.test(specifier)))
        .map((specifier) => `${relativeFile(file)} imports ${specifier}`);
      const sourceViolations = FORBIDDEN_SOURCE_PATTERNS
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${relativeFile(file)} matches ${pattern}`);

      return [...importViolations, ...sourceViolations];
    });

    expect(violations).toEqual([]);
  });
});

function collectReachableFiles(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) {
    return [];
  }

  seen.add(file);
  const source = readFileSync(file, "utf8");
  const childFiles = readImportSpecifiers(source)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolveImport(file, specifier))
    .filter((resolved): resolved is string => resolved !== null && resolved.startsWith(MODULE_ROOT))
    .flatMap((resolved) => collectReachableFiles(resolved, seen));

  return [file, ...childFiles];
}

function readImportSpecifiers(source: string): string[] {
  return Array.from(source.matchAll(IMPORT_SPECIFIER_PATTERN), (match) => match[1]);
}

function resolveImport(fromFile: string, specifier: string): string | null {
  const basePath = resolve(dirname(fromFile), specifier);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    resolve(basePath, "index.ts"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function relativeFile(file: string): string {
  return file.slice(MODULE_ROOT.length + 1);
}
