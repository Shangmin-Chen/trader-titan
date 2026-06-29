import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const COMPATIBILITY_DATE = "2026-06-29";
const GENERATED_OPENNEXT_WORKER = "../../.open-next/worker.js";
const GAME_ROOM_BINDING = "GAME_ROOM";
const GAME_ROOM_DURABLE_OBJECT = "GameRoomDurableObject";
const OPENNEXT_TEST_WORKER = "./src/worker/testing/open-next-worker.ts";
const WORKER_ENTRYPOINT = "./src/worker/index.ts";
const WORKER_TEST_INCLUDE = "src/worker/**/*.worker-test.ts";
const WORKER_COMPATIBILITY_FLAGS = ["nodejs_compat"] as const;

const openNextTestWorkerPath = fileURLToPath(
  new URL(OPENNEXT_TEST_WORKER, import.meta.url)
);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: GENERATED_OPENNEXT_WORKER,
        replacement: openNextTestWorkerPath
      }
    ]
  },
  plugins: [
    cloudflareTest({
      main: WORKER_ENTRYPOINT,
      additionalExports: {
        [GAME_ROOM_DURABLE_OBJECT]: "DurableObject"
      },
      miniflare: {
        bindings: {
          GEMINI_API_KEY: "worker-test-gemini-api-key",
          WORKER_ITEM_PROVIDER: "deterministic"
        },
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: [...WORKER_COMPATIBILITY_FLAGS],
        durableObjects: {
          [GAME_ROOM_BINDING]: {
            className: GAME_ROOM_DURABLE_OBJECT,
            useSQLite: true
          }
        }
      }
    })
  ],
  test: {
    include: [WORKER_TEST_INCLUDE],
    globals: false
  }
});
