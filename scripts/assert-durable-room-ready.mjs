#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const checks = [
  {
    path: "wrangler.toml",
    needle: 'name = "GAME_ROOM"',
    description: "Wrangler binds the GAME_ROOM Durable Object.",
  },
  {
    path: "wrangler.toml",
    needle: 'new_sqlite_classes = ["GameRoomDurableObject"]',
    description: "Wrangler applies the SQLite Durable Object migration.",
  },
  {
    path: "src/worker/index.ts",
    needle: "LEGACY_NEXT_GAME_API_PATHS",
    description: "The Worker blocks legacy process-local game API routes.",
  },
  {
    path: "src/worker/index.ts",
    needle: "applyAutomaticRoomEffects",
    description: "The Durable Object drives automatic deck-item receipt after round-opening commands.",
  },
  {
    path: "src/worker/index.ts",
    needle: "itemForRound",
    description: "Settlement derives the true value from the static deck inside the command transaction.",
  },
  {
    path: "src/worker/static-deck.ts",
    needle: "itemForRound",
    description: "The static deck exposes the pure modulo pick seam.",
  },
];

let hasFailure = false;

for (const check of checks) {
  const contents = readRepoFile(check.path);

  if (!contents.includes(check.needle)) {
    hasFailure = true;
    console.error(`Missing readiness check: ${check.description}`);
    console.error(`Expected ${check.path} to contain ${JSON.stringify(check.needle)}.`);
  }
}

if (hasFailure) {
  process.exit(1);
}

console.log("Durable room readiness checks passed.");

function readRepoFile(path) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}
