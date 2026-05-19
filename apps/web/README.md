# docxcorp.us web

Static site assets are deployed to Cloudflare R2 by `.github/workflows/deploy-site.yml`.

## Raw File Indexing

Raw document files are served from R2 at `https://docxcorp.us/documents/{id}.docx`.
Extracted text files are served from R2 at `https://docxcorp.us/extracted/{id}.txt`.
They must stay crawlable so Google can see the `X-Robots-Tag: noindex` response
header and remove raw file URLs from search results.

That header is set outside this repo by a Cloudflare Response Header Transform Rule:

- Rule name: `noindex raw docx and extracted text files`
- Phase: `http_response_headers_transform`
- Expression: `http.host eq "docxcorp.us" and (starts_with(http.request.uri.path, "/documents/") or starts_with(http.request.uri.path, "/extracted/"))`
- Header: `X-Robots-Tag: noindex`

Verify before changing `robots.txt`:

```bash
curl -I https://docxcorp.us/documents/000014a959f5225c658740fd7915cd50c5728c9cbe06c7d72d79a9708244ec1f.docx
curl -I https://docxcorp.us/extracted/000014a959f5225c658740fd7915cd50c5728c9cbe06c7d72d79a9708244ec1f.txt
```

## HTML Edge Caching

Cloudflare does not cache HTML by default. A zone-level Cache Rule enables caching
for HTML pages, the homepage, and the three metadata files. Static assets
(favicons, og-image, logo) keep Cloudflare's default static-asset cache behavior.

The Cache Rule is set outside this repo:

- Phase: `http_request_cache_settings`
- Expression: `http.host eq "docxcorp.us" and (http.request.uri.path eq "/" or http.request.uri.path in {"/dataset" "/classification" "/quality" "/download" "/types" "/topics" "/sitemap.xml" "/robots.txt" "/llms.txt"} or starts_with(http.request.uri.path, "/types/") or starts_with(http.request.uri.path, "/topics/"))`
- Action: `cache: true`, `edge_ttl.mode: bypass_by_default` (TTL driven by origin `Cache-Control`)

The matching upload-side `Cache-Control` header (`public, max-age=300, stale-while-revalidate=3600`)
is set by `deploy-site.yml` on HTML uploads and on `sitemap.xml`/`robots.txt`/`llms.txt`. Keep the
two sides in sync: if you add a new cacheable HTML route, add it to the expression above.

Verify after deploy:

```bash
# Two same-URL requests in a row: first MISS, second HIT.
URL="https://docxcorp.us/dataset"
curl -sI "$URL" | grep -i "cf-cache-status\|cache-control"
curl -sI "$URL" | grep -i "cf-cache-status"
```
