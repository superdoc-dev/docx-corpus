#!/usr/bin/env bun
/**
 * Local preview server for the landing page.
 * Serves static files and proxies /api/* to the Worker (if running).
 *
 * Usage: bun run apps/web/scripts/preview.ts
 */

const WEB_DIR = new URL("../", import.meta.url).pathname;

Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    // Serve static files
    let path = url.pathname;
    if (path === "/") path = "/index.html";

    const file = Bun.file(WEB_DIR + path);
    if (await file.exists()) {
      return new Response(file);
    }

    // Clean URLs: /types/legal → /types/legal.html (generated pages)
    const htmlFile = Bun.file(WEB_DIR + path + ".html");
    if (await htmlFile.exists()) {
      return new Response(htmlFile, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // Directory index: /types → /types/index.html
    const indexFile = Bun.file(WEB_DIR + path + "/index.html");
    if (await indexFile.exists()) {
      return new Response(indexFile, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log("Preview: http://localhost:3000");
