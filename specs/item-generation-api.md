# Item Generation API Spec

The item generation API routes are Node.js Next route handlers retained during the Cloudflare migration. They should stay thin and delegate provider behavior to `src/api/item-generation`.

## Shared Guards

Both `/api/generate-item` and `/api/generate-custom-amazon-item` apply:

- same-origin request checks
- bounded in-memory per-key rate limiting
- deterministic JSON parsing fallback for malformed bodies

The in-memory limiter is a temporary route-boundary guard. Durable Object room commands will become the authoritative multiplayer path.

The same shared guard module also provides Worker-side public room limiters for `POST /api/rooms` and `POST /api/rooms/:roomId/custom-amazon-item`. Those room limiters use Cloudflare client IP keys, remain bounded in memory, and return Worker-style `{ "ok": false, "error": ... }` responses from the Worker boundary rather than the legacy Next route error shape.

## Responses

Successful responses contain only public item fields:

- `round_id`
- `item_title`
- `category`
- `context_clue`

Routes store private values server-side and must not expose `true_value`, scrape metadata, token hashes, provider causes, or persistence metadata.

## Error Mapping

- Missing Gemini configuration: `500`
- Invalid custom query: `400`
- Cross-origin request: `403`
- Rate limit exceeded: `429`
- Invalid provider response or unavailable Amazon price: `502`
- Unexpected custom Amazon storage/provider failure: `500`
