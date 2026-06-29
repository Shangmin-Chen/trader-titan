import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageJson = JSON.parse(readRepoFile("package.json")) as {
  scripts?: Record<string, string>;
};
const wranglerToml = readRepoFile("wrangler.toml");
const openNextConfig = readRepoFile("open-next.config.ts");
const workerVitestConfig = readRepoFile("vitest.worker.config.ts");
const deployReadinessScript = readRepoFile("scripts/assert-durable-room-ready.mjs");

describe("Cloudflare configuration contract", () => {
  it("keeps required package scripts wired to OpenNext and Worker Vitest", () => {
    expect(packageJson.scripts).toEqual(
      expect.objectContaining({
        "build:cloudflare": "node scripts/build-cloudflare.mjs",
        "preview:cloudflare": "npm run build:cloudflare && wrangler dev",
        "deploy:cloudflare": "node scripts/assert-durable-room-ready.mjs && npm run build:cloudflare && opennextjs-cloudflare deploy",
        "typegen:worker": "wrangler types worker-configuration.d.ts --env-file .dev.vars.example",
      }),
    );
    expect(packageJson.scripts?.["worker-test"]).toContain("vitest.worker.config.ts");
    expect(packageJson.scripts?.["worker-test"]).toContain("--configLoader runner");
  });

  it("keeps Wrangler bindings and migrations aligned with the Worker scaffold", () => {
    expect(wranglerToml).toContain('main = "src/worker/index.ts"');
    expect(wranglerToml).toContain('compatibility_flags = ["nodejs_compat"]');
    expect(wranglerToml).toContain('directory = ".open-next/assets"');
    expect(wranglerToml).toContain('binding = "ASSETS"');
    expect(wranglerToml).toContain('name = "GAME_ROOM"');
    expect(wranglerToml).toContain('class_name = "GameRoomDurableObject"');
    expect(wranglerToml).toContain('new_sqlite_classes = ["GameRoomDurableObject"]');
  });

  it("keeps OpenNext and Worker Vitest using the expected generated-worker contract", () => {
    expect(openNextConfig).toContain('routePreloadingBehavior: "none"');
    expect(workerVitestConfig).toContain('const GENERATED_OPENNEXT_WORKER = "../../.open-next/worker.js"');
    expect(workerVitestConfig).toContain('const OPENNEXT_TEST_WORKER = "./src/worker/testing/open-next-worker.ts"');
    expect(workerVitestConfig).toContain('const WORKER_TEST_INCLUDE = "src/worker/**/*.worker-test.ts"');
    expect(workerVitestConfig).toContain("useSQLite: true");
  });

  it("keeps deploy readiness tied to Durable Object room ownership", () => {
    expect(deployReadinessScript).toContain("LEGACY_NEXT_GAME_API_PATHS");
    expect(deployReadinessScript).toContain("applyAutomaticRoomEffects");
    expect(deployReadinessScript).toContain("privateGeneratedItemStorageKey");
    expect(deployReadinessScript).not.toContain("TRADER_TITAN_ALLOW_PROCESS_LOCAL_ROUNDS");
  });
});

function readRepoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}
