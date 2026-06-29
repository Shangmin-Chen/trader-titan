#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SECRET_KEYS = ["GEMINI_API_KEY"];
const ARTIFACT_ROOT = ".open-next";
const ENV_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
  ".dev.vars",
];

const secretValues = readSecretValues();
const buildEnv = {
  ...process.env,
};

for (const key of SECRET_KEYS) {
  buildEnv[key] = "";
}

const build = spawnSync("opennextjs-cloudflare", ["build"], {
  env: buildEnv,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const leakedKeys = scanArtifactsForSecretValues(secretValues);

if (leakedKeys.length > 0) {
  console.error(
    `Cloudflare build artifact contains server secret values for: ${leakedKeys.join(", ")}.`,
  );
  console.error("Move server secrets to Wrangler secrets or .dev.vars and rebuild.");
  process.exit(1);
}

function readSecretValues() {
  const values = new Map();

  for (const key of SECRET_KEYS) {
    const envValue = process.env[key];

    if (typeof envValue === "string" && envValue.length > 0) {
      values.set(key, envValue);
    }
  }

  for (const file of ENV_FILES) {
    if (!existsSync(file)) {
      continue;
    }

    const source = readFileSync(file, "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);

      if (match === null || !SECRET_KEYS.includes(match[1])) {
        continue;
      }

      const value = unquoteEnvValue(match[2]);
      if (value.length > 0) {
        values.set(match[1], value);
      }
    }
  }

  return values;
}

function unquoteEnvValue(value) {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function scanArtifactsForSecretValues(secretValues) {
  if (secretValues.size === 0 || !existsSync(ARTIFACT_ROOT)) {
    return [];
  }

  const leakedKeys = new Set();
  const artifactFiles = walkFiles(ARTIFACT_ROOT);

  for (const file of artifactFiles) {
    const contents = readFileSync(file, "utf8");

    for (const [key, value] of secretValues) {
      if (contents.includes(value)) {
        leakedKeys.add(key);
      }
    }
  }

  return [...leakedKeys];
}

function walkFiles(root) {
  const files = [];

  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);

    if (stat.isDirectory()) {
      files.push(...walkFiles(path));
    } else if (stat.isFile()) {
      files.push(path);
    }
  }

  return files;
}
