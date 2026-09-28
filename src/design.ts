import { randomBytes } from "node:crypto";
import { z } from "zod";
import { round, worldBox } from "./geometry.js";
import { getMaterial } from "./materials.js";
import { buildCarcass, CarcassParams } from "./templates/carcass.js";
import type { SagCheck, TemplateResult } from "./templates/common.js";
import { buildDesk, DeskParams } from "./templates/desk.js";
import type { Design, Issue, Part } from "./types.js";

export interface TemplateDef {
  key: string;
  description: string;
  schema: z.ZodTypeAny;
  defaults: Record<string, unknown>;
  build: (params: any) => TemplateResult;
}

export const TEMPLATES: Record<string, TemplateDef> = {
  bookshelf: {
    key: "bookshelf",
    description: "Open or backed bookcase: two sides, top, bottom, optional fixed + adjustable shelves, optional plinth.",
    schema: CarcassParams,
    defaults: { width: 800, height: 1800, depth: 300, material: "plywood_18", adjustableShelves: 4, fixedShelves: 0, load: "books" },
    build: buildCarcass,
  },
  cabinet: {
    key: "cabinet",
    description: "Low storage carcass / media console with a plinth and a fixed middle shelf (no doors in v1).",
    schema: CarcassParams,
    defaults: { width: 1200, height: 600, depth: 400, fixedShelves: 1, adjustableShelves: 0, plinthHeight: 80, load: "light" },
    build: buildCarcass,
  },
  cube: {
    key: "cube",
    description: "Small storage cube / nightstand box; stackable.",
    schema: CarcassParams,
    defaults: { width: 400, height: 400, depth: 350, adjustableShelves: 0, load: "light" },
    build: buildCarcass,
  },
  desk: {
    key: "desk",
    description: "Panel-leg desk: two leg panels, a top and a rear modesty panel for racking stiffness.",
    schema: DeskParams,
    defaults: { width: 1400, depth: 700, height: 740 },
    build: buildDesk,
  },
};

/** Maximum sag, uniformly loaded simply-supported beam: δ = 5wL⁴ / 384EI. */
export function shelfSag(c: SagCheck): { deflection: number; ratio: number; verdict: "ok" | "noticeable" | "too_much" } {
  const E = getMaterial(c.material).modulusMPa;
  const w = (c.loadKPa / 1000) * c.depth; // N/mm² * mm = N/mm
  const I = (c.depth * c.thickness ** 3) / 12;
  const deflection = (5 * w * c.span ** 4) / (384 * E * I);
  const ratio = c.span / deflection;
  return { deflection: round(deflection, 2), ratio: Math.round(ratio), verdict: ratio >= 600 ? "ok" : ratio >= 300 ? "noticeable" : "too_much" };
}

function validate(parts: Part[], sag: SagCheck[]): Issue[] {
  const issues: Issue[] = [];
  const trim = 10;
  for (const p of parts) {
    if (![p.length, p.width, p.thickness].every((v) => Number.isFinite(v) && v > 0)) {
      issues.push({ level: "error", code: "part_size", message: `${p.name}: each panel dimension must be greater than zero.` });
    }
    const m = getMaterial(p.material);
    const L = m.sheet.length - 2 * trim, Wd = m.sheet.width - 2 * trim;
    const fits = p.grain ? p.length <= L && p.width <= Wd : (p.length <= L && p.width <= Wd) || (p.length <= Wd && p.width <= L);
    if (!fits) {
      issues.push({ level: "error", code: "part_exceeds_sheet", message: `${p.name} (${p.length}×${p.width}) does not fit a ${m.sheet.length}×${m.sheet.width} ${m.name} sheet${p.grain ? " with the grain running lengthwise" : ""}. Choose a 4x8 material or reduce the size.` });
    }
    // overlapping machining on the same face
    for (const face of ["A", "B"] as const) {
      const hs = p.holes.filter((h) => h.face === face || h.depth >= p.thickness);
      for (let i = 0; i < hs.length; i++)
        for (let j = i + 1; j < hs.length; j++) {
          const d = Math.hypot(hs[i].x - hs[j].x, hs[i].y - hs[j].y);
          if (d < hs[i].dia / 2 + hs[j].dia / 2 + 3) {
            issues.push({ level: "warn", code: "hole_clash", message: `${p.name}: ${hs[i].purpose} and ${hs[j].purpose} holes are ${round(d, 1)}mm apart on face ${face}.` });
          }
        }
      for (const h of hs) {
        const edgeDist = Math.min(h.x, h.y, p.length - h.x, p.width - h.y) - h.dia / 2;
        if (edgeDist < 0 || h.depth <= 0 || h.depth > p.thickness || h.dia <= 0) {
          issues.push({ level: "error", code: "hole_outside_panel", message: `${p.name}: keep the ${h.purpose} hole inside the panel and within its thickness. Choose a thicker board or adjust the dimensions.` });
        } else if (edgeDist < 3) issues.push({ level: "warn", code: "hole_near_edge", message: `${p.name}: ${h.purpose} hole is ${round(edgeDist, 1)}mm from an edge.` });
      }
    }
  }
  // The back intentionally enters its grooves. Every other panel needs clear space.
  const solid = parts.filter((p) => p.id !== "back").map((p) => ({ p, box: worldBox(p) }));
  for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
    const a = solid[i], b = solid[j];
    if ([0, 1, 2].every((k) => Math.min(a.box.max[k], b.box.max[k]) - Math.max(a.box.min[k], b.box.min[k]) > 0.01)) {
      issues.push({ level: "error", code: "panel_overlap", message: `${a.p.name} (${a.p.id}) and ${b.p.name} (${b.p.id}) overlap. Increase their spacing or reduce the shelf count.` });
    }
  }
  for (const c of sag) {
    const r = shelfSag(c);
    const part = parts.find((p) => p.id === c.partId);
    if (r.verdict === "too_much") {
      issues.push({ level: c.note ? "info" : "warn", code: "shelf_sag", message: `${part?.name ?? c.partId}: estimated sag ${r.deflection}mm over ${c.span}mm (L/${r.ratio}) under ${c.loadKPa} kPa — visibly bowed. ${c.advice ?? "Narrow the span, add a fixed shelf/divider, or use a stiffer board."}${c.note ? " " + c.note : ""}` });
    } else if (r.verdict === "noticeable") {
      issues.push({ level: "info", code: "shelf_sag", message: `${part?.name ?? c.partId}: estimated sag ${r.deflection}mm (L/${r.ratio}) — slightly visible when fully loaded.` });
    }
  }
  // de-duplicate identical messages (e.g. several identical shelves)
  const seen = new Set<string>();
  return issues.filter((i) => (seen.has(i.message) ? false : (seen.add(i.message), true)));
}

/** Identical physical parts (same board, size and machining) share a letter. */
export function partSignature(p: Part): string {
  const sortJ = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).sort();
  return JSON.stringify([p.material, p.length, p.width, p.thickness, sortJ(p.holes), sortJ(p.edgeBores), sortJ(p.grooves), p.edgeBand]);
}

function assignLabels(parts: Part[]) {
  const groups = new Map<string, Part[]>();
  for (const p of parts) {
    const s = partSignature(p);
    groups.set(s, [...(groups.get(s) ?? []), p]);
  }
  const ordered = [...groups.values()].sort((a, b) => b[0].length * b[0].width - a[0].length * a[0].width);
  ordered.forEach((g, i) => {
    const label = i < 26 ? String.fromCharCode(65 + i) : `Z${i - 25}`;
    for (const p of g) p.label = label;
  });
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "design";
}

export function createDesign(template: string, params: Record<string, unknown>, name?: string, id?: string): Design {
  const def = TEMPLATES[template];
  if (!def) throw new Error(`Unknown template "${template}". Options: ${Object.keys(TEMPLATES).join(", ")}`);
  const merged = def.schema.parse({ ...def.defaults, ...params }) as Record<string, unknown> & { joinery: Design["joinery"] };
  const r = def.build(merged);
  assignLabels(r.parts);
  const issues = [...r.issues, ...validate(r.parts, r.sagChecks)];
  const { width, depth, height } = r.overall;
  const title = name ?? `${template} ${width}×${depth}×${height}`;
  return {
    id: id ?? `${slug(title)}-${randomBytes(3).toString("hex")}`,
    name: title,
    template,
    params: merged,
    createdAt: new Date().toISOString(),
    overall: r.overall,
    parts: r.parts,
    steps: r.steps,
    issues,
    joinery: merged.joinery,
  };
}

/** A partial revision keeps settings and the original creation date. */
export function reviseDesign(previous: Design, template: string, params: Record<string, unknown>, name?: string): Design {
  const d = createDesign(template, {
    ...(previous.template === template ? previous.params : {}), ...params,
  }, name ?? previous.name, previous.id);
  return { ...d, createdAt: previous.createdAt, updatedAt: new Date().toISOString() };
}

export function assertBuildable(d: Design): void {
  const errors = [...d.issues, ...validate(d.parts, [])].filter((i) => i.level === "error");
  const messages = [...new Set(errors.map((i) => i.message))];
  if (messages.length) throw new Error(`Fix design errors first:\n${messages.map((message) => `- ${message}`).join("\n")}`);
}
