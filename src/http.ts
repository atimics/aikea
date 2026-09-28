import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { buildPackage } from "./package.js";
import { createServer } from "./server.js";
import { aikeaHome, listDesigns, loadDesign, saveDesign } from "./store.js";
import { designFromInput, studioDesign, studioOptions } from "./studio.js";

const MIME: Record<string, string> = {
  ".zip": "application/zip", ".dxf": "application/dxf", ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".json": "application/json", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
};
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
async function readJson(req: IncomingMessage) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new HttpError(415, "Send application/json.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 64 * 1024) { req.resume(); throw new HttpError(413, "Keep the request under 64 KB."); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Send valid JSON."); }
}
async function sendFile(res: ServerResponse, file: string, head: boolean, root: string) {
  if (!existsSync(file) || !statSync(file).isFile() || !realpathSync(file).startsWith(realpathSync(root) + sep)) {
    throw new HttpError(404, "File unavailable. Build the current design to create its files.");
  }
  const headers: Record<string, string | number> = {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "content-length": statSync(file).size, "cache-control": "no-store",
  };
  if (extname(file) === ".zip") headers["content-disposition"] = `attachment; filename="${file.split(sep).pop()}"`;
  res.writeHead(200, headers);
  if (head) res.end();
  else await pipeline(createReadStream(file), res);
}
export function createApp() {
  const root = join(aikeaHome(), "designs");
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const assets = existsSync(join(moduleDir, "public/index.html")) ? join(moduleDir, "public") : join(moduleDir, "../public");
  const publicOrigin = process.env.AIKEA_PUBLIC_URL ? new URL(process.env.AIKEA_PUBLIC_URL).origin : undefined;
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]", ...(publicOrigin ? [new URL(publicOrigin).hostname] : [])]);
  if (process.env.HOST && !["0.0.0.0", "::"].includes(process.env.HOST)) hosts.add(process.env.HOST);
  return createHttpServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const base = new URL(`http://${req.headers.host ?? "localhost"}`);
      if (!hosts.has(base.hostname)) throw new HttpError(403, "Use the configured Aikea host.");
      if (req.headers.origin && req.headers.origin !== base.origin && req.headers.origin !== publicOrigin) {
        throw new HttpError(403, "Open this action from your Aikea workshop.");
      }
      const url = new URL(req.url ?? "/", base);
      const path = url.pathname;
      if (path === "/mcp") {
        const body = req.method === "POST" ? await readJson(req) : undefined;
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => { void transport.close(); void server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        if (path === "/health") { json(res, 200, { status: "ok", service: "aikea" }); return; }
        const staticFiles: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/styles.css": "styles.css" };
        if (Object.hasOwn(staticFiles, path)) { await sendFile(res, join(assets, staticFiles[path]), req.method === "HEAD", assets); return; }
        if (path === "/api/options") { json(res, 200, studioOptions()); return; }
        if (path === "/api/designs") { json(res, 200, listDesigns()); return; }
        const design = /^\/api\/designs\/([a-z0-9-]+)$/.exec(path);
        if (design) { json(res, 200, studioDesign(loadDesign(design[1]))); return; }
        if (path.startsWith("/files/")) {
          const rel = decodeURIComponent(path.slice(7));
          const match = /^([a-z0-9-]+)\/(.+)$/.exec(rel);
          if (!match || !/^(?:design\.json|[a-z0-9-]+\.zip|build\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:dxf|html|md|csv|svg|png|json))$/.test(match[2]) || rel.split("/").some((s) => s.startsWith("."))) {
            throw new HttpError(404, "File unavailable.");
          }
          await sendFile(res, join(root, rel), req.method === "HEAD", root);
          return;
        }
      }
      if (req.method === "POST") {
        if (path === "/api/preview" || path === "/api/designs") {
          const d = designFromInput(await readJson(req));
          const result = studioDesign(d);
          if (path === "/api/designs") saveDesign(d);
          json(res, 200, result);
          return;
        }
        const build = /^\/api\/designs\/([a-z0-9-]+)\/build$/.exec(path);
        if (build) {
          const options = z.object({ toolDia: z.number().min(1).max(20).optional(), spacing: z.number().min(0).max(30).optional(), trim: z.number().min(0).max(50).optional() }).strict().parse(await readJson(req));
          const d = loadDesign(build[1]);
          const b = await buildPackage(d, options);
          const prefix = `/files/${d.id}/`;
          json(res, 200, { sheets: b.sheets, metrics: b.metrics, download: `${prefix}${d.id}.zip`, instructions: `${prefix}build/instructions.html`, files: b.files.map((name) => ({ name, url: `${prefix}build/${name}` })) });
          return;
        }
      }
      throw new HttpError(404, "Page unavailable.");
    } catch (e) {
      if (res.headersSent || res.destroyed) return;
      const status = e instanceof HttpError ? e.status : e instanceof URIError ? 400 : 422;
      const error = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".") || "Input"}: ${i.message}`).join("\n") : e instanceof Error ? e.message : "Please try again.";
      json(res, status, { error });
    }
  });
}
