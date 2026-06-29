# Item Generation API Spec

The item generation API routes are Node.js Next route handlers retained during the Cloudflare migration. They should stay thin and delegate provider behavior to `src/api/item-generation`.

## Shared Guards

Both `/api/generate-item` and `/api/generate-custom-amazon-item` apply:

- same-origin request checks
- bounded in-memory per-key rate limiting
- deterministic JSON parsing fallback for malformed bodies

The in-memory limiter is a temporary route-boundary guard. Durable Object room commands will become the authoritative multiplayer path.

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
