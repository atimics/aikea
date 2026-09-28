import { z } from "zod";
import { createHash } from "node:crypto";
import { cutList, hardwareBom, machiningMetrics } from "./bom.js";
import { createDesign, reviseDesign, TEMPLATES } from "./design.js";
import { MATERIALS } from "./materials.js";
import { nestParts } from "./nest.js";
import { isoSvg, partSvg, sheetSvg } from "./render.js";
import { loadDesign } from "./store.js";
import type { Design } from "./types.js";

export const DesignInput = z.object({
  template: z.enum(["bookshelf", "cabinet", "cube", "desk", "tideline"]),
  params: z.record(z.string(), z.unknown()).default({}),
  name: z.string().trim().min(1).max(100).optional(),
  design_id: z.string().regex(/^[a-z0-9-]+$/).max(100).optional(),
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export function designFromInput(input: unknown): Design {
  const a = DesignInput.parse(input);
  if (!a.design_id) return createDesign(a.template, a.params, a.name);
  const previous = loadDesign(a.design_id);
  if (a.expected_revision && a.expected_revision !== revisionOf(previous)) {
    throw new Error("This design changed in another client. Open the latest saved design from My designs before making a revision.");
  }
  return reviseDesign(previous, a.template, a.params, a.name);
}

export const revisionOf = (d: Design) => createHash("sha256").update(JSON.stringify(d)).digest("hex");

export function studioOptions() {
  return {
    templates: Object.values(TEMPLATES).map((t) => ({
      key: t.key, description: t.description,
      defaults: t.schema.parse(t.defaults), schema: z.toJSONSchema(t.schema, { io: "input" }),
    })),
    materials: Object.values(MATERIALS),
  };
}

/** Browser and MCP clients share the furniture engine and saved designs. */
export function studioDesign(d: Design) {
  const opts = { width: 760, maxHeight: 660, background: "transparent", materialColors: true };
  const byId = new Map(d.parts.map((p) => [p.id, p]));
  let sheets: { index: number; material: string; utilisation: number; svg: string }[] = [];
  let nestingError: string | undefined;
  if (!d.issues.some((i) => i.level === "error")) {
    try {
      sheets = nestParts(d.parts).map((s) => ({
        index: s.index, material: MATERIALS[s.material].name,
        utilisation: s.utilisation, svg: sheetSvg(s, byId),
      }));
    } catch (e) {
      nestingError = e instanceof Error ? e.message : "Adjust the dimensions to fit the sheet.";
    }
  }
  const rows = cutList(d);
  return {
    design: d,
    revision: revisionOf(d),
    buildable: !nestingError && !d.issues.some((i) => i.level === "error"),
    nestingError,
    metrics: machiningMetrics(d),
    cutlist: rows.map((r) => ({ ...r, svg: partSvg(d.parts.find((p) => p.label === r.label)!) })),
    hardware: hardwareBom(d), sheets,
    preview: isoSvg(d, d.parts, { ...opts, dims: true, camera: d.template === "tideline" ? "front" : "isometric" }),
    exploded: isoSvg(d, d.parts, { ...opts, explode: 160, highlight: new Set(d.parts.map((p) => p.id)) }),
    steps: d.steps.map((s, i) => {
      const added = new Set(d.steps.slice(0, i + 1).flatMap((step) => step.parts));
      return { ...s, svg: isoSvg(d, d.parts.filter((p) => added.has(p.id)), { ...opts, highlight: new Set(s.parts) }) };
    }),
  };
}
