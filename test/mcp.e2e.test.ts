import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttp, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

let client: Client;
let hook: Server;
let hookUrl = "";
const received: any[] = [];

const text = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

beforeAll(async () => {
  process.env.AIKEA_HOME = mkdtempSync(join(tmpdir(), "aikea-e2e-"));
  hook = createHttp((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ quote_id: "Q-1", price: 612.5, currency: "CAD", lead_time_days: 7 }));
    });
  });
  await new Promise<void>((r) => hook.listen(0, r));
  hookUrl = `http://127.0.0.1:${(hook.address() as any).port}/rfq`;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});

afterAll(async () => {
  await client.close();
  hook.close();
});

describe("MCP end to end", () => {
  let id = "";

  it("lists the tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "aikea_add_fabricator", "aikea_build", "aikea_design", "aikea_get_design", "aikea_list_designs",
      "aikea_list_fabricators", "aikea_list_options", "aikea_preview", "aikea_request_quote", "aikea_shelf_sag",
    ]);
  });

  it("describes templates and parameters", async () => {
    const r = await client.callTool({ name: "aikea_list_options", arguments: {} });
    expect(text(r)).toContain("### bookshelf");
    expect(text(r)).toContain("adjustableShelves");
    expect(text(r)).toContain("baltic_birch_18");
  });

  it("designs a bookshelf and returns a preview image", async () => {
    const r: any = await client.callTool({ name: "aikea_design", arguments: { template: "bookshelf", name: "Hall bookcase", params: { width: 700, height: 1500, depth: 280, adjustableShelves: 3, fixedShelves: 1 } } });
    expect(r.isError).toBeFalsy();
    id = /design_id: (\S+)/.exec(text(r))![1];
    expect(id).toMatch(/^hall-bookcase-/);
    expect(r.content.some((c: any) => c.type === "image" && c.mimeType === "image/png")).toBe(true);
  });

  it("revises a design in place", async () => {
    const r: any = await client.callTool({ name: "aikea_design", arguments: { template: "bookshelf", design_id: id, params: { width: 760 } } });
    expect(text(r)).toContain(`design_id: ${id}`);
    expect(text(r)).toContain("760 W");
    expect(text(r)).toContain("280 D × 1500 H");
    const list = await client.callTool({ name: "aikea_list_designs", arguments: {} });
    expect(text(list).match(new RegExp(id, "g"))!.length).toBe(1);
  });

  it("renders an assembly step", async () => {
    const r: any = await client.callTool({ name: "aikea_preview", arguments: { design_id: id, step: 2 } });
    expect(text(r)).toContain("Step 2");
    expect(r.content.some((c: any) => c.type === "image")).toBe(true);
  });

  it("returns a tool error for invalid designs instead of throwing", async () => {
    const r: any = await client.callTool({ name: "aikea_design", arguments: { template: "bookshelf", params: { width: 50 } } });
    expect(r.isError).toBe(true);
  });

  it("refuses to build designs with errors", async () => {
    const d: any = await client.callTool({ name: "aikea_design", arguments: { template: "bookshelf", params: { material: "baltic_birch_18", height: 2000 } } });
    const bad = /design_id: (\S+)/.exec(text(d))![1];
    const r: any = await client.callTool({ name: "aikea_build", arguments: { design_id: bad } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("does not fit");
  });

  it("builds the fabrication package", async () => {
    const r: any = await client.callTool({ name: "aikea_build", arguments: { design_id: id } });
    expect(r.isError).toBeFalsy();
    const zipPath = /Package zip: (\S+)/.exec(text(r))![1];
    expect(existsSync(zipPath)).toBe(true);
    const zip = unzipSync(readFileSync(zipPath));
    const names = Object.keys(zip);
    for (const f of ["instructions.html", "cutlist.csv", "hardware.csv", "SHOP_NOTES.md", "design.json"]) expect(names).toContain(`${id}/${f}`);
    expect(names.some((n) => n.includes("dxf/sheets/sheet_1_"))).toBe(true);
    expect(names.some((n) => n.endsWith("dxf/parts/A.dxf"))).toBe(true);
    const html = new TextDecoder().decode(zip[`${id}/instructions.html`]);
    expect(html).toContain("Anchor it to the wall");
  });

  it("exposes built files as resources", async () => {
    const r = await client.readResource({ uri: `aikea://designs/${id}/SHOP_NOTES.md` });
    expect((r.contents[0] as any).text).toContain("DXF layers");
  });

  it("requests a quote from a webhook fabricator", async () => {
    process.env.TEST_FAB_TOKEN = "secret";
    await client.callTool({ name: "aikea_add_fabricator", arguments: { id: "testfab", name: "Test CNC", email: "shop@example.com", webhook: hookUrl, token_env: "TEST_FAB_TOKEN" } });
    const r: any = await client.callTool({
      name: "aikea_request_quote",
      arguments: { design_id: id, fabricator_id: "testfab", quantity: 2, customer: { name: "Jo", postal_code: "V6X 1A1" }, finishing: "clear matte lacquer" },
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("HTTP 200");
    expect(text(r)).toContain("Q-1");
    expect(text(r)).toContain("To: shop@example.com");
    expect(received).toHaveLength(1);
    const { auth, body } = received[0];
    expect(auth).toBe("Bearer secret");
    expect(body.schema).toBe("aikea.rfq/v1");
    expect(body.quantity).toBe(2);
    expect(body.cutlist.length).toBeGreaterThan(3);
    expect(body.package_zip_base64.length).toBeGreaterThan(1000);
    expect(body.hardware.find((h: any) => h.key === "cam15").order).toBeGreaterThan(20);
  });
});
