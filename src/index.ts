#!/usr/bin/env node
// AIKEA MCP server entry point.
//   aikea-mcp            → stdio transport (Claude Desktop, Claude Code, etc.)
//   aikea-mcp --http     → Streamable HTTP on $PORT (default 3000) at /mcp,
//                          plus read-only downloads of built packages at /files/<id>/...
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { aikeaHome } from "./store.js";

const MIME: Record<string, string> = {
  ".zip": "application/zip", ".dxf": "application/dxf", ".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
};

async function main() {
  if (!process.argv.includes("--http")) {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    return;
  }
  const port = Number(process.env.PORT ?? 3000);
  const root = join(aikeaHome(), "designs");
  const http = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/mcp") {
        // Stateless: a fresh server + transport per request.
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => { transport.close(); server.close(); });
        await server.connect(transport);
        let body: unknown;
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        }
        await transport.handleRequest(req, res, body);
        return;
      }
      if (url.pathname.startsWith("/files/") && req.method === "GET") {
        const rel = normalize(decodeURIComponent(url.pathname.slice("/files/".length)));
        const file = join(root, rel);
        if (!file.startsWith(root + sep) || rel.includes("..") || !existsSync(file) || !statSync(file).isFile()) {
          res.writeHead(404).end("not found");
          return;
        }
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        createReadStream(file).pipe(res);
        return;
      }
      if (url.pathname === "/" || url.pathname === "/health") {
        res.writeHead(200, { "content-type": "text/plain" }).end("aikea mcp ok\n");
        return;
      }
      res.writeHead(404).end("not found");
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  });
  http.listen(port, () => console.error(`aikea MCP listening on http://localhost:${port}/mcp`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
