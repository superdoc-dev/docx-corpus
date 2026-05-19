# docxcorp.us web

Static site assets are deployed to Cloudflare R2 by `.github/workflows/deploy-site.yml`.

## Raw DOCX indexing

Raw document files are served from R2 at `https://docxcorp.us/documents/{id}.docx`.
They must stay crawlable so Google can see the `X-Robots-Tag: noindex` response
header and remove raw file URLs from search results.

That header is set outside this repo by a Cloudflare Response Header Transform Rule:

- Rule name: `noindex raw docx files`
- Phase: `http_response_headers_transform`
- Expression: `http.host eq "docxcorp.us" and starts_with(http.request.uri.path, "/documents/")`
- Header: `X-Robots-Tag: noindex`

Verify before changing `robots.txt`:

```bash
curl -I https://docxcorp.us/documents/000014a959f5225c658740fd7915cd50c5728c9cbe06c7d72d79a9708244ec1f.docx
```
