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

    return new Response("Not found", { status: 404 });
  },
});

console.log("Preview: http://localhost:3000");
