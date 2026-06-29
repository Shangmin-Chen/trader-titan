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
    description: "The Durable Object drives automatic generation and settlement.",
  },
  {
    path: "src/worker/index.ts",
    needle: "privateGeneratedItemStorageKey",
    description: "Private generated items are stored outside public room snapshots.",
  },
  {
    path: "src/worker/index.ts",
    needle: "loadPrivateGeneratedItemEnvelope",
    description: "Settlement loads Durable Object private item state.",
  },
  {
    path: "src/worker/private-generated-items.ts",
    needle: "createSettledGeneratedItem",
    description: "Private item storage can reconstruct settlement items.",
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
