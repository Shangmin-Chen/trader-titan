/// <reference types="@cloudflare/workers-types" />

declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    GEMINI_API_KEY?: string;
    GAME_ROOM: DurableObjectNamespace<
      import("./src/worker/index").GameRoomDurableObject
    >;
    NEXT_PUBLIC_APP_ENV?: "local" | "preview" | "production";
    WORKER_ITEM_PROVIDER?: "deterministic" | "gemini";
    /**
     * Dedicated test/dev-only gate for test-only Worker routes (currently
     * just POST /room/test-expire-turn - see testExpireTurnSoon in
     * src/worker/index.ts). Deliberately has no meaning anywhere else in
     * this codebase and is never set by wrangler.toml, unlike
     * WORKER_ITEM_PROVIDER (a real provider-selection override that an
     * operator could legitimately set on a genuine deploy) - so presence of
     * this var can only ever be a deliberate, test-specific choice.
     */
    WORKER_TEST_MODE?: string;
  }

  interface GlobalProps {
    mainModule: typeof import("./src/worker/index");
    durableNamespaces: "GameRoomDurableObject";
  }
}
