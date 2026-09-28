#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { createApp } from "./http.js";

async function main() {
  if (!process.argv.includes("--http")) {
    await createServer().connect(new StdioServerTransport());
    return;
  }
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  const app = createApp();
  app.on("error", (e) => { console.error(e.message); process.exitCode = 1; });
  app.listen(port, host, () => console.error(`AIKEA workshop: http://${host}:${port}\nMCP endpoint: http://${host}:${port}/mcp`));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => app.close());
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
