import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * `buildCommand` is pinned to `next build` deliberately.
 *
 * OpenNext defaults it to `<packager> run build` — i.e. `npm run build` for
 * this repo (see buildNextjsApp in @opennextjs/aws). Since `npm run build`
 * now invokes the Cloudflare build so that Cloudflare Workers Builds produces
 * `.open-next/`, leaving the default in place would make the adapter re-enter
 * the script that invoked it and recurse forever.
 *
 * Pinning the inner command also decouples the adapter from whatever the
 * `build` script happens to contain, so changing one can no longer silently
 * break the other.
 */
const config = {
  ...defineCloudflareConfig({
    routePreloadingBehavior: "none"
  }),
  buildCommand: "next build"
};

export default config;
