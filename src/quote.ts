// Fulfilment: turn a built package into a request for quote (RFQ) that a CNC
// shop can price, cut, band, drill, kit with hardware and ship.
//
// There is no universal "cut my flat-pack" API, so fulfilment is adapter based:
//   - email:   produce a ready-to-send RFQ email (subject/body + zip attachment path).
//              Hosts with an email connector (e.g. Gmail) can send it directly.
//   - webhook: POST the RFQ JSON (+ base64 zip) to a fabricator endpoint that
//              speaks the AIKEA RFQ schema (see README).
// Fabricators are configured in $AIKEA_HOME/fabricators.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cutList, hardwareBom, machiningMetrics } from "./bom.js";
import { getMaterial } from "./materials.js";
import type { BuildResult } from "./package.js";
import { aikeaHome, designDir } from "./store.js";
import type { Design } from "./types.js";

export interface Fabricator {
  id: string;
  name: string;
  email?: string;
  webhook?: string;
  tokenEnv?: string; // name of env var holding a bearer token for the webhook
  region?: string;
  services?: string[]; // e.g. ["cnc", "edge_banding", "horizontal_boring", "hardware_kitting", "delivery"]
  notes?: string;
}

export function loadFabricators(): Fabricator[] {
  const file = join(aikeaHome(), "fabricators.json");
  const list: Fabricator[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  if (process.env.AIKEA_FABRICATOR_WEBHOOK && !list.some((f) => f.id === "env")) {
    list.push({ id: "env", name: "Default webhook fabricator", webhook: process.env.AIKEA_FABRICATOR_WEBHOOK, tokenEnv: "AIKEA_FABRICATOR_TOKEN", services: ["cnc", "delivery"] });
  }
  return list;
}

export function saveFabricator(f: Fabricator): Fabricator[] {
  const file = join(aikeaHome(), "fabricators.json");
  const list: Fabricator[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const next = [...list.filter((x) => x.id !== f.id), f];
  writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

export interface Customer { name: string; email?: string; phone?: string; deliveryAddress?: string; postalCode?: string }

export interface RfqOptions {
  customer: Customer;
  services: { edgeBanding: boolean; horizontalBoring: boolean; hardwareKit: boolean; delivery: boolean; finishing?: string };
  quantity: number;
  neededBy?: string;
  notes?: string;
}

export function rfqPayload(d: Design, build: BuildResult, o: RfqOptions) {
  return {
    schema: "aikea.rfq/v1",
    design: { id: d.id, name: d.name, template: d.template, overall_mm: d.overall, joinery: d.joinery },
    quantity: o.quantity,
    customer: o.customer,
    services: o.services,
    needed_by: o.neededBy ?? null,
    notes: o.notes ?? null,
    sheets: build.sheets,
    materials: [...new Set(d.parts.map((p) => p.material))].map((k) => {
      const m = getMaterial(k);
      return { key: k, name: m.name, thickness_mm: m.thickness, sheet_mm: [m.sheet.length, m.sheet.width], sheets: build.sheets.filter((s) => s.material === k).length * o.quantity };
    }),
    machining: machiningMetrics(d),
    cutlist: cutList(d),
    hardware: hardwareBom(d).map((h) => ({ ...h, order: h.order * o.quantity })),
    files: build.files,
  };
}

export function rfqEmail(d: Design, build: BuildResult, o: RfqOptions, f?: Fabricator) {
  const p = rfqPayload(d, build, o);
  const m = p.machining;
  const subject = `RFQ: CNC cut flat-pack ${d.template} (${d.overall.width}×${d.overall.depth}×${d.overall.height} mm) ×${o.quantity}`;
  const lines = [
    `Hi${f ? ` ${f.name}` : ""},`,
    "",
    `I'd like a quote to CNC-cut and kit ${o.quantity === 1 ? "one" : o.quantity} ${d.template}${o.quantity === 1 ? "" : "s"} from the attached DXF package (${d.id}.zip).`,
    "",
    "Materials:",
    ...p.materials.map((x) => `  - ${x.name}: ${x.sheets} sheet(s) of ${x.sheet_mm[0]}×${x.sheet_mm[1]} mm`),
    "",
    `Machining per unit: ${m.parts} parts (${m.uniqueParts} unique), ${m.profileCutM} m profile cut, ${m.holes} face holes, ${m.grooveM} m groove, ${m.edgeBores} horizontal edge bores.`,
    "",
    "Please include:",
    `  - Edge banding (${m.edgeBandM} m): ${o.services.edgeBanding ? "yes" : "no"}`,
    `  - Horizontal edge boring: ${o.services.horizontalBoring ? "yes — or tell me if you can't and I'll use a jig" : "no, I'll drill these myself"}`,
    `  - Hardware kit (list in hardware.csv): ${o.services.hardwareKit ? "yes, please bag and label it" : "no"}`,
    `  - Finishing: ${o.services.finishing ?? "none (raw)"}`,
    `  - Delivery: ${o.services.delivery ? `yes, to ${o.customer.deliveryAddress ?? o.customer.postalCode ?? "(address to follow)"}` : "no, I'll pick up"}`,
    ...(o.neededBy ? ["", `Needed by: ${o.neededBy}`] : []),
    ...(o.notes ? ["", o.notes] : []),
    "",
    "SHOP_NOTES.md in the package explains the DXF layer conventions. Nested sheet layouts are included but feel free to re-nest.",
    "",
    "Thanks,",
    o.customer.name,
    ...(o.customer.phone ? [o.customer.phone] : []),
    ...(o.customer.email ? [o.customer.email] : []),
  ];
  return { to: f?.email ?? null, subject, body: lines.join("\n"), attachment: build.zip };
}

export async function submitRfq(d: Design, build: BuildResult, o: RfqOptions, f?: Fabricator) {
  const email = rfqEmail(d, build, o, f);
  let webhook: { url: string; status: number; response: unknown } | null = null;
  if (f?.webhook) {
    const token = f.tokenEnv ? process.env[f.tokenEnv] : undefined;
    const body = { ...rfqPayload(d, build, o), package_zip_base64: readFileSync(build.zip).toString("base64") };
    const res = await fetch(f.webhook, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    webhook = { url: f.webhook, status: res.status, response: parsed };
  }
  const record = { at: new Date().toISOString(), fabricator: f?.id ?? null, quantity: o.quantity, webhook, email: { to: email.to, subject: email.subject } };
  const file = join(designDir(d.id), "quotes.json");
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  writeFileSync(file, JSON.stringify([...prev, record], null, 2));
  return { email, webhook };
}
