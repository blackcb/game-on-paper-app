// KV-backed HTML cache for completed games.
//
// Layer-3 cache sitting between `caches.default` (Layer 1, per-PoP)
// and the Python pipeline (origin). `caches.default` covers the warm
// same-PoP case in ~30 ms; this KV layer covers the
// "first user in this PoP for this game" case in ~80 ms instead of
// the ~5 s pipeline.
//
// Why KV: it's globally replicated, so a write from any PoP becomes
// readable from every PoP within ~60 s. Once the FIRST user globally
// loads a completed game, every subsequent user in every other PoP
// pays the KV-read cost (~50-100 ms over the WAN), not the Python
// cost. Worker `caches.default` is per-PoP; the tiered cache TTL is
// 30 s and only caches the JSON not the HTML. KV is the right tool
// for "this completed game's HTML is byte-stable for the foreseeable
// future, share it globally."
//
// Why "completed only": in-progress and pregame responses change as
// new plays arrive or matchup data shifts. Caching their HTML
// globally would serve stale data. Completed games are immutable —
// once the box score is final, the rendered HTML doesn't change.
//
// Version prefix lets us invalidate the cache without listing+
// deleting KV entries (which is paginated and slow). Bump `v1` to
// `v2` here when shipping a template/render change that would make
// existing cached HTML stale; old `v1:` entries age out via the
// 1-year `expirationTtl`. Acceptable storage overhead for a 1-year
// TTL on a small site.

const HTML_CACHE_VERSION = "v1";
const HTML_CACHE_TTL_SECONDS = 31_536_000; // 365 days; matches CACHE_CONTROL.completed s-maxage

function keyFor(gameId: string | number): string {
  return `game-html:${HTML_CACHE_VERSION}:${gameId}`;
}

export async function readCachedGameHtml(
  kv: KVNamespace,
  gameId: string | number,
): Promise<string | null> {
  return await kv.get(keyFor(gameId), "text");
}

export async function writeCachedGameHtml(
  kv: KVNamespace,
  gameId: string | number,
  html: string,
): Promise<void> {
  // KV value-size limit is 25 MB; typical game HTML is ~200 KB so
  // we're well under. expirationTtl makes KV auto-delete after the
  // window — completed-game HTML stays byte-stable but no point
  // hanging on to it forever if nobody re-clicks.
  await kv.put(keyFor(gameId), html, { expirationTtl: HTML_CACHE_TTL_SECONDS });
}
