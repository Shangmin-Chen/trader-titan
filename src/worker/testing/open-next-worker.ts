const JSON_CONTENT_TYPE = "application/json";
const SMOKE_HEADER_NAME = "x-trader-titan-worker";
const SMOKE_HEADER_VALUE = "opennext-smoke";
const SMOKE_RUNTIME = "workerd";

/**
 * Lets Worker Vitest exercise the wrapper before the generated OpenNext worker exists.
 */
const openNextSmokeWorker = {
  fetch(request: Request): Response {
    const url = new URL(request.url);

    return Response.json(
      {
        ok: true,
        path: url.pathname,
        runtime: SMOKE_RUNTIME
      },
      {
        headers: {
          "content-type": JSON_CONTENT_TYPE,
          [SMOKE_HEADER_NAME]: SMOKE_HEADER_VALUE
        }
      }
    );
  }
} satisfies ExportedHandler<Cloudflare.Env>;

export { SMOKE_HEADER_NAME, SMOKE_HEADER_VALUE };

export default openNextSmokeWorker;
