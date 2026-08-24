#!/usr/bin/env node

import { spawnSync } from "node:child_process";

// NOTE: if a future server secret is ever introduced, reinstate a build-time
// blanking + artifact secret-scanning step here (the previous mechanism was
// removed once this repo's only build-time secret was deleted; see git
// history).

const build = spawnSync("opennextjs-cloudflare", ["build"], {
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}
