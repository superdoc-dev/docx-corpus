import type { APIRoute } from 'astro';
import { absoluteUrl } from '../lib/routes';

// /documents/ and /extracted/ are intentionally NOT disallowed.
// X-Robots-Tag: noindex is applied to those paths via a Cloudflare Response
// Header Transform Rule so Google can crawl them, see noindex, and exclude
// them from the index without an "indexed, blocked by robots.txt" state.

export const GET: APIRoute = async () => {
  const body = `# https://docxcorp.us/robots.txt

User-agent: *
Allow: /
Sitemap: ${absoluteUrl('/sitemap.xml')}

# AI-friendly content available at /llms.txt
# See https://llmstxt.org for the specification

# Block AI training crawlers (we allow retrieval bots like GPTBot, ClaudeBot, Amazonbot)
User-agent: CCBot
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: Applebot-Extended
Disallow: /

User-agent: meta-externalagent
Disallow: /
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
