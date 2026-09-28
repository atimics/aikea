import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cutList, hardwareBom, machiningMetrics } from "./bom.js";
import { createDesign, reviseDesign, shelfSag, TEMPLATES } from "./design.js";
import { MATERIALS } from "./materials.js";
import { buildPackage, svgToPng, type BuildResult } from "./package.js";
import { loadFabricators, saveFabricator, submitRfq } from "./quote.js";
import { isoSvg } from "./render.js";
import { designDir, listDesigns, loadDesign, saveDesign } from "./store.js";
import { LOADS } from "./templates/common.js";
import type { Design } from "./types.js";

export const VERSION = "0.1.0";

const INSTRUCTIONS = `AIKEA turns furniture ideas into flat-pack kits a CNC shop can cut.
Workflow:
1. aikea_list_options — templates, materials, joinery and their parameters.
2. aikea_design — create (or revise, by passing design_id) a design. Read the issues it reports (sheet fit, shelf sag, tip-over, hole clashes) and fix errors before building. Look at the preview image and iterate with the user.
3. aikea_preview — re-render the whole piece or a single assembly step.
4. aikea_build — nest parts on sheets and write the fabrication package: per-part and nested-sheet DXFs, cut list, hardware list, IKEA-style instructions (HTML), shop notes and a zip.
5. aikea_request_quote — send the package to a configured fabricator (webhook) and/or return a ready-to-send RFQ email.
All dimensions are millimetres. Width = left–right, depth = front–back, height = floor–top.`;

function publicUrl(id: string, rel: string): string | undefined {
  const base = process.env.AIKEA_PUBLIC_URL;
  return base ? `${base.replace(/\/$/, "")}/files/${id}/${rel.split("/").map(encodeURIComponent).join("/")}` : undefined;
}

function paramDocs(schema: z.ZodTypeAny, defaults: Record<string, unknown>): string {
  const js = z.toJSONSchema(schema, { io: "input" }) as any;
  return Object.entries(js.properties ?? {})
    .map(([k, v]: [string, any]) => {
      const type = v.enum ? v.enum.join("|") : v.anyOf ? v.anyOf.map((a: any) => a.type).join("|") : v.type;
      const def = k in defaults ? defaults[k] : v.default;
      const range = v.minimum !== undefined ? ` [${v.minimum}–${v.maximum}]` : "";
      return `  - ${k} (${type}${range}${def !== undefined ? `, default ${JSON.stringify(def)}` : ""}): ${v.description ?? ""}`;
    })
    .join("\n");
}

function summary(d: Design): string {
  const rows = cutList(d);
  const m = machiningMetrics(d);
  const hw = hardwareBom(d);
  const lines = [
    `# ${d.name}`,
    `design_id: ${d.id} · template: ${d.template} · ${d.overall.width} W × ${d.overall.depth} D × ${d.overall.height} H mm · joinery: ${d.joinery}`,
    "",
    "## Issues",
    ...(d.issues.length ? d.issues.map((i) => `- [${i.level.toUpperCase()}] ${i.message}`) : ["- none"]),
    "",
    "## Parts",
    "| Part | Qty | Name | L × W × T (mm) | Material | Ops |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.label} | ${r.qty} | ${r.name} | ${r.length} × ${r.width} × ${r.thickness} | ${r.material} | ${r.faceOps} face, ${r.edgeBores} edge |`),
    "",
    "## Hardware (incl. spares)",
    ...hw.map((h) => `- ${h.order}× ${h.name} — ${h.spec}`),
    "",
    `Panels weigh ≈ ${m.weightKg} kg. ${m.holes} face holes, ${m.edgeBores} edge bores, ${m.edgeBandM} m edge banding.`,
    "",
    "## Assembly",
    ...d.steps.map((s, i) => `${i + 1}. ${s.title}`),
  ];
  return lines.join("\n");
}

async function image(svg: string): Promise<{ type: "image"; data: string; mimeType: string } | { type: "text"; text: string }> {
  const png = await svgToPng(svg, 900);
  return png ? { type: "image", data: png.toString("base64"), mimeType: "image/png" } : { type: "text", text: svg };
}

function buildSummary(d: Design, b: BuildResult): string {
  const files = b.files.map((f) => {
    const url = publicUrl(d.id, `build/${f}`);
    return `- ${f}${url ? ` → ${url}` : ""}`;
  });
  const zipUrl = publicUrl(d.id, `${d.id}.zip`);
  return [
    `Built fabrication package for ${d.name} (${d.id}).`,
    "",
    `Package zip: ${b.zip}${zipUrl ? `\nDownload: ${zipUrl}` : ""}`,
    `Folder: ${b.dir}`,
    "",
    "## Sheets",
    ...b.sheets.map((s) => `- Sheet ${s.index}: ${MATERIALS[s.material].name} ${s.size} — parts ${s.parts.join(" ")} — ${Math.round(s.utilisation * 100)}% used`),
    "",
    "## Machining",
    `${b.metrics.parts} parts · ${b.metrics.profileCutM} m profile · ${b.metrics.holes} holes · ${b.metrics.edgeBores} edge bores · ${b.metrics.grooveM} m groove · ${b.metrics.edgeBandM} m banding · ≈${b.metrics.weightKg} kg`,
    "",
    "## Files",
    ...files,
  ].join("\n");
}

const err = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] });

export function createServer(): McpServer {
  const server = new McpServer({ name: "aikea", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "aikea_list_options",
    {
      title: "List templates, materials and options",
      description: "List furniture templates with their parameters, board materials, joinery methods and load presets. Call this first.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const t = Object.values(TEMPLATES).map((d) => `### ${d.key}\n${d.description}\nParameters:\n${paramDocs(d.schema, d.defaults)}`);
      const m = Object.values(MATERIALS).map((x) => `- ${x.key}: ${x.name} — ${x.sheet.length}×${x.sheet.width} sheet${x.grain ? ", grain" : ""}. ${x.notes}`);
      const l = Object.entries(LOADS).map(([k, v]) => `- ${k}: ${v.kPa} kPa — ${v.description}`);
      const text = [
        "## Templates", ...t, "",
        "## Materials", ...m, "",
        "## Joinery",
        "- cam_dowel: 15mm cam locks + 8mm dowels (IKEA-style knock-down, re-assemblable). Needs ≥15mm board.",
        "- confirmat: 7×50 confirmat screws through the sides (strong, simple, visible screw heads).",
        "", "## Load presets (for shelf-sag checks)", ...l,
      ].join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "aikea_design",
    {
      title: "Create or revise a furniture design",
      description: "Generate a parametric flat-pack design: every panel, its CNC machining (holes, grooves, edge bores), hardware and assembly steps. Returns a summary, validation issues and a preview image. Pass design_id to revise an existing design in place.",
      inputSchema: {
        template: z.enum(Object.keys(TEMPLATES) as [string, ...string[]]).describe("Template key from aikea_list_options"),
        params: z.record(z.string(), z.any()).default({}).describe("Template parameters (mm). Omitted values keep saved settings on revisions, or use template defaults for new designs."),
        name: z.string().optional().describe("Human-friendly name, e.g. 'Living room bookcase'"),
        design_id: z.string().optional().describe("Existing design to overwrite (revision)"),
      },
    },
    async ({ template, params, name, design_id }) => {
      try {
        const d = design_id
          ? reviseDesign(loadDesign(design_id), template, params ?? {}, name)
          : createDesign(template, params ?? {}, name);
        saveDesign(d);
        const preview = isoSvg(d, d.parts, { dims: true, width: 640, maxHeight: 820, title: d.name });
        return { content: [{ type: "text", text: summary(d) }, await image(preview)] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "aikea_get_design",
    {
      title: "Get a design",
      description: "Return a saved design's summary, or the full JSON model (every part with local-frame machining) when full=true.",
      inputSchema: { design_id: z.string(), full: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    async ({ design_id, full }) => {
      try {
        const d = loadDesign(design_id);
        return { content: [{ type: "text", text: full ? JSON.stringify(d, null, 2) : summary(d) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "aikea_list_designs",
    { title: "List saved designs", description: "List saved designs, newest first.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      const ds = listDesigns();
      const text = ds.length ? ds.map((d) => `- ${d.id}: ${d.name} (${d.template}, ${d.overall.width}×${d.overall.depth}×${d.overall.height})`).join("\n") : "No designs yet.";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "aikea_preview",
    {
      title: "Render a design",
      description: "Render an isometric preview of the finished piece, or of a single assembly step (1-based) with the newly added parts highlighted and labelled.",
      inputSchema: { design_id: z.string(), step: z.number().int().min(1).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ design_id, step }) => {
      try {
        const d = loadDesign(design_id);
        if (!step) return { content: [await image(isoSvg(d, d.parts, { dims: true, width: 640, maxHeight: 820, title: d.name }))] };
        if (step > d.steps.length) throw new Error(`Design has ${d.steps.length} steps`);
        const upto = new Set(d.steps.slice(0, step).flatMap((s) => s.parts));
        const s = d.steps[step - 1];
        const svg = isoSvg(d, d.parts.filter((p) => upto.has(p.id)), { highlight: new Set(s.parts), width: 640, maxHeight: 700, title: `${step}. ${s.title}` });
        const hw = s.hardware.map((h) => `${h.qty}× ${h.key}`).join(", ");
        return { content: [{ type: "text", text: `Step ${step}: ${s.title}\n${s.text}${hw ? `\nHardware: ${hw}` : ""}` }, await image(svg)] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "aikea_shelf_sag",
    {
      title: "Estimate shelf sag",
      description: "Estimate the deflection of a uniformly loaded shelf (simply supported). Useful for choosing widths/materials before designing.",
      inputSchema: {
        span: z.number().describe("Unsupported span, mm"),
        depth: z.number().describe("Shelf depth, mm"),
        material: z.string().default("plywood_18"),
        load: z.enum(["light", "books", "heavy"]).default("books"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ span, depth, material, load }) => {
      try {
        const m = MATERIALS[material];
        if (!m) throw new Error(`Unknown material ${material}`);
        const r = shelfSag({ partId: "shelf", span, depth, thickness: m.thickness, material, loadKPa: LOADS[load].kPa });
        return { content: [{ type: "text", text: `${m.name}, ${span}mm span × ${depth}mm deep, ${load} (${LOADS[load].kPa} kPa): sag ≈ ${r.deflection}mm (L/${r.ratio}) → ${r.verdict}. Target ≤ L/600 for invisible sag.` }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "aikea_build",
    {
      title: "Build the fabrication package",
      description: "Nest parts onto sheets and write the fabrication package: nested-sheet and per-part DXFs (layered by operation), cutlist.csv, hardware.csv, instructions.html (IKEA-style), SHOP_NOTES.md and a zip. Returns file paths (and download URLs when served over HTTP) plus a sheet layout image.",
      inputSchema: {
        design_id: z.string(),
        tool_diameter: z.number().min(1).max(20).optional().describe("Router bit diameter, mm (default 6.35)"),
        spacing: z.number().min(0).max(30).optional().describe("Extra gap between parts, mm (default 4)"),
        trim: z.number().min(0).max(50).optional().describe("Unusable margin at sheet edges, mm (default 12)"),
      },
    },
    async ({ design_id, tool_diameter, spacing, trim }) => {
      try {
        const d = loadDesign(design_id);
        const blocking = d.issues.filter((i) => i.level === "error");
        if (blocking.length) throw new Error(`Fix design errors first:\n${blocking.map((i) => `- ${i.message}`).join("\n")}`);
        const b = await buildPackage(d, { ...(tool_diameter ? { toolDia: tool_diameter } : {}), ...(spacing !== undefined ? { spacing } : {}), ...(trim !== undefined ? { trim } : {}) });
        const firstSheet = b.files.find((f) => f.startsWith("svg/sheet_1"));
        const content: any[] = [{ type: "text", text: buildSummary(d, b) }];
        if (firstSheet) content.push(await image(readFileSync(join(b.dir, firstSheet), "utf8")));
        return { content };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "aikea_list_fabricators",
    { title: "List fabricators", description: "List CNC shops configured for quotes ($AIKEA_HOME/fabricators.json, or AIKEA_FABRICATOR_WEBHOOK).", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      const fs = loadFabricators();
      const text = fs.length
        ? fs.map((f) => `- ${f.id}: ${f.name}${f.email ? ` <${f.email}>` : ""}${f.webhook ? " [webhook]" : ""}${f.region ? ` — ${f.region}` : ""}${f.services ? ` (${f.services.join(", ")})` : ""}`).join("\n")
        : "No fabricators configured. Add one with aikea_add_fabricator, or request a quote without one to get an RFQ email you can send to any local CNC shop.";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "aikea_add_fabricator",
    {
      title: "Add a fabricator",
      description: "Save a CNC shop for quotes. Give an email for RFQ emails and/or a webhook URL that accepts the aikea.rfq/v1 JSON schema.",
      inputSchema: {
        id: z.string().regex(/^[a-z0-9-]+$/),
        name: z.string(),
        email: z.string().email().optional(),
        webhook: z.string().url().optional(),
        token_env: z.string().optional().describe("Env var holding a bearer token for the webhook"),
        region: z.string().optional(),
        services: z.array(z.string()).optional(),
        notes: z.string().optional(),
      },
    },
    async (a) => {
      const list = saveFabricator({ id: a.id, name: a.name, email: a.email, webhook: a.webhook, tokenEnv: a.token_env, region: a.region, services: a.services, notes: a.notes });
      return { content: [{ type: "text", text: `Saved ${a.name}. ${list.length} fabricator(s) configured.` }] };
    },
  );

  server.registerTool(
    "aikea_request_quote",
    {
      title: "Request a fabrication quote",
      description: "Package a design for a CNC shop: builds it if needed, POSTs the RFQ to the fabricator's webhook when one is configured, and always returns a ready-to-send RFQ email (to/subject/body + zip path). Confirm quantities and contact details with the user before submitting.",
      inputSchema: {
        design_id: z.string(),
        fabricator_id: z.string().optional(),
        quantity: z.number().int().min(1).default(1),
        customer: z.object({
          name: z.string(),
          email: z.string().optional(),
          phone: z.string().optional(),
          delivery_address: z.string().optional(),
          postal_code: z.string().optional(),
        }),
        edge_banding: z.boolean().default(true),
        horizontal_boring: z.boolean().default(true).describe("Ask the shop to drill edge bores (otherwise the customer uses a jig)"),
        hardware_kit: z.boolean().default(true),
        delivery: z.boolean().default(true),
        finishing: z.string().optional().describe("e.g. 'clear matte lacquer', or omit for raw"),
        needed_by: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async (a) => {
      try {
        const d = loadDesign(a.design_id);
        const fab = a.fabricator_id ? loadFabricators().find((f) => f.id === a.fabricator_id) : undefined;
        if (a.fabricator_id && !fab) throw new Error(`Unknown fabricator ${a.fabricator_id}`);
        const b = await buildPackage(d);
        const r = await submitRfq(d, b, {
          customer: { name: a.customer.name, email: a.customer.email, phone: a.customer.phone, deliveryAddress: a.customer.delivery_address, postalCode: a.customer.postal_code },
          services: { edgeBanding: a.edge_banding, horizontalBoring: a.horizontal_boring, hardwareKit: a.hardware_kit, delivery: a.delivery, finishing: a.finishing },
          quantity: a.quantity,
          neededBy: a.needed_by,
          notes: a.notes,
        }, fab);
        const parts = [
          r.webhook ? `Webhook ${r.webhook.url} → HTTP ${r.webhook.status}\n${JSON.stringify(r.webhook.response, null, 2)}` : "No webhook configured for this fabricator — send the email below.",
          "",
          `To: ${r.email.to ?? "(your CNC shop)"}`,
          `Subject: ${r.email.subject}`,
          `Attach: ${r.email.attachment}${publicUrl(d.id, `${d.id}.zip`) ? ` (${publicUrl(d.id, `${d.id}.zip`)})` : ""}`,
          "",
          r.email.body,
        ];
        return { content: [{ type: "text", text: parts.join("\n") }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerResource(
    "design-file",
    new ResourceTemplate("aikea://designs/{id}/{file}", { list: undefined }),
    { title: "AIKEA design files", description: "design.json, instructions.html, SHOP_NOTES.md, cutlist.csv or hardware.csv for a design" },
    async (uri, { id, file }) => {
      const allowed: Record<string, [string, string]> = {
        "design.json": ["design.json", "application/json"],
        "instructions.html": ["build/instructions.html", "text/html"],
        "SHOP_NOTES.md": ["build/SHOP_NOTES.md", "text/markdown"],
        "cutlist.csv": ["build/cutlist.csv", "text/csv"],
        "hardware.csv": ["build/hardware.csv", "text/csv"],
      };
      const entry = allowed[String(file)];
      if (!entry) throw new Error(`Unknown file ${file}`);
      const path = join(designDir(String(id)), entry[0]);
      if (!existsSync(path)) throw new Error(`${file} not built yet — run aikea_build`);
      return { contents: [{ uri: uri.href, mimeType: entry[1], text: readFileSync(path, "utf8") }] };
    },
  );

  return server;
}
