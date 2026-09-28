import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createDesign, shelfSag, TEMPLATES } from "../src/design.js";
import { partDxf, sheetDxf } from "../src/dxf.js";
import { cross, frameOf, toLocal, toWorld, worldBox } from "../src/geometry.js";
import { nestParts } from "../src/nest.js";
import type { Design, Part, Vec3 } from "../src/types.js";

beforeAll(() => {
  process.env.AIKEA_HOME = mkdtempSync(join(tmpdir(), "aikea-test-"));
});

const CASES: [string, Record<string, unknown>][] = [
  ["bookshelf", {}],
  ["bookshelf", { fixedShelves: 2, adjustableShelves: 3, plinthHeight: 80, material: "melamine_19", width: 700 }],
  ["bookshelf", { joinery: "confirmat", backMaterial: null, height: 900 }],
  ["cabinet", {}],
  ["cube", {}],
  ["cube", { joinery: "confirmat", material: "mdf_18" }],
  ["desk", {}],
  ["desk", { joinery: "confirmat", topOverhang: 50, height: 1050 }],
];

const designs: Design[] = CASES.map(([t, p]) => createDesign(t, p));

function boreEntryWorld(p: Part, b: Part["edgeBores"][number]): Vec3 {
  const t = p.thickness / 2;
  switch (b.edge) {
    case "W0": return toWorld(p, [0, b.along, t]);
    case "W1": return toWorld(p, [p.length, b.along, t]);
    case "L0": return toWorld(p, [b.along, 0, t]);
    case "L1": return toWorld(p, [b.along, p.width, t]);
  }
}
const faceHoleWorld = (p: Part, h: Part["holes"][number]): Vec3[] =>
  h.depth >= p.thickness ? [toWorld(p, [h.x, h.y, 0]), toWorld(p, [h.x, h.y, p.thickness])] : [toWorld(p, [h.x, h.y, h.face === "A" ? p.thickness : 0])];
const near = (a: Vec3, b: Vec3, tol = 0.05) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol;

describe("geometry", () => {
  it("round-trips local/world coordinates", () => {
    for (const d of designs)
      for (const p of d.parts) {
        const l: Vec3 = [p.length * 0.3, p.width * 0.7, p.thickness * 0.5];
        expect(toLocal(p, toWorld(p, l)).map((v) => +v.toFixed(6))).toEqual(l.map((v) => +v.toFixed(6)));
      }
  });

  it("uses right-handed part frames (face A = x × y)", () => {
    for (const d of designs)
      for (const p of d.parts) {
        const f = frameOf(p);
        expect(cross(f.x, f.y)).toEqual(f.z);
      }
  });

  it("keeps parts from intersecting (except the back panel inside its grooves)", () => {
    for (const d of designs) {
      const solid = d.parts.filter((p) => p.id !== "back");
      for (let i = 0; i < solid.length; i++)
        for (let j = i + 1; j < solid.length; j++) {
          const a = worldBox(solid[i]), b = worldBox(solid[j]);
          const ov = [0, 1, 2].map((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]));
          const overlap = ov.every((v) => v > 0.01);
          expect(overlap, `${d.template}: ${solid[i].id} ∩ ${solid[j].id}`).toBe(false);
        }
    }
  });

  it("fits the overall bounding box to the requested size", () => {
    for (const d of designs) {
      const boxes = d.parts.map(worldBox);
      const size = [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k])) - Math.min(...boxes.map((b) => b.min[k])));
      expect(size.map((v) => Math.round(v))).toEqual([d.overall.width, d.overall.depth, d.overall.height]);
    }
  });
});

describe("joinery", () => {
  it("lines every edge bore up with a matching face hole on the mating part", () => {
    for (const d of designs) {
      for (const p of d.parts)
        for (const b of p.edgeBores) {
          const at = boreEntryWorld(p, b);
          const match = d.parts.some((q) => q !== p && q.holes.some((h) => faceHoleWorld(q, h).some((w) => near(w, at))));
          expect(match, `${d.template}/${p.id} ${b.purpose} bore on ${b.edge}@${b.along}`).toBe(true);
        }
    }
  });

  it("puts a cam housing on the bolt axis of every cam bore", () => {
    for (const d of designs)
      for (const p of d.parts)
        for (const b of p.edgeBores.filter((x) => x.purpose === "cam bolt")) {
          const cams = p.holes.filter((h) => h.purpose === "cam housing");
          const onAxis = cams.some((h) => (b.edge.startsWith("W") ? Math.abs(h.y - b.along) < 0.01 : Math.abs(h.x - b.along) < 0.01));
          expect(onAxis).toBe(true);
        }
  });

  it("uses the same hardware in the BOM as the joints need", () => {
    for (const d of designs) {
      const cams = d.parts.reduce((s, p) => s + p.holes.filter((h) => h.purpose === "cam housing").length, 0);
      const bomCams = d.steps.flatMap((s) => s.hardware).filter((h) => h.key === "cam15").reduce((s, h) => s + h.qty, 0);
      expect(bomCams).toBe(cams);
      const dowels = d.parts.reduce((s, p) => s + p.edgeBores.filter((b) => b.purpose === "dowel").length, 0);
      const bomDowels = d.steps.flatMap((s) => s.hardware).filter((h) => h.key === "dowel8x30").reduce((s, h) => s + h.qty, 0);
      expect(bomDowels).toBe(dowels);
    }
  });

  it("keeps all machining inside the part", () => {
    for (const d of designs)
      for (const p of d.parts) {
        for (const h of p.holes) {
          expect(h.x - h.dia / 2).toBeGreaterThan(0);
          expect(h.y - h.dia / 2).toBeGreaterThan(0);
          expect(h.x + h.dia / 2).toBeLessThan(p.length);
          expect(h.y + h.dia / 2).toBeLessThan(p.width);
          expect(h.depth).toBeLessThanOrEqual(p.thickness);
        }
        for (const b of p.edgeBores) expect(b.depth).toBeLessThan(b.edge.startsWith("W") ? p.length : p.width);
      }
  });
});

describe("validation", () => {
  it("flags parts that do not fit the sheet", () => {
    const d = createDesign("bookshelf", { material: "baltic_birch_18", height: 1800 });
    expect(d.issues.some((i) => i.code === "part_exceeds_sheet" && i.level === "error")).toBe(true);
  });

  it("computes shelf sag with the beam formula", () => {
    // 5wL^4/384EI with w=0.36 N/mm, L=800, E=3500, I=300*18^3/12
    const r = shelfSag({ partId: "s", span: 800, depth: 300, thickness: 18, material: "mdf_18", loadKPa: 1.2 });
    expect(r.deflection).toBeCloseTo(3.76, 1);
    expect(r.verdict).toBe("too_much");
  });

  it("warns about tip-over for tall pieces and adds an anti-tip kit", () => {
    const d = createDesign("bookshelf", {});
    expect(d.issues.some((i) => i.code === "tip_over")).toBe(true);
    expect(d.steps.some((s) => s.hardware.some((h) => h.key === "anti_tip_kit"))).toBe(true);
  });

  it("labels identical parts with the same letter and mirror parts differently", () => {
    const d = createDesign("bookshelf", { adjustableShelves: 3 });
    const adj = d.parts.filter((p) => p.id.startsWith("shelf_adj"));
    expect(new Set(adj.map((p) => p.label)).size).toBe(1);
    const l = d.parts.find((p) => p.id === "side_left")!, r = d.parts.find((p) => p.id === "side_right")!;
    expect(l.label).not.toBe(r.label);
  });

  it("covers every template", () => {
    for (const k of Object.keys(TEMPLATES)) expect(designs.some((d) => d.template === k)).toBe(true);
  });
});

describe("nesting and DXF", () => {
  it("nests every part exactly once, inside the sheet, without overlaps", () => {
    for (const d of designs.filter((x) => !x.issues.some((i) => i.level === "error"))) {
      const sheets = nestParts(d.parts);
      const placed = sheets.flatMap((s) => s.placements.map((p) => p.partId)).sort();
      expect(placed).toEqual(d.parts.map((p) => p.id).sort());
      for (const s of sheets) {
        for (const a of s.placements) {
          expect(a.x).toBeGreaterThanOrEqual(0);
          expect(a.y).toBeGreaterThanOrEqual(0);
          expect(a.x + a.w).toBeLessThanOrEqual(s.length);
          expect(a.y + a.h).toBeLessThanOrEqual(s.width);
          for (const b of s.placements)
            if (a !== b) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
        }
        // grain-constrained parts are never rotated
        for (const pl of s.placements) if (d.parts.find((p) => p.id === pl.partId)!.grain) expect(pl.rotated).toBe(false);
      }
    }
  });

  it("writes well-formed R12 DXF with operation layers", () => {
    const d = designs[0];
    const side = d.parts.find((p) => p.id === "side_left")!;
    const dxf = partDxf(side);
    expect(dxf.startsWith("0\r\nSECTION")).toBe(true);
    expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
    expect(dxf).toContain("AC1009");
    expect(dxf).toMatch(/CUT_OUTLINE/);
    expect(dxf).toMatch(/DRILL_D5_Z10/);
    expect(dxf).toMatch(/POCKET_W3\.7_Z8/);
    const sheets = nestParts(d.parts);
    const s = sheetDxf(sheets[0], new Map(d.parts.map((p) => [p.id, p])));
    const outlines = (s.match(/\r\nPOLYLINE\r\n8\r\nCUT_OUTLINE/g) ?? []).length;
    expect(outlines).toBe(sheets[0].placements.length);
  });
});
