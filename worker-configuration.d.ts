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
  }

  interface GlobalProps {
    mainModule: typeof import("./src/worker/index");
    durableNamespaces: "GameRoomDurableObject";
  }
}
